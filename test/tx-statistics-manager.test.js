/*eslint-disable no-undef */
jest.mock('../domain/container', () => ({
    appConfig: {getNetworkConfig: () => ({urls: [], horizonUrls: []})},
    configManager: {currentConfig: null},
    notificationsManager: {report: jest.fn(), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined)}
}))
jest.mock('../persistence-layer/models/statistics', () => ({
    findOne: () => ({exec: async () => null}),
    findOneAndUpdate: () => ({exec: async () => null})
}))

const container = require('../domain/container')
const TxStatisticsManager = require('../domain/statistics/tx-statistics-manager')

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
