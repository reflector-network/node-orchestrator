const {
    Config,
    ConfigEnvelope,
    buildUpdates,
    verifySignature,
    ValidationError,
    normalizeTimestamp,
    sortObjectKeys
} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')
const ConfigEnvelopeModel = require('../persistence-layer/models/contract-config')
const ConfigStatus = require('./config-status')
const {computeUpdateStatus} = require('./utils')
const notificationProvider = require('./notification-provider')
const {getUpdateTxHash, getUpdateTx} = require('./tx-helper')

/**
 * @typedef {import('./types').ConfigEnvelopeDto} ConfigEnvelopeDto
 * @typedef {import('./types').SignatureDto} Signature
 */

const hourPeriod = 60 * 60 * 1000

const minExpirationDatePeriod = hourPeriod * 24 * 7 //7 days

const updateItems = () => {
    switch (__pendingConfig?.status) {
        case ConfigStatus.REJECTED:
            __pendingConfig = null
            break
        case ConfigStatus.APPLIED:
            __currentConfig = __pendingConfig
            __pendingConfig = null
            break
        default:
            return
    }
}

const processPendingConfig = async () => {
    let timeout = 5000
    try {
        const now = Date.now()
        if (!__pendingConfig)
            return
        if (__pendingConfig.expirationDate < now) {
            switch (__pendingConfig.status) {
                case ConfigStatus.VOTING:
                    { //reject expired voting updates
                        await ConfigEnvelopeModel.findOneAndUpdate(
                            {_id: __pendingConfig.id},
                            {status: ConfigStatus.REJECTED},
                            {new: true}
                        ).exec()
                        __pendingConfig.status = ConfigStatus.REJECTED
                    }
                    break
                case ConfigStatus.PENDING: //try to apply expired pending updates
                    if (__pendingConfig.envelope.timestamp > now) {
                        timeout = __pendingConfig.envelope.timestamp - now
                        return
                    }
                    if (__pendingConfig.txHash) { //if now txHash, than tx is not required for update, so just change status
                        const txResponse = await getUpdateTx(__pendingConfig.txHash)
                        if (!txResponse?.successful)
                            return
                    }
                    if (__currentConfig) {
                        const session = await mongoose.startSession()
                        session.startTransaction()
                        try {
                            await ConfigEnvelopeModel.findByIdAndUpdate({_id: __currentConfig.id}, {status: ConfigStatus.REPLACED}).exec()
                            await ConfigEnvelopeModel.findByIdAndUpdate({_id: __pendingConfig.id}, {status: ConfigStatus.APPLIED}).exec()
                            await session.commitTransaction()
                            __pendingConfig.status = ConfigStatus.APPLIED
                        } catch (error) {
                            await session.abortTransaction()
                            throw error
                        } finally {
                            await session.endSession()
                        }
                    }
                    break
                default: {
                    console.error('Unexpected status:', __pendingConfig.status)
                    return
                }
            }
            updateItems()
            notificationProvider.notify({type: 'update', data: __pendingConfig.toPlainObject()})
        }
    } catch (error) {
        console.error(error)
    } finally {
        setTimeout(processPendingConfig, timeout)
    }
}

class ConfigItem {
    /**
     * @param {any} rawEnvelope
     */
    constructor(rawEnvelope) {
        if (!rawEnvelope)
            throw new ValidationError('Config envelope is not defined')
        this.envelope = new ConfigEnvelope(rawEnvelope)
        if (!rawEnvelope.expirationDate)
            throw new ValidationError('Expiration date is not defined')
        this.expirationDate = rawEnvelope.expirationDate
        this.status = rawEnvelope.status
        this.id = rawEnvelope.id
        processPendingConfig()
    }

    /**
     * @type {ConfigEnvelope} config
     */
    envelope = null

    /**
     * @type {string}
     */
    description = null

    /**
     * @type {number}
     */
    expirationDate = null

    /**
     * @type {string}
     */
    status = null

    /**
     * @type {string}
     */
    id = null

    toPlainObject() {
        return sortObjectKeys({
            ...this.envelope.toPlainObject(),
            id: this.id,
            initiator: this.envelope.signatures[0].pubkey,
            description: this.description,
            expirationDate: this.expirationDate,
            status: this.status
        })
    }
}

/**
 * @type {ConfigItem}
 */
let __currentConfig = null

/**
 * @type {ConfigItem}
 */
let __pendingConfig = null

/**
 * @type {Node[]}
 */
let __defaultNodes = null

/**
 * @param {ConfigItem} configItem
 * @returns {{configToModify: ConfigItem, signatureIndex: number}}
 */
function getConfigToModify(configItem) {
    const {envelope} = configItem
    const signature = envelope.signatures[0]
    let configToModify = null
    if (__currentConfig && __currentConfig.envelope.isPayloadEqual(configItem.envelope)) {
        if (signature.rejected)
            throw new ValidationError('Rejected signature cannot be used to modify config in status ' + __currentConfig.status)
        configToModify = __currentConfig
    } else if (__pendingConfig) {
        if (!__pendingConfig.envelope.isPayloadEqual(configItem.envelope))
            throw new ValidationError('Pending config already exists')
        if (__pendingConfig.envelope.expirationDate < Date.now())
            throw new ValidationError('Pending config already expired')
        configToModify = __pendingConfig
    } else
        return null

    const signatureIndex = configToModify.envelope.signatures.findIndex(s => s.pubkey === signature.pubkey)
    if (signatureIndex >= 0 && ![ConfigStatus.VOTING].includes(configToModify.status))
        throw new ValidationError('Signature cannot be modified for this config in status ' + configToModify.status)
    return {configToModify, signatureIndex}
}

/**
 * @param {ConfigItem} configItem
 */
async function getPendingConfigData(configItem) {
    let timestamp = 0
    if (configItem.envelope.timestamp === 0) {
        //get timestamp for pending config
        const minDate = Math.max(configItem.envelope.config.minDate || Date.now())
        timestamp = normalizeTimestamp(minDate + hourPeriod * 2, hourPeriod)
    }
    //get txHash for pending config
    const txHash = await getUpdateTxHash(__currentConfig.envelope.config, configItem.envelope.config, timestamp)
    return {timestamp, txHash}
}

/**
 * @param {ConfigItem} configItem
 * @param {Number} signatureIndex
 * @param {Signature} signature
 * @param {boolean} isInitConfig
 */
async function updateConfig(configItem, signatureIndex, signature, isInitConfig) {
    //copy signatures array to avoid mutation
    const signatures = [...configItem.envelope.signatures]
    let update = null
    //prepare signatures update, and modify signatures collection
    if (signatureIndex >= 0) {
        update = {$set: {[`config.signatures.${signatureIndex}`]: signature}}
        signatures[signatureIndex] = signature
    } else {
        update = {$push: {signatures: signature}}
        signatures.push(signature)
    }
    //compute status and add to update if changed
    const currentStatus = computeUpdateStatus(signatures, configProvider.allNodePubkeys().length, isInitConfig)
    if (configItem.status !== currentStatus) {
        update.$set = update.$set || {}
        update.$set.status = currentStatus
        if (currentStatus === ConfigStatus.PENDING) {
            const {timestamp, txHash} = getPendingConfigData(configItem)
            update.$set.timestamp = timestamp
            update.$set.txHash = txHash
        }
    }

    const updatedDoc = (await ConfigEnvelopeModel.findByIdAndUpdate(
        configItem.id,
        update,
        {new: true}
    ).exec()).toPlainObject()

    const updatedEnvelope = new ConfigEnvelope(updatedDoc)

    //set updated values to configItem
    configItem.status = updatedDoc.status
    configItem.envelope.signatures = updatedEnvelope.signatures
    configItem.envelope.timestamp = updatedEnvelope.timestamp
    configItem.txHash = updatedEnvelope.txHash

    return configItem
}

/**
 * @param {ConfigItem} configItem
 * @param {boolean} isInitConfig
 */
async function createConfig(configItem, isInitConfig) {
    //compute status and add to update if changed
    const currentStatus = computeUpdateStatus(configItem.envelope.signatures, configProvider.allNodePubkeys().length, isInitConfig)
    configItem.status = currentStatus
    if (currentStatus === ConfigStatus.PENDING) {
        const {timestamp, txHash} = getPendingConfigData(configItem)
        configItem.envelope.timestamp = timestamp
        configItem.txHash = txHash
    }
    const rawConfig = configItem.toPlainObject()
    const configDoc = new ConfigEnvelopeModel(rawConfig)
    await configDoc.save()
    configItem.id = configDoc.id
    return configItem
}

function cleanupConfig(config) {
    for (const node of config.config.nodes) {
        delete node.url
    }
    delete config.config.wasmHash
}

/**
 * @param {ConfigItem} configItem
 * @param {boolean} onlyPublicFields
 * @returns {{config: ConfigEnvelopeDto, hash: string}}
 */
function getConfigForClient(configItem, onlyPublicFields) {
    const config = configItem?.toPlainObject()
    if (!config)
        return null
    if (onlyPublicFields) {
        cleanupConfig(config)
    }
    return {
        config,
        hash: configItem?.envelope.config.getHash()
    }
}

const configProvider = {
    /**
     * @param {boolean} onlyPublicFields
     * @returns {{currentConfig: {config: ConfigEnvelopeDto, hash: string}, pendingConfig: {config: ConfigEnvelopeDto, hash: string}}} - The current configs
     */
    getCurrentConfigs(onlyPublicFields) {
        return {
            currentConfig: getConfigForClient(__currentConfig, onlyPublicFields),
            pendingConfig: getConfigForClient(__pendingConfig, onlyPublicFields)
        }
    },
    init: async (defaultNodes) => {
        const currentConfigDoc = await ConfigEnvelopeModel.findOne({status: ConfigStatus.APPLIED}).exec()
        if (currentConfigDoc) {
            __currentConfig = new ConfigItem(currentConfigDoc.toPlainObject())
        }
        const pendingConfigDoc = await ConfigEnvelopeModel.findOne({status: {$in: [ConfigStatus.PENDING, ConfigStatus.VOTING]}}).exec()
        if (pendingConfigDoc)
            __pendingConfig = new ConfigItem(pendingConfigDoc.toPlainObject())
        if (!__currentConfig && (!defaultNodes || defaultNodes.length < 1))
            throw new Error('Default nodes are not defined')
        __defaultNodes = defaultNodes
    },
    /**
     * @param {{ status: string, initiator: string, page: number, pageSize: number }} filter - The filter
     * @param {boolean} onlyPublicFields - Flag to return only public fields
     * @returns {Promise<ConfigEnvelopeDto[]>}
     */
    history: async (filter, onlyPublicFields) => {
        const query = {}
        if (filter?.status)
            query.status = filter.status
        if (filter?.initiator)
            query['signatures.0.pubkey'] = filter.initiator

        const page = filter?.page || 1
        const pageSize = filter?.pageSize || 10
        const skip = (page > 0 ? page - 1 : page) * pageSize

        const configDocs = await ConfigEnvelopeModel.find(query).sort({createdAt: -1}).skip(skip).limit(pageSize).exec()
        return configDocs.map(d => {
            const plainObject = d.toPlainObject()
            if (onlyPublicFields)
                cleanupConfig(plainObject)
            return plainObject
        })
    },
    /**
     *
     * @param {any} rawConfigEnvelope
     * @returns {Promise<any>}
     */
    create: async (rawConfigEnvelope) => {
        if (!rawConfigEnvelope)
            throw new ValidationError('Config is not defined')

        if (!rawConfigEnvelope.signatures || rawConfigEnvelope.signatures.length !== 1)
            throw new ValidationError('Invalid signatures object')

        const configItem = new ConfigItem(rawConfigEnvelope)
        const {config} = configItem.envelope
        if (!config.isValid)
            throw new ValidationError(`Invalid config. ${config.issuesString}`)

        const {pubkey, signature, nonce, rejected} = configItem.envelope.signatures[0]
        if (!verifySignature(pubkey, signature, config.getSignaturePayloadHash(pubkey, nonce, rejected)))
            throw new ValidationError('Invalid signature')

        const {configToModify, signatureIndex} = getConfigToModify(configItem) || {}
        if (configToModify) {
            const resultConfig = await updateConfig(
                configToModify,
                signatureIndex,
                rawConfigEnvelope.signatures[0],
                true,
                !!__currentConfig
            )
            updateItems()
            notificationProvider.notify({type: 'config-updated', data: resultConfig.toPlainObject()})
            return
        }

        //no configToModify, create new config
        if (config.expirationDate < Date.now() + minExpirationDatePeriod)
            throw new ValidationError('Pending config already expired')
        if (config.expirationDate <= config.minDate)
            throw new ValidationError('Config min date cannot be less than expiration date')
        if (__currentConfig && buildUpdates(1n, new Config(__currentConfig.envelope.config), config).size === 0)
            throw new ValidationError('Config doesn\'t have any changes')
        if (rejected)
            throw new ValidationError('Rejected signature cannot be used to create config')

        __pendingConfig = await createConfig(configItem, !!__currentConfig)

        updateItems()
        notificationProvider.notify({type: 'config-created', data: __pendingConfig.toPlainObject()})
    },
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {Node}
     */
    getNode: (pubkey) => {
        if (__currentConfig)
            return __currentConfig?.envelope.config.nodes.get(pubkey)
        return __defaultNodes.find(n => n === pubkey)
    },
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {boolean}
     */
    hasNode: (pubkey) => {
        const node = configProvider.getNode(pubkey)
        return !!node
    },
    /**
     * Returns all nodes
     * @returns {Node[]}
     */
    allNodePubkeys: () => {
        if (configProvider.currentConfig)
            return configProvider.currentConfig?.config.nodes.map(n => n.pubkey)
        return __defaultNodes
    }
}

module.exports = configProvider