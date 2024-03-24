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

const baseUpdateFee = 10000000

function __getMaxTime(syncTimestamp, iteration) {
    const maxTime = syncTimestamp + (15000 * iteration)
    return maxTime / 1000 //convert to seconds
}

/**
 *
 * @param {Config} currentConfig
 * @param {Config} newConfig
 * @param {number} timestamp
 * @param {number} syncTimestamp
 * @param {number} [iteration]
 * @returns {Promise<{hash: string, maxTime: number}>}
 */
async function getUpdateTxHash(currentConfig, newConfig, accountSequence, timestamp, syncTimestamp, iteration = 0) {

    const fee = baseUpdateFee * Math.pow(4, iteration) //increase fee by 4 times on each iteration
    const maxTime = __getMaxTime(syncTimestamp, iteration + 1)

    const {network, systemAccount} = currentConfig
    const {urls, passphrase} = container.appConfig.getNetworkConfig(network)
    const account = new Account(systemAccount, accountSequence)
    const tx = await buildUpdateTransaction({
        network: passphrase,
        sorobanRpc: urls,
        currentConfig,
        newConfig,
        account,
        timestamp,
        fee,
        maxTime
    })
    if (!tx)
        return null
    logger.info(`Update tx: ${tx.transaction.toXDR()}`)
    return {hash: tx.hashHex, maxTime}
}

async function getUpdateTx(txHash, network) {
    try {
        const {urls} = container.appConfig.getNetworkConfig(network)
        const requestFn = async (url) => await (new SorobanRpc.Server(url, {allowHttp: true}))
            .getTransaction(txHash)
        const txResponse = await tryMakeRpcRequest(urls, requestFn)
        return txResponse
    } catch (err) {
        if (err.response?.status === 404)
            logger.error(`Transaction ${txHash} not found`)
        return null
    }
}

async function getAccountSequence(currentConfig) {
    const {network, systemAccount} = currentConfig
    const {urls} = container.appConfig.getNetworkConfig(network)
    const requestFn = async (url) => await (new SorobanRpc.Server(url, {allowHttp: true})).getAccount(systemAccount)
    const accountResponse = await tryMakeRpcRequest(urls, requestFn)
    return accountResponse.sequenceNumber()
}

module.exports = {getUpdateTxHash, getUpdateTx, getAccountSequence}