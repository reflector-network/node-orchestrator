import { Config, Node, buildUpdates, verifySignature, getHash, ValidationError, getDataHash } from '@reflector/reflector-shared'
import ConfigEnvelopeModel from '../persistence-layer/models/contract-config.js'
import ConfigStatus from './config-status.js'
import { computeUpdateStatus } from './utils.js'
import notificationProvider from './notification-provider.js'

/**
 * @typedef {import('./types.js').ConfigEnvelope} ConfigEnvelope
 * @typedef {import('./types.js').Signature} Signature
 */

const minExpirationDatePeriod = 1000 * 60 * 60 * 24 * 7 //7 days

//TODO: add processing of expired updates if it's not applied
const processExpiredUpdates = async () => {
    try {
        const now = Date.now()
        if (!__pendingConfig)
            return
        if (__pendingConfig.expirationDate < now) {
            switch (__pendingConfig.status) {
                case ConfigStatus.VOTING: //reject expired voting updates
                    __pendingConfig.status = ConfigStatus.REJECTED
                    break
                default:
                    console.error('Unexpected status:', __pendingConfig.status)
            }
            const rejected = await ConfigEnvelopeModel.findOneAndUpdate(
                { _id: __pendingConfig.id },
                { status: __pendingConfig.status },
                { new: true }
            ).exec()
            notificationProvider.notify({ type: 'update', data: rejected.toPlainObject() })
        }
    } catch (error) {
        console.error(error)
    } finally {
        setTimeout(processExpiredUpdates, 5000)
    }
}

const privateItems = ['signatures', 'status', 'id', 'timestamp', 'initiator', 'createdAt', 'updatedAt']

function getCleanConfig(config) {
    let cleanConfig = structuredClone(config)
    privateItems.forEach(p => delete cleanConfig[p])
    return cleanConfig
}

function getConfigHash(config) {
    const hashData = getCleanConfig(config)
    return getDataHash(hashData)
}

class ConfigItem {
    /**
     * @param {ConfigEnvelope} envelope
     */
    constructor(envelope) {
        this.envelope = envelope
        this.hash = getConfigHash(envelope)
    }

    /**
     * @type {ConfigEnvelope} config
     */
    envelope = null

    /**
     * @type {string}
     */
    hash = null
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
 * @returns {{configToModify: ConfigEnvelope, signatureIndex: number}}
 */
function getConfigToModify(configItem) {
    const { envelope } = configItem
    const signature = envelope.signatures[0]
    let configEnvelope = null
    if (__currentConfig && __currentConfig.hash === configItem.hash) {
        if (signature.rejected)
            throw new ValidationError('Rejected signature cannot be used to modify config in status ' + __currentConfig.envelope.status)
        configEnvelope = __currentConfig.envelope
    } else if (__pendingConfig) {
        if (__pendingConfig.hash !== configItem.hash)
            throw new ValidationError('Pending config already exists')
        if (__pendingConfig.envelope.expirationDate < Date.now())
            throw new ValidationError('Pending config already expired')
        configEnvelope = __pendingConfig.envelope
    } else
        return null

    const signatureIndex = configEnvelope.signatures.findIndex(s => s.pubkey === signature.pubkey)
    if (signatureIndex >= 0 && ![ConfigStatus.VOTING, ConfigStatus.APPLIED].includes(configEnvelope.status))
        throw new ValidationError('Signature cannot be modified for this config in status ' + configEnvelope.status)
    return { configToModify: configEnvelope, signatureIndex }
}

/**
 * @param {ConfigEnvelope} config 
 * @param {Number} signatureIndex 
 * @param {Signature} signature 
 */
async function updateConfig(config, signatureIndex, signature) {
    let signatures = [...config.signatures]
    let update = null
    //prepare signatures update, and modify signatures collection
    if (signatureIndex >= 0) {
        update = { $set: { [`config.signatures.${signatureIndex}`]: signature } }
        signatures[signatureIndex] = signature
    } else {
        update = { $push: { signatures: signature } }
        signatures.push(signature)
    }
    //compute status and add to update if changed
    const currentStatus = computeUpdateStatus(signatures, configProvider.allNodes().length)
    if (config.status !== currentStatus) {
        update['$set'] = update['$set'] || {}
        update['$set'].status = currentStatus
    }
    await ConfigEnvelopeModel.findByIdAndUpdate(
        config.id,
        update,
        { new: true }
    ).exec()

    config.signatures = signatures
    config.status = currentStatus
    if (currentStatus === ConfigStatus.REJECTED) {
        __pendingConfig = null
        notificationProvider.notify({ type: 'config-rejected', data: config })
    } else {
        notificationProvider.notify({ type: 'config-updated', data: config })
    }
}

const configProvider = {
    /**
     * @returns {ConfigEnvelope}
     */
    get currentConfig() {
        return __currentConfig?.envelope
    },
    /**
     * @returns {ConfigEnvelope}
     */
    get pendingConfig() {
        return __pendingConfig?.envelope
    },
    init: async (defaultNodes) => {
        const currentConfigDoc = await ConfigEnvelopeModel.findOne({ status: ConfigStatus.APPLIED }).exec()
        if (currentConfigDoc)
            __currentConfig = new ConfigItem(currentConfigDoc.toPlainObject())
        const pendingConfigDoc = await ConfigEnvelopeModel.findOne({ status: { $in: [ConfigStatus.PENDING, ConfigStatus.VOTING] } }).exec()
        if (pendingConfigDoc)
            __pendingConfig = new ConfigItem(pendingConfigDoc.toPlainObject())
        if (!__currentConfig && (!defaultNodes || defaultNodes.length < 1))
            throw new ValidationError('Default nodes are not defined')
        __defaultNodes = (defaultNodes || []).map(n => new Node(n))
    },
    /**
     * @param {{ status: string, initiator: string, page: number, pageSize: number }} filter - The filter
     * @returns {Promise<ConfigEnvelope[]>}
     */
    history: async (filter) => {
        const query = {}
        if (filter?.status)
            query.status = filter.status
        if (filter?.initiator)
            query['signatures.0.pubkey'] = filter.initiator

        const page = filter?.page || 1
        const pageSize = filter?.pageSize || 10
        const skip = (page > 0 ? page - 1 : page) * pageSize

        const configDocs = await ConfigEnvelopeModel.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).exec()
        return configDocs.map(d => d.toPlainObject())
    },
    /**
     * 
     * @param {ConfigEnvelope} arrivedConfigEnvelope 
     * @returns 
     */
    create: async (arrivedConfigEnvelope) => {
        if (!arrivedConfigEnvelope)
            throw new ValidationError('Config is not defined')

        if (!arrivedConfigEnvelope.signatures || arrivedConfigEnvelope.signatures.length !== 1)
            throw new ValidationError('Invalid signatures object')

        const arrivedConfigItem = new ConfigItem(arrivedConfigEnvelope)

        const arrivedConfig = new Config(arrivedConfigItem.envelope.config)
        if (!arrivedConfig.isValid)
            throw new ValidationError(`Invalid config. ${arrivedConfig.issuesString}`)

        const { pubkey, signature, nonce, rejected } = arrivedConfigEnvelope.signatures[0]
        if (!verifySignature(pubkey, signature, getHash(pubkey, arrivedConfig.toPlainObject(), nonce, rejected)))
            throw new ValidationError('Invalid signature')

        let { configToModify, signatureIndex } = getConfigToModify(arrivedConfigItem) || {}
        if (configToModify) {
            updateConfig(configToModify, signatureIndex, arrivedConfigEnvelope.signatures[0])
            return configToModify
        }
        //no configToModify, create new config
        if (arrivedConfig.expirationDate < Date.now() + minExpirationDatePeriod)
            throw new ValidationError('Pending config already expired')
        if (arrivedConfig.expirationDate <= arrivedConfig.minDate)
            throw new ValidationError('Config min date cannot be less than expiration date')
        if (__currentConfig && buildUpdates(1n, new Config(__currentConfig.envelope.config), arrivedConfig).size === 0)
            throw new ValidationError('Config doesn\'t have any changes')
        if (rejected)
            throw new ValidationError('Rejected signature cannot be used to create config')

        arrivedConfigEnvelope.status = ConfigStatus.VOTING
        let configDoc = new ConfigEnvelopeModel(arrivedConfigEnvelope)
        configDoc = await configDoc.save()
        __pendingConfig = new ConfigItem(configDoc.toPlainObject())
        notificationProvider.notify({ type: 'config-created', data: __pendingConfig.envelope })
        return __pendingConfig.envelope
    },
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {Node}
     */
    getNode: (pubkey) => {
        if (configProvider.currentConfig)
            return configProvider.currentConfig?.config.nodes.find(n => n.pubkey === pubkey)
        return __defaultNodes.find(n => n.pubkey === pubkey)
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
    allNodes: () => {
        if (configProvider.currentConfig)
            return configProvider.currentConfig?.config.nodes
        return __defaultNodes
    }
}

export default configProvider