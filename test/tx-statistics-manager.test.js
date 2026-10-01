/*eslint-disable no-undef */
jest.useFakeTimers()
//eslint-disable-next-line no-var
var mockStatisticsState = {value: null, findOneError: null, saved: null, renameError: null, renamed: []}
jest.mock('../domain/container', () => ({
    appConfig: {getNetworkConfig: () => ({urls: [], horizonUrls: []})},
    configManager: {currentConfig: null},
    notificationsManager: {report: jest.fn(), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined)}
}))
jest.mock('../persistence-layer/models/statistics', () => ({
    db: {name: 'orchestrator'},
    collection: {
        collectionName: 'statistics',
        //a rename that goes through leaves nothing under the original name, as MongoDB's renameCollection does
        rename: target => {
            mockStatisticsState.renamed.push(target)
            if (mockStatisticsState.renameError)
                return Promise.reject(mockStatisticsState.renameError)
            mockStatisticsState.value = null
            return Promise.resolve({collectionName: target})
        }
    },
    findOne: () => ({
        exec: () => {
            if (mockStatisticsState.findOneError)
                return Promise.reject(mockStatisticsState.findOneError)
            return Promise.resolve(mockStatisticsState.value)
        }
    }),
    findOneAndUpdate: (filter, update) => {
        mockStatisticsState.saved = update
        return {exec: () => Promise.resolve(null)}
    }
}))
jest.mock('../utils/horizon-helper', () => ({getLastTransactions: jest.fn()}))

const {TransactionBuilder, Account, Contract, Keypair, Networks, nativeToScVal, Transaction, Operation, Asset, xdr} = require('@stellar/stellar-sdk')
const {BSON} = require('mongoose').mongo
const container = require('../domain/container')
const TxStatisticsManager = require('../domain/statistics/tx-statistics-manager')
const {getLastTransactions} = require('../utils/horizon-helper')
const logger = require('../logger')
const StatisticsModel = require('../persistence-layer/models/statistics')
const {normalizeValues} = require('../persistence-layer/utils')

//build a 32-byte price mask with the given asset indices set. The set_price parser
//(restorePricesFromUpdate) walks this mask bit-by-bit to reconstruct the prices array.
function maskFor(indices) {
    const mask = new Array(32).fill(0)
    for (const idx of indices)
        mask[Math.floor(idx / 8)] |= (1 << (idx % 8))
    return mask
}

describe('TxStatisticsManager state fields', () => {
    test('StatisticsData starts with an empty updates map', () => {
        const s = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        expect(s.updates).toEqual({})
    })
})

describe('TxStatisticsManager set_price parser', () => {
    test('captures hash, prices, and initializes signers slot', () => {
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('oracle', 'set_price')
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        const changed = parser({
            source: {fn: 'set_price', args: [{mask: maskFor([0, 1, 2]), prices: [1n, 2n, 3n]}, 1700000000n], txHash: 'TXH1'},
            account: 'GADMIN',
            timestamp: 1700000000n,
            state
        })
        expect(changed).toBe(true)
        expect(Object.keys(state.updates)).toEqual(['1700000000'])
        expect(state.updates['1700000000']).toEqual({tx: 'TXH1', prices: [1n, 2n, 3n], signers: []})
        //the hash index resolves back to the same round object
        expect(state.getUpdateByHash('TXH1')).toBe(state.updates['1700000000'])
    })

    test('prunes oldest rounds beyond the retention cap', () => {
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('oracle', 'set_price')
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        //insert 257 rounds - one over the 256 cap
        for (let i = 0n; i < 257n; i++) {
            parser({
                source: {fn: 'set_price', args: [{mask: maskFor([0]), prices: [i]}, i], txHash: 'TX' + i},
                account: 'GADMIN',
                timestamp: i,
                state
            })
        }
        expect(Object.keys(state.updates).length).toBe(256)
        //oldest (ts 0) evicted from both the update map and the hash index
        expect(state.updates['0']).toBeUndefined()
        expect(state.getUpdateByHash('TX0')).toBeUndefined()
        //newest retained
        expect(state.updates['256']).toBeDefined()
    })
})

describe('TxStatisticsManager recordSigners', () => {
    function seed(mgr) {
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        state.addUpdate('100', {tx: 'H1', prices: [1n], signers: []})
        state.addUpdate('200', {tx: 'H2', prices: [2n], signers: []})
        state.addUpdate('300', {tx: 'H3', prices: [3n], signers: []})
        mgr.__contractsState.clusterStatistics.set('C1', state)
        return state
    }

    test('appends pubkey to the matched round signers for each hash', () => {
        const mgr = new TxStatisticsManager()
        const state = seed(mgr)
        mgr.recordSigners('C1', 'GNODEA', ['H1', 'H2'])
        expect(state.getUpdateByHash('H1').signers).toEqual(['GNODEA'])
        expect(state.getUpdateByHash('H2').signers).toEqual(['GNODEA'])
        expect(state.getUpdateByHash('H3').signers).toEqual([])
    })

    test('idempotent - duplicate pubkey not appended twice', () => {
        const mgr = new TxStatisticsManager()
        const state = seed(mgr)
        mgr.recordSigners('C1', 'GNODEA', ['H1'])
        mgr.recordSigners('C1', 'GNODEA', ['H1'])
        expect(state.getUpdateByHash('H1').signers).toEqual(['GNODEA'])
    })

    test('unmatched hashes are silently dropped', () => {
        const mgr = new TxStatisticsManager()
        const state = seed(mgr)
        expect(() => mgr.recordSigners('C1', 'GNODEA', ['UNKNOWNHASH'])).not.toThrow()
        expect(state.getUpdateByHash('H1').signers).toEqual([])
        expect(state.getUpdateByHash('H2').signers).toEqual([])
        expect(state.getUpdateByHash('H3').signers).toEqual([])
    })

    test('unknown contractId is a no-op', () => {
        const mgr = new TxStatisticsManager()
        seed(mgr)
        expect(() => mgr.recordSigners('UNKNOWN_CONTRACT', 'GNODEA', ['H1'])).not.toThrow()
    })

    test('resolves rounds added after a prior recordSigners call', () => {
        const mgr = new TxStatisticsManager()
        const state = seed(mgr)
        mgr.recordSigners('C1', 'GNODEA', ['H1']) //touch the index first
        //add a new round through the parser
        const parser = mgr.__getParserFn('oracle', 'set_price')
        parser({
            source: {fn: 'set_price', args: [{mask: maskFor([0]), prices: [4n]}, 400n], txHash: 'H4'},
            account: 'GADMIN',
            timestamp: 400n,
            state
        })
        mgr.recordSigners('C1', 'GNODEB', ['H4'])
        expect(state.getUpdateByHash('H4').signers).toEqual(['GNODEB'])
    })
})

describe('TxStatisticsManager __detectPriceSpike', () => {
    const notificationsManager = container.notificationsManager

    //the source default __changeThreshold (20) is expressed in the same per-mille units
    //getPriceDiff returns, where a 20% move == 200. Override to 200 so these tests assert
    //the documented "moved >= 20%" semantics.
    function setup(prevPrices, currPrices) {
        notificationsManager.report.mockClear()
        const mgr = new TxStatisticsManager()
        mgr.__changeThreshold = 200
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = {
            updates: {
                '100': {tx: 'H1', prices: prevPrices, signers: []},
                '200': {tx: 'H2', prices: currPrices, signers: []}
            },
            type: 'oracle',
            account: 'GADMIN',
            entries: {}
        }
        mgr.__contractsState.clusterStatistics.set('C1', state)
        container.configManager.currentConfig = {
            contracts: new Map([['C1', {assets: [{code: 'A'}, {code: 'B'}, {code: 'C'}], dataSource: 'pubnet', type: 'oracle'}]])
        }
        return {mgr, state}
    }

    afterEach(() => {
        container.configManager.currentConfig = null
    })

    test('no event when no prior round exists', () => {
        notificationsManager.report.mockClear()
        const mgr = new TxStatisticsManager()
        mgr.__changeThreshold = 200
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = {updates: {'200': {tx: 'H2', prices: [100n], signers: []}}, type: 'oracle', account: 'GADMIN', entries: {}}
        mgr.__contractsState.clusterStatistics.set('C1', state)
        container.configManager.currentConfig = {contracts: new Map([['C1', {assets: [{code: 'A'}], dataSource: 'd', type: 'oracle'}]])}
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })

    test('no event when delta < 20%', () => {
        const {mgr} = setup([100n], [115n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })

    test('emits per-asset event when delta >= 20%', () => {
        const {mgr} = setup([100n, 100n], [120n, 100n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).toHaveBeenCalledTimes(1)
        const call = notificationsManager.report.mock.calls[0][0]
        expect(call.type).toBe('PRICE_SPIKE')
        expect(call.scope).toBe('C1')
        expect(call.dedupKey).toBe('oracle:C1:asset:0:200:PRICE_SPIKE')
        expect(call.recipient).toEqual({kind: 'monitoring'})
        expect(call.message).toMatch(/100/) //includes prev
        expect(call.message).toMatch(/120/) //includes curr
    })

    test('emits one event per offending asset in multi-asset round', () => {
        const {mgr} = setup([100n, 100n, 100n], [120n, 105n, 80n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).toHaveBeenCalledTimes(2)
        const keys = notificationsManager.report.mock.calls.map(c => c[0].dedupKey)
        expect(keys).toEqual(expect.arrayContaining([
            'oracle:C1:asset:0:200:PRICE_SPIKE',
            'oracle:C1:asset:2:200:PRICE_SPIKE'
        ]))
    })

    test('skips assets where prev is 0n', () => {
        const {mgr} = setup([0n], [100n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })

    test('skips assets where curr is 0n', () => {
        const {mgr} = setup([100n], [0n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })

    test('skips assets where prev is undefined', () => {
        const {mgr} = setup([undefined, 100n], [100n, 110n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })

    test('skips assets where curr is null', () => {
        const {mgr} = setup([100n, 100n], [null, 110n])
        mgr.__detectPriceSpike('C1', '200')
        expect(notificationsManager.report).not.toHaveBeenCalled()
    })
})

describe('TxStatisticsManager DAO parser', () => {
    const notificationsManager = require('../domain/container').notificationsManager

    test('create_ballot reports DAO_BALLOT_CREATED through notificationsManager', () => {
        notificationsManager.report.mockClear()
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('dao', 'create_ballot')
        const state = {updates: {}, prices: {}, signers: {}, entries: {}}
        parser({
            source: {fn: 'create_ballot', args: [{title: 'T', description: 'D'}], txHash: 'TXBALLOT'},
            timestamp: 1700n,
            state
        })
        expect(notificationsManager.report).toHaveBeenCalledTimes(1)
        const evt = notificationsManager.report.mock.calls[0][0]
        expect(evt.type).toBe('DAO_BALLOT_CREATED')
        expect(evt.dedupKey).toBe('dao:ballot:TXBALLOT')
        expect(evt.recipient).toEqual({kind: 'monitoring'})
        expect(evt.message).toContain('T')
        expect(evt.message).toContain('D')
    })

    test('vote reports DAO_VOTE through notificationsManager', () => {
        notificationsManager.report.mockClear()
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('dao', 'vote')
        const state = {updates: {}, prices: {}, signers: {}, entries: {}}
        parser({
            source: {fn: 'vote', args: ['BALLOT1', 'yes'], txHash: 'TXVOTE'},
            account: 'GVOTER',
            timestamp: 1800n,
            state
        })
        expect(notificationsManager.report).toHaveBeenCalledTimes(1)
        const evt = notificationsManager.report.mock.calls[0][0]
        expect(evt.type).toBe('DAO_VOTE')
        expect(evt.dedupKey).toBe('dao:vote:TXVOTE')
        expect(evt.message).toContain('BALLOT1')
        expect(evt.message).toContain('yes')
    })

    test('DAO StatisticsData no longer carries notifications field', () => {
        const s = new TxStatisticsManager.StatisticsData('GADMIN', 'dao')
        expect(s.notifications).toBeUndefined()
    })
})

describe('TxStatisticsManager getTimelines shape', () => {
    test('oracle slots emit {tx, signers} for landed rounds', () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const now = Date.now()
        const tf = 60 * 1000
        const landedTs = Math.floor(now / tf) * tf - tf //one slot ago
        const state = {
            updates: {[landedTs]: {tx: 'HASHX', signers: ['GNODEA', 'GNODEB']}},
            prices: {[landedTs]: [1n]},
            type: 'oracle',
            account: 'GADMIN',
            entries: {expiration: [[0n, BigInt(now) + 1000000n]]}
        }
        mgr.__contractsState.clusterStatistics.set('C1', state)
        const result = mgr.getTimelines(
            [{contractId: 'C1', type: 'oracle', timeframe: tf}],
            {priceHeartbeat: 0}
        )
        expect(result.C1[landedTs]).toEqual({tx: 'HASHX', signers: ['GNODEA', 'GNODEB']})
    })

    test('landed slot with no recorded signers emits empty array', () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const now = Date.now()
        const tf = 60 * 1000
        const landedTs = Math.floor(now / tf) * tf - tf
        const state = {
            updates: {[landedTs]: {tx: 'HASHY'}}, //no signer recorded yet
            prices: {[landedTs]: [1n]},
            type: 'oracle',
            account: 'GADMIN',
            entries: {expiration: [[0n, BigInt(now) + 1000000n]]}
        }
        mgr.__contractsState.clusterStatistics.set('C1', state)
        const result = mgr.getTimelines(
            [{contractId: 'C1', type: 'oracle', timeframe: tf}],
            {priceHeartbeat: 0}
        )
        expect(result.C1[landedTs]).toEqual({tx: 'HASHY', signers: []})
    })

    test('missing/pending/inactive slots remain bare STATUS numbers', () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const now = Date.now()
        const tf = 60 * 1000
        const state = {
            updates: {},
            prices: {},
            signers: {},
            type: 'oracle',
            account: 'GADMIN',
            entries: {expiration: [[0n, BigInt(now) + 1000000n]]}
        }
        mgr.__contractsState.clusterStatistics.set('C1', state)
        const result = mgr.getTimelines(
            [{contractId: 'C1', type: 'oracle', timeframe: tf}],
            {priceHeartbeat: 0}
        )
        for (const v of Object.values(result.C1))
            expect(typeof v).toBe('number') //-1, 0, or 1
    })
})

const ORACLE_CONTRACT = 'CBMZO5MRIBFL457FBK5FEWZ4QJTYL3XWID7QW7SWDSDOQI5H4JN7XPZU'
//the matching fee-bump result: txFeeBumpInnerSuccess wrapping one invokeHostFunction op result
const FEE_BUMP_RESULT = 'AAAAAAAAAMgAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZAAAAAAAAAABAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='

/**
 * Builds a fee-bump envelope wrapping one invokeHostFunction `set_price` call on ORACLE_CONTRACT.
 * The fixture is built rather than pasted so the test does not depend on a magic string: the mask has bit 0 set,
 * so the parser reconstructs a single price of 10^19, and the timestamp argument is 1700000000.
 * @returns {string} base64 fee-bump transaction envelope
 */
function feeBumpEnvelope() {
    const inner = Keypair.random()
    const feeSource = Keypair.random()
    const mask = Buffer.alloc(32)
    mask[0] = 1
    const update = nativeToScVal({mask, prices: [10n ** 19n]}, {type: {mask: ['symbol', 'bytes'], prices: ['symbol', 'i128']}})
    const tx = new TransactionBuilder(new Account(inner.publicKey(), '100'), {fee: '100', networkPassphrase: Networks.TESTNET})
        .addOperation(new Contract(ORACLE_CONTRACT).call('set_price', update, nativeToScVal(1700000000, {type: 'u64'})))
        .setTimeout(300)
        .build()
    tx.sign(inner)
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(feeSource, '400', tx, Networks.TESTNET)
    feeBump.sign(feeSource)
    return feeBump.toEnvelope().toXDR('base64')
}

describe('fee-bump transactions', () => {
    test('a fee-bumped set_price is parsed instead of skipped', async () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 100, clusterStatistics: new Map()}
        mgr.__stateLoaded = true
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        mgr.__contractsState.clusterStatistics.set(ORACLE_CONTRACT, state)
        getLastTransactions.mockResolvedValue({
            lastLedger: 105,
            txs: [{
                hash: 'FEEBUMPHASH',
                successful: true, //horizon marks every record; only successful ones land a round
                inner_transaction: {hash: 'INNERHASH'},
                envelope_xdr: feeBumpEnvelope(),
                result_xdr: FEE_BUMP_RESULT,
                created_at: new Date(1700000000000).toISOString(),
                ledger_attr: 105,
                source_account: 'GFEESOURCE'
            }]
        })

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates['1700000000']).toEqual({tx: 'FEEBUMPHASH', prices: [10000000000000000000n], signers: []})
        expect(mgr.__contractsState.lastLedger).toBe(105)
    })
})

describe('snapshot load flag', () => {
    const config = {contracts: new Map(), systemAccount: 'GSYSTEM'}

    beforeEach(() => {
        mockStatisticsState.value = null
        mockStatisticsState.findOneError = null
        mockStatisticsState.saved = null
    })

    afterEach(() => {
        //a failing test must not leave a config behind: the next constructor would run a worker tick against it
        container.configManager.currentConfig = null
    })

    test('a failed load leaves the state unloaded so the next tick retries it', async () => {
        const mgr = new TxStatisticsManager()
        mockStatisticsState.findOneError = new Error('db down')

        await expect(mgr.__ensureState(config)).rejects.toThrow('db down')
        expect(mgr.__stateLoaded).toBe(false)

        mockStatisticsState.findOneError = null
        await mgr.__ensureState(config)
        expect(mgr.__stateLoaded).toBe(true)
    })

    test('nothing is persisted while the snapshot has not loaded', async () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        mgr.__stateLoaded = false
        container.configManager.currentConfig = config
        //horizon has nothing new, so the cursor stays wherever the snapshot load left it
        getLastTransactions.mockImplementation((urls, lastLedger) => Promise.resolve({lastLedger, txs: []}))
        mockStatisticsState.findOneError = new Error('db down')

        //tick 1: the snapshot cannot be read, so the empty in-memory state must not be written over it
        await mgr.__transactionsWorker()
        expect(mockStatisticsState.saved).toBeNull()

        //tick 2: the database is back, so the snapshot is loaded first and only then persisted
        mockStatisticsState.findOneError = null
        mockStatisticsState.value = {toPlainObject: () => ({data: {lastLedger: 42, clusterStatistics: {}}})}

        await mgr.__transactionsWorker()

        //the old __ensureState returned early because __contractsState was already set, so it persisted 0
        expect(mgr.__contractsState.lastLedger).toBe(42)
        expect(mockStatisticsState.saved.data.lastLedger).toBe(42)
        container.configManager.currentConfig = null
    })

    test('a loaded snapshot is read once, not again on every tick', async () => {
        const mgr = new TxStatisticsManager()
        mockStatisticsState.value = {toPlainObject: () => ({data: {lastLedger: 42, clusterStatistics: {}}})}
        const findOne = jest.spyOn(StatisticsModel, 'findOne')

        await mgr.__ensureState(config)
        mgr.__contractsState.lastLedger = 50 //the scan moved on after the load
        await mgr.__ensureState(config)

        expect(findOne).toHaveBeenCalledTimes(1)
        expect(mgr.__contractsState.lastLedger).toBe(50) //a second load would have wound the cursor back to 42
        findOne.mockRestore()
    })

    test('the persistence guard holds when a caller reaches it with the snapshot unloaded', async () => {
        //a failed load throws out of __ensureState before the guard, so the guard is only reachable through a caller
        //that returns without loading; stubbing __ensureState stands in for that caller
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 7, clusterStatistics: new Map()}
        mgr.__stateLoaded = false
        mgr.__ensureState = () => Promise.resolve()
        container.configManager.currentConfig = config
        getLastTransactions.mockImplementation((urls, lastLedger) => Promise.resolve({lastLedger, txs: []}))

        await mgr.__transactionsWorker()

        expect(mockStatisticsState.saved).toBeNull()
        container.configManager.currentConfig = null
    })
})

//one successful invokeHostFunction operation result, the shape a set_price that applied leaves behind
const invokeHostFunctionSuccess = () => xdr.OperationResult.opInner(
    xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionSuccess(Buffer.alloc(32))))

/**
 * Encodes a successful plain transaction result through the sdk
 * @param {xdr.OperationResult} opResult - the single operation result
 * @returns {string} base64 TransactionResult
 */
function plainResult(opResult) {
    return new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txSuccess([opResult]),
        ext: xdr.TransactionResultExt.v0()
    }).toXDR('base64')
}

/**
 * Encodes a successful fee-bump transaction result wrapping one inner operation result through the sdk
 * @param {xdr.OperationResult} opResult - the single inner operation result
 * @returns {string} base64 TransactionResult
 */
function feeBumpResult(opResult) {
    const inner = new xdr.InnerTransactionResult({
        feeCharged: 100n,
        result: xdr.InnerTransactionResultResult.txSuccess([opResult]),
        ext: xdr.InnerTransactionResultExt.v0()
    })
    const pair = new xdr.InnerTransactionResultPair({transactionHash: Buffer.alloc(32), result: inner})
    return new xdr.TransactionResult({
        feeCharged: 200n,
        result: xdr.TransactionResultResult.txFeeBumpInnerSuccess(pair),
        ext: xdr.TransactionResultExt.v0()
    }).toXDR('base64')
}

/**
 * Encodes through the sdk the result of a transaction whose set_price trapped. A failed result still carries its
 * operation results, so it reads as an invokeHostFunction transaction
 * @param {boolean} feeBumped - wrap the failed inner result in txFeeBumpInnerFailed
 * @returns {string} base64 TransactionResult
 */
function failedResult(feeBumped) {
    const trapped = xdr.OperationResult.opInner(
        xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()))
    if (!feeBumped)
        return new xdr.TransactionResult({
            feeCharged: 100n,
            result: xdr.TransactionResultResult.txFailed([trapped]),
            ext: xdr.TransactionResultExt.v0()
        }).toXDR('base64')
    const inner = new xdr.InnerTransactionResult({
        feeCharged: 100n,
        result: xdr.InnerTransactionResultResult.txFailed([trapped]),
        ext: xdr.InnerTransactionResultExt.v0()
    })
    const pair = new xdr.InnerTransactionResultPair({transactionHash: Buffer.alloc(32), result: inner})
    return new xdr.TransactionResult({
        feeCharged: 200n,
        result: xdr.TransactionResultResult.txFeeBumpInnerFailed(pair),
        ext: xdr.TransactionResultExt.v0()
    }).toXDR('base64')
}

/**
 * The plain envelope of the transaction a fee bump wraps: the same signed set_price, submitted without the bump
 * @returns {string} base64 v1 transaction envelope
 */
function plainEnvelope() {
    return TransactionBuilder.fromXDR(feeBumpEnvelope(), Networks.TESTNET).innerTransaction.toEnvelope().toXDR('base64')
}

/**
 * Builds a fee-bump envelope wrapping a classic native payment, the kind of fee bump wallets submit every ledger
 * @returns {string} base64 fee-bump transaction envelope
 */
function feeBumpedPaymentEnvelope() {
    const source = Keypair.random()
    const feeSource = Keypair.random()
    const tx = new TransactionBuilder(new Account(source.publicKey(), '100'), {fee: '100', networkPassphrase: Networks.TESTNET})
        .addOperation(Operation.payment({destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1'}))
        .setTimeout(300)
        .build()
    tx.sign(source)
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(feeSource, '400', tx, Networks.TESTNET)
    feeBump.sign(feeSource)
    return feeBump.toEnvelope().toXDR('base64')
}

/**
 * Shapes a horizon transaction record around an envelope the way horizon reports it: a fee bump is a single record
 * whose hash is the outer hash, whose source_account is the inner transaction's source, whose fee_account paid, and
 * which carries inner_transaction and fee_bump_transaction
 * @param {string} envelope - base64 transaction envelope
 * @param {string} result - base64 transaction result
 * @param {number} ledger - ledger the transaction was applied in
 * @returns {object} horizon transaction record as the sdk hands it over
 */
function horizonRecord(envelope, result, ledger) {
    const parsed = TransactionBuilder.fromXDR(envelope, Networks.TESTNET)
    const hex = tx => Buffer.from(tx.hash()).toString('hex')
    const record = {
        hash: hex(parsed),
        successful: true,
        envelope_xdr: envelope,
        result_xdr: result,
        created_at: new Date(1700000000000).toISOString(),
        ledger_attr: ledger
    }
    if (parsed.innerTransaction) {
        record.source_account = parsed.innerTransaction.source
        record.fee_account = parsed.feeSource
        record.fee_bump_transaction = {hash: record.hash}
        record.inner_transaction = {hash: hex(parsed.innerTransaction)}
    } else {
        record.source_account = parsed.source
        record.fee_account = parsed.source
    }
    return record
}

describe('transaction shapes from horizon', () => {
    let mgr
    let state

    beforeEach(() => {
        mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 100, clusterStatistics: new Map()}
        mgr.__stateLoaded = true
        state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        mgr.__contractsState.clusterStatistics.set(ORACLE_CONTRACT, state)
    })

    test('the fee-bump fixtures are what they claim to be', () => {
        const envelope = feeBumpEnvelope()
        const decoded = xdr.TransactionEnvelope.fromXdr(envelope, 'base64')
        expect(decoded.type).toBe('envelopeTypeTxFeeBump')
        expect(decoded.value.tx.innerTx.type).toBe('envelopeTypeTx')
        const [op] = decoded.value.tx.innerTx.value.tx.operations
        expect(op.body.type).toBe('invokeHostFunction')
        expect(op.body.value.hostFunction.value.functionName.toString()).toBe('set_price')
        //the sdk will not read it as a plain transaction, which is why the envelope has to be unwrapped
        expect(() => new Transaction(envelope, Networks.TESTNET)).toThrow(/envelopeTypeTxFeeBump/)

        const result = xdr.TransactionResult.fromXdr(FEE_BUMP_RESULT, 'base64')
        expect(result.result.type).toBe('txFeeBumpInnerSuccess')
        expect(result.result.value.result.result.value.map(r => r.value.type)).toEqual(['invokeHostFunction'])
        //and the pasted constant is byte for byte the sdk's own encoding of that result
        expect(feeBumpResult(invokeHostFunctionSuccess())).toBe(FEE_BUMP_RESULT)

        expect(xdr.TransactionEnvelope.fromXdr(plainEnvelope(), 'base64').type).toBe('envelopeTypeTx')
    })

    test('a plain set_price is still parsed', async () => {
        const record = horizonRecord(plainEnvelope(), plainResult(invokeHostFunctionSuccess()), 104)
        expect(record.inner_transaction).toBeUndefined()
        getLastTransactions.mockResolvedValue({lastLedger: 104, txs: [record]})

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates['1700000000']).toEqual({tx: record.hash, prices: [10000000000000000000n], signers: []})
        expect(mgr.__contractsState.lastLedger).toBe(104)
    })

    test('a fee-bumped set_price shaped as horizon reports it is recorded under the outer hash', async () => {
        const record = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 105)
        expect(record.inner_transaction.hash).not.toBe(record.hash)
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [record]})

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates['1700000000']).toEqual({tx: record.hash, prices: [10000000000000000000n], signers: []})
        expect(state.getUpdateByHash(record.hash)).toBe(state.updates['1700000000'])
    })

    test('a fee-bumped classic payment is stepped over without an error', async () => {
        const error = jest.spyOn(logger, 'error')
        const payment = horizonRecord(feeBumpedPaymentEnvelope(), feeBumpResult(xdr.OperationResult.opInner(
            xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()))), 104)
        const setPrice = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 105)
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [payment, setPrice]})

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(error).not.toHaveBeenCalled()
        expect(Object.keys(state.updates)).toEqual(['1700000000'])
        expect(state.updates['1700000000'].tx).toBe(setPrice.hash)
        expect(mgr.__contractsState.lastLedger).toBe(105)
        error.mockRestore()
    })

    test('a record that fails to parse at the end of the page is logged, and the records before it still land', async () => {
        const error = jest.spyOn(logger, 'error')
        const good = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 104)
        const truncated = {...horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 105), hash: 'TRUNCATED'}
        truncated.envelope_xdr = truncated.envelope_xdr.slice(0, 60)
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [good, truncated]})

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates['1700000000'].tx).toBe(good.hash)
        expect(error).toHaveBeenCalledTimes(1)
        expect(error.mock.calls[0][0].msg).toBe('Error processing transaction TRUNCATED')
        //parsing is deterministic, so reading the record again would fail the same way on every tick; the cursor moves on
        expect(mgr.__contractsState.lastLedger).toBe(105)
        error.mockRestore()
    })

    test('a record read twice is applied once and keeps the signers recorded in between', async () => {
        const record = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 105)
        //the same record twice in one fetch, as a page overlap would deliver it
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [record, record]})
        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])
        mgr.recordSigners(ORACLE_CONTRACT, 'GNODEA', [record.hash])

        //and again on a later tick, as a restart from an older persisted cursor would re-read it
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [record]})
        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates).toEqual({1700000000: {tx: record.hash, prices: [10000000000000000000n], signers: ['GNODEA']}})
        expect(state.getUpdateByHash(record.hash)).toBe(state.updates['1700000000'])
    })

    test('the cursor moves only to what the horizon helper returned', async () => {
        //the helper answers a total failure with the cursor it started from
        getLastTransactions.mockResolvedValue({lastLedger: 100, txs: []})
        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])
        expect(mgr.__contractsState.lastLedger).toBe(100)

        //and a throw before it could answer (the latest-ledger lookup) leaves the cursor alone
        getLastTransactions.mockRejectedValue(new Error('no horizon'))
        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])
        expect(mgr.__contractsState.lastLedger).toBe(100)
    })

    test('a transaction horizon does not mark successful lands no round, plain or fee-bumped', async () => {
        //the fixtures are genuine failures that still read as set_price calls
        expect(xdr.TransactionResult.fromXdr(failedResult(false), 'base64').result.type).toBe('txFailed')
        const bumped = xdr.TransactionResult.fromXdr(failedResult(true), 'base64').result
        expect(bumped.type).toBe('txFeeBumpInnerFailed')
        expect(bumped.value.result.result.value.map(r => r.value.type)).toEqual(['invokeHostFunction'])

        const failedPlain = {...horizonRecord(plainEnvelope(), failedResult(false), 103), successful: false}
        const failedBumped = {...horizonRecord(feeBumpEnvelope(), failedResult(true), 104), successful: false}
        //the sdk's TransactionRecord requires the flag, so a record without it is not known to have landed either
        const unflagged = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 105)
        delete unflagged.successful
        getLastTransactions.mockResolvedValue({lastLedger: 105, txs: [failedPlain, failedBumped, unflagged]})

        await mgr.__updateTransactions({contracts: new Map()}, ['http://horizon.example.com'])

        expect(state.updates).toEqual({})
        expect(mgr.__contractsState.lastLedger).toBe(105) //stepped over, not stalled on
    })
})

describe('a malformed snapshot is moved aside and statistics start fresh', () => {
    const SUBSCRIPTIONS = 'CSUBSCRIPTIONS'
    const config = {
        contracts: new Map([
            [ORACLE_CONTRACT, {contractId: ORACLE_CONTRACT, admin: 'GADMIN', type: 'oracle'}],
            [SUBSCRIPTIONS, {contractId: SUBSCRIPTIONS, admin: 'GADMIN', type: 'subscriptions'}]
        ]),
        systemAccount: 'GSYSTEM'
    }
    const detectedAt = Date.UTC(2026, 8, 23, 10, 15, 30, 123)
    const firstName = 'statistics_quarantined_20260923T101530123Z'
    /**
     * @param {any} data - `data` of the stored snapshot
     * @returns {{toPlainObject: Function}} the snapshot as findOne hands it over
     */
    const stored = data => ({toPlainObject: () => ({data})})
    //a snapshot that reads fine and cannot be loaded: BigInt() throws on the update key
    const badKey = () => stored({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: {updates: {'not-a-timestamp': {tx: 'OLD'}}}}})
    const logged = spy => spy.mock.calls.map(([entry]) => entry)
    let error
    let warn
    let landed

    /**
     * @returns {TxStatisticsManager} a manager whose next tick runs against the test config
     */
    function manager() {
        const mgr = new TxStatisticsManager() //no config yet, so the constructor's own tick does nothing
        mgr.__updateEntries = () => Promise.resolve(false) //contract entries come from soroban rpc and are not under test
        container.configManager.currentConfig = config
        return mgr
    }

    beforeEach(() => {
        Object.assign(mockStatisticsState, {value: null, findOneError: null, saved: null, renameError: null, renamed: []})
        jest.setSystemTime(detectedAt)
        landed = horizonRecord(feeBumpEnvelope(), FEE_BUMP_RESULT, 500)
        //horizon delivers one set_price and moves the cursor to 500
        getLastTransactions.mockReset()
        getLastTransactions.mockImplementation(() => Promise.resolve({lastLedger: 500, txs: [landed]}))
        container.notificationsManager.flush.mockClear()
        error = jest.spyOn(logger, 'error')
        warn = jest.spyOn(logger, 'warn')
    })

    afterEach(() => {
        container.configManager.currentConfig = null
        error.mockRestore()
        warn.mockRestore()
        jest.setSystemTime(jest.getRealSystemTime())
    })

    test('it is renamed under a timestamped name, logged by that name, and the next save is the fresh state', async () => {
        const mgr = manager()
        mockStatisticsState.value = badKey()

        await mgr.__transactionsWorker()

        expect(mockStatisticsState.renamed).toEqual([firstName])
        const [moved] = logged(error).filter(entry => entry?.msg?.includes('moved it aside'))
        expect(moved.msg).toBe(`Contract statistics snapshot is malformed; moved it aside to orchestrator.${firstName} and started fresh`)
        expect(moved.err.message).toBe('Contract statistics snapshot is malformed: Cannot convert not-a-timestamp to a BigInt')
        //statistics went on in the same tick: horizon's round landed and was saved with the cursor horizon returned
        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__malformedSnapshot).toBeNull()
        expect(mockStatisticsState.saved.data.lastLedger).toBe(500)
        //saved as a decimal string: 10^19 is above int64, which BSON would have wrapped
        expect(mockStatisticsState.saved.data.clusterStatistics[ORACLE_CONTRACT].updates)
            .toEqual({1700000000: {tx: landed.hash, prices: ['10000000000000000000'], signers: []}})
    })

    test.each([
        ['has no data object', {toPlainObject: () => ({data: null})}, 'the snapshot holds no clusterStatistics object'],
        ['has the layout from before lastLedger was stored', stored({[ORACLE_CONTRACT]: {updates: {}}}), 'the snapshot holds no clusterStatistics object'],
        ['stores lastLedger as a string', stored({lastLedger: '42', clusterStatistics: {}}), 'lastLedger is not an integer: string 42'],
        ['reads lastLedger back as a bigint', stored({lastLedger: 42n, clusterStatistics: {}}), 'lastLedger is not an integer: bigint 42'],
        ['has no lastLedger', stored({clusterStatistics: {}}), 'lastLedger is not an integer: undefined undefined'],
        ['holds a string for a contract\'s statistics', stored({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: 'x'}}),
            `the statistics of ${ORACLE_CONTRACT} are not an object of updates and entries`],
        ['holds an array for a contract\'s updates', stored({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: {updates: [1]}}}),
            `the statistics of ${ORACLE_CONTRACT} are not an object of updates and entries`],
        ['holds a string for a contract\'s entries', stored({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: {entries: 'x'}}}),
            `the statistics of ${ORACLE_CONTRACT} are not an object of updates and entries`],
        ['keys an update by something other than a timestamp', badKey(), 'Cannot convert not-a-timestamp to a BigInt'],
        //the model's toPlainObject normalizes through the persistence layer, which calls each stored object's hasOwnProperty
        ['cannot be normalized', {toPlainObject: () => ({data: normalizeValues({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: {hasOwnProperty: 5}}})})},
            'obj.hasOwnProperty is not a function']
    ])('a snapshot that %s is moved aside', async (_, snapshot, cause) => {
        const mgr = manager()
        mockStatisticsState.value = snapshot

        await mgr.__ensureState(config)

        expect(mockStatisticsState.renamed).toEqual([firstName])
        const [moved] = logged(error).filter(entry => entry?.msg?.includes('moved it aside'))
        expect(moved.err.cause.message).toBe(cause)
        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__contractsState.lastLedger).toBe(0)
    })

    test('whatever the load applied before it failed is dropped with the old state', async () => {
        const mgr = manager()
        mockStatisticsState.value = stored({lastLedger: 42, clusterStatistics: {
            [ORACLE_CONTRACT]: {updates: {1600000000: {tx: 'APPLIED', prices: [1n], signers: []}}},
            [SUBSCRIPTIONS]: {updates: {'not-a-timestamp': {tx: 'BAD'}}}
        }})

        await mgr.__ensureState(config)

        expect(mockStatisticsState.renamed).toEqual([firstName])
        const oracle = mgr.__contractsState.clusterStatistics.get(ORACLE_CONTRACT)
        expect(oracle.updates).toEqual({})
        expect(oracle.getUpdateByHash('APPLIED')).toBeUndefined()
        expect([...mgr.__contractsState.clusterStatistics.keys()]).toEqual([ORACLE_CONTRACT, SUBSCRIPTIONS, 'system'])
        expect(mgr.__contractsState.lastLedger).toBe(0)
    })

    test('a snapshot the loader can use is loaded, not moved aside, even with the older shapes it accepts', async () => {
        const mgr = manager()
        mockStatisticsState.value = stored({lastLedger: 42, clusterStatistics: {
            //an update stored as a bare hash is the layout from before signers were recorded
            [ORACLE_CONTRACT]: {updates: {1500000000: 'OLDHASH', 1600000000: {tx: 'NEW', prices: [5n], signers: ['GNODEA']}}, entries: {expiration: [[0n, 5n]]}},
            [SUBSCRIPTIONS]: {updates: null, entries: null},
            CREMOVED: 'no longer configured, so never loaded'
        }})

        await mgr.__ensureState(config)

        expect(mockStatisticsState.renamed).toEqual([])
        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__contractsState.lastLedger).toBe(42)
        const oracle = mgr.__contractsState.clusterStatistics.get(ORACLE_CONTRACT)
        expect(oracle.updates).toEqual({1500000000: {tx: 'OLDHASH'}, 1600000000: {tx: 'NEW', prices: [5n], signers: ['GNODEA']}})
        expect(oracle.entries).toEqual({expiration: [[0n, 5n]]})
        expect(mgr.__contractsState.clusterStatistics.get(SUBSCRIPTIONS).updates).toEqual({})
    })

    test('a snapshot that cannot be read this time is read again on the next tick, never moved aside, and loaded once it reads', async () => {
        const mgr = manager()
        const kept = {1600000000: {tx: 'KEPT', prices: [5n], signers: ['GNODEA']}}
        mockStatisticsState.value = stored({lastLedger: 42, clusterStatistics: {[ORACLE_CONTRACT]: {updates: kept}}})
        const unreachable = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), {name: 'MongoNetworkError'})
        const unauthorized = Object.assign(new Error('not authorized on orchestrator to execute command'), {code: 13, codeName: 'Unauthorized'})

        for (const failure of [unreachable, unauthorized]) {
            mockStatisticsState.findOneError = failure
            await mgr.__transactionsWorker()
            expect(mgr.__stateLoaded).toBe(false)
        }
        expect(mockStatisticsState.renamed).toEqual([])
        expect(mockStatisticsState.saved).toBeNull()
        expect(getLastTransactions).not.toHaveBeenCalled()

        mockStatisticsState.findOneError = null
        getLastTransactions.mockImplementation((urls, lastLedger) => Promise.resolve({lastLedger, txs: []}))
        await mgr.__transactionsWorker()

        expect(mockStatisticsState.renamed).toEqual([])
        expect(mockStatisticsState.saved.data.lastLedger).toBe(42)
        //the kept round goes back out with its prices as decimal strings
        expect(mockStatisticsState.saved.data.clusterStatistics[ORACLE_CONTRACT].updates)
            .toEqual({1600000000: {tx: 'KEPT', prices: ['5'], signers: ['GNODEA']}})
    })

    test('a move that fails leaves statistics running unpersisted and is retried under a new name until it goes through', async () => {
        const mgr = manager()
        const findOne = jest.spyOn(StatisticsModel, 'findOne')
        mockStatisticsState.value = badKey()
        mockStatisticsState.renameError = Object.assign(new Error('not authorized on orchestrator to execute command'), {code: 13, codeName: 'Unauthorized'})

        await mgr.__transactionsWorker()

        //the malformed snapshot is still under its own name, so nothing is written over it...
        expect(mockStatisticsState.renamed).toEqual([firstName])
        expect(mockStatisticsState.saved).toBeNull()
        expect(logged(error).map(entry => entry?.msg)).toContain(`Contract statistics snapshot is malformed and could not be moved aside to orchestrator.${firstName}; statistics continue from a fresh state, unpersisted, and the move is retried on the next tick`)
        //...but statistics are not stuck: the round landed, the cursor moved and notifications went out
        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__contractsState.lastLedger).toBe(500)
        expect(mgr.__contractsState.clusterStatistics.get(ORACLE_CONTRACT).updates['1700000000'].tx).toBe(landed.hash)
        expect(container.notificationsManager.flush).toHaveBeenCalledTimes(1)

        //the next tick's name is taken, so the move fails again
        jest.setSystemTime(detectedAt + 10000)
        mockStatisticsState.renameError = Object.assign(new Error('target namespace exists'), {code: 48, codeName: 'NamespaceExists'})
        await mgr.__transactionsWorker()
        expect(mockStatisticsState.saved).toBeNull()

        //and the one after goes through, so the state built meanwhile is persisted
        jest.setSystemTime(detectedAt + 20000)
        mockStatisticsState.renameError = null
        await mgr.__transactionsWorker()

        expect(mockStatisticsState.renamed).toEqual([firstName, 'statistics_quarantined_20260923T101540123Z', 'statistics_quarantined_20260923T101550123Z'])
        expect(mgr.__malformedSnapshot).toBeNull()
        expect(mockStatisticsState.saved.data.lastLedger).toBe(500)
        expect(Object.keys(mockStatisticsState.saved.data.clusterStatistics[ORACLE_CONTRACT].updates)).toEqual(['1700000000'])

        //from then on nothing is moved or read again
        await mgr.__transactionsWorker()
        expect(mockStatisticsState.renamed).toHaveLength(3)
        expect(findOne).toHaveBeenCalledTimes(1)
        findOne.mockRestore()
    })

    test('a malformed snapshot that is already gone when the move is retried is not waited on', async () => {
        const mgr = manager()
        mockStatisticsState.value = badKey()
        mockStatisticsState.renameError = Object.assign(new Error('connection closed'), {name: 'MongoNetworkError'})

        await mgr.__transactionsWorker()
        expect(mockStatisticsState.saved).toBeNull()

        //the first move went through after all and only its reply was lost, or the snapshot was removed by hand
        jest.setSystemTime(detectedAt + 10000)
        mockStatisticsState.renameError = Object.assign(new Error('Source collection orchestrator.statistics does not exist'), {code: 26, codeName: 'NamespaceNotFound'})
        await mgr.__transactionsWorker()

        expect(mgr.__malformedSnapshot).toBeNull()
        expect(logged(warn).map(entry => entry?.msg)).toContain('The malformed contract statistics snapshot is no longer in place; persisting the fresh state')
        expect(mockStatisticsState.saved.data.lastLedger).toBe(500)
    })
})

describe('subscription contract type', () => {
    test('a subscriptions contract gets a timeline instead of an unknown-type warning', () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'subscriptions')
        const landed = Date.now() - 600000
        state.addUpdate(String(landed), {tx: 'TRIGGERED'})
        //a round with no landed transaction, which the trigger parser never records; addUpdate would re-wrap
        //{tx: undefined}, so it is written straight into the map
        const missed = Date.now() - 300000
        state.updates[String(missed)] = {}
        mgr.__contractsState.clusterStatistics.set('S1', state)

        const timelines = mgr.getTimelines([{contractId: 'S1', type: 'subscriptions', timeframe: 60000}], {priceHeartbeat: 7200000})

        expect(timelines.S1[landed]).toEqual({tx: 'TRIGGERED', signers: []})
        expect(timelines.S1[missed]).toBe(-1) //STATUS.MISSING
    })

    test('the trigger parser is reachable under the shared contract type', () => {
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('subscriptions', 'trigger')
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'subscriptions')
        parser({source: {fn: 'trigger', args: [1700000000], txHash: 'TRIG1'}, timestamp: 1700000000n, state})
        expect(state.updates['1700000000']).toEqual({tx: 'TRIG1'})
    })

    test('a subscriptions contract keeps its latest 256 triggers, each found by its hash', () => {
        //a contract with events triggers once a minute, and every contract's statistics share one MongoDB document
        const mgr = new TxStatisticsManager()
        const parser = mgr.__getParserFn('subscriptions', 'trigger')
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'subscriptions')
        for (let i = 0n; i < 257n; i++)
            parser({source: {fn: 'trigger', args: [1700000000000n + i * 60000n], txHash: 'TRIG' + i}, timestamp: 1700000000000n, state})

        expect(Object.keys(state.updates)).toHaveLength(256)
        expect(state.updates['1700000000000']).toBeUndefined()
        expect(state.getUpdateByHash('TRIG0')).toBeUndefined()
        expect(state.getUpdateByHash('TRIG256')).toBe(state.updates[String(1700000000000n + 256n * 60000n)])
    })
})

describe('bigint-safe persistence', () => {
    beforeEach(() => {
        mockStatisticsState.value = null
        mockStatisticsState.findOneError = null
        mockStatisticsState.saved = null
    })

    afterEach(() => {
        container.configManager.currentConfig = null
    })

    test('bigints are stored as decimal strings', () => {
        expect(TxStatisticsManager.toStorable({prices: [10n ** 19n], nested: {ttl: 5n}, name: 'x'}))
            .toEqual({prices: ['10000000000000000000'], nested: {ttl: '5'}, name: 'x'})
    })

    test('stored strings load back as bigints', async () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        mgr.__contractsState.clusterStatistics.set('C1', state)
        mockStatisticsState.value = {
            toPlainObject: () => ({
                data: {
                    lastLedger: 42,
                    clusterStatistics: {
                        C1: {
                            updates: {'1700000000': {tx: 'H1', prices: ['10000000000000000000'], signers: []}},
                            entries: {expiration: [['0', '1800000000']]}
                        }
                    }
                }
            })
        }

        await mgr.__loadContractStatistics()

        expect(state.updates['1700000000'].prices).toEqual([10000000000000000000n])
        expect(state.entries.expiration).toEqual([[0n, 1800000000n]])
        expect(mgr.__contractsState.lastLedger).toBe(42)
    })

    test('a snapshot written by the previous version still loads', async () => {
        const mgr = new TxStatisticsManager()
        mgr.__contractsState = {lastLedger: 0, clusterStatistics: new Map()}
        const state = new TxStatisticsManager.StatisticsData('GADMIN', 'oracle')
        mgr.__contractsState.clusterStatistics.set('C1', state)
        mockStatisticsState.value = {
            toPlainObject: () => ({
                data: {
                    lastLedger: 7,
                    clusterStatistics: {C1: {updates: {'1700000000': {tx: 'H1', prices: [123n], signers: []}}, entries: {expiration: [[0n, 5n]]}}}
                }
            })
        }

        await mgr.__loadContractStatistics()

        expect(state.updates['1700000000'].prices).toEqual([123n])
        expect(state.entries.expiration).toEqual([[0n, 5n]])
    })

    test('prices above int64 come back exact from the BSON the worker\'s save encodes to', async () => {
        //2^53 + 1 is the first integer a double cannot hold, 2^63 - 1 is the largest int64, 10^19 is a price of 100,000
        //at 14 decimals, and 2^127 - 1 is the largest i128 set_price accepts
        const prices = [0n, 2n ** 53n + 1n, 2n ** 63n - 1n, 10n ** 19n, 2n ** 127n - 1n]
        const expiration = [[0n, 0n], [1700000000000n, 1800000000000n]]
        const config = {contracts: new Map([['C1', {contractId: 'C1', admin: 'GADMIN', type: 'oracle'}]]), systemAccount: 'GSYSTEM'}
        getLastTransactions.mockReset()
        getLastTransactions.mockImplementation((urls, lastLedger) => Promise.resolve({lastLedger, txs: []}))
        const writer = new TxStatisticsManager() //no config yet, so the constructor's own tick does nothing
        writer.__updateEntries = () => Promise.resolve(false) //contract entries come from soroban rpc and are not under test
        await writer.__ensureState(config)
        const written = writer.__contractsState.clusterStatistics.get('C1')
        written.addUpdate('1700000000000', {tx: 'H1', prices, signers: ['GNODEA']})
        written.entries.expiration = expiration
        container.configManager.currentConfig = config
        await writer.__transactionsWorker()
        container.configManager.currentConfig = null

        //MongoDB keeps the driver's BSON encoding of the save, and the orchestrator reads it back with promoteLongs off,
        //as persistence-layer/index.js connects
        const stored = BSON.deserialize(BSON.serialize(mockStatisticsState.saved), {promoteValues: true, promoteLongs: false})
        mockStatisticsState.value = {toPlainObject: () => ({data: normalizeValues(stored.data)})}
        const reader = new TxStatisticsManager()
        await reader.__ensureState(config)

        const loaded = reader.__contractsState.clusterStatistics.get('C1')
        expect(loaded.updates['1700000000000']).toEqual({tx: 'H1', prices, signers: ['GNODEA']})
        expect(loaded.entries.expiration).toEqual(expiration)
    })
})
