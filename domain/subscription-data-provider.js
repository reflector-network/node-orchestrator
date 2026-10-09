const {scValToNative} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const {
    getSubscriptionEvents,
    getLatestLedgerSequence,
    loadSubscriptions,
    loadSubscription,
    EventsOutOfRangeError
} = require('../utils/rpc-helper')
const container = require('./container')

/**
 * @typedef {import('@reflector/reflector-shared').OracleConfig} OracleConfig
 * @typedef {import('@reflector/reflector-shared').SubscriptionsConfig} SubscriptionsConfig
 */

/**
 * @typedef {Object} PriceData
 * @property {OracleConfig} contract - contract
 * @property {BigInt[]} prices - prices
 */

/**
 * @typedef {Object} Subscription
 * @property {string} id - subscription id
 * @property {string} balance - balance
 * @property {number} threshold - threshold
 * @property {string} updated - last charge, or creation while there has been none, in milliseconds
 * @property {number} lastCharge - `updated` as a number
 * @property {any} base - base asset
 * @property {any} quote - quote asset
 * @property {number} heartbeat - heartbeat
 * @property {number} status - status
 * @property {string} owner - owner
 * @property {Buffer} webhook - webhook
 */

//the contract's SubscriptionStatus::Suspended
const suspendedStatus = 1
//a failed initial load is retried after this delay, doubled on every further failure up to the cap
const initialLoadRetryDelay = 5000
const maxInitialLoadRetryDelay = 5 * 60 * 1000

/**
 * Returns the subscription id an event carries, in the string form the cache is keyed by. The contract publishes the id
 * as a u64, which scValToNative turns into a bigint - bare for `cancelled`, the first tuple item for `charged` and
 * `suspended` - and a bigint never matched a string key, so cancellations, suspensions and charges were never applied
 * @param {any} value - decoded event value
 * @returns {string}
 */
function getEventSubscriptionId(value) {
    const id = Array.isArray(value) ? value[0] : value
    if (typeof id !== 'bigint')
        throw new Error('Event value carries no subscription id')
    return id.toString()
}

/**
 * @param {string} contractId - contract id
 * @param {string} network - network
 * @param {number} lastProcessedLedger - last processed ledger
 * @returns {Promise<{events: any[], lastLedger: number}>}
 * */
async function loadLastEvents(contractId, network, lastProcessedLedger) {
    const {events: rawEvents, lastLedger} = await getSubscriptionEvents(
        contractId,
        lastProcessedLedger,
        container.appConfig.getNetworkConfig(network).urls
    )
    const events = rawEvents
        .map(raw => {
            const data = {
                topic: raw.topic.map(t => scValToNative(t)),
                value: scValToNative(raw.value),
                timestamp: raw.timestamp
            }
            return data
        })
    return {events, lastLedger}
}

class SubscriptionContractManager {

    constructor(contractId) {
        this.contractId = contractId
    }

    network = null

    isRunning = false

    /**
     * @type {Map<string, Subscription>}
     */
    __subscriptions = new Map()

    /**
     * @type {number}
     */
    __lastLedger = null

    __workerTimeoutId = null

    /**
     * @returns {Promise<void>} settles once the first load attempt, and the first events read if it succeeded, are done
     */
    start() {
        this.isRunning = true
        return this.__init(0)
    }

    stop() {
        this.isRunning = false
        if (this.__workerTimeoutId)
            clearTimeout(this.__workerTimeoutId)
    }

    /**
     * Load the subscriptions, then start reading events. Nothing else ever loads them, so a failed load is retried with
     * a growing delay for as long as the manager runs, and every failure is logged
     * @param {number} attempt - failed attempts so far
     * @returns {Promise<void>}
     */
    async __init(attempt) {
        try {
            await this.__loadSubscriptionsData()
        } catch (e) {
            if (!this.isRunning)
                return
            const delay = Math.min(initialLoadRetryDelay * 2 ** attempt, maxInitialLoadRetryDelay)
            logger.error(`Loading subscriptions of contract ${this.contractId} failed (attempt ${attempt + 1}), retrying in ${delay / 1000}s: ${e.message}`)
            this.__workerTimeoutId = setTimeout(() => this.__init(attempt + 1), delay)
            return
        }
        if (attempt > 0)
            logger.info(`Loaded subscriptions of contract ${this.contractId} after ${attempt + 1} attempts`)
        if (this.isRunning)
            await this.__processLastEvents()
    }

    /**
     * Replace the cache with the subscriptions the contract holds now, and move the event cursor to the latest ledger
     * read before the load. The snapshot is at least as new as that ledger, so reading on from it replays only events
     * the snapshot may already hold - which changes nothing - and skips none it lacks, however long the reads after
     * it keep failing. The cache is swapped in whole, together with the cursor, once the load has finished, so a lookup
     * never sees it half-filled, an id the contract no longer holds is gone from it, and a failed load changes neither
     * @returns {Promise<void>}
     */
    async __loadSubscriptionsData() {
        const {urls} = container.appConfig.getNetworkConfig(this.network)
        const snapshotLedger = await getLatestLedgerSequence(urls)
        const rawData = await loadSubscriptions(this.contractId, urls)
        const subscriptions = new Map()
        for (const raw of rawData)
            try {
                if (raw) //null where the contract removed the id; a suspended subscription loads with its status
                    this.__setSubscription(raw, subscriptions)
            } catch (err) {
                logger.error({err}, `Error on adding subscription ${raw.id?.toString()}`)
            }
        this.__subscriptions = subscriptions
        this.__lastLedger = snapshotLedger
    }

    getSubscriptionById(id) {
        return this.__subscriptions.get(id)
    }

    getSubscriptions(owner) {
        return [...this.__subscriptions.values()].filter(s => s.owner === owner)
    }

    /**
     * @param {any} raw - raw subscription data
     * @param {Map<string, Subscription>} [subscriptions] - cache to store it in, the live one by default
     */
    __setSubscription(raw, subscriptions = this.__subscriptions) {
        const subscription = {
            base: raw.base,
            quote: raw.quote,
            balance: raw.balance.toString(),
            status: raw.status,
            id: raw.id.toString(),
            updated: raw.updated.toString(),
            lastCharge: Number(raw.updated),
            owner: raw.owner,
            threshold: raw.threshold,
            webhook: raw.webhook?.toString('base64') || null,
            heartbeat: raw.heartbeat
        }
        subscriptions.set(subscription.id, subscription)
    }

    /**
     * Loads a subscription the cache has never seen - one the initial load missed - from the contract. The stored state
     * is current, so it already reflects the event that named the subscription and every event before it
     * @param {string} id - subscription id
     * @returns {Promise<void>}
     */
    async __loadSubscription(id) {
        const raw = await loadSubscription(this.contractId, id, container.appConfig.getNetworkConfig(this.network).urls)
        if (raw) //null once the contract has removed it
            this.__setSubscription(raw)
    }

    /**
     * Read the events since the cursor. A cursor the RPC no longer holds events for can never be read on from, so the
     * cache is reloaded from chain state, as reflector-node does, which moves the cursor to the ledger read before the
     * snapshot, and the events are read once more from there. The reload happens only in the catch below, so a round
     * reloads at most once: if even the new cursor is refused - a snapshot that took longer than the RPC keeps events -
     * the error ends the round and the next one reloads again. A failed reload leaves the cache and the cursor as they
     * were, and the next round tries again
     * @returns {Promise<{events: any[], lastLedger: number}>}
     */
    async __loadEventsOrReload() {
        try {
            return await loadLastEvents(this.contractId, this.network, this.__lastLedger)
        } catch (e) {
            if (!(e instanceof EventsOutOfRangeError))
                throw e
            logger.warn(`${e.message}, reloading the subscriptions of contract ${this.contractId} from chain state`)
            await this.__loadSubscriptionsData()
            return await loadLastEvents(this.contractId, this.network, this.__lastLedger)
        }
    }

    async __processLastEvents() {
        try {
            logger.debug(`Processing events for contract ${this.contractId} from ${this.__lastLedger}`)
            const {events, lastLedger} = await this.__loadEventsOrReload()
            logger.debug(`Loaded ${events.length} events for contract ${this.contractId}, new last ledger: ${lastLedger}`)
            this.__lastLedger = lastLedger

            const triggerEvents = events
            for (const event of triggerEvents) {
                try {
                    const eventTopic = event.topic[1] === "triggers" //triggers topic appears in new version of the contract
                        ? event.topic[2]
                        : event.topic[1]
                    switch (eventTopic) {
                        case 'created':
                        case 'deposited':
                            {
                                //(id, subscription) and (id, subscription, amount): the whole state after the call, so
                                //applying it again, or for an id the cache has never seen, stores the same thing
                                const [id, rawSubscription] = event.value
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                rawSubscription.id = id
                                this.__setSubscription(rawSubscription)
                            }
                            break
                        case 'cancelled':
                            {
                                //the contract removes the subscription from its storage
                                const id = getEventSubscriptionId(event.value)
                                logger.debug(`Subscription ${id} cancelled. Contract ${this.contractId}`)
                                this.__subscriptions.delete(id)
                            }
                            break
                        case 'suspended':
                            {
                                //(id, now): the contract keeps a suspended subscription, as the initial load does, until
                                //a deposit revives it
                                const id = getEventSubscriptionId(event.value)
                                logger.debug(`Subscription ${id} suspended. Contract ${this.contractId}`)
                                const subscription = this.__subscriptions.get(id)
                                if (subscription)
                                    subscription.status = suspendedStatus
                                else
                                    await this.__loadSubscription(id)
                            }
                            break
                        case 'charged':
                            {
                                //(id, charge, now): the contract deducts the charge and moves `updated` to now
                                const id = getEventSubscriptionId(event.value)
                                const [, charge, timestamp] = event.value
                                logger.debug(`Subscription ${id} charged. Contract ${this.contractId}`)
                                const subscription = this.__subscriptions.get(id)
                                if (!subscription) {
                                    await this.__loadSubscription(id)
                                    break
                                }
                                //a charge needs a full day since `updated`, so `updated` only moves forward and a
                                //charge the cache already holds - a page re-read from its last ledger, or the window a
                                //restart replays over a newer snapshot - is not deducted a second time
                                if (timestamp <= BigInt(subscription.updated))
                                    break
                                subscription.balance = (BigInt(subscription.balance) - charge).toString()
                                subscription.updated = timestamp.toString()
                                subscription.lastCharge = Number(timestamp)
                            }
                            break
                        case 'triggered': //do nothing
                        case 'updated':
                            break
                        default:
                            logger.error(`Unknown event type: ${eventTopic}`)
                    }
                } catch (e) {
                    logger.error(`Error processing event ${event.topic}: ${e.message}`)
                }
            }
        } catch (e) {
            logger.error(`Error processing events: ${e.message}`)
        } finally {
            if (this.isRunning)
                this.__workerTimeoutId = setTimeout(() => this.__processLastEvents(), 60 * 1000)
        }
    }
}

/**
 * @type {Map<string, SubscriptionContractManager>}
 */
const subscriptionManager = new Map()

function getManager(contractId) {
    return subscriptionManager.get(contractId)
}

function removeManager(contractId) {
    const manager = subscriptionManager.get(contractId)
    if (manager)
        manager.stop()
    subscriptionManager.delete(contractId)
}

/**
 * @param {string[]} newSubscriptionIds - subscription contract ids
 * @param {string} network - network
 */
function setManagers(newSubscriptionIds, network) {
    try {
        const allSubscriptionIds = [...subscriptionManager.keys(), ...newSubscriptionIds]
        for (const subscriptionId of allSubscriptionIds) {
            if (newSubscriptionIds.indexOf(subscriptionId) < 0) {
                removeManager(subscriptionId)
                continue
            }
            let manager = subscriptionManager.get(subscriptionId)
            if (!manager) {
                manager = new SubscriptionContractManager(subscriptionId)
                subscriptionManager.set(subscriptionId, manager)
            }
            manager.network = network
            if (!manager.isRunning)
                manager.start()
        }
    } catch (e) {
        logger.error(`Error setting subscription managers: ${e.message}`)
    }
}

module.exports = {
    setManagers,
    getManager,
    SubscriptionContractManager
}