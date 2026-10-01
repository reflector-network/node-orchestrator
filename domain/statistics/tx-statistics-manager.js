const {scValToNative, xdr, Address} = require('@stellar/stellar-sdk')
const {getContractInstanceEntries, mapToPlainObject, normalizeTimestamp, ContractTypes} = require('@reflector/reflector-shared')
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
        case ContractTypes.DAO:
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
        case ContractTypes.ORACLE:
        case ContractTypes.ORACLE_BEAM:
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
        case ContractTypes.SUBSCRIPTIONS:
            return {
                fns: {"trigger": (context) => {
                    //through addUpdate, so the rounds are capped like an oracle's and each is found by its hash: a
                    //contract with events triggers once a minute, and every contract shares one statistics document
                    context.state.addUpdate(String(context.source.args[0]), {tx: context.source.txHash})
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

function buildOracleTimeline(updates, activeTtls, currentTime, timeframe, heartbeat, totalSlots = maxItemsToStore) {
    const slotsToProcess = Math.min(totalSlots, maxItemsToStore)
    const lastSlotTs = normalizeTimestamp(currentTime, timeframe)
    const nowTs = Date.now()

    const timeline = {}

    for (let i = 0; i < slotsToProcess; i++) {
        const ts = lastSlotTs - (i * timeframe)

        if (updates[ts]?.tx !== undefined) {
            timeline[ts] = {tx: updates[ts].tx, signers: updates[ts].signers || []}
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

/**
 * Build the timeline of a subscriptions contract from the trigger rounds that were actually recorded. The previous
 * signature took the `getStatistics` extra-data object as a third argument and iterated it, which threw.
 * @param {Object<string, {tx: string, signers: string[]}>} updates - recorded trigger rounds by timestamp
 * @param {number} now - current time in milliseconds
 * @returns {Object<number, any>}
 */
function buildSubscriptionTimeline(updates, now) {
    const timeline = {}
    const timestamps = Object.keys(updates)
        .map(Number)
        .filter(ts => Number.isFinite(ts))
        .sort((a, b) => b - a)
        .slice(0, maxItemsToStore)
    for (const ts of timestamps) {
        if (updates[ts]?.tx !== undefined) {
            timeline[ts] = {tx: updates[ts].tx, signers: updates[ts].signers || []}
            continue
        }
        timeline[ts] = now - ts < gracePeriod ? STATUS.PENDING : STATUS.MISSING
    }
    return timeline
}

/**
 * Returns the transaction of an envelope, unwrapping a fee bump. Horizon reports a fee-bump transaction as a single
 * record carrying the fee-bump envelope, so skipping records with `inner_transaction` skipped the invocation entirely.
 * Under js-xdr 5 a union exposes `.type` and `.value`, not `.switch()`.
 * @param {xdr.TransactionEnvelope} envelope - parsed transaction envelope
 * @returns {any} the v0/v1 transaction that carries the operations
 */
function getInnerTransaction(envelope) {
    if (envelope.type === 'envelopeTypeTxFeeBump')
        return envelope.value.tx.innerTx.value.tx
    return envelope.value.tx
}

/**
 * Returns the operation results of a transaction result, unwrapping a fee bump
 * @param {xdr.TransactionResult} result - parsed transaction result
 * @returns {any[]} operation results, empty when the transaction ran no operations
 */
function getOperationResults(result) {
    let inner = result.result
    if (inner.type === 'txFeeBumpInnerSuccess' || inner.type === 'txFeeBumpInnerFailed')
        inner = inner.value.result.result
    return Array.isArray(inner.value) ? inner.value : []
}

/**
 * BSON encodes a bigint as int64 and silently wraps anything at or above 2^63, which prices exceed at 14 decimals, so
 * every bigint is persisted as a decimal string.
 * @param {any} value - value about to be written to MongoDB
 * @returns {any}
 */
function toStorable(value) {
    if (typeof value === 'bigint')
        return value.toString()
    if (Array.isArray(value))
        return value.map(toStorable)
    if (value && typeof value === 'object') {
        const result = {}
        for (const [key, item] of Object.entries(value))
            result[key] = toStorable(item)
        return result
    }
    return value
}

/**
 * @param {any} value - decimal string, number or bigint read back from MongoDB
 * @returns {bigint} 0n when the value cannot be parsed
 */
function toBigInt(value) {
    if (typeof value === 'bigint')
        return value
    try {
        return BigInt(value)
    } catch (e) {
        return 0n
    }
}

/**
 * @param {any} update - one persisted round
 * @returns {any} the same round with its price vector back in bigints
 */
function parseStoredUpdate(update) {
    if (!update || typeof update !== 'object' || !Array.isArray(update.prices))
        return update
    return {...update, prices: update.prices.map(toBigInt)}
}

/**
 * @param {any} entries - persisted contract entries
 * @returns {any} the same entries with the expiration ranges back in bigints
 */
function parseStoredEntries(entries) {
    if (!entries || !Array.isArray(entries.expiration))
        return entries || {}
    return {
        ...entries,
        expiration: entries.expiration
            .filter(range => Array.isArray(range) && range.length === 2)
            .map(([from, to]) => [toBigInt(from), toBigInt(to)])
    }
}

/**
 * The stored snapshot was read but its content cannot be loaded. By the time this is thrown the document is already
 * in memory and interpreting it does no i/o, so every later read of the same snapshot fails the same way
 */
class MalformedSnapshotError extends Error {
    /**
     * @param {Error} cause - what failed while the snapshot was interpreted
     */
    constructor(cause) {
        super(`Contract statistics snapshot is malformed: ${cause?.message}`, {cause})
        this.name = 'MalformedSnapshotError'
    }
}

/**
 * @param {any} value - value to check
 * @returns {boolean} true for an object that is neither null nor an array
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {any} value - value to check
 * @returns {boolean} true when the value is absent or an object
 */
function isOptionalObject(value) {
    return value === undefined || value === null || isObject(value)
}

/**
 * @param {any} err - error thrown by a MongoDB command
 * @returns {boolean} true when the command's source collection does not exist
 */
function isNamespaceNotFound(err) {
    return err?.code === 26 || err?.codeName === 'NamespaceNotFound'
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
        let normalizedUpdate = update
        if (!normalizedUpdate?.tx)
            normalizedUpdate = {tx: normalizedUpdate}
        this.__updates[timestamp] = normalizedUpdate
        this.__hashToUpdate[normalizedUpdate.tx] = timestamp
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

    /**
     * @type {boolean} true once the persisted snapshot has been dealt with: loaded, absent, or found malformed and
     * replaced by a fresh state
     */
    __stateLoaded = false

    /**
     * @type {MalformedSnapshotError|null} set while a malformed snapshot is still under its original name because
     * moving it aside failed; nothing is persisted over it until the move succeeds
     */
    __malformedSnapshot = null

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
                case ContractTypes.ORACLE:
                case ContractTypes.ORACLE_BEAM:
                    data = buildOracleTimeline(
                        state.updates,
                        state.entries.expiration,
                        now,
                        contract.timeframe,
                        state.type === ContractTypes.ORACLE_BEAM ? extraData.priceHeartbeat : undefined,
                        300)
                    break
                case ContractTypes.SUBSCRIPTIONS:
                    data = buildSubscriptionTimeline(state.updates, now)
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
                dedupKey: `oracle:${contractId}:asset:${i}:${tsKey}:PRICE_SPIKE`
            })
        }
    }

    __changeThreshold = 200

    /**
     * Loads the persisted snapshot into the current state. A read that rejects propagates unchanged: it says nothing
     * about the content (a lost connection, missing permissions, a lock), so the caller retries it. Anything that fails
     * once the document is in hand is thrown as MalformedSnapshotError, because it would fail the same way on every read
     *
     */
    async __loadContractStatistics() {
        const doc = await StatisticsModel.findOne().exec()
        if (!doc)
            return
        try {
            const {data} = doc.toPlainObject()
            if (!isObject(data) || !isObject(data.clusterStatistics))
                throw new Error('the snapshot holds no clusterStatistics object')
            //the cursor is incremented and compared as a number: a string would concatenate and a bigint would throw
            if (!Number.isSafeInteger(data.lastLedger))
                throw new Error(`lastLedger is not an integer: ${typeof data.lastLedger} ${String(data.lastLedger)}`)
            for (const [contractId, stats] of Object.entries(data.clusterStatistics)) {
                const contractState = this.__contractsState.clusterStatistics.get(contractId)
                if (!contractState) {
                    logger.trace(`Loading statistics from db. ${contractId} is not part of the current config. Skipping.`)
                    continue
                }
                if (!isObject(stats) || !isOptionalObject(stats.updates) || !isOptionalObject(stats.entries))
                    throw new Error(`the statistics of ${contractId} are not an object of updates and entries`)
                for (const [key, value] of Object.entries(stats.updates || {})) {
                    contractState.addUpdate(key, parseStoredUpdate(value))
                }
                contractState.entries = parseStoredEntries(stats.entries)
            }
            this.__contractsState.lastLedger = data.lastLedger
        } catch (err) {
            throw new MalformedSnapshotError(err)
        }
    }

    /**
     * Moves the malformed snapshot aside under a timestamped collection name next to the original, where it stays for
     * inspection, and clears `__malformedSnapshot` once nothing is left under the original name. Never throws: while the
     * move fails, statistics keep updating from the fresh state without being persisted, and the next tick retries the
     * move under that tick's name
     */
    async __quarantineSnapshot() {
        const {collection} = StatisticsModel
        const target = `${collection.collectionName}_quarantined_${new Date(Date.now()).toISOString().replace(/[-:.]/g, '')}`
        const location = [StatisticsModel.db?.name, target].filter(Boolean).join('.')
        try {
            await collection.rename(target)
            logger.error({err: this.__malformedSnapshot, msg: `Contract statistics snapshot is malformed; moved it aside to ${location} and started fresh`})
        } catch (err) {
            if (!isNamespaceNotFound(err)) {
                logger.error({err, msg: `Contract statistics snapshot is malformed and could not be moved aside to ${location}; statistics continue from a fresh state, unpersisted, and the move is retried on the next tick`})
                return
            }
            //nothing is left under the original name (an earlier move whose reply was lost, or a removal by hand), so the
            //fresh state overwrites nothing
            logger.warn({err: this.__malformedSnapshot, msg: 'The malformed contract statistics snapshot is no longer in place; persisting the fresh state'})
        }
        this.__malformedSnapshot = null
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
        const ensureContractsSetup = () => {
            if (this.__contractsState === null)
                this.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
            for (const contract of config.contracts.values())
                ensureContractSetup(contract)
            //system account
            ensureContractSetup({contractId: 'system', admin: config.systemAccount, type: 'system'})
        }
        ensureContractsSetup()
        if (this.__stateLoaded) {
            if (this.__malformedSnapshot)
                await this.__quarantineSnapshot()
            return
        }
        try {
            await this.__loadContractStatistics()
        } catch (err) {
            //a snapshot that could not be read this time propagates: the flag stays down, the next tick reads it again,
            //and nothing is persisted over it meanwhile
            if (!(err instanceof MalformedSnapshotError))
                throw err
            //the content itself cannot be loaded and never will be, so the snapshot is moved aside and statistics start
            //over; whatever the load applied before it failed goes with the old state
            this.__contractsState = null
            ensureContractsSetup()
            this.__malformedSnapshot = err
            await this.__quarantineSnapshot()
        }
        this.__stateLoaded = true
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
                //a failed transaction landed no round; horizon leaves them out unless include_failed is requested, and
                //this keeps them out whatever the request asks for. The flag is required in the sdk's TransactionRecord
                if (tx.successful !== true)
                    continue
                try {
                    const operationResults = getOperationResults(xdr.TransactionResult.fromXdr(tx.result_xdr, 'base64'))
                    const isHostFnTx = operationResults.some(r => r.value && r.value.type === 'invokeHostFunction')
                    if (isHostFnTx) {
                        const envelope = xdr.TransactionEnvelope.fromXdr(tx.envelope_xdr, 'base64')
                        const operations = getInnerTransaction(envelope).operations
                        for (let i = 0; i < operations.length; i++) {
                            const hostFunction = operations[i].body.value.hostFunction
                            if (hostFunction.type !== 'hostFunctionTypeInvokeContract')
                                continue
                            const fnName = hostFunction.value.functionName.toString()
                            const args = [...hostFunction.value.args].map(v => scValToNative(v))
                            const contractId = Address.contract(hostFunction.value.contractAddress.contractId.toBytes()).toString()
                            const state = this.__contractsState.clusterStatistics.get(contractId)
                            if (!state)
                                continue
                            const parser = getParser(state.type)?.fns?.[fnName]
                            if (!parser)
                                continue
                            let before
                            if (fnName === 'set_price' && state.type !== ContractTypes.SUBSCRIPTIONS && args.length >= 2) {
                                before = state.updates[args[1].toString()]
                            }
                            parser({
                                source: {fn: fnName, args, txHash: tx.hash},
                                account: tx.source_account,
                                timestamp: BigInt(new Date(tx.created_at).getTime()),
                                ledger: tx.ledger_attr,
                                state
                            })
                            if (fnName === 'set_price' && state.type !== ContractTypes.SUBSCRIPTIONS && args.length >= 2) {
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

            const rawData = toStorable({
                lastLedger: this.__contractsState.lastLedger,
                clusterStatistics: mapToPlainObject(this.__contractsState.clusterStatistics)
            })
            //nothing is written over a snapshot that has not been read, or over a malformed one that is still in place
            //because moving it aside failed; the round itself goes on. A failed read already throws out of
            //__ensureState above, so the first condition is defence in depth
            if (this.__stateLoaded && !this.__malformedSnapshot) {
                //persist statistics
                StatisticsModel.findOneAndUpdate({}, {
                    data: rawData
                }, {upsert: true}).exec().catch(err => {
                    logger.error(`Error saving contract statistics: ${err.message}`)
                })
            } else {
                logger.warn('Contract statistics snapshot is not settled yet; skipping persistence for this tick')
            }
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
module.exports.toStorable = toStorable