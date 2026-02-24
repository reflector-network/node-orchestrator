const {scValToNative, xdr, Address} = require('@stellar/stellar-sdk')
const {getContractInstanceEntries, mapToPlainObject, normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const {getLastTransactionsForAccount, getLastTransactions} = require('../../utils/horizon-helper')
const StatisticsModel = require('../../persistence-layer/models/statistics')

/**
 * @typedef {import('@reflector/reflector-shared').Config} Config
 */

const maxItemsToStore = 256

/**
 * Context object passed to parsers of transactions and entries
 * @typedef {Object} ParserContext
 * @property {{fn: string, args: Array<any>, txHash: string}|any} source - source of the data, can be either function call or a specific entries update
 * @property {string} [account] - transaction source account. Only for transaction parsers
 * @property {bigint} timestamp - transaction timestamp
 * @property {number} [ledger] - transaction ledger. Only for transaction parsers
 * @property {StatisticsData} state - current state of the contract related to this transaction
 */

/**
 * Parser function. Parses context and changes the state of the contract if necessary. Returns true if state was changed and false otherwise
 * @callback ParserFunction
 * @param {ParserContext} context - context object with all necessary information to parse the transaction or entry
 * @returns {boolean} - true if state was changed, false otherwise
 */

/**
 * @typedef {Object} Parser
 * @property {Object<string, ParserFunction>} fns - map of function names to their parsers
 * @property {Object<string, ParserFunction>} entries - map of entry names to their parsers
 */

/**
 * Returns parser object for the given contract type
 * @param {string} type - contract type
 * @returns {Parser|null} - parser object or null if there is no parser for this type
 */
function getParser(type) {
    switch (type) {
        case "dao":
            return {
                fns: {
                    "create_ballot": (context) => {
                        context.state.notifications.push({
                            topic: "Ballot Created",
                            title: context.source.args[0].title,
                            desc: context.source.args[0].description,
                            timestamp: context.timestamp,
                            tx: context.source.txHash
                        })
                        return true
                    },
                    "vote": (context) => {
                        context.state.notifications.push({
                            topic: "DAO Vote",
                            vote: context.source.args[1],
                            ballotId: context.source.args[0],
                            voter: context.source,
                            timestamp: context.timestamp,
                            tx: context.source.txHash
                        })
                        return true
                    }
                }
            }
        case "oracle":
        case "oracle_beam":
            return {
                fns: {"set_price": (context) => {
                    context.state.updates[context.source.args[1]] = context.source.txHash
                    return true
                }},
                entries: {"expiration": (context) => { //assetTtls is array of expiration timestamps
                    const {timestamp, state, source: assetTtls} = context

                    //v1 oracles
                    if (!assetTtls)
                        return

                    //max TTL or 0 if there are no active assets yet
                    const maxTtl = assetTtls.length > 0
                        ? assetTtls.reduce((m, e) => e > m ? e : m)
                        : 0n

                    //ensure we have the expiration array initialized
                    state.entries.expiration ??= []
                    const expiration = state.entries.expiration

                    //if max TTL is zero or in the past
                    if (maxTtl === 0n || maxTtl < timestamp) {
                        if (expiration.length > 0)
                            return //already have an inactive range, no need to add another one
                        expiration.push([0n, 0n])
                        return true
                    }

                    const lastEntry = expiration[expiration.length - 1]

                    //no changes
                    if (lastEntry[1] === maxTtl)
                        return

                    //update existing range if it overlaps with the current timestamp
                    if (lastEntry[1] > timestamp) {
                        lastEntry[1] = maxTtl
                        return true
                    }

                    //start a new range if current maxTtl is ahead of the current timestamp
                    if (maxTtl > timestamp) {
                        expiration.push([timestamp, maxTtl])
                        return true
                    }
                }}
            }
        case "subscription":
            return {
                fns: {"trigger": (context) => {
                    context.state.updates[context.source.args[0]] = context.source.txHash
                    return true
                }} //use trigger timestamp as the update timestamp for subscriptions
            }
        default:
            return null
    }
}

const STATUS = {
    MISSING: -1,
    PENDING: 0,
    INACTIVE: 1
}

const gracePeriod = BigInt(60 * 1000)

function buildOracleTimeline(updates, activeTtls, currentTime, timeframe, totalSlots = maxItemsToStore) {
    const slotsToProcess = Math.min(totalSlots, maxItemsToStore)
    const lastSlotTs = BigInt(normalizeTimestamp(currentTime, timeframe))
    const nowTs = BigInt(Date.now())

    //generate all expected timestamps
    const timeline = {}

    for (let i = 0; i < slotsToProcess; i++) {
        const ts = lastSlotTs - (BigInt(i) * BigInt(timeframe))

        //hash is present for this timestamp
        if (updates[ts] !== undefined) {
            timeline[ts] = updates[ts]
            continue
        }

        //current timestamp, it can delay
        if (nowTs - ts < gracePeriod) {
            timeline[ts] = STATUS.PENDING
            continue
        }

        if (!activeTtls?.length) { //v1 oracle, all timestamps are required
            timeline[ts] = STATUS.MISSING
            continue
        }

        //if there are no active ranges, all timestamps are not required
        const isWithinActiveRange = activeTtls.some(([start, end]) =>
            ts >= BigInt(start) && ts <= BigInt(end)
        )

        timeline[ts] = isWithinActiveRange ? STATUS.MISSING : STATUS.INACTIVE
    }

    return timeline
}

function buildSubscriptionTimeline(updates, now, data) {
    const timeline = {}
    for (const triggerTimestamps of data) {
        const ts = BigInt(triggerTimestamps)
        if (updates[ts] !== undefined) {
            timeline[ts] = updates[ts]
            continue
        }

        if (now - ts < gracePeriod) {
            timeline[ts] = STATUS.PENDING
            continue
        }
        timeline[ts] = STATUS.MISSING
    }
    return timeline
}

class StatisticsData {
    constructor(account, type) {
        this.updates = {}
        this.account = account
        this.type = type
        this.entries = {}
    }

    /**
     * @type {string}
     */
    account

    /**
     * Map of transaction hash by transaction timestamp
     * @type {Object<bigint, string>}
     */
    updates

    /**
     * An array of asset ttl ranges. Each range is represented as a tuple [start, end].
     * This is necessary for oracles to determine if there are gaps in active contract.
     * @type {Object<string, any>}
     */
    entries

    /**
     * An array of notifications related to the contract.
     * @type {Array<{topic: string, type: string, [key: string]: any, timestamp: bigint}>}
     */
    notifications = []
}

class TxStatisticsManager {

    /**
     * @type {{lastLedger: number, clusterStatistics: Map<string, StatisticsData>}}
     */
    __contractsState = null

    constructor() {
        try {
            this.__transactionsWorker()
        } catch (error) {
            logger.error(`Error initializing TxStatisticsManager: ${error.message}`)
        }
    }

    /**
     * @param {Array<{contractId: string, type: string, timeframe: number}>} contracts
     * @param {any} extraData - any additional data that might be needed to build timelines
     * @returns {Object<string, {type: string, updates: Object<string, any>}>}
     */
    getTimelines(contracts, extraData) {
        const now = Date.now()
        const statistics = {}
        if (!this.__contractsState)
            return statistics
        for (const contract of contracts) {
            const state = this.__contractsState.clusterStatistics.get(contract.contractId)
            if (!state) {
                logger.warn(`Contract ${contract.contractId} is not part of the current config. Skipping.`)
                continue
            }
            let data = null
            switch (state.type) {
                case "oracle":
                case "oracle_beam":
                    data = buildOracleTimeline(state.updates, state.entries.expiration, now, contract.timeframe, 300)
                    break
                case "subscription":
                    data = buildSubscriptionTimeline(state.updates, now, extraData)
                    break
                default:
                    logger.warn(`Unknown contract type ${state.type} for contract ${contract.contractId}. Skipping transaction data.`)
                    continue
            }
            statistics[contract.contractId] = data
        }
        return statistics
    }

    async __loadContractStatistics() {
        const doc = await StatisticsModel.findOne().exec()
        if (doc) {
            const normalizedData = doc.toPlainObject()
            for (const [contractId, stats] of Object.entries(normalizedData.data.clusterStatistics)) {
                const contractState = this.__contractsState.clusterStatistics.get(contractId)
                if (!contractState) {
                    logger.trace(`Loading statistics from db. ${contractId} is not part of the current config. Skipping.`)
                    continue
                }
                contractState.updates = stats.updates
                contractState.entries = stats.entries
                contractState.notifications = stats.notifications || []
            }
            this.__contractsState.lastLedger = normalizedData.data.lastLedger
        }
    }

    /**
     * @param {Config} config - current config
     */
    async __ensureState(config) {
        /**
         * @param {{contractId: string, admin: string, type: string}} contractData
         */
        const ensureContractSetup = (contractData) => {
            let contractState = this.__contractsState.clusterStatistics.get(contractData.contractId)
            if (!contractState) {
                contractState = new StatisticsData(contractData.admin, contractData.type)
                this.__contractsState.clusterStatistics.set(contractData.contractId, contractState)
            } else if (contractState.account !== contractData.admin) {
                contractState.account = contractData.admin //update account if it was changed
            }
        }
        const isInitialized = this.__contractsState === null
            ? !(this.__contractsState = {lastLedger: 0, clusterStatistics: new Map()})
            : true
        for (const contract of config.contracts.values())
            ensureContractSetup(contract)
        //system account
        ensureContractSetup({contractId: 'system', admin: config.systemAccount, type: 'system'})
        if (isInitialized)
            return
        //load persisted statistics
        await this.__loadContractStatistics()
    }


    /**
     * Updates asset ttl ranges for contracts that have them and returns true if there were any changes
     * @param {Config} config - current config
     * @param {Array<string>} urls - array of urls to fetch data from
     * @returns {Promise<boolean>} - true if there were any changes, false otherwise
     */
    async __updateEntries(config, urls) {
        try {
            const now = BigInt(Date.now())
            const entriesRequests = [...config.contracts.values()]
                .reduce((requests, {contractId, type}) => {
                    const parser = getParser(type)
                    if (parser?.entries)
                        requests.set(contractId,
                            getContractInstanceEntries(contractId, urls, [...Object.keys(parser.entries)])
                                .then(entries => {
                                    const state = this.__contractsState.clusterStatistics.get(contractId)
                                    if (!state)
                                        return
                                    let hasChanges = false
                                    for (const [key, parserFn] of Object.entries(parser.entries))
                                        if (parserFn({source: entries[key], state, timestamp: now}))
                                            hasChanges = true
                                    return hasChanges
                                })
                        )
                    return requests
                }, new Map())

            const entriesResults = (await Promise.all([...entriesRequests.values()]))

            return entriesResults.some(result => result)
        } catch (error) {
            logger.error(error)
            logger.error(`Error updating entries: ${error.message}`)
            return false
        }
    }

    /**
     * Updates transactions for all contracts and returns true if there were any changes
     * @param {Config} config - current config
     * @param {Array<string>} urls - array of urls to fetch data from
     * @returns {Promise<boolean>} - true if there were any changes, false otherwise
     */
    async __updateTransactions(config, urls) {
        try {
            const {txs, lastLedger} = await getLastTransactions(
                urls,
                this.__contractsState.lastLedger
            )
            logger.debug(`Fetched ${txs.length} transactions from horizon.`)
            for (const tx of txs) {
                try {
                    if (tx.inner_transaction) {
                        continue //skip inner transactions, they will be processed with their parent transaction
                    }
                    const isHostFnTx = xdr.TransactionResult.fromXDR(tx.result_xdr, 'base64').result().value().some(r => r.value().switch().name === 'invokeHostFunction')
                    if (isHostFnTx) {
                        const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64')
                        const operations = envelope.value().tx().operations()
                        for (let i = 0; i < operations.length; i++) {
                            const hostFunction = operations[i].body().value().hostFunction()
                            if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract')
                                continue
                            const fnName = hostFunction.value().functionName().toString()
                            const args = [...hostFunction.value().args()].map(v => scValToNative(v))
                            const contractId = Address.contract(hostFunction.value().contractAddress().contractId()).toString()
                            const state = this.__contractsState.clusterStatistics.get(contractId)
                            if (!state)
                                continue
                            const parser = getParser(state.type)?.fns?.[fnName]
                            if (!parser)
                                continue
                            //normalize data
                            parser({
                                source: {fn: fnName, args, txHash: tx.hash},
                                account: tx.source_account,
                                timestamp: BigInt(new Date(tx.created_at).getTime()),
                                ledger: tx.ledger_attr,
                                state
                            })
                        }
                    }
                } catch (err) {
                    logger.error({err, msg: `Error processing transaction ${tx.hash}`})
                }
            }
            this.__contractsState.lastLedger = lastLedger
        } catch (error) {
            logger.error(error)
            logger.error(`Error updating transactions: ${error.message}`)
            return false
        }
    }

    async __transactionsWorker() {
        try {
            const config = container?.configManager?.currentConfig
            if (!config)
                return
            //call each time to ensure that new contracts are added
            await this.__ensureState(config)

            const {urls, horizonUrls} = container.appConfig.getNetworkConfig(config.network)

            await Promise.all([this.__updateEntries(config, urls), this.__updateTransactions(config, horizonUrls)])

            const rawData = {
                lastLedger: this.__contractsState.lastLedger,
                clusterStatistics: mapToPlainObject(this.__contractsState.clusterStatistics)
            }
            //persist statistics
            StatisticsModel.findOneAndUpdate({}, {
                data: rawData
            }, {upsert: true}).exec().catch(err => {
                logger.error(`Error saving contract statistics: ${err.message}`)
            })
            logger.debug(`Transactions worker completed.`)
            logger.trace(`Current statistics state: ${Math.max(...Object.values(rawData.clusterStatistics).map(o => Object.keys(o.updates).length))}. Last ledger: ${rawData.lastLedger}`)
        } catch (error) {
            logger.error(`Error getting transactions: ${error.message}`)
        } finally {
            setTimeout(() => this.__transactionsWorker(), 1000 * 10) //run every 10 seconds
        }
    }
}

module.exports = TxStatisticsManager