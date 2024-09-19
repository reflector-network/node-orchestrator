const {SorobanRpc, Account} = require('@stellar/stellar-sdk')
const {buildUpdateTransaction, getSubscriptionsContractState, getSubscriptions, getSubscriptionById} = require('@reflector/reflector-shared')
const logger = require('../logger')
const container = require('./container')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

async function makeServerRequest(urls, requestFn) {
    const errors = []
    for (const url of urls) {
        try {
            const server = new SorobanRpc.Server(url, {allowHttp: true})
            return await requestFn(server, url)
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

const txTimeout = 20000

function __getMaxTime(syncTimestamp, iteration) {
    const maxTime = syncTimestamp + (txTimeout * iteration)
    return maxTime / 1000 //convert to seconds
}

/**
 *
 * @param {Config} currentConfig
 * @param {Config} newConfig
 * @param {number} timestamp
 * @param {number} syncTimestamp
 * @param {number} [iteration]
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

async function getUpdateTx(txHash, network) {
    try {
        const {urls} = container.appConfig.getNetworkConfig(network)
        const requestFn = async (server) => await server.getTransaction(txHash)
        const txResponse = await makeServerRequest(urls, requestFn)
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
    const requestFn = async (server) => await server.getAccount(systemAccount)
    const accountResponse = await makeServerRequest(urls, requestFn)
    return accountResponse.sequenceNumber()
}

/**
 * @param {string} contractId - contract id
 * @param {number} depth - depth in seconds (only used when pagingToken is not provided)
 * @param {string} pagingToken - paging token
 * @param {string} network - network
 * @returns {Promise<{events: any[], pagingToken: string}>}
 */
async function getSubscriptionEvents(contractId, depth, pagingToken, network) {
    const limit = 100
    const {urls} = container.appConfig.getNetworkConfig(network)
    const lastLedger = (await makeServerRequest(urls, async (server) => await server.getLatestLedger())).sequence
    const startLedger = lastLedger - Math.ceil(depth / 5) //1 ledger is closed every 5 seconds
    const loadEvents = async (startLedger, cursor) => {
        const d = await makeServerRequest(urls, async (server) => {
            startLedger = cursor ? undefined : startLedger
            const data = await server.getEvents({filters: [{type: 'contract', contractIds: [contractId]}], startLedger, limit, cursor})
            return data
        })
        return d
    }
    let events = []
    let hasMore = true
    while (hasMore) {
        const eventsResponse = (await loadEvents(startLedger, pagingToken))
        if (eventsResponse.events.length < limit)
            hasMore = false
        if (eventsResponse.events.length === 0)
            break
        events = events.concat(eventsResponse.events)
        pagingToken = eventsResponse.events[eventsResponse.events.length - 1].pagingToken
    }
    return {events, pagingToken}
}

/**
 * @param {string} contractId - contract id
 * @param {string} network - network
 * @returns {Promise<any[]>}
 */
async function loadSubscriptions(contractId, network) {
    const {urls} = container.appConfig.getNetworkConfig(network)
    const {lastSubscriptionId} = await getSubscriptionsContractState(contractId, urls)
    return await getSubscriptions(contractId, urls, lastSubscriptionId)
}

/**
 * @param {string} contractId - contract id
 * @param {string} id - subscription id
 * @param {string} network - network
 * @returns {Promise<any[]>}
 */
async function loadSubscription(contractId, id, network) {
    const {urls} = container.appConfig.getNetworkConfig(network)
    return await getSubscriptionById(contractId, urls, id)
}

module.exports = {getUpdateTxHash, getUpdateTx, getAccountSequence, getSubscriptionEvents, loadSubscriptions, loadSubscription}