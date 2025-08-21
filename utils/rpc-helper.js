const {rpc} = require('@stellar/stellar-sdk')
const {getSubscriptionsContractState, getSubscriptions, getSubscriptionById} = require('@reflector/reflector-shared')
const logger = require('../logger')
const container = require('../domain/container')
const {makeServerRequest} = require('./request-helper')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

/**
 * @param {string} url - server URL
 * @returns {rpc.Server}
 */
function getServer(url) {
    return new rpc.Server(url, {allowHttp: true})
}

async function getUpdateTx(txHash, network) {
    try {
        const {urls} = container.appConfig.getNetworkConfig(network)
        const requestFn = async (server) => await server.getTransaction(txHash)
        const txResponse = await makeServerRequest(urls, getServer, requestFn)
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
    const accountResponse = await makeServerRequest(urls, getServer, requestFn)
    return accountResponse.sequenceNumber()
}

/**
 * @param {string} contractId - contract id
 * @param {number} lastProcessedLedger - last processed ledger
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<{events: any[], lastLedger: number}>}
 */
async function getSubscriptionEvents(contractId, lastProcessedLedger, urls) {
    const limit = 100
    const lastLedger = (await makeServerRequest(urls, getServer, async (server) => await server.getLatestLedger())).sequence
    const startLedger = lastProcessedLedger ? lastProcessedLedger : lastLedger - 180 //180 is 15 minutes in ledgers
    const loadEvents = async (startLedger, cursor) => {
        const d = await makeServerRequest(urls, getServer, async (server) => {
            startLedger = cursor ? undefined : startLedger
            const data = await server.getEvents({filters: [{type: 'contract', contractIds: [contractId]}], startLedger, limit, cursor})
            return data
        })
        return d
    }
    let events = []
    let hasMore = true
    let latestLedger = null
    let pagingToken = null
    while (hasMore) {
        const eventsResponse = (await loadEvents(startLedger, pagingToken))
        if (eventsResponse.events.length < limit)
            hasMore = false
        latestLedger = eventsResponse.latestLedger
        if (eventsResponse.events.length === 0)
            break
        events = events.concat(eventsResponse.events)
        pagingToken = eventsResponse.events[eventsResponse.events.length - 1].pagingToken
    }
    return {events, lastLedger: latestLedger}
}

/**
 * @param {string} contractId - contract id
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<any[]>}
 */
async function loadSubscriptions(contractId, urls) {
    const {lastSubscriptionId} = await getSubscriptionsContractState(contractId, urls)
    return await getSubscriptions(contractId, urls, lastSubscriptionId)
}

/**
 * @param {string} contractId - contract id
 * @param {string} id - subscription id
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<any[]>}
 */
async function loadSubscription(contractId, id, urls) {
    return await getSubscriptionById(contractId, urls, id)
}

module.exports = {getUpdateTx, getAccountSequence, getSubscriptionEvents, loadSubscriptions, loadSubscription}