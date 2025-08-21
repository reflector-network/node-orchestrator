const {scValToNative} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const {getSubscriptionEvents, loadSubscriptions} = require('../utils/rpc-helper')
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
     * @type {Map<BigInt, Subscription>}>}
     */
    __subscriptions = new Map()

    /**
     * @type {number}
     */
    __lastLedger = null

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
        const rawData = await loadSubscriptions(
            this.contractId,
            container.appConfig.getNetworkConfig(this.network).urls
        )
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
            logger.debug(`Processing events for contract ${this.contractId} from ${this.__lastLedger}`)
            const {events, lastLedger} = await loadLastEvents(this.contractId, this.network, this.__lastLedger)
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
                                const [id, rawSubscription] = event.value
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                rawSubscription.id = id
                                await this.__setSubscription(rawSubscription)
                            }
                            break
                        case 'suspended':
                        case 'cancelled':
                            {
                                const id = event.value[0] || event.value
                                logger.debug(`Subscription ${id} ${eventTopic}. Contract ${this.contractId}`)
                                if (this.__subscriptions.has(id))
                                    this.__subscriptions.delete(id)
                            }
                            break
                        case 'charged':
                            {
                                const id = event.value[0]
                                const timestamp = event.value[2]
                                logger.debug(`Subscription ${id} charged. Contract ${this.contractId}`)
                                if (this.__subscriptions.has(id)) {
                                    const subscription = this.__subscriptions.get(id)
                                    subscription.lastCharge = Number(timestamp)
                                }
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
    getManager
}