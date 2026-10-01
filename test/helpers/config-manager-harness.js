/*eslint-disable no-undef */
const path = require('path')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const constants = require('../constants')

const root = path.resolve(__dirname, '..', '..')

const FAR_FUTURE = Date.now() + 1000 * 60 * 60 * 24 * 365

const CONTRACT_ID = 'CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW'

let nonceCounter = Date.now()

/**
 * @param {number} count - node keypairs to return; the first two come from test/constants.js
 * @returns {Keypair[]}
 */
function getNodeKeypairs(count) {
    const keypairs = [...constants.nodeKps]
    while (keypairs.length < count)
        keypairs.push(Keypair.random())
    return keypairs.slice(0, count)
}

/**
 * Deep copy of the fixture config with the given nodes and a cluster secret
 * @param {Keypair[]} nodeKps - node keypairs
 * @returns {object}
 */
function buildConfig(nodeKps) {
    const config = structuredClone(constants.config)
    config.nodes = {}
    nodeKps.forEach((kp, i) => {
        const pubkey = kp.publicKey()
        config.nodes[pubkey] = {pubkey, url: `ws://127.0.0.1:300${i}`, domain: `trusted-node-${i}.com`}
    })
    config.clusterSecret = 'seed-cluster-secret'
    return config
}

/**
 * A proposal that differs from the given config by one contract period
 * @param {object} config - base config
 * @returns {object}
 */
function changedConfig(config) {
    const proposed = structuredClone(config)
    proposed.contracts[CONTRACT_ID].period = 9999999
    return proposed
}

/**
 * Signs a config the way admin-dashboard and nodes do:
 * sha256(`${pubkey}:${JSON.stringify(sortObjectKeys({...config, nonce[, rejected: true]}))}`)
 * @param {object} config - config to sign
 * @param {Keypair} kp - signer
 * @param {{rejected: boolean, timestamp: number, expirationDate: number}} [options] - envelope options
 * @returns {object} raw envelope as POST /config receives it
 */
function getSignedEnvelope(config, kp, {rejected = false, timestamp = 0, expirationDate = FAR_FUTURE} = {}) {
    const pubkey = kp.publicKey()
    const nonce = ++nonceCounter
    const payload = {...config, nonce}
    if (rejected)
        payload.rejected = true
    const messageHash = createHash('sha256').update(`${pubkey}:${JSON.stringify(sortObjectKeys(payload))}`, 'utf8').digest()
    const signature = Buffer.from(kp.sign(messageHash)).toString('hex')
    return {
        config,
        signatures: [{signature, pubkey, nonce, rejected}],
        timestamp,
        expirationDate
    }
}

//seeded signatures are never cryptographically verified, but 7.2.0 requires the 64-byte hex shape
function acceptedSignature(kp) {
    return {pubkey: kp.publicKey(), signature: 'aa'.repeat(64), nonce: 1, rejected: false}
}

function rejectedSignature(kp) {
    return {pubkey: kp.publicKey(), signature: 'aa'.repeat(64), nonce: 1, rejected: true}
}

/**
 * A stored envelope document in the shape ConfigEnvelopeModel.toPlainObject() returns
 * @param {object} fields - document fields
 * @returns {object} plain document
 */
function makeDoc({
    id, config, signatures, status, timestamp = 0, expirationDate = FAR_FUTURE, isBlockchainUpdate = false,
    updatedAt = Date.now(), txHash = null, hasMoreTxns = false
}) {
    return {
        id,
        config,
        signatures,
        initiator: signatures[0].pubkey,
        description: 'seed',
        expirationDate,
        status,
        timestamp,
        txHash,
        hasMoreTxns,
        isBlockchainUpdate,
        allowEarlySubmission: false,
        updatedAt
    }
}

/**
 * Submits an envelope the way `POST /config` does, with the authenticated caller bound to the signer.
 * @param {object} configManager - config manager under test
 * @param {object} envelope - raw envelope from getSignedEnvelope
 * @returns {Promise<void>}
 */
function submit(configManager, envelope) {
    return configManager.create(envelope, envelope.signatures[0].pubkey)
}

function setPath(target, dottedPath, value) {
    const keys = dottedPath.split('.')
    let current = target
    for (const key of keys.slice(0, -1)) {
        if (current[key] === undefined || current[key] === null)
            current[key] = {} //MongoDB creates an object for a missing parent
        current = current[key]
    }
    current[keys[keys.length - 1]] = value
}

function applyUpdate(doc, update) {
    for (const [key, value] of Object.entries(update)) {
        if (key === '$set') {
            for (const [dottedPath, fieldValue] of Object.entries(value))
                setPath(doc, dottedPath, fieldValue)
        } else if (key === '$push') {
            for (const [field, item] of Object.entries(value))
                doc[field].push(item)
        } else {
            setPath(doc, key, value) //mongoose treats top-level fields as $set
        }
    }
}

/**
 * In-memory stand-in for the mongoose ConfigEnvelopeModel, covering the calls config-manager.js makes
 * @param {object[]} seedDocs - documents to start with
 * @returns {object} model mock with findOne/find/findOneAndUpdate/findByIdAndUpdate/__get/__all
 */
function createModelMock(seedDocs = []) {
    const docs = new Map(seedDocs.map(doc => [doc.id, structuredClone(doc)]))
    let counter = 0
    const updates = []
    const wrap = (doc) => ({__doc: doc, toPlainObject: () => structuredClone(doc)})
    const chain = (result) => ({
        exec: () => result,
        sort(order) {
            if (Array.isArray(result) && order) {
                const [field, direction] = Object.entries(order)[0]
                result.sort((left, right) => ((left.__doc[field] || 0) - (right.__doc[field] || 0)) * (direction < 0 ? -1 : 1))
            }
            return this
        },
        skip() {
            return this
        },
        limit() {
            return this
        }
    })
    const matches = (doc, query) => Object.entries(query).every(([key, condition]) => {
        const value = key === '_id' ? doc.id : doc[key]
        if (condition && typeof condition === 'object' && '$in' in condition)
            return condition.$in.includes(value)
        return value === condition
    })
    const findDoc = (query) => [...docs.values()].find(doc => matches(doc, query))
    const idOf = (idOrFilter) => (idOrFilter && typeof idOrFilter === 'object') ? idOrFilter._id : idOrFilter

    function Model(raw) {
        const doc = structuredClone(raw)
        this.save = () => {
            counter++
            doc.id = `doc-${counter}`
            docs.set(doc.id, doc)
            this.id = doc.id
        }
    }
    Model.findOne = (query) => {
        const doc = findDoc(query)
        return chain(doc ? wrap(doc) : null)
    }
    Model.find = (query) => chain([...docs.values()].filter(doc => matches(doc, query)).map(wrap))
    Model.findOneAndUpdate = (query, update) => {
        const doc = findDoc(query)
        if (doc)
            applyUpdate(doc, update)
        return chain(doc ? wrap(doc) : null)
    }
    Model.findByIdAndUpdate = (idOrFilter, update) => {
        const id = idOf(idOrFilter)
        updates.push({id, update: update.$set ? {...update, ...update.$set} : update})
        const doc = docs.get(id)
        if (doc)
            applyUpdate(doc, update)
        return chain(doc ? wrap(doc) : null)
    }
    Model.__get = (id) => docs.get(id)
    Model.__all = () => [...docs.values()]
    Model.__updates = updates
    return Model
}

/**
 * Loads a fresh ConfigManager with every collaborator mocked and fake timers installed, then runs init().
 * @param {{docs: object[], nodeKps: Keypair[]}} options - seed documents and the cluster's node keypairs
 * @returns {Promise<object>} resolves to {configManager, model, notificationProvider, nonceProvider, container, MessageTypes}
 */
async function loadConfigManager({docs = [], nodeKps}) {
    jest.resetModules()
    jest.useFakeTimers()
    const model = createModelMock(docs)
    const notificationProvider = {notify: jest.fn().mockResolvedValue(undefined), notifyNode: jest.fn().mockResolvedValue(undefined)}
    const container = {connectionManager: {removeByPubkey: jest.fn()}, logTokenProvider: {revoke: jest.fn()}}
    const signatureNonces = new Map()
    const nonceProvider = {
        get: jest.fn(() => Promise.resolve(0)),
        update: jest.fn(() => Promise.resolve()),
        tryConsume: jest.fn(() => Promise.resolve(true)),
        getSignatureNonce: jest.fn(pubkey => Promise.resolve(signatureNonces.get(pubkey) || 0)),
        updateSignatureNonce: jest.fn((pubkey, nonce) => {
            signatureNonces.set(pubkey, nonce)
            return Promise.resolve()
        })
    }
    jest.doMock(path.join(root, 'logger.js'), () => ({info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(), trace: jest.fn()}))
    jest.doMock(path.join(root, 'persistence-layer', 'models', 'contract-config.js'), () => model)
    jest.doMock(path.join(root, 'domain', 'container.js'), () => container)
    jest.doMock(path.join(root, 'domain', 'subscription-data-provider.js'), () => ({setManagers: jest.fn()}))
    jest.doMock(path.join(root, 'domain', 'notification-provider.js'), () => notificationProvider)
    jest.doMock(path.join(root, 'domain', 'blockchain-data-provider.js'), () => ({getUpdateTxHash: jest.fn(), maxSubmitAttempts: 1}))
    //a successful lookup by default, so a test that drives the blockchain apply path only has to assert the hashes
    const rpcHelper = {getUpdateTx: jest.fn(() => Promise.resolve({status: 'SUCCESS'})), getAccountSequence: jest.fn()}
    jest.doMock(path.join(root, 'utils', 'rpc-helper.js'), () => rpcHelper)
    jest.doMock(path.join(root, 'domain', 'nonce-provider.js'), () => nonceProvider)
    const ConfigManager = require(path.join(root, 'domain', 'config-manager.js'))
    const MessageTypes = require(path.join(root, 'server', 'ws', 'handlers', 'message-types.js'))
    const configManager = new ConfigManager()
    await configManager.init(nodeKps.map(kp => kp.publicKey()))
    return {configManager, model, notificationProvider, nonceProvider, container, MessageTypes, rpcHelper}
}

module.exports = {
    FAR_FUTURE,
    CONTRACT_ID,
    getNodeKeypairs,
    buildConfig,
    changedConfig,
    getSignedEnvelope,
    acceptedSignature,
    rejectedSignature,
    makeDoc,
    submit,
    loadConfigManager
}
