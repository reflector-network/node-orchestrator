const {scValToNative, xdr, Address} = require('@stellar/stellar-sdk')
const {getContractInstanceEntries, mapToPlainObject, normalizeTimestamp} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const container = require('../container')
const {getLastTransactions} = require('../../utils/horizon-helper')
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
                        const arg = context.source.args[0] || {}
                        container.notificationsManager.report({
                            category: 'cluster',
                            type: 'DAO_BALLOT_CREATED',
                            message: 'Ballot created: ' + (arg.title || '(no title)') + ' - ' + (arg.description || ''),
                            recipient: {kind: 'monitoring'},
                            firstSeenAt: Number(context.timestamp),
                            dedupKey: 'dao:ballot:' + context.source.txHash
                        })
                        return false
                    },
                    "vote": (context) => {
                        container.notificationsManager.report({
                            category: 'cluster',
                            type: 'DAO_VOTE',
                            message: 'Vote on ballot ' + context.source.args[0] + ': ' + context.source.args[1] + ' by ' + (context.account || 'unknown'),
                            recipient: {kind: 'monitoring'},
                            firstSeenAt: Number(context.timestamp),
                            dedupKey: 'dao:vote:' + context.source.txHash
                        })
                        return false
                    }
                }
            }
        case "oracle":
        case "oracle_beam":
            return {
                fns: {"set_price": (context) => {
                    function restorePricesFromUpdate(update) {
                        const prices = []
                        let priceIndex = 0

                        for (let byte = 0; byte < 32; byte++) {
                            const maskByte = update.mask[byte]
                            if (maskByte === 0)
                                continue

                            for (let bit = 0; bit < 8; bit++) {
                                if (maskByte & (1 << bit)) {
                                    const assetIndex = byte * 8 + bit
                                    //fill gaps with zeros
                                    while (prices.length < assetIndex)
                                        prices.push(0n)
                                    prices.push(update.prices[priceIndex++])
                                }
                            }
                        }

                        return prices
                    }

                    const tsKey = context.source.args[1].toString()
                    context.state.addUpdate(tsKey, {
                        tx: context.source.txHash,
                        prices: restorePricesFromUpdate(context.source.args[0]),
                        signers: context.state.updates[tsKey]?.signers || []
                    })
                    return true
                }},
                entries: {"expiration": (context) => { //assetTtls is array of expiration timestamps
                    const {timestamp, state, source: assetTtls} = context

                    //v1 oracles
                    if (!assetTtls)
                        return

                    //max TTL or 0 if there are no active assets yet
                    const maxTtl = assetTtls.length > 0
                        ? BigInt(assetTtls.reduce((m, e) => e > m ? e : m))
                        : 0n

                    //ensure we have the expiration array initialized
                    state.entries.expiration ??= [[0n, 0n]]

                    const lastEntry = state.entries.expiration[state.entries.expiration.length - 1]

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
                        state.entries.expiration.push([timestamp, maxTtl])
                        return true
                    }
                }}
            }
        case "subscription":
            return {
                fns: {"trigger": (context) => {
                    context.state.updates[context.source.args[0]] = {tx: context.source.txHash}
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

const gracePeriod = 60 * 1000

function buildOracleTimeline(updates, signers, activeTtls, currentTime, timeframe, heartbeat, totalSlots = maxItemsToStore) {
    const slotsToProcess = Math.min(totalSlots, maxItemsToStore)
    const lastSlotTs = normalizeTimestamp(currentTime, timeframe)
    const nowTs = Date.now()

    const timeline = {}

    for (let i = 0; i < slotsToProcess; i++) {
        const ts = lastSlotTs - (i * timeframe)

        if (updates[ts] !== undefined) {
            timeline[ts] = {hash: updates[ts], signers: signers[ts] || []}
            continue
        }

        if (nowTs - ts < gracePeriod) {
            timeline[ts] = STATUS.PENDING
            continue
        }

        let isRequired = true
        if (heartbeat && normalizeTimestamp(ts, heartbeat) !== ts) {
            isRequired = false
        }

        const isWithinActiveRange = (activeTtls || []).some(([start, end]) =>
            ts >= BigInt(start) && ts <= BigInt(end)
        ) && isRequired

        timeline[ts] = isWithinActiveRange ? STATUS.MISSING : STATUS.INACTIVE
    }

    return timeline
}

function buildSubscriptionTimeline(updates, now, data) {
    const timeline = {}
    for (const triggerTimestamps of data) {
        const ts = Number(triggerTimestamps)
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
        this.account = account
        this.type = type
        this.__updates = {}
        this.__hashToUpdate = {}
        this.entries = {}
    }

    /**
     * @type {string}
     */
    account

    /**
     * Map of transaction hash by transaction timestamp
     * @type {Object<bigint, {tx: string, prices: Array<bigint>, signers: Array<string>}>}
     */
    get updates() {
        return this.__updates
    }

    getUpdateByHash(txHash) {
        const timestamp = this.__hashToUpdate[txHash]
        return timestamp !== undefined ? this.__updates[timestamp] : undefined
    }

    addUpdate(timestamp, update) {
        this.__updates[timestamp] = update
        this.__hashToUpdate[update.tx] = timestamp
        this.__pruneStateMaps()
    }

    toPlainObject() {
        return {
            account: this.account,
            type: this.type,
            updates: this.__updates,
            entries: this.entries
        }
    }

    __pruneStateMaps() {
        const tsKeys = Object.keys(this.__updates).map(ts => BigInt(ts))
        if (tsKeys.length <= maxItemsToStore)
            return
        const sorted = tsKeys.sort((a, b) => (a > b ? 1 : -1))
        while (sorted.length > maxItemsToStore) {
            const oldest = sorted[0].toString()
            const tx = this.__updates[oldest]?.tx
            delete this.__updates[oldest]
            delete this.__hashToUpdate[tx]
            sorted.shift()
        }
    }
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
                    data = buildOracleTimeline(
                        state.updates,
                        state.signers || {},
                        state.entries.expiration,
                        now,
                        contract.timeframe,
                        state.type === 'oracle_beam' ? extraData.priceHeartbeat : undefined,
                        300)
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

    /**
     * Append pubkey to state.signers[ts] for each hash in `hashes` that maps
     * to a known landed ts on the given contract. Hashes that don't resolve
     * are silently dropped (in-flight or pre-retention-window). Idempotent.
     *
     * @param {string} contractId
     * @param {string} pubkey
     * @param {string[]} hashes
     */
    recordSigners(contractId, pubkey, hashes) {
        if (!this.__contractsState || !pubkey || !hashes || hashes.length === 0)
            return
        const state = this.__contractsState.clusterStatistics.get(contractId)
        if (!state)
            return
        for (const hash of hashes) {
            const update = state.getUpdateByHash(hash)
            if (!update)
                continue
            logger.debug({msg: `Recording signer for hash ${hash}`, contractId, pubkey})
            const list = update.signers || (update.signers = [])
            if (!list.includes(pubkey))
                list.push(pubkey)
        }
    }

    /**
     * Compare the current round's prices against the previous round and
     * report PRICE_SPIKE events for assets that moved >= 20%.
     *
     * @param {string} contractId
     * @param {string} tsKey - timestamp of the freshly applied round
     */
    __detectPriceSpike(contractId, tsKey) {
        const state = this.__contractsState && this.__contractsState.clusterStatistics.get(contractId)
        const {assets, dataSource, type} = container.configManager.currentConfig?.contracts.get(contractId) || {}
        if (!state || !state.updates || !assets) {
            logger.debug({msg: 'Contract not found or missing data', contractId})
            return
        }
        const currentTs = BigInt(tsKey)
        const curr = state.updates[tsKey]?.prices
        if (!Array.isArray(curr))
            return
        function getPriceDiff(oldPrice, newPrice) {
            //if old price is 0 and new price is 0, or both 0 - skip the diff
            if (
                (oldPrice > 0n && newPrice === 0n)
                || (oldPrice === 0n && newPrice === 0n)
            )
                return 0
            //if old price is 0 and new price is not 0, return 100% diff
            else if (oldPrice === 0n && newPrice > 0n)
                return 0

            const absDiff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice
            const percentageDiff = (absDiff * 1000n) / oldPrice

            return Number(percentageDiff)
        }
        const descOrdered = Object.keys(state.updates)
            .filter((ts) => BigInt(ts) < currentTs)
            .map((ts) => BigInt(ts))
            .sort((a, b) => a > b ? -1 : a < b ? 1 : 0)
        for (let i = 0; i < curr.length; i++) {
            let prevPrice = 0n
            for (const ts of descOrdered) {
                prevPrice = state.updates[ts]?.prices?.[i] || 0n
                if (prevPrice > 0n)
                    break
            }
            const currentPrice = curr[i] || 0n
            if (prevPrice === 0n || currentPrice === 0n)
                continue
            const diff = getPriceDiff(prevPrice, currentPrice)
            if (diff < this.__changeThreshold)
                continue
            container.notificationsManager.report({
                category: 'oracle',
                scope: contractId,
                type: 'PRICE_SPIKE',
                message: `Asset ${assets[i].code} on oracle ${contractId} (${dataSource}, ${type}) moved ${prevPrice.toString()} → ${currentPrice.toString()} (${+(diff / 10).toFixed(2)}%) at ${tsKey}`,
                recipient: {kind: 'monitoring'},
                firstSeenAt: Number(currentTs),
                dedupKey: `oracle:${contractId}:asset:${i}:PRICE_SPIKE`
            })
        }
    }

    __changeThreshold = 200

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
                for (const [key, value] of Object.entries(stats.updates || {})) {
                    contractState.addUpdate(key, value)
                }
                contractState.entries = stats.entries || {}
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
                            let before
                            if (fnName === 'set_price' && state.type !== 'subscription' && args.length >= 2) {
                                before = state.updates[args[1].toString()]
                            }
                            parser({
                                source: {fn: fnName, args, txHash: tx.hash},
                                account: tx.source_account,
                                timestamp: BigInt(new Date(tx.created_at).getTime()),
                                ledger: tx.ledger_attr,
                                state
                            })
                            if (fnName === 'set_price' && state.type !== 'subscription' && args.length >= 2) {
                                const tsKey = args[1].toString()
                                if (state.updates[tsKey] && state.updates[tsKey] !== before)
                                    this.__detectPriceSpike(contractId, tsKey)
                            }
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

    __getParserFn(type, fnName) {
        return getParser(type).fns[fnName]
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
            try {
                await container.notificationsManager.flush()
            } catch (e) {
                logger.error(`NotificationsManager flush failed: ${e.message}`)
            }
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
module.exports.StatisticsData = StatisticsData