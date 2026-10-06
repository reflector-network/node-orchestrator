const {Account} = require('@stellar/stellar-sdk')
//The submit schedule is reflector-shared's, the one the nodes build with; a cluster round lasts clusterRoundLength.
//baseUpdateFee mirrors reflector-node src/domain/runners/cluster-runner.js; change both in the same release.
const {buildUpdateTransaction, FEE_MULTIPLIER, maxSubmitAttempts, getMaxTime, clusterRoundLength} = require('@reflector/reflector-shared')
const logger = require('../logger')
const {getAccountSequence} = require('../utils/rpc-helper')
const container = require('./container')

const baseUpdateFee = 10_000_000

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

    const fee = baseUpdateFee * Math.pow(FEE_MULTIPLIER, iteration)
    const maxTime = getMaxTime(syncTimestamp, iteration, clusterRoundLength)

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
    logger.debug(`Update tx: ${tx.transaction.toXdr()}, maxTime: ${maxTime}, hasMoreTxns: ${tx.hasMoreTxns}, fee: ${fee}, iteration: ${iteration}, sequence: ${tx.transaction.sequence}, syncTimestamp: ${syncTimestamp}`)
    return {
        hash: tx.hashHex,
        maxTime,
        hasMoreTxns: !!tx.hasMoreTxns //if there are more txns to be processed
    }
}

/**
 * Builds the update transaction from the system account's current sequence, as the first attempt of the round at the
 * switch time would; the switch time is on the sync grid, so the bounds are whole seconds. Building simulates its
 * contract call, so an update the contracts refuse rejects here with the simulation error
 * @param {Config} currentConfig - current config
 * @param {Config} newConfig - proposed config
 * @param {number} timestamp - switch time in milliseconds
 * @returns {Promise<void>}
 */
async function checkUpdateBuilds(currentConfig, newConfig, timestamp) {
    const accountSequence = await getAccountSequence(currentConfig)
    await getUpdateTxHash(currentConfig, newConfig, accountSequence, timestamp, timestamp)
}

module.exports = {
    getUpdateTxHash,
    checkUpdateBuilds,
    maxSubmitAttempts,
    baseUpdateFee,
    FEE_MULTIPLIER
}