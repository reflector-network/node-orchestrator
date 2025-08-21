/*eslint-disable class-methods-use-this */
const {
    ConfigEnvelope,
    buildUpdates,
    verifySignature,
    ValidationError,
    sortObjectKeys,
    isTimestampValid,
    normalizeTimestamp,
    UpdateType,
    areAllSignaturesPresent,
    ContractTypes
} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')
const ConfigEnvelopeModel = require('../persistence-layer/models/contract-config')
const MessageTypes = require('../server/ws/handlers/message-types')
const ChannelTypes = require('../server/ws/channel-types')
const logger = require('../logger')
const {getUpdateTx, getAccountSequence} = require('../utils/rpc-helper')
const ConfigStatus = require('./config-status')
const {computeUpdateStatus} = require('./utils')
const notificationProvider = require('./notification-provider')
const container = require('./container')
const {setManagers} = require('./subscription-data-provider')
const {getUpdateTxHash} = require('./blockchain-data-provider')

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

function setCurrentConfig(config) {
    __currentConfig = config
    const contracts = [...config.envelope.config.contracts.values()]
        .filter(c => c.type === ContractTypes.SUBSCRIPTIONS)
        .map(c => c.contractId)
    setManagers( //set managers for subscription data provider
        contracts,
        __currentConfig.envelope.config.network
    )
}

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
     * @param {any} rawEnvelope - The raw config envelope
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
        this.isBlockchainUpdate = rawEnvelope.isBlockchainUpdate
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

    /**
     * @type {boolean}
     */
    isBlockchainUpdate = null

    /**
     * @type {boolean}
     */
    hasMoreTxns = false

    toPlainObject() {
        return sortObjectKeys({
            ...this.envelope.toPlainObject(),
            id: this.id,
            initiator: this.envelope.signatures[0].pubkey,
            description: this.description,
            expirationDate: this.expirationDate,
            status: this.status,
            txHash: this.txHash,
            isBlockchainUpdate: this.isBlockchainUpdate
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
            setCurrentConfig(new ConfigItem(currentConfigDoc.toPlainObject()))
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
        processPendingConfig(this, normalizeTimestamp(Date.now(), updateIdleTimeframe))
    }

    /**
     * @param {boolean} onlyPublicFields - Flag to return only public fields
     * @returns {{currentConfig: {config: ConfigEnvelopeDto, hash: string}, pendingConfig: {config: ConfigEnvelopeDto, hash: string}}|{any}} - The current configs
     */
    getCurrentConfigs(onlyPublicFields) {
        if (onlyPublicFields)
            return cleanupConfig(__currentConfig?.toPlainObject())?.config
        return {
            currentConfig: getConfigForClient(__currentConfig),
            pendingConfig: getConfigForClient(__pendingConfig)
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
     * @param {any} rawConfigEnvelope - The raw config envelope
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
                this.allNodePubkeys().length,
                !__currentConfig
            )
            updateItems(this.allNodePubkeys())
            notificationProvider.notify({type: 'config-updated', data: cleanupConfig(resultConfig.toPlainObject())}, ChannelTypes.ANON)
            return
        }

        //no configToModify, create new config
        if (!configItem.expirationDate)
            throw new ValidationError('Expiration date is not defined')
        if (configItem.expirationDate < Date.now() + minExpirationDatePeriod)
            throw new ValidationError('Pending config already expired')
        if (configItem.expirationDate <= config.minDate)
            throw new ValidationError('Config min date cannot be less than expiration date')
        if (config.minDate && !isTimestampValid(config.minDate, 1000))
            throw new ValidationError('Config min date is not valid. It should be rounded to seconds')
        if (configItem.envelope.timestamp && configItem.envelope.timestamp < config.minDate)
            throw new ValidationError('Config timestamp cannot be less than min date')
        if (configItem.envelope.timestamp && configItem.envelope.timestamp > configItem.expirationDate)
            throw new ValidationError('Config timestamp cannot be greater than expiration date')
        if (configItem.envelope.timestamp && !isTimestampValid(configItem.envelope.timestamp, 1000))
            throw new ValidationError('Config timestamp is not valid. It should be rounded to seconds')
        let isBlockchainUpdate = false
        if (__currentConfig) {
            const updates = buildUpdates(1n, __currentConfig.envelope.config, config)
            if (updates.size === 0)
                throw new ValidationError('Config doesn\'t have any changes')
            for (const update of [...updates.values()].filter(u => u)) {
                if (update.type === UpdateType.NODES) {
                    const newNodes = [...update.newNodes.keys()]
                    const currentNodes = [...update.currentNodes.keys()]
                    if (newNodes.length === currentNodes.length && newNodes.every(n => currentNodes.includes(n)))
                        continue
                }
                isBlockchainUpdate = true
            }
        }
        if (rejected)
            throw new ValidationError('Rejected signature cannot be used to create config')

        __pendingConfig = await createConfig(configItem, this.allNodePubkeys().length, !__currentConfig, isBlockchainUpdate)

        updateItems(this.allNodePubkeys())
        notificationProvider.notify({type: 'config-created', data: cleanupConfig(configItem.toPlainObject())}, ChannelTypes.ANON)

    }
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {boolean}
     */
    hasNode(pubkey) {
        return this.allNodePubkeys().includes(pubkey)
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
    getConfigMessage() {
        return getConfigMessage()
    }
    get currentConfig() {
        return __currentConfig?.envelope?.config
    }
}

function getConfigMessage() {
    return {
        type: MessageTypes.CONFIG,
        data: {
            currentConfig: __currentConfig?.envelope.toPlainObject(),
            pendingConfig: __pendingConfig && __pendingConfig.status !== ConfigStatus.PENDING
                ? undefined
                : __pendingConfig?.envelope.toPlainObject()
        }
    }
}

async function notifyNodesAboutConfig() {
    try {
        await notificationProvider.notify(getConfigMessage(), ChannelTypes.INCOMING)
    } catch (err) {
        logger.error({err}, 'Error while notifying nodes about config')
    }
}

async function notifyNodeAboutUpdate(pubkey) {
    try {
        await notificationProvider.notifyNode(getConfigMessage(), pubkey)
    } catch (err) {
        logger.error({err}, `Error while notifying node ${pubkey} about config update`)
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
            })
            setCurrentConfig(__pendingConfig)
            __pendingConfig = null
            break
        case ConfigStatus.PENDING:
            break
        default:
            break
    }
    //wait one second before notifying nodes about config. Otherwise, some nodes may clear pending config before they processed it
    await new Promise(resolve => setTimeout(resolve, 1000))
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

const updateIdleTimeframe = 1000 * 60 * 2 //2 minutes

function isPendingConfigExpired() {
    return __pendingConfig.envelope.timestamp < Date.now()
}

function getNextSyncTimestamp(timestamp) {
    if (!__pendingConfig || __pendingConfig.envelope.allowEarlySubmission || isPendingConfigExpired())
        return normalizeTimestamp(timestamp + updateIdleTimeframe, updateIdleTimeframe)
    return __pendingConfig.envelope.timestamp
}

/**
 * @param {ConfigManager} configManager
 * @param {number} syncTimestamp
 */
async function processPendingConfig(configManager, syncTimestamp) {
    let timeout = 5000
    try {
        if (!__pendingConfig)
            return
        switch (__pendingConfig.status) {
            case ConfigStatus.VOTING:
                {
                    if (__pendingConfig.expirationDate < Date.now()) {
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
                {
                    const updateTimeReached = __pendingConfig.envelope.timestamp < syncTimestamp
                    if (!(updateTimeReached || __pendingConfig.envelope.allowEarlySubmission))
                        return

                    if (!updateTimeReached) { //if update time is not reached, check if all signatures are present
                        if (!areAllSignaturesPresent(
                            [...__currentConfig.envelope.config.nodes.keys()],
                            [...__pendingConfig.envelope.config.nodes.keys()],
                            __pendingConfig.envelope.signatures)
                        )
                            return
                    }

                    if (__pendingConfig.envelope.timestamp > Date.now() && !__pendingConfig.envelope.allowEarlySubmission) {
                        syncTimestamp = __pendingConfig.envelope.timestamp
                        timeout = __pendingConfig.envelope.timestamp - Date.now()
                        return
                    }

                    if (__pendingConfig.isBlockchainUpdate) { //if now txHash, than tx is not required for update, so just change status
                        await waitForSuccessfulUpdate(__pendingConfig, __currentConfig, syncTimestamp)
                        if (__pendingConfig.hasMoreTxns) { //if update failed, or there are more txns to be processed
                            return //wait for next sync
                        }
                    }
                    if (__currentConfig) {
                        const session = await mongoose.startSession()
                        session.startTransaction()
                        try {
                            await ConfigEnvelopeModel.findByIdAndUpdate({_id: __currentConfig.id}, {status: ConfigStatus.REPLACED}).exec()
                            await ConfigEnvelopeModel.findByIdAndUpdate(
                                {_id: __pendingConfig.id},
                                {status: ConfigStatus.APPLIED, txHash: __pendingConfig.txHash}
                            ).exec()
                            await session.commitTransaction()
                            __pendingConfig.status = ConfigStatus.APPLIED
                        } catch (error) {
                            await session.abortTransaction()
                            throw error
                        } finally {
                            await session.endSession()
                        }
                    }
                }
                break
            default: {
                return
            }
        }
        updateItems(configManager.allNodePubkeys())
        if (__currentConfig)
            notificationProvider.notify({type: 'update', data: cleanupConfig(__currentConfig.toPlainObject())}, ChannelTypes.ANON)
    } catch (err) {
        logger.error({err}, 'Error while processing pending config')
    } finally {
        if (!__pendingConfig || __pendingConfig.status === ConfigStatus.VOTING) {
            timeout = 5000
            syncTimestamp = normalizeTimestamp(Date.now() + timeout, updateIdleTimeframe)
        } else {
            syncTimestamp = getNextSyncTimestamp(syncTimestamp)
            timeout = syncTimestamp - Date.now()
        }
        setTimeout(() => processPendingConfig(configManager, syncTimestamp), timeout)
    }
}

async function waitForSuccessfulUpdate(__pendingConfig, __currentConfig, syncTimestamp) {
    //Attempt to get transaction response directly by hash
    if (__pendingConfig.txHash && !__pendingConfig.hasMoreTxns) {
        const hashes = __pendingConfig.txHash.split(',')
        for (const hash of hashes) {
            const txResponse = await getUpdateTx(__pendingConfig.txHash, __currentConfig.envelope.config.network)
            if (txResponse?.status !== 'SUCCESS') {
                throw new Error(`Failed to get transaction response by hash: ${hash}. Status: ${txResponse?.status}`)
            }
        }
        return
    }

    //Transaction hash not found, generate and poll
    const accountSequence = await getAccountSequence(__currentConfig.envelope.config)

    for (let i = 0; i < 3; i++) {
        const {hash, maxTime, hasMoreTxns} = await getUpdateTxHash(
            __currentConfig.envelope.config,
            __pendingConfig.envelope.config,
            accountSequence,
            __pendingConfig.envelope.timestamp,
            syncTimestamp,
            i
        ) || {}

        if (!hash) { //if no hash and no error, than no changes to apply
            __pendingConfig.hasMoreTxns = false
            return //No changes to apply
        }

        __pendingConfig.hasMoreTxns = hasMoreTxns

        if (await pollForTransactionSuccess(hash, maxTime, __currentConfig.envelope.config.network)) {
            logger.info(`Success update. Tx hash: ${hash}, hasMoreTxns: ${hasMoreTxns}`)
            __pendingConfig.txHash = [(__pendingConfig.txHash || ''), hash].join(',').replace(/(^,)|(,$)/g, '')
            return
        }
    }

    throw new Error('Failed to get successful update')
}

async function pollForTransactionSuccess(hash, maxTime, network) {
    while (maxTime + 1 >= Date.now() / 1000) {
        const txResponse = await getUpdateTx(hash, network)
        if (txResponse?.status === 'SUCCESS') {
            return true
        } else if (txResponse?.status === 'FAILED') {
            throw new Error(`Failed to get successful update. Tx failed. Hash: ${hash}.`)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
    }
    return false
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
    if (configItem.status !== ConfigStatus.APPLIED) { //only update status if config is not applied
        //compute status and add to update if changed
        const currentStatus = computeUpdateStatus(signatures, nodesCount, isInitConfig)
        if (configItem.status !== currentStatus) {
            update.$set = update.$set || {}
            update.$set.status = currentStatus
            if (currentStatus === ConfigStatus.PENDING) {
                //get timestamp for pending config
                update.$set.timestamp = getTimestamp(configItem.envelope.timestamp, configItem.envelope.config.minDate)
            }
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

    return configItem
}

function getTimestamp(timestamp, minDate) {
    if (timestamp)
        return timestamp
    minDate = normalizeTimestamp(Math.max(minDate || Date.now()), updateIdleTimeframe)
    return minDate + 1000 * 60 * 3 //10 minutes
}

/**
 * @param {ConfigItem} configItem - The config item to create
 * @param {Number} nodesCount - The total nodes count
 * @param {boolean} isInitConfig - Flag to indicate if the config is initial
 * @param {boolean} isBlockchainUpdate - Flag to indicate if the config is blockchain update
 * @returns {Promise<ConfigItem>}
 */
async function createConfig(configItem, nodesCount, isInitConfig, isBlockchainUpdate) {
    //compute status and add to update if changed
    const currentStatus = computeUpdateStatus(configItem.envelope.signatures, nodesCount, isInitConfig)
    configItem.status = currentStatus
    configItem.isBlockchainUpdate = isBlockchainUpdate
    if (currentStatus === ConfigStatus.PENDING) {
        configItem.envelope.timestamp = getTimestamp(configItem.envelope.timestamp, configItem.envelope.config.minDate)
    }
    const rawConfig = configItem.toPlainObject()
    const configDoc = new ConfigEnvelopeModel(rawConfig)
    await configDoc.save()
    configItem.id = configDoc.id
    return configItem
}

function cleanupConfig(config) {
    if (!config)
        return null
    config = new ConfigEnvelope(config).toPlainObject(false)
    for (const [, node] of Object.entries(config.config.nodes)) {
        delete node.url
    }
    if (config.config.clusterSecret)
        delete config.config.clusterSecret
    return config
}

/**
 * @param {ConfigItem} configItem
 * @returns {{config: ConfigEnvelopeDto, hash: string}}
 */
function getConfigForClient(configItem) {
    const config = configItem?.toPlainObject()
    if (!config)
        return null
    return {
        config,
        hash: configItem?.envelope.config.getHash()
    }
}

module.exports = ConfigManager