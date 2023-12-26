const {
    ConfigEnvelope,
    buildUpdates,
    verifySignature,
    ValidationError,
    normalizeTimestamp,
    sortObjectKeys
} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')
const ConfigEnvelopeModel = require('../persistence-layer/models/contract-config')
const MessageTypes = require('../server/ws/handlers/message-types')
const ChannelTypes = require('../server/ws/channel-types')
const logger = require('../logger')
const ConfigStatus = require('./config-status')
const {computeUpdateStatus} = require('./utils')
const notificationProvider = require('./notification-provider')
const {getUpdateTxHash, getUpdateTx} = require('./tx-helper')
const container = require('./container')

/**
 * @typedef {import('./types').ConfigEnvelopeDto} ConfigEnvelopeDto
 * @typedef {import('./types').SignatureDto} Signature
 */

const hourPeriod = 60 * 60 * 1000

const minExpirationDatePeriod = hourPeriod * 24 * 7 //7 days

/**
 * @type {ConfigItem}
 */
let __currentConfig = null

/**
 * @type {ConfigItem}
 */
let __pendingConfig = null

/**
 * @type {string[]}
 */
let __defaultNodes = null

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
        this.description = rawEnvelope.description
        this.txHash = rawEnvelope.txHash
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

    /**
     * @type {string}
     */
    txHash = null

    toPlainObject() {
        return sortObjectKeys({
            ...this.envelope.toPlainObject(),
            id: this.id,
            initiator: this.envelope.signatures[0].pubkey,
            description: this.description,
            expirationDate: this.expirationDate,
            status: this.status,
            txHash: this.txHash
        })
    }
}

class ConfigManager {
    /**
     * @param {string[]} defaultNodes - The default node pubkeys
     * @returns {Promise<void>}
     */
    async init(defaultNodes) {
        const currentConfigDoc = await ConfigEnvelopeModel.findOne({status: ConfigStatus.APPLIED}).exec()
        if (currentConfigDoc) {
            __currentConfig = new ConfigItem(currentConfigDoc.toPlainObject())
            if (!__currentConfig.envelope.config.isValid) {
                throw new Error(`Current config is invalid. ${__currentConfig.envelope.config.issuesString}`)
            }
        }
        const pendingConfigDoc = await ConfigEnvelopeModel.findOne({status: {$in: [ConfigStatus.PENDING, ConfigStatus.VOTING]}}).exec()
        if (pendingConfigDoc) {
            __pendingConfig = new ConfigItem(pendingConfigDoc.toPlainObject())
            if (!__pendingConfig.envelope.config.isValid) {
                throw new Error(`Pending config is invalid. ${__pendingConfig.envelope.config.issuesString}`)
            }
        }
        if (!__currentConfig && (!defaultNodes || defaultNodes.length < 1))
            throw new Error('Default nodes are not defined')
        __defaultNodes = defaultNodes
        processPendingConfig(this)
    }

    /**
     * @param {boolean} onlyPublicFields - Flag to return only public fields
     * @returns {{currentConfig: {config: ConfigEnvelopeDto, hash: string}, pendingConfig: {config: ConfigEnvelopeDto, hash: string}}} - The current configs
     */
    getCurrentConfigs(onlyPublicFields) {
        return {
            currentConfig: getConfigForClient(__currentConfig, onlyPublicFields),
            pendingConfig: getConfigForClient(__pendingConfig, onlyPublicFields)
        }
    }
    /**
     * @param {{ status: string, initiator: string, page: number, pageSize: number }} filter - The filter
     * @param {boolean} onlyPublicFields - Flag to return only public fields
     * @returns {Promise<ConfigEnvelopeDto[]>}
     */
    async history(filter, onlyPublicFields) {
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
    }
    /**
     *
     * @param {any} rawConfigEnvelope
     * @returns {Promise<any>}
     */
    async create(rawConfigEnvelope) {
        if (!rawConfigEnvelope)
            throw new ValidationError('Config is not defined')

        if (!rawConfigEnvelope.signatures || rawConfigEnvelope.signatures.length !== 1)
            throw new ValidationError('Invalid signatures object')

        const configItem = new ConfigItem(rawConfigEnvelope)
        const {config} = configItem.envelope
        if (!config.isValid)
            throw new ValidationError(`Invalid config. ${config.issuesString}`)

        const {pubkey, signature, nonce, rejected} = configItem.envelope.signatures[0]
        if (!config.nodes.has(pubkey))
            throw new ValidationError('Signature pubkey doesn\'t exist in config nodes')
        if (!verifySignature(pubkey, signature, config.getSignaturePayloadHash(pubkey, nonce, rejected)))
            throw new ValidationError('Invalid signature')

        const {configToModify, signatureIndex} = getConfigToModify(configItem) || {}
        if (configToModify) {
            const resultConfig = await updateConfig(
                configToModify,
                signatureIndex,
                rawConfigEnvelope.signatures[0],
                true,
                this.allNodePubkeys().length,
                !__currentConfig
            )
            updateItems(this.allNodePubkeys())
            notificationProvider.notify({type: 'config-updated', data: cleanupConfig(resultConfig.toPlainObject())})
            return
        }

        //no configToModify, create new config
        if (config.expirationDate < Date.now() + minExpirationDatePeriod)
            throw new ValidationError('Pending config already expired')
        if (config.expirationDate <= config.minDate)
            throw new ValidationError('Config min date cannot be less than expiration date')
        if (__currentConfig && buildUpdates(1n, __currentConfig.envelope.config, config).size === 0)
            throw new ValidationError('Config doesn\'t have any changes')
        if (rejected)
            throw new ValidationError('Rejected signature cannot be used to create config')

        __pendingConfig = await createConfig(configItem, this.allNodePubkeys().length, !__currentConfig)

        updateItems(this.allNodePubkeys())
        notificationProvider.notify({type: 'config-created', data: cleanupConfig(configItem.toPlainObject())}, ChannelTypes.ANON)

    }
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {Node}
     */
    getNode(pubkey) {
        if (__currentConfig)
            return __currentConfig?.envelope.config.nodes.get(pubkey)
        return __defaultNodes.find(n => n === pubkey)
    }
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {boolean}
     */
    hasNode(pubkey) {
        const node = this.getNode(pubkey)
        return !!node
    }
    /**
     * Returns all nodes pubkeys
     * @returns {string[]} - The node pubkeys
     */
    allNodePubkeys() {
        if (__currentConfig)
            return [...__currentConfig.envelope.config.nodes.keys()]
        return __defaultNodes
    }
    notifyNodeAboutUpdate(pubkey) {
        notifyNodeAboutUpdate(pubkey)
    }
}

function getConfigMessage() {
    return {
        type: MessageTypes.CONFIG,
        data: {
            currentConfig: __currentConfig?.envelope.toPlainObject(),
            pendingConfig: __pendingConfig?.envelope.toPlainObject()
        }
    }
}

async function notifyNodesAboutConfig() {
    try {
        await notificationProvider.notify(getConfigMessage(), ChannelTypes.INCOMING)
    } catch (error) {
        logger.error('Error while notifying nodes about config')
        logger.error(error)
    }
}

async function notifyNodeAboutUpdate(pubkey) {
    try {
        await notificationProvider.notifyNode(getConfigMessage(), pubkey)
    } catch (error) {
        logger.error(`Error while notifying node ${pubkey} about config update`)
        logger.error(error)
    }
}

/**
 * @param {string[]} allNodePubkeys
 */
async function updateItems(allNodePubkeys) {
    switch (__pendingConfig?.status) {
        case ConfigStatus.REJECTED:
            __pendingConfig = null
            break
        case ConfigStatus.APPLIED:
            //close all connections for removed nodes
            getRemovedNodes(allNodePubkeys).forEach(pubkey => {
                container.connectionManager.removeByPubkey(pubkey)
                container.statisticsManager.removePubkeys([pubkey])
            })
            __currentConfig = __pendingConfig
            __pendingConfig = null
            break
        case ConfigStatus.PENDING:
            break
        default:
            return
    }
    await notifyNodesAboutConfig()
}

function getRemovedNodes(currentNodePubkeys) {
    if (!currentNodePubkeys)
        return []
    const removedNodes = []
    for (const nodePubkey of currentNodePubkeys) {
        if (!__pendingConfig.envelope.config.nodes.has(nodePubkey))
            removedNodes.push(nodePubkey)
    }
    return removedNodes
}

/**
 * @param {ConfigManager} configManager
 */
async function processPendingConfig(configManager) {
    let timeout = 5000
    try {
        const now = Date.now()
        if (!__pendingConfig)
            return
        switch (__pendingConfig.status) {
            case ConfigStatus.VOTING:
                {
                    if (__pendingConfig.expirationDate < now) {
                        //reject expired voting updates
                        await ConfigEnvelopeModel.findOneAndUpdate(
                            {_id: __pendingConfig.id},
                            {status: ConfigStatus.REJECTED},
                            {new: true}
                        ).exec()
                        __pendingConfig.status = ConfigStatus.REJECTED
                    }
                }
                break
            case ConfigStatus.PENDING: //try to apply expired pending updates
                if (__pendingConfig.envelope.timestamp > now) {
                    timeout = __pendingConfig.envelope.timestamp - now
                    return
                }
                if (__pendingConfig.txHash) { //if now txHash, than tx is not required for update, so just change status
                    const txResponse = await getUpdateTx(__pendingConfig.txHash, __currentConfig.envelope.config.network)
                    if (txResponse?.status !== 'SUCCESS')
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
                return
            }
        }
        updateItems(configManager.allNodePubkeys())
        notificationProvider.notify({type: 'update', data: cleanupConfig(__currentConfig.toPlainObject())}, ChannelTypes.ANON)
    } catch (error) {
        logger.error(error)
    } finally {
        setTimeout(() => processPendingConfig(configManager), timeout)
    }
}

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
    const txHash = __currentConfig ? (await getUpdateTxHash(__currentConfig.envelope.config, configItem.envelope.config, timestamp)) : null
    return {timestamp, txHash}
}

/**
 * @param {ConfigItem} configItem
 * @param {Number} signatureIndex
 * @param {Signature} signature
 * @param {Number} nodesCount
 * @param {boolean} isInitConfig
 */
async function updateConfig(configItem, signatureIndex, signature, nodesCount, isInitConfig) {
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
    const currentStatus = computeUpdateStatus(signatures, nodesCount, isInitConfig)
    if (configItem.status !== currentStatus) {
        update.$set = update.$set || {}
        update.$set.status = currentStatus
        if (currentStatus === ConfigStatus.PENDING) {
            const {timestamp, txHash} = await getPendingConfigData(configItem)
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
 * @param {Number} nodesCount
 * @param {boolean} isInitConfig
 */
async function createConfig(configItem, nodesCount, isInitConfig) {
    //compute status and add to update if changed
    const currentStatus = computeUpdateStatus(configItem.envelope.signatures, nodesCount, isInitConfig)
    configItem.status = currentStatus
    if (currentStatus === ConfigStatus.PENDING) {
        const {timestamp, txHash} = await getPendingConfigData(configItem)
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
    for (const [, node] of Object.entries(config.config.nodes)) {
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
    if (onlyPublicFields)
        cleanupConfig(config)
    return {
        config,
        hash: configItem?.envelope.config.getHash()
    }
}

module.exports = ConfigManager