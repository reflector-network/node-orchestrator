const {Horizon, Account} = require('stellar-sdk')
const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const container = require('./container')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

/**
 *
 * @param {Config} currentConfig
 * @param {Config} newConfig
 * @param {number} timestamp
 * @returns {string|null}
 */
async function getUpdateTxHash(currentConfig, newConfig, timestamp) {
    const {network, systemAccount} = currentConfig
    const {url, passphrase} = container.appConfig.getNetworkConfig(network)
    const accountResponse = await (new Horizon.Server(url)).loadAccount(systemAccount)
    const account = new Account(systemAccount, accountResponse.sequence)
    const tx = await buildUpdateTransaction({
        network: passphrase,
        horizonUrl: url,
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
        const txResponse = await (new Horizon.Server(container.appConfig.horizonUrl))
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