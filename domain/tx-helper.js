const {SorobanRpc, Account} = require('@stellar/stellar-sdk')
const {buildUpdateTransaction, normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../logger')
const container = require('./container')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

async function tryMakeRpcRequest(urls, requestFn) {
    const errors = []
    for (const url of urls) {
        try {
            return await requestFn(url)
        } catch (err) {
            logger.debug(`Request to ${url} failed. Error: ${err.message}`)
            errors.push(err)
        }
    }
    for (const err of errors)
        logger.error(err)
    throw new Error('Failed to make request. See logs for details.')
}

/**
 *
 * @param {Config} currentConfig
 * @param {Config} newConfig
 * @param {number} timestamp
 * @returns {string|null}
 */
async function getUpdateTxHash(currentConfig, newConfig, timestamp) {
    const {network, systemAccount} = currentConfig
    const {urls, passphrase} = container.appConfig.getNetworkConfig(network)
    const requestFn = async (url) => await (new SorobanRpc.Server(url)).getAccount(systemAccount)
    const accountResponse = await tryMakeRpcRequest(urls, requestFn)
    const account = new Account(systemAccount, accountResponse.sequence.toString())
    const tx = await buildUpdateTransaction({
        network: passphrase,
        sorobanRpc: urls,
        currentConfig,
        newConfig,
        account,
        timestamp,
        fee: 10000000,
        maxTime: (normalizeTimestamp(timestamp, 1000) / 1000) + 15 //round to seconds and add 15 seconds
    })
    if (!tx)
        return null
    logger.info(`Update tx: ${tx.transaction.toXDR()}`)
    return tx.hashHex
}

async function getUpdateTx(txHash, network) {
    try {
        const {urls} = container.appConfig.getNetworkConfig(network)
        const requestFn = async (url) => await (new SorobanRpc.Server(url))
            .getTransaction(txHash)
        const txResponse = await tryMakeRpcRequest(urls, requestFn)
        return txResponse
    } catch (err) {
        if (err.response?.status === 404)
            logger.error(`Transaction ${txHash} not found`)
        return null
    }
}

module.exports = {getUpdateTxHash, getUpdateTx}