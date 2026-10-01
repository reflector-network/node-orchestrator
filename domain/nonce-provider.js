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

const nonceProvider = {
    /**
     * @param {string} pubkey - The public key of the node
     * @returns {Promise<number>} last consumed request nonce
     */
    get: (pubkey) => readNonce(pubkey, 'nonce', requestNonceCache),
    /**
     * @param {string} pubkey - The public key of the node
     * @param {number} nonce - The nonce
     * @returns {Promise<void>}
     */
    update: async (pubkey, nonce) => {
        await NonceModel.findOneAndUpdate(
            {pubkey},
            {$set: {nonce}},
            {upsert: true}
        ).exec()
        requestNonceCache.set(pubkey, nonce)
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
