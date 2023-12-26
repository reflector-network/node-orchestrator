const {SorobanRpc, Account} = require('@stellar/stellar-sdk')
const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const logger = require('../logger')
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
    const accountResponse = await (new SorobanRpc.Server(url)).getAccount(systemAccount)
    const account = new Account(systemAccount, accountResponse.sequence.toString())
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

async function getUpdateTx(txHash, network) {
    try {
        const {url} = container.appConfig.getNetworkConfig(network)
        const txResponse = await (new SorobanRpc.Server(url))
            .getTransaction(txHash)
        return txResponse
    } catch (err) {
        if (err.response?.status === 404)
            logger.error(`Transaction ${txHash} not found`)
        return null
    }
}

module.exports = {getUpdateTxHash, getUpdateTx}