const NonceModel = require('../persistence-layer/models/nonce')

const requestNonceCache = new Map()
const signatureNonceCache = new Map()

/**
 * @param {string} pubkey - The public key of the node
 * @param {'nonce'|'signatureNonce'} field - stored field to read
 * @param {Map<string, number>} cache - cache for that field
 * @returns {Promise<number>}
 */
async function readNonce(pubkey, field, cache) {
    if (cache.has(pubkey))
        return cache.get(pubkey)
    const value = (await NonceModel.findOne({pubkey}).exec())?.toPlainObject()?.[field] || 0
    cache.set(pubkey, value)
    return value
}

//the index tryConsume depends on, as the schema declares it on persistence-layer/models/nonce.js
const pubkeyIndexName = 'pubkey_1'

//server codes for an existing index that clashes with the requested one in name or options
const indexConflictCodes = new Set([85, 86])
const indexConflictNames = new Set(['IndexOptionsConflict', 'IndexKeySpecsConflict'])

/**
 * @param {object} index - index as the driver lists it: name, key and options such as unique and sparse
 * @returns {string} name, key and the options that matter to the replay guard
 */
function describeIndex(index) {
    const options = [index.unique ? 'unique' : 'not unique']
    if (index.sparse)
        options.push('sparse')
    if (index.partialFilterExpression)
        options.push('partial')
    return `'${index.name}' on ${JSON.stringify(index.key)} (${options.join(', ')})`
}

/**
 * The refusal for an index on `pubkey` that stops the schema index from being built. It names what was found and says
 * what to do, since the only fix is an operator dropping it; boot never drops an index itself.
 * @param {string} collectionName - collection name
 * @param {Error} cause - the createIndex error
 * @returns {Promise<Error>}
 */
async function conflictError(collectionName, cause) {
    let found = []
    try {
        //a clash is either the same key under another name or options, or another index holding the name
        found = (await NonceModel.collection.indexes()).filter(index => index.name === pubkeyIndexName
            || (index.key && Object.keys(index.key).length === 1 && 'pubkey' in index.key))
    } catch (e) {
        //the listing is only for the message; the refusal stands without it
    }
    const existing = found.length ? found.map(describeIndex).join(', ') : 'an index on \'pubkey\''
    return new Error(`Replay protection is unavailable: collection '${collectionName}' already has ${existing}, which `
        + `conflicts with the schema index '${pubkeyIndexName}' (unique, non-sparse). Drop it so the orchestrator can `
        + `build '${pubkeyIndexName}', then start it again. Nothing was dropped. (${cause.message})`)
}

/**
 * Build the indexes the schema declares before the check reads them. On an empty database the collection does not exist
 * yet and Mongoose's autoIndex builds `pubkey_1` in the background after the model compiles, so reading the index list
 * straight after connect() found nothing and a first deployment could never start. Model.init() creates the collection
 * and builds the schema indexes, and is awaited first so the explicit build never races the automatic one;
 * createIndexes() repeats the build for a connection with autoIndex turned off. Building an index that already exists
 * with the same name and options is a no-op; one that conflicts in name or options fails, and boot refuses.
 * syncIndexes() is not used because it drops indexes the schema does not declare. Nothing is ever dropped or deleted:
 * duplicates and conflicting indexes refuse the start instead.
 * @returns {Promise<void>}
 */
async function buildPubkeyIndex() {
    const {collectionName} = NonceModel.collection
    try {
        await NonceModel.init()
        await NonceModel.createIndexes()
    } catch (e) {
        if (e.code === 11000 || e.codeName === 'DuplicateKey')
            throw new Error(`Replay protection is unavailable: collection '${collectionName}' holds more than one `
                + `document for the same pubkey, so the unique index '${pubkeyIndexName}' cannot be built. Remove the `
                + 'duplicates, keeping one document per pubkey, then start the orchestrator again. Nothing was deleted.')
        if (indexConflictCodes.has(e.code) || indexConflictNames.has(e.codeName))
            throw await conflictError(collectionName, e)
        throw new Error(`Replay protection is unavailable: building the unique index '${pubkeyIndexName}' on collection `
            + `'${collectionName}' failed: ${e.message}`)
    }
}

/**
 * Confirm the collection carries the unique index on `pubkey`. tryConsume is atomic only because a filter that matches
 * nothing falls through to an insert that the unique index rejects; the index is
 * part of the guard, and a missing index refuses the start rather than being logged.
 * @returns {Promise<void>}
 */
async function assertPubkeyIndex() {
    await buildPubkeyIndex()
    const {collectionName} = NonceModel.collection
    const indexes = await NonceModel.collection.indexes()
    //only an index whose sole key is `pubkey` rejects a second document for the same node: a compound unique index
    //would happily admit one document per distinct nonce
    const found = indexes.some(index => index.unique && index.key
        && Object.keys(index.key).length === 1 && index.key.pubkey === 1)
    if (!found)
        throw new Error(`Replay protection is unavailable: collection '${collectionName}' has no unique index `
            + `'${pubkeyIndexName}' on 'pubkey'. Build it before starting the orchestrator.`)
}

const nonceProvider = {
    /**
     * Build, then verify, the invariant the replay guard rests on before the service accepts a single request
     * @returns {Promise<void>}
     */
    init: assertPubkeyIndex,
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {Promise<number>} last consumed request nonce
     */
    get: (pubkey) => readNonce(pubkey, 'nonce', requestNonceCache),
    /**
     * Consume a request nonce atomically. The conditional filter plus the unique index on `pubkey` means two copies of
     * the same signed request cannot both pass the check.
     * @param {string} pubkey - The public key of the node
     * @param {number} nonce - The nonce presented by the request
     * @returns {Promise<boolean>} true when this call consumed the nonce
     */
    tryConsume: async (pubkey, nonce) => {
        try {
            await NonceModel.findOneAndUpdate(
                {pubkey, nonce: {$lt: nonce}},
                {$set: {nonce}},
                {upsert: true}
            ).exec()
            requestNonceCache.set(pubkey, nonce)
            return true
        } catch (e) {
            if (e.code === 11000 || e.codeName === 'DuplicateKey')
                return false //a concurrent request, or an already stored higher nonce, won the race
            throw e
        }
    },
    /**
     * @param {string} pubkey - The public key of the signer
     * @returns {Promise<number>} last consumed envelope-signature nonce
     */
    getSignatureNonce: (pubkey) => readNonce(pubkey, 'signatureNonce', signatureNonceCache),
    /**
     * @param {string} pubkey - The public key of the signer
     * @param {number} nonce - The nonce carried by the envelope signature
     * @returns {Promise<void>}
     */
    updateSignatureNonce: async (pubkey, nonce) => {
        await NonceModel.findOneAndUpdate(
            {pubkey},
            {$set: {signatureNonce: nonce}, $setOnInsert: {nonce: 0}},
            {upsert: true}
        ).exec()
        signatureNonceCache.set(pubkey, nonce)
    }
}

module.exports = nonceProvider
