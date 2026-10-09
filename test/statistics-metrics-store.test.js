/*eslint-disable no-undef */
//These tests need a real MongoDB on 127.0.0.1:27017, as config-manager.test.js does: what they pin is a save that
//MongoDB or its BSON encoder refuses, how MongoDB answers the rename that moves a malformed transaction statistics
//snapshot aside, and what a price reads back as once BSON has stored it, which a mocked model cannot reproduce. The
//database is created for this file and dropped after it.
jest.mock('../domain/container', () => ({
    configManager: {
        allNodePubkeys: () => [],
        getCurrentConfigs: () => ({currentConfig: {hash: 'CCH', config: {config: {contracts: {}}}}, pendingConfig: null})
    },
    connectionManager: {getNodeConnection: () => null},
    notificationsManager: {report: jest.fn(), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined)},
    txStatisticsManager: {recordSigners: jest.fn()}
}))

const mongoose = require('mongoose')
const container = require('../domain/container')
const MetricsModel = require('../persistence-layer/models/metrics-model')
const StatisticsModel = require('../persistence-layer/models/statistics')
const StatisticsManager = require('../domain/statistics/statistics-manager')
const TxStatisticsManager = require('../domain/statistics/tx-statistics-manager')
const logger = require('../logger')

const {BSON} = mongoose.mongo
const databaseName = 'reflector-orchestrator-test-metrics'
const nul = String.fromCharCode(0)
//the shape nodes before v0.12.0-rc10 sent: host keys carry dots, and one error key is given a leading $ because
//MongoDB stores that too
const honestMetrics = {
    info: {gatewaysCount: 1, from: '2024-12-13T00:00:00.000Z', to: '2024-12-13T00:01:00.000Z'},
    metrics: [{
        totalCount: 2,
        slowResponseCount: 0,
        statusCodes: {200: 2},
        errors: {'$timeout of 5000ms exceeded.': 1},
        dataStreams: {
            'api.binance.com': {
                urls: {'/api/v3/ticker/price?symbol=BTCUSDT': {count: 2, avgResponseTime: 312, slowResponseCount: 0, statusCodes: {200: 2}}},
                statusCodes: {200: 2},
                totalCount: 2,
                slowResponseCount: 0
            }
        }
    }, 'n/a']
}
//a node's JSON.stringify escapes the byte, and the orchestrator's JSON.parse turns it back into a real NUL
const nulKeyMetrics = '{"gw\\u0000x":1}'

//the manager schedules its next round and its metrics clean-up with setTimeout; these tests drive every round by hand
const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(() => 0)
let statisticsManager

/**
 * @param {number} levels - how many objects deep the value is
 * @returns {object}
 */
function nested(levels) {
    let value = 1
    for (let i = 0; i < levels; i++)
        value = {n: value}
    return value
}

/**
 * @param {string} gatewaysMetrics - raw JSON of the gatewaysMetrics the node sends
 * @returns {object} channel answering with the node's statistics, parsed as a node's frame is
 */
function sending(gatewaysMetrics) {
    return {isReady: true, send: () => Promise.resolve(JSON.parse(`{"currentTime":${Date.now()},"oracleStatistics":{},"gatewaysMetrics":${gatewaysMetrics}}`))}
}

const honest = () => sending(JSON.stringify(honestMetrics))
const garbled = () => ({isReady: true, send: () => Promise.resolve(JSON.parse('"garbage"'))})

/**
 * Run one monitoring round and return the metrics document it stored, as GET /metrics serves it.
 * @param {object} channels - pubkey to the node's channel, or null for a node that does not answer
 * @returns {Promise<object|null>} the stored document, or null when the round stored none
 */
async function round(channels) {
    const pubkeys = Object.keys(channels)
    container.configManager.allNodePubkeys = () => pubkeys
    container.connectionManager.getNodeConnection = pubkey => channels[pubkey]
    const before = await MetricsModel.countDocuments()
    await statisticsManager.__requestStatistics()
    if (await MetricsModel.countDocuments() !== before + 1)
        return null
    const [latest] = await statisticsManager.getMetrics({limit: 1})
    const {id, ...stored} = latest.toPlainObject()
    expect(id).toBeDefined()
    return stored
}

beforeAll(async () => {
    //read values back as the orchestrator does: persistence-layer/index.js connects with promoteLongs off, so an int64
    //comes back as a Long for normalizeValues to turn into a bigint rather than as a number
    await mongoose.connect('mongodb://127.0.0.1:27017/' + databaseName, {serverSelectionTimeoutMS: 3000, promoteValues: true, promoteLongs: false})
    await mongoose.connection.db.dropDatabase()
    statisticsManager = new StatisticsManager()
})

afterAll(async () => {
    await mongoose.connection.db.dropDatabase()
    await mongoose.disconnect()
    setTimeoutSpy.mockRestore()
})

beforeEach(async () => {
    await MetricsModel.deleteMany({})
    statisticsManager.__gatewaysMetrics = {}
})

describe('one node cannot empty the round\'s gateway metrics', () => {
    test('the NUL fixture really carries a NUL byte in its key', () => {
        expect(Object.keys(JSON.parse(nulKeyMetrics))).toEqual([`gw${nul}x`])
    })

    test('an honest node\'s metrics are stored and served back unchanged', async () => {
        expect(await round({GA: honest(), GB: sending('{"gw":1}')})).toEqual({GA: honestMetrics, GB: {gw: 1}})
    })

    //the dashboard's metrics view reads the newest document, as nodes since v0.12.0-rc10 send no metrics at all
    test('a round in which no node sends metrics still stores a document', async () => {
        const withoutMetrics = {isReady: true, send: () => Promise.resolve({currentTime: Date.now(), oracleStatistics: {}})}
        expect(await round({GA: withoutMetrics, GB: withoutMetrics})).toEqual({})
    })

    test.each([
        ['a key holding a NUL byte', nulKeyMetrics],
        ['metrics nested 200 levels deep', JSON.stringify(nested(200))],
        ['more than 512 KiB of metrics', JSON.stringify({pad: 'x'.repeat(600 * 1024)})]
    ])('a node sending %s loses only its own metrics', async (_, poison) => {
        expect(await round({GA: sending(poison), GB: honest()})).toEqual({GB: honestMetrics})
    })

    test('after sending metrics that cannot be stored, a silent or garbled node does not break later saves', async () => {
        expect(await round({GA: sending(nulKeyMetrics), GB: honest()})).toEqual({GB: honestMetrics})
        expect(await round({GA: null, GB: honest()})).toEqual({GB: honestMetrics})
        expect(await round({GA: garbled(), GB: honest()})).toEqual({GB: honestMetrics})
    })

    test('a value held over from an earlier round cannot break a later save', async () => {
        //as it would be held had it ever got past the check on the way in
        statisticsManager.__gatewaysMetrics = {GA: JSON.parse(nulKeyMetrics)}
        expect(await round({GA: null, GB: honest()})).toEqual({GB: honestMetrics})
    })

    test('metrics a node sent in an earlier round are not saved again once it goes silent', async () => {
        expect(await round({GA: sending('{"gw":1}'), GB: honest()})).toEqual({GA: {gw: 1}, GB: honestMetrics})
        expect(await round({GA: null, GB: honest()})).toEqual({GB: honestMetrics})
    })

    //Cluster nodes are signers of one Stellar account, and the protocol allows an account at most 20 signers
    test('twenty nodes each sending the most the limits allow still save in one document', async () => {
        const padding = {deep: nested(15), pad: ''}
        const largest = {...padding, pad: 'x'.repeat(512 * 1024 - BSON.calculateObjectSize({gatewaysMetrics: padding}))}
        expect(BSON.calculateObjectSize({gatewaysMetrics: largest})).toBe(512 * 1024)
        expect(StatisticsManager.isStorableGatewaysMetrics(largest)).toBe(true)
        const raw = JSON.stringify(largest)
        const pubkeys = Array.from({length: 20}, (_, i) => 'G' + String(i).padStart(55, 'A'))
        const stored = await round(Object.fromEntries(pubkeys.map(pubkey => [pubkey, sending(raw)])))
        expect(Object.keys(stored)).toEqual(pubkeys)
        expect(pubkeys.every(pubkey => stored[pubkey].pad === largest.pad)).toBe(true)
    }, 30000)
})

describe('a malformed transaction statistics snapshot is moved aside on a real MongoDB', () => {
    const config = {contracts: new Map([['C1', {contractId: 'C1', admin: 'GADMIN', type: 'oracle'}]]), systemAccount: 'GSYSTEM'}
    const detectedAt = Date.UTC(2026, 8, 23, 10, 15, 30, 123)
    const firstName = 'statistics_quarantined_20260923T101530123Z'
    const nextName = 'statistics_quarantined_20260923T101540123Z'
    //reads fine and cannot be loaded: BigInt() throws on the update key
    const malformed = () => ({
        _id: new mongoose.Types.ObjectId(),
        data: {lastLedger: 42, clusterStatistics: {C1: {updates: {'not-a-timestamp': {tx: 'H'}}}}},
        createdAt: new Date(detectedAt - 60000)
    })
    const db = () => mongoose.connection.db
    const documents = name => db().collection(name).find().toArray()
    const statisticsCollections = async () => (await db().listCollections().toArray())
        .map(collection => collection.name)
        .filter(name => name.startsWith('statistics'))
        .sort()
    let now
    let error

    beforeEach(async () => {
        for (const name of await statisticsCollections())
            await db().dropCollection(name)
        now = jest.spyOn(Date, 'now').mockReturnValue(detectedAt)
        error = jest.spyOn(logger, 'error')
    })

    afterEach(() => {
        now.mockRestore()
        error.mockRestore()
    })

    test('the whole document is renamed under a timestamped name, and the original name is left to the fresh state', async () => {
        const original = malformed()
        await db().collection('statistics').insertOne(original)
        const mgr = new TxStatisticsManager()

        await mgr.__ensureState(config)

        expect(await statisticsCollections()).toEqual([firstName])
        expect(await documents(firstName)).toEqual([original])
        expect(error.mock.calls.map(([entry]) => entry?.msg))
            .toContain(`Contract statistics snapshot is malformed; moved it aside to ${databaseName}.${firstName} and started fresh`)
        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__malformedSnapshot).toBeNull()

        //the next save lands under the original name and leaves the quarantined document alone
        await StatisticsModel.findOneAndUpdate({}, {data: {lastLedger: 500, clusterStatistics: {}}}, {upsert: true}).exec()
        expect(await statisticsCollections()).toEqual(['statistics', firstName])
        expect(await documents(firstName)).toEqual([original])
    })

    test('a taken name fails the move and leaves the snapshot where it was, and the next tick\'s name goes through', async () => {
        const earlier = {_id: new mongoose.Types.ObjectId(), earlier: true}
        await db().collection(firstName).insertOne(earlier)
        const original = malformed()
        await db().collection('statistics').insertOne(original)
        const mgr = new TxStatisticsManager()

        await mgr.__ensureState(config)

        expect(mgr.__stateLoaded).toBe(true)
        expect(mgr.__malformedSnapshot?.message).toBe('Contract statistics snapshot is malformed: Cannot convert not-a-timestamp to a BigInt')
        expect(await documents('statistics')).toEqual([original])
        expect(await documents(firstName)).toEqual([earlier])
        const [failure] = error.mock.calls.map(([entry]) => entry).filter(entry => entry?.msg?.includes('could not be moved aside'))
        expect(failure.err.codeName).toBe('NamespaceExists')

        now.mockReturnValue(detectedAt + 10000)
        await mgr.__ensureState(config)

        expect(mgr.__malformedSnapshot).toBeNull()
        expect(await statisticsCollections()).toEqual([firstName, nextName])
        expect(await documents(nextName)).toEqual([original])
        expect(await documents(firstName)).toEqual([earlier])
    })

    test('a retried move whose original is already gone is recognised from MongoDB\'s own answer', async () => {
        await db().collection(firstName).insertOne({_id: new mongoose.Types.ObjectId(), earlier: true})
        await db().collection('statistics').insertOne(malformed())
        const mgr = new TxStatisticsManager()
        await mgr.__ensureState(config)
        expect(mgr.__malformedSnapshot).not.toBeNull()

        //removed by hand before the next tick
        await db().dropCollection('statistics')
        now.mockReturnValue(detectedAt + 10000)
        await mgr.__ensureState(config)

        expect(mgr.__malformedSnapshot).toBeNull()
        expect(await statisticsCollections()).toEqual([firstName])
    })
})

describe('prices read back from a real MongoDB exactly as they were saved', () => {
    const config = {contracts: new Map([['C1', {contractId: 'C1', admin: 'GADMIN', type: 'oracle'}]]), systemAccount: 'GSYSTEM'}
    const round = '1700000000000'
    const expiration = [[0n, 0n], [1700000000000n, 1800000000000n]]
    const stored = () => mongoose.connection.db.collection('statistics').findOne()

    beforeEach(async () => {
        await StatisticsModel.deleteMany({})
    })

    afterEach(() => {
        delete container.configManager.currentConfig
        delete container.appConfig
    })

    /**
     * @returns {Promise<TxStatisticsManager>} a manager that has dealt with the stored snapshot and whose ticks reach no
     * network
     */
    async function manager() {
        const mgr = new TxStatisticsManager() //no config yet, so the constructor's own tick does nothing
        mgr.__updateEntries = () => Promise.resolve(false)
        mgr.__updateTransactions = () => Promise.resolve(false)
        await mgr.__ensureState(config)
        return mgr
    }

    test('a round the worker saves loads into a fresh manager with every price exact', async () => {
        //2^53 + 1 is the first integer a double cannot hold, 2^63 - 1 is the largest int64, 10^19 is a price of 100,000
        //at 14 decimals, 2^64 + 5 is what int64 wraps to 5, and 2^127 - 1 is the largest i128 set_price accepts
        const prices = [0n, 123n, 2n ** 53n + 1n, 2n ** 63n - 1n, 10n ** 19n, 2n ** 64n + 5n, 2n ** 127n - 1n]
        const writer = await manager()
        const written = writer.__contractsState.clusterStatistics.get('C1')
        written.addUpdate(round, {tx: 'H1', prices, signers: ['GNODEA']})
        written.entries.expiration = expiration
        container.appConfig = {getNetworkConfig: () => ({urls: [], horizonUrls: []})}
        container.configManager.currentConfig = config

        await writer.__transactionsWorker()
        delete container.configManager.currentConfig
        //the worker does not wait for its save, so wait for the document to appear
        let document = null
        for (let attempt = 0; attempt < 100 && !document; attempt++)
            document = await stored()

        expect(document).not.toBeNull()
        const reader = await manager()

        const loaded = reader.__contractsState.clusterStatistics.get('C1')
        expect(loaded.updates[round]).toEqual({tx: 'H1', prices, signers: ['GNODEA']})
        expect(loaded.entries.expiration).toEqual(expiration)
        //stored as decimal strings, which BSON keeps whole
        expect(document.data.clusterStatistics.C1.updates[round].prices).toEqual(prices.map(String))
    })

    test('a snapshot the previous version saved with int64 prices still loads exactly', async () => {
        //the previous version handed bigints to the driver as they were, which encodes each as int64
        const prices = [0n, 123n, 2n ** 53n + 1n, 2n ** 63n - 1n]
        await StatisticsModel.findOneAndUpdate({}, {
            data: {lastLedger: 7, clusterStatistics: {C1: {updates: {[round]: {tx: 'OLD', prices, signers: []}}, entries: {expiration}}}}
        }, {upsert: true}).exec()
        const document = await stored()
        expect(document.data.clusterStatistics.C1.updates[round].prices.map(price => price._bsontype)).toEqual(['Long', 'Long', 'Long', 'Long'])

        const reader = await manager()

        const loaded = reader.__contractsState.clusterStatistics.get('C1')
        expect(loaded.updates[round]).toEqual({tx: 'OLD', prices, signers: []})
        expect(loaded.entries.expiration).toEqual(expiration)
        expect(reader.__contractsState.lastLedger).toBe(7)
    })
})
