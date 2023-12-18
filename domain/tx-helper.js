const {Horizon, Account} = require('stellar-sdk')
const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const appConfig = require('./app-config')

/**
 *
 * @param {Config} currentConfig
 * @param {Config} newConfig
 * @param {number} timestamp
 * @returns {string|null}
 */
async function getUpdateTxHash(currentConfig, newConfig, timestamp) {
    const {network, systemAccount} = currentConfig
    const accountResponse = await (new Horizon.Server(appConfig.horizonUrl)).loadAccount(systemAccount)
    const account = new Account(systemAccount, accountResponse.sequence)
    const tx = await buildUpdateTransaction({
        network,
        horizonUrl: appConfig.horizonUrl,
        currentConfig,
        newConfig,
        account,
        timestamp
    })
    if (!tx)
        return null
    return tx.hashHex
}

async function getUpdateTx(txHash) {
    try {
        const txResponse = await (new Horizon.Server(appConfig.horizonUrl))
            .transactions()
            .transaction(txHash)
            .call()
        return txResponse
    } catch (err) {
        if (err.response?.status === 404)
            console.error(`Transaction ${txHash} not found`)
        return null
    }
}

module.exports = {getUpdateTxHash, getUpdateTx}