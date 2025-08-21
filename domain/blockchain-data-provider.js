const {Account} = require('@stellar/stellar-sdk')
const {buildUpdateTransaction} = require('@reflector/reflector-shared')
const logger = require('../logger')
const {getTransactions} = require('../utils/horizon-helper')
const container = require('./container')

const baseUpdateFee = 10000000

const txTimeout = 20000

function __getMaxTime(syncTimestamp, iteration) {
    const maxTime = syncTimestamp + (txTimeout * iteration)
    return maxTime / 1000 //convert to seconds
}

/**
 *
 * @param {Config} currentConfig - current config
 * @param {Config} newConfig - new config
 * @param {number} accountSequence - current account sequence number
 * @param {number} timestamp - current timestamp in milliseconds
 * @param {number} syncTimestamp - sync timestamp in milliseconds
 * @param {number} [iteration] - iteration number, used to increase fee and maxTime
 * @returns {Promise<{hash: string, maxTime: number, hasMoreTxns: boolean}>}
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
    logger.debug(`Update tx: ${tx.transaction.toXDR()}, maxTime: ${maxTime}, hasMoreTxns: ${tx.hasMoreTxns}, fee: ${fee}, iteration: ${iteration}, sequence: ${tx.transaction.sequence}, syncTimestamp: ${syncTimestamp}`)
    return {
        hash: tx.hashHex,
        maxTime,
        hasMoreTxns: !!tx.hasMoreTxns //if there are more txns to be processed
    }
}

/**
 * Fetches the last transactions for all contracts in the cluster.
 * @returns {Promise<Object.<string, string[]>>} - A map of contract IDs to their last transaction hashes.
 */
async function getLastClusterTransactions() {
    //ensure that the config is loaded
    const config = container.configManager.currentConfig
    if (!config)
        return
    const requests = new Map()
    //get all transaction sources
    for (const [contractId, account] of [...config.contracts.values()]
        .map(c => [c.contractId, c.admin])
        .concat([null, config.systemAccount])) {
        requests.set(contractId, getTransactions(account))
    }
    await Promise.allSettled(...requests.values())
    return requests.entries().reduce((acc, [contractId, promise]) => {
        if (promise.status === 'fulfilled' && promise.value) {
            acc[contractId] = promise.value.map(tx => ({
                hash: tx.hash
            }))
        } else {
            logger.warn(`Failed to get transactions for contract ${contractId}: ${promise.reason?.message || 'Unknown error'}`)
        }
        return acc
    }, {})
}

module.exports = {
    getUpdateTxHash,
    getLastClusterTransactions
}