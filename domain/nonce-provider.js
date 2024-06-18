const NonceModel = require('../persistence-layer/models/nonce')

const cache = {}

const nonceProvider = {
    /**
     * @param {string} pubkey - The public key of the node
     * @param {string} oracleId - The oracle ID
     * @returns {Promise<number>}
     */
    get: async (pubkey) => {
        //Check cache first
        if (cache[pubkey] > 0)
            return cache[pubkey]

        const nonce = (await NonceModel.findOne({pubkey}).exec())?.toPlainObject()?.nonce || 0
        cache[pubkey] = nonce

        return nonce
    },
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

        cache[pubkey] = nonce
    }
}

module.exports = nonceProvider