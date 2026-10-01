const {rpc} = require('@stellar/stellar-sdk')
const {getSubscriptionsContractState, getSubscriptions, getSubscriptionById} = require('@reflector/reflector-shared')
const logger = require('../logger')
const container = require('../domain/container')
const {makeServerRequest} = require('./request-helper')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

//an upstream that accepts the connection and never answers must count as a failure, so the next url is tried
const rpcTimeout = 15000

/**
 * @param {string} url - server URL
 * @returns {rpc.Server}
 */
function getServer(url) {
    const server = new rpc.Server(url, {allowHttp: true})
    //sdk 17.0.1 forwards only the headers from the constructor options; the deadline has to live on the http client
    server.httpClient.defaults.timeout = rpcTimeout
    return server
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
 * The ledger events were requested from is older than any the RPC still holds events for. Reading on from it can never
 * succeed, so the caller has to rebuild its state from the chain instead
 */
class EventsOutOfRangeError extends Error {
    /**
     * @param {number} startLedger - ledger the events were requested from
     * @param {number} oldestLedger - oldest ledger the RPC holds events for
     */
    constructor(startLedger, oldestLedger) {
        super(`Ledger ${startLedger} is outside the event retention of the RPC (oldest ledger ${oldestLedger})`)
        this.name = 'EventsOutOfRangeError'
        this.startLedger = startLedger
        this.oldestLedger = oldestLedger
    }
}

/**
 * The causes a failed request carries, as a list: makeServerRequest attaches an array, any other cause is one entry
 * @param {any} cause - error cause
 * @returns {any[]}
 */
function toCauseList(cause) {
    if (Array.isArray(cause))
        return cause
    return cause === undefined || cause === null ? [] : [cause]
}

/**
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<number>} the latest ledger the RPC has closed
 */
async function getLatestLedgerSequence(urls) {
    return (await makeServerRequest(urls, getServer, async (server) => await server.getLatestLedger())).sequence
}

/**
 * @param {string} contractId - contract id
 * @param {number} lastProcessedLedger - last processed ledger
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<{events: any[], lastLedger: number}>}
 * @throws {EventsOutOfRangeError} when lastProcessedLedger is older than the oldest ledger the RPC holds events for
 */
async function getSubscriptionEvents(contractId, lastProcessedLedger, urls) {
    const limit = 100
    const filters = [{type: 'contract', contractIds: [contractId]}]
    const lastLedger = await getLatestLedgerSequence(urls)
    const startLedger = lastProcessedLedger ? lastProcessedLedger : lastLedger - 180 //180 is 15 minutes in ledgers
    const loadEvents = async (startLedger, cursor, quiet = false) => {
        const d = await makeServerRequest(urls, getServer, async (server) => {
            startLedger = cursor ? undefined : startLedger
            const data = await server.getEvents({filters, startLedger, limit, cursor})
            return data
        }, {quiet})
        return d
    }
    //the first page is read from the stored cursor. After an outage longer than the RPC keeps events, that ledger is
    //gone and every read from it is refused, so the refusal is told apart from a transient failure by asking the RPC
    //for the oldest ledger it holds - read from a request that starts at the latest ledger, which is always in range.
    //reflector-node makes the same comparison before every read; here it costs a request only once a read has failed
    const loadFirstPage = async () => {
        try {
            //quiet: after a long outage this read is refused by design and the refusal triggers a reload, so its errors
            //are logged below only once they are known to be something else
            return await loadEvents(startLedger, null, true)
        } catch (err) {
            if (lastProcessedLedger) {
                const oldestLedger = await makeServerRequest(urls, getServer,
                    async (server) => (await server.getEvents({filters, startLedger: lastLedger, limit: 1})).oldestLedger)
                    .catch(() => null)
                if (oldestLedger > lastProcessedLedger)
                    throw new EventsOutOfRangeError(lastProcessedLedger, oldestLedger)
            }
            for (const cause of toCauseList(err.cause))
                logger.error(cause)
            throw err
        }
    }
    let events = []
    let hasMore = true
    let latestLedger = null
    let pagingToken = null
    while (hasMore) {
        const eventsResponse = pagingToken ? await loadEvents(startLedger, pagingToken) : await loadFirstPage()
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

/**
 * @param {string} txHash - transaction hash
 * @param {string[]} urls - soroban rpc urls
 * @returns {Promise<any|null>}
 */
async function loadTransaction(txHash, urls) {
    try {
        const requestFn = async (server) => await server.getTransaction(txHash)
        const txResponse = await makeServerRequest(urls, getServer, requestFn)
        return txResponse
    } catch (err) {
        if (err.response?.status === 404)
            logger.error(`Transaction ${txHash} not found`)
        return null
    }
}

module.exports = {
    getUpdateTx,
    getAccountSequence,
    getSubscriptionEvents,
    getLatestLedgerSequence,
    loadSubscriptions,
    loadSubscription,
    loadTransaction,
    getServer,
    EventsOutOfRangeError
}