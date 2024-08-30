const {scValToNative} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const {getSubscriptionEvents, loadSubscriptions} = require('./rpc-helper')

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
 * @property {string} updated - last charge
 * @property {any} base - base asset
 * @property {any} quote - quote asset
 * @property {number} heartbeat - heartbeat
 * @property {number} status - status
 * @property {string} owner - owner
 * @property {Buffer} webhook - webhook
 */

/**
 * @param {string} contractId - contract id
 * @param {string} network - network
 * @param {string} [cursor] - cursor
 * @returns {Promise<{events: any[], pagingToken: string}>}
 * */
async function loadLastEvents(contractId, network, cursor = null) {
    const {events: rawEvents, pagingToken} = await getSubscriptionEvents(contractId, 60 * 60, cursor, network)
    const events = rawEvents
        .map(raw => {
            const data = {
                topic: raw.topic.map(t => scValToNative(t)),
                value: scValToNative(raw.value),
                timestamp: raw.timestamp
            }
            return data
        })
    return {events, pagingToken}
}

class SubscriptionContractManager {

    constructor(contractId) {
        this.contractId = contractId
    }

    network = null

    isRunning = false

    /**
     * @type {Map<BigInt, Subscription>}>}
     */
    __subscriptions = new Map()

    /**
     * @type {string}
     */
    __pagingToken = null

    __workerTimeoutId = null

    start() {
        this.isRunning = true
        this.__loadSubscriptionsData()
            .then(() =>  this.__processLastEvents())
            .catch(e => logger.error(`Error starting subscription manager: ${e.message}`))
    }

    stop() {
        this.isRunning = false
        if (this.__workerTimeoutId)
            clearTimeout(this.__workerTimeoutId)
    }

    async __loadSubscriptionsData() {
        const rawData = await loadSubscriptions(this.contractId, this.network)
        for (const raw of rawData)
            try {
                if (raw) //only active subscriptions
                    this.__setSubscription(raw)
            } catch (err) {
                logger.error({err}, `Error on adding subscription ${raw.id?.toString()}`)
            }
    }

    getSubscriptionById(id) {
        return this.__subscriptions.get(id)
    }

    getSubscriptions(owner) {
        return [...this.__subscriptions.values()].filter(s => s.owner === owner)
    }

    /**
     * @param {any} raw - raw subscription data
     */
    __setSubscription(raw) {
        const subscription = {
            base: raw.base,
            quote: raw.quote,
            balance: raw.balance.toString(),
            status: raw.status,
            id: raw.id.toString(),
            updated: raw.updated.toString(),
            owner: raw.owner,
            threshold: raw.threshold,
            webhook: raw.webhook?.toString('base64') || null,
            heartbeat: raw.heartbeat
        }
        this.__subscriptions.set(subscription.id, subscription)
    }

    async __processLastEvents() {
        try {
            logger.debug(`Processing events for contract ${this.contractId} from ${this.__pagingToken}`)
            const {events, pagingToken} = await loadLastEvents(this.contractId, this.network, this.__pagingToken)
            logger.debug(`Loaded ${events.length} events for contract ${this.contractId}, new paging token: ${pagingToken}`)
            this.__pagingToken = pagingToken

            const triggerEvents = events
            for (const event of triggerEvents) {
                try {
                    const eventTopic = event.topic[1]
                    switch (eventTopic) {
                        case 'created':
                        case 'deposited':
                            {
                                const [id, rawSubscription] = event.value
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                rawSubscription.id = id
                                this.__setSubscription(rawSubscription)
                            }
                            break
                        case 'suspended':
                            {
                                const id = event.value[1].toString()
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                if (this.__subscriptions.has(id)) {
                                    const subscription = this.__subscriptions.get(id)
                                    subscription.status = 1
                                }
                            }
                            break
                        case 'cancelled':
                            {
                                const id = event.value[1].toString()
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                if (this.__subscriptions.has(id))
                                    this.__subscriptions.delete(id)
                            }
                            break
                        case 'charged':
                            {
                                const timestamp = BigInt(event.value[2])
                                const id = event.value[0].toString()
                                logger.debug(`Subscription ${id} charged. Contract ${this.contractId}`)
                                if (this.__subscriptions.has(id)) {
                                    const subscription = this.__subscriptions.get(id)
                                    if (BigInt(subscription.updated) >= timestamp)
                                        continue
                                    subscription.updated = timestamp.toString()
                                    subscription.balance -= Number(event.value[1].toString())
                                }
                            }
                            break
                        case 'triggered': //do nothing
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
    getManager
}