/*eslint-disable no-undef */
jest.useFakeTimers()
jest.mock('../domain/container', () => ({
    appConfig: {monitoringKey: 'GMONITOR'},
    configManager: {allNodePubkeys: () => ['GA', 'GB'], getCurrentConfigs: () => ({currentConfig: {hash: 'CCH', config: {config: {contracts: {}}}}, pendingConfig: null})},
    connectionManager: {getNodeConnection: () => null},
    emailProvider: {sendToPubkey: jest.fn(), sendToAll: jest.fn()},
    notificationsManager: {report: jest.fn(), clear: jest.fn(), flush: jest.fn().mockResolvedValue(undefined)},
    txStatisticsManager: {recordSigners: jest.fn(), getTimelines: jest.fn().mockReturnValue({})}
}))
jest.mock('../persistence-layer/models/metrics-model', () => ({deleteMany: () => ({}), save: async () => {}, find: jest.fn()}))

const {BSON} = require('mongoose').mongo
const container = require('../domain/container')
const StatisticsManager = require('../domain/statistics/statistics-manager')
const statisticsManager = new StatisticsManager()

describe('StatisticsManager issue reporting via NotificationsManager', () => {
    beforeEach(() => {
        container.notificationsManager.report.mockClear()
        container.notificationsManager.clear.mockClear()
        container.notificationsManager.flush.mockClear()
        container.txStatisticsManager.recordSigners.mockClear()

        statisticsManager.__previousDedupKeys = new Set()
        statisticsManager.__issues.nodeIssues = {}
        statisticsManager.__issues.clusterIssues = {}
        statisticsManager.__issues.oracleIssues = {}
    })

    test('__reportIssues calls notificationsManager.report once per active issue with the correct dedupKey/recipient', () => {
        const merged = {
            nodeIssues: {GA: {NODE_UNAVAILABLE: {type: 'NODE_UNAVAILABLE', message: 'a down', timestamp: 1}}},
            clusterIssues: {NO_MAJORITY: {type: 'NO_MAJORITY', message: 'no maj', timestamp: 2}},
            oracleIssues: {ORACLE1: {PRICE_UPDATE_ISSUE: {type: 'PRICE_UPDATE_ISSUE', message: 'late', timestamp: 3}}}
        }
        statisticsManager.__issues = merged
        statisticsManager.__reportIssues()
        expect(container.notificationsManager.report).toHaveBeenCalledTimes(3)
        const calls = container.notificationsManager.report.mock.calls.map(c => c[0])
        expect(calls.find(c => c.dedupKey === 'node:GA:NODE_UNAVAILABLE').recipient).toEqual({kind: 'pubkey', pubkey: 'GA'})
        expect(calls.find(c => c.dedupKey === 'cluster:NO_MAJORITY').recipient).toEqual({kind: 'all'})
        expect(calls.find(c => c.dedupKey === 'oracle:ORACLE1:PRICE_UPDATE_ISSUE').recipient).toEqual({kind: 'all'})
    })

    test('__reportIssues calls clear() for issues that existed before but are gone now', () => {
        statisticsManager.__previousDedupKeys = new Set(['node:GA:NODE_UNAVAILABLE'])
        const prev = {
            nodeIssues: {GA: {NODE_UNAVAILABLE: {}}},
            clusterIssues: {},
            oracleIssues: {}
        }
        const curr = {
            nodeIssues: {},
            clusterIssues: {},
            oracleIssues: {}
        }
        statisticsManager.__issues = prev
        statisticsManager.__reportIssues() //seeds the snapshot
        container.notificationsManager.clear.mockClear()
        statisticsManager.__issues = curr
        statisticsManager.__reportIssues()
        expect(container.notificationsManager.clear).toHaveBeenCalledWith('node:GA:NODE_UNAVAILABLE')
    })

    test('__recordSignersForAllNodes calls recordSigners per (node, contract) with non-empty hashes', () => {
        const nodeStatistics = {
            GA: {processedHashes: {C1: ['H1', 'H2'], C2: ['H3']}},
            GB: {processedHashes: {C1: []}},
            GC: null
        }
        statisticsManager.__statistics = {nodeStatistics}
        statisticsManager.__recordSignersForAllNodes()
        expect(container.txStatisticsManager.recordSigners).toHaveBeenCalledWith('C1', 'GA', ['H1', 'H2'])
        expect(container.txStatisticsManager.recordSigners).toHaveBeenCalledWith('C2', 'GA', ['H3'])
        expect(container.txStatisticsManager.recordSigners).not.toHaveBeenCalledWith('C1', 'GB', [])
        expect(container.txStatisticsManager.recordSigners).not.toHaveBeenCalledWith(expect.anything(), 'GC', expect.anything())
    })
})

const {normalizeNodeStatistics} = require('../domain/statistics/statistics-manager')
const MessageTypes = require('../server/ws/handlers/message-types')
const ChannelBase = require('../server/ws/channel-base')
const {wsServerOptions} = require('../server/ws/connection-handler')
const {makeFakeSocket} = require('./helpers/fake-socket')

describe('normalizeNodeStatistics', () => {
    const valid = {
        currentTime: 1700000000000,
        oracleStatistics: {C1: {lastOracleTimestamp: 1700000000000}},
        connectionIssues: ['peer down'],
        processedHashes: {C1: ['a'.repeat(64)]},
        currentConfigHash: 'hash',
        version: '0.13.0'
    }

    test('stamps the oracle id on each entry', () => {
        const result = normalizeNodeStatistics(structuredClone(valid))
        expect(result.oracleStatistics.C1.oracleId).toBe('C1')
    })

    test('rejects a response that is not an object', () => {
        for (const response of [null, undefined, 'statistics', 42, []])
            expect(normalizeNodeStatistics(response)).toBeNull()
    })

    test('rejects a response without a numeric currentTime', () => {
        expect(normalizeNodeStatistics({...valid, currentTime: 'now'})).toBeNull()
    })

    test('rejects a response whose oracleStatistics is not an object of objects', () => {
        expect(normalizeNodeStatistics({...valid, oracleStatistics: 'none'})).toBeNull()
        expect(normalizeNodeStatistics({...valid, oracleStatistics: {C1: 5}})).toBeNull()
    })

    test('tolerates a missing oracleStatistics', () => {
        const result = normalizeNodeStatistics({currentTime: 1700000000000})
        expect(result.oracleStatistics).toEqual({})
        expect(result.connectionIssues).toEqual([])
        expect(result.processedHashes).toEqual({})
    })

    test('bounds connection issues and drops non-string entries', () => {
        const result = normalizeNodeStatistics({...valid, connectionIssues: [...new Array(80).fill('x'), 5]})
        expect(result.connectionIssues).toHaveLength(50)
        expect(result.connectionIssues.every(issue => typeof issue === 'string')).toBe(true)
    })

    test('drops processed hashes that are not 64-character hex', () => {
        const result = normalizeNodeStatistics({...valid, processedHashes: {C1: ['nope', 'b'.repeat(64)], C2: 'x'}})
        expect(result.processedHashes).toEqual({C1: ['b'.repeat(64)]})
    })
})

describe('normalizeNodeStatistics contract beyond the round', () => {
    const base = {currentTime: 1700000000000}

    test('returns null rather than throwing for a null oracleStatistics', () => {
        expect(normalizeNodeStatistics({...base, oracleStatistics: null})).toBeNull()
    })

    test('omits a contract none of whose hashes are valid', () => {
        expect(normalizeNodeStatistics({...base, processedHashes: {C1: ['nope']}}).processedHashes).toEqual({})
    })

    test('replaces non-string config hashes and version with null', () => {
        const result = normalizeNodeStatistics({...base, currentConfigHash: 5, pendingConfigHash: {}, version: ['0.13.0']})
        expect(result.currentConfigHash).toBeNull()
        expect(result.pendingConfigHash).toBeNull()
        expect(result.version).toBeNull()
    })
})

describe('__requestStatistics isolation', () => {
    function channelReturning(statistics) {
        return {isReady: true, send: () => Promise.resolve(statistics)}
    }

    test('a malformed response drops one node, not the round', async () => {
        const channels = {
            GA: channelReturning('garbage'),
            GB: channelReturning({currentTime: Date.now(), oracleStatistics: {C1: {lastOracleTimestamp: Date.now()}}})
        }
        container.connectionManager.getNodeConnection = pubkey => channels[pubkey]

        await statisticsManager.__requestStatistics()

        const {nodeStatistics} = statisticsManager.__statistics
        expect(nodeStatistics.GA).toBeNull()
        expect(nodeStatistics.GB.oracleStatistics.C1.oracleId).toBe('C1')
        expect(statisticsManager.__statistics.currentTimestamp).toBeGreaterThan(0)
        expect(container.notificationsManager.flush).toHaveBeenCalled()
    })
})

//Every node below talks to the round through a real ChannelBase: the request goes out through send() with its 5 s
//deadline and the answer comes back as a raw frame through the same JSON.parse a node's frame goes through. GB is an
//honest node throughout, and whatever GA does, GB's contribution and the round itself must come through unchanged.
describe('one misbehaving node cannot delay, corrupt or empty the round', () => {
    const now = 1700000000000
    const honestHash = 'c'.repeat(64)
    const honestStatistics = {
        currentTime: now,
        oracleStatistics: {C1: {lastOracleTimestamp: now}},
        connectionIssues: [],
        processedHashes: {C1: [honestHash]},
        currentConfigHash: 'CCH',
        version: '0.13.0'
    }

    class PeerChannel extends ChannelBase {
        type = 'peer'
    }

    /**
     * @param {string} pubkey - node pubkey
     * @param {function} respond - (requestId, reply, writeCallback) called for each frame the orchestrator sends
     * @returns {PeerChannel}
     */
    function peerChannel(pubkey, respond) {
        const socket = makeFakeSocket()
        const channel = new PeerChannel(socket, pubkey)
        channel.__assignListeners()
        channel.validated()
        socket.send.mockImplementation((raw, callback) =>
            respond(JSON.parse(raw).requestId, frame => socket.__emit('message', frame), callback))
        return channel
    }

    /**
     * @param {string} data - raw JSON the node puts in its response frame
     * @returns {function}
     */
    function answers(data) {
        return (requestId, reply, callback) => {
            callback()
            reply(`{"type":${MessageTypes.OK},"responseId":"${requestId}","data":${data}}`)
        }
    }

    function neverAnswers() {
        return (requestId, reply, callback) => callback()
    }

    /**
     * @param {object} channels - pubkey to channel
     */
    function useChannels(channels) {
        container.connectionManager.getNodeConnection = pubkey => channels[pubkey]
    }

    function honestNode() {
        return peerChannel('GB', answers(JSON.stringify(honestStatistics)))
    }

    function expectRoundCompletedWithHonestNodeIntact() {
        const {nodeStatistics, currentTimestamp} = statisticsManager.__statistics
        expect(currentTimestamp).toBe(Date.now())
        expect(nodeStatistics.GB).toMatchObject({
            ...honestStatistics,
            oracleStatistics: {C1: {lastOracleTimestamp: now, oracleId: 'C1'}},
            timeshift: 0
        })
        expect(container.txStatisticsManager.recordSigners).toHaveBeenCalledWith('C1', 'GB', [honestHash])
        expect(container.notificationsManager.flush).toHaveBeenCalledTimes(1)
    }

    beforeEach(() => {
        jest.clearAllTimers()
        jest.setSystemTime(now)
        container.notificationsManager.flush.mockClear()
        container.notificationsManager.report.mockClear()
        container.txStatisticsManager.recordSigners.mockClear()
        statisticsManager.__statistics = {}
        statisticsManager.__gatewaysMetrics = {}
    })

    test('two honest nodes complete a round', async () => {
        useChannels({GA: honestNode(), GB: honestNode()})
        await statisticsManager.__requestStatistics()
        expectRoundCompletedWithHonestNodeIntact()
    })

    test('a node that never answers delays the round by the 5 s request deadline and no more', async () => {
        const hanging = peerChannel('GA', neverAnswers())
        expect(hanging.isReady).toBe(true)
        useChannels({GA: hanging, GB: honestNode()})

        const round = statisticsManager.__requestStatistics()
        await jest.advanceTimersByTimeAsync(4999)
        expect(hanging.__ws.send).toHaveBeenCalledTimes(1)
        expect(container.notificationsManager.flush).not.toHaveBeenCalled()
        expect(statisticsManager.__statistics).toEqual({})
        await jest.advanceTimersByTimeAsync(1)
        expect(container.notificationsManager.flush).toHaveBeenCalledTimes(1)
        await round

        expect(statisticsManager.__statistics.nodeStatistics.GA).toBeNull()
        expectRoundCompletedWithHonestNodeIntact()
    })

    //the normalizer defaults timeshift to 0, so without this the round could stop measuring clock drift unnoticed
    test('a node whose clock is off still has its drift measured and reported', async () => {
        const drifting = JSON.stringify({...honestStatistics, currentTime: now - 7000})
        useChannels({GA: peerChannel('GA', answers(drifting)), GB: honestNode()})
        await statisticsManager.__requestStatistics()
        expectRoundCompletedWithHonestNodeIntact()
        expect(statisticsManager.__statistics.nodeStatistics.GA.timeshift).toBe(7000)
        expect(container.notificationsManager.report).toHaveBeenCalledWith(expect.objectContaining({dedupKey: 'node:GA:TIME_SHIFT'}))
    })

    test('a node\'s gateway metrics are moved out of its statistics and kept for the metrics store', async () => {
        const gatewaysMetrics = {gateway1: {latency: 12}}
        useChannels({GA: peerChannel('GA', answers(JSON.stringify({...honestStatistics, gatewaysMetrics}))), GB: honestNode()})
        await statisticsManager.__requestStatistics()
        expectRoundCompletedWithHonestNodeIntact()
        expect(statisticsManager.__gatewaysMetrics.GA).toEqual(gatewaysMetrics)
        expect(statisticsManager.__statistics.nodeStatistics.GA.gatewaysMetrics).toBeUndefined()
    })

    test('a node whose handler throws, or whose socket write fails, is dropped at once', async () => {
        const throwing = peerChannel('GA', (requestId, reply, callback) => {
            callback()
            reply(JSON.stringify({type: MessageTypes.ERROR, responseId: requestId, error: 'handler threw'}))
        })
        const unwritable = peerChannel('GA', (requestId, reply, callback) => callback(new Error('write EPIPE')))
        for (const failing of [throwing, unwritable]) {
            container.notificationsManager.flush.mockClear()
            container.txStatisticsManager.recordSigners.mockClear()
            useChannels({GA: failing, GB: honestNode()})
            await statisticsManager.__requestStatistics()
            expect(statisticsManager.__statistics.nodeStatistics.GA).toBeNull()
            expectRoundCompletedWithHonestNodeIntact()
        }
    })

    test.each([
        ['a string', '"garbage"', 'dropped'],
        ['an array', '[]', 'dropped'],
        ['a non-numeric currentTime', '{"currentTime":"now","oracleStatistics":{}}', 'dropped'],
        ['a currentTime that parses to Infinity', '{"currentTime":1e400,"oracleStatistics":{}}', 'dropped'],
        ['a string oracleStatistics', `{"currentTime":${now},"oracleStatistics":"none"}`, 'dropped'],
        ['a numeric oracleStatistics', `{"currentTime":${now},"oracleStatistics":5}`, 'dropped'],
        ['an array oracleStatistics', `{"currentTime":${now},"oracleStatistics":[{"lastOracleTimestamp":${now}}]}`, 'dropped'],
        ['a numeric oracle entry', `{"currentTime":${now},"oracleStatistics":{"C1":5}}`, 'dropped'],
        ['a null oracle entry', `{"currentTime":${now},"oracleStatistics":{"C1":null}}`, 'dropped'],
        ['an array oracle entry', `{"currentTime":${now},"oracleStatistics":{"C1":[]}}`, 'dropped'],
        ['no oracleStatistics', `{"currentTime":${now}}`, 'kept'],
        ['a string connectionIssues', `{"currentTime":${now},"oracleStatistics":{},"connectionIssues":"down"}`, 'kept'],
        ['a non-string connection issue', `{"currentTime":${now},"oracleStatistics":{},"connectionIssues":[5]}`, 'kept'],
        ['a null processedHashes', `{"currentTime":${now},"oracleStatistics":{},"processedHashes":null}`, 'kept'],
        ['an array processedHashes', `{"currentTime":${now},"oracleStatistics":{},"processedHashes":[["${honestHash}"]]}`, 'kept'],
        ['a string list of hashes', `{"currentTime":${now},"oracleStatistics":{},"processedHashes":{"C1":"${honestHash}"}}`, 'kept']
    ])('a node answering with %s leaves the round intact', async (_, data, outcome) => {
        useChannels({GA: peerChannel('GA', answers(data)), GB: honestNode()})
        await statisticsManager.__requestStatistics()
        expectRoundCompletedWithHonestNodeIntact()
        const contributed = statisticsManager.__statistics.nodeStatistics.GA
        if (outcome === 'dropped') {
            expect(contributed).toBeNull()
        } else {
            expect(contributed.oracleStatistics).toEqual({})
            expect(contributed.connectionIssues).toEqual([])
            expect(contributed.processedHashes).toEqual({})
        }
        expect(container.txStatisticsManager.recordSigners).not.toHaveBeenCalledWith(expect.anything(), 'GA', expect.anything())
    })

    test('a node answering with the largest frame the socket accepts contributes a bounded record', async () => {
        const enormous = JSON.stringify({
            currentTime: now,
            oracleStatistics: {C1: {lastOracleTimestamp: now}},
            connectionIssues: new Array(400).fill('i'.repeat(1200)),
            processedHashes: {C1: new Array(7000).fill('d'.repeat(64))}
        })
        const frameSize = Buffer.byteLength(enormous) + 100
        expect(frameSize).toBeGreaterThan(wsServerOptions.maxPayload * 0.9)
        expect(frameSize).toBeLessThanOrEqual(wsServerOptions.maxPayload)
        useChannels({GA: peerChannel('GA', answers(enormous)), GB: honestNode()})

        await statisticsManager.__requestStatistics()

        expectRoundCompletedWithHonestNodeIntact()
        const contributed = statisticsManager.__statistics.nodeStatistics.GA
        expect(contributed.connectionIssues).toHaveLength(50)
        expect(contributed.connectionIssues.every(issue => issue.length === 512)).toBe(true)
        expect(contributed.processedHashes.C1).toHaveLength(1000)
        expect(container.txStatisticsManager.recordSigners).toHaveBeenCalledWith('C1', 'GA', contributed.processedHashes.C1)
    })
})

//The price alert is decided per oracle from every node's lastOracleTimestamp. Every node answers through the same
//JSON.parse a node's frame goes through, so a string or 1e400 below arrives exactly as a peer would send it.
describe('one node cannot hide or invent a price alert', () => {
    const now = 1700000000000
    const timeframe = 5 * 60 * 1000
    const stale = now - 60 * 60 * 1000
    const fresh = now - 60 * 1000
    const year = 365 * 24 * 60 * 60 * 1000
    const {configManager} = container
    const {allNodePubkeys, getCurrentConfigs} = configManager

    /**
     * Run one round in which each node reports the given raw JSON as its lastOracleTimestamp for every contract.
     * @param {object} reports - pubkey to the raw JSON text of its lastOracleTimestamp
     * @param {object} [contracts] - contracts of the current config
     * @returns {Promise<string[]>} oracle ids PRICE_UPDATE_ISSUE was reported for
     */
    async function alertsAfterRound(reports, contracts = {C1: {type: 'oracle', timeframe}}) {
        const pubkeys = Object.keys(reports)
        configManager.allNodePubkeys = () => pubkeys
        configManager.getCurrentConfigs = () => ({currentConfig: {hash: 'CCH', config: {config: {contracts}}}, pendingConfig: null})
        container.connectionManager.getNodeConnection = pubkey => {
            const entries = Object.keys(contracts).map(id => `"${id}":{"lastOracleTimestamp":${reports[pubkey]}}`)
            return {isReady: true, send: () => Promise.resolve(JSON.parse(`{"currentTime":${now},"currentConfigHash":"CCH","oracleStatistics":{${entries.join(',')}}}`))}
        }
        await statisticsManager.__requestStatistics()
        return container.notificationsManager.report.mock.calls
            .map(([issue]) => issue)
            .filter(issue => issue.type === 'PRICE_UPDATE_ISSUE')
            .map(issue => issue.scope)
    }

    beforeEach(() => {
        jest.clearAllTimers()
        jest.setSystemTime(now)
        container.notificationsManager.report.mockClear()
        statisticsManager.__previousDedupKeys = new Set()
        statisticsManager.__issues = {nodeIssues: {}, clusterIssues: {}, oracleIssues: {}}
    })

    afterAll(() => {
        configManager.allNodePubkeys = allNodePubkeys
        configManager.getCurrentConfigs = getCurrentConfigs
    })

    test.each([
        ['every node sees C1 stale', true, {GA: stale, GB: stale, GC: stale}],
        ['every node sees C1 fresh', false, {GA: fresh, GB: fresh, GC: fresh}],
        ['every node reports an oracle that was never updated', true, {GA: 0, GB: 0, GC: 0}],
        ['GA reports the current time while GB and GC see C1 stale', true, {GA: now, GB: stale, GC: stale}],
        ['GA reports a time a year ahead while GB and GC see C1 stale', true, {GA: now + year, GB: stale, GC: stale}],
        ['GA reports a string while GB and GC see C1 stale', true, {GA: '"x"', GB: stale, GC: stale}],
        ['GA reports a fresh time as a numeric string while GB and GC see C1 stale', true, {GA: `"${fresh}"`, GB: stale, GC: stale}],
        ['GA reports 1e400 while GB and GC see C1 stale', true, {GA: '1e400', GB: stale, GC: stale}],
        ['GA alone reports C1 stale', false, {GA: stale, GB: fresh, GC: fresh}],
        ['two of three nodes see C1 stale', true, {GA: fresh, GB: stale, GC: stale}],
        ['the only two reporting nodes disagree', true, {GA: fresh, GB: stale}],
        ['the only two reporting nodes disagree, listed the other way round', true, {GA: stale, GB: fresh}]
    ])('%s: alert raised is %s', async (_, raised, reports) => {
        expect(await alertsAfterRound(reports)).toEqual(raised ? ['C1'] : [])
    })

    //GB fresh and GC stale split the honest vote, so each row shows whether GA's report was counted as a fresh vote
    test.each([
        ['a year ahead', now + year],
        ['one millisecond beyond the clock drift allowance', now + 5001],
        ['a fresh time sent as a string', `"${fresh}"`],
        ['a fractional time', fresh + 0.5],
        ['1e400', '1e400']
    ])('a report %s is discarded, not counted as a fresh vote', async (_, report) => {
        expect(await alertsAfterRound({GA: report, GB: fresh, GC: stale})).toEqual(['C1'])
    })

    //GB fresh alone is a majority of one, so each row shows whether GA's report was counted as a stale vote
    test.each([
        ['a negative time', -1],
        ['a string', '"x"'],
        ['null', 'null']
    ])('a report of %s is discarded, not counted as a stale vote', async (_, report) => {
        expect(await alertsAfterRound({GA: report, GB: fresh})).toEqual([])
    })

    test('a report within the clock drift allowance counts as a fresh vote', async () => {
        expect(await alertsAfterRound({GA: now + 5000, GB: now + 5000, GC: stale})).toEqual([])
    })

    //(timeframe + 20%) x 2, as before: a report exactly that old is still fresh, one millisecond older is stale
    test('the stale threshold keeps its boundary', async () => {
        const threshold = (timeframe + timeframe * .2) * 2
        expect(await alertsAfterRound({GA: now - threshold, GB: now - threshold, GC: now - threshold})).toEqual([])
        expect(await alertsAfterRound({GA: now - threshold - 1, GB: now - threshold - 1, GC: now - threshold - 1})).toEqual(['C1'])
    })

    //a legacy contract is serialised with oracleId and no type
    test('a legacy price oracle, which has no type, still raises it', async () => {
        expect(await alertsAfterRound({GA: stale, GB: stale, GC: stale}, {C1: {oracleId: 'C1', timeframe}})).toEqual(['C1'])
    })

    test('contracts that are not price oracles never raise it', async () => {
        const contracts = {
            B1: {type: 'oracle_beam', timeframe},
            S1: {type: 'subscriptions'},
            D1: {type: 'dao'}
        }
        expect(await alertsAfterRound({GA: stale, GB: stale, GC: stale}, contracts)).toEqual([])
    })
})

//A price alert that flaps across the majority line - two reporting nodes that alternately disagree (a tie raises it)
//and agree the oracle is fresh - is cleared and raised again every other round. The mails go through the real
//NotificationsManager: clearing must not reset the 1 h throttle, or every re-raise mails every operator
describe('a price alert flapping across the majority line mails once per throttle window', () => {
    const NotificationsManager = require('../domain/notifications/notifications-manager')
    const start = 1700000000000
    const timeframe = 5 * 60 * 1000
    const {configManager} = container
    const {allNodePubkeys, getCurrentConfigs} = configManager
    const mockedNotifications = container.notificationsManager

    async function round(at, gbSeesFresh) {
        jest.setSystemTime(at)
        const fresh = at - 60 * 1000
        const stale = at - 60 * 60 * 1000
        const reports = {GA: fresh, GB: gbSeesFresh ? fresh : stale}
        container.connectionManager.getNodeConnection = pubkey => ({
            isReady: true,
            send: () => Promise.resolve({currentTime: at, currentConfigHash: 'CCH', oracleStatistics: {C1: {lastOracleTimestamp: reports[pubkey]}}})
        })
        await statisticsManager.__requestStatistics()
    }

    function priceAlertMails() {
        return container.emailProvider.sendToAll.mock.calls
            .filter(([, html]) => html.includes('Price update issue with oracle C1.'))
            .length
    }

    beforeAll(() => {
        configManager.allNodePubkeys = () => ['GA', 'GB']
        configManager.getCurrentConfigs = () => ({currentConfig: {hash: 'CCH', config: {config: {contracts: {C1: {type: 'oracle', timeframe}}}}}, pendingConfig: null})
        configManager.hasNode = pubkey => pubkey === 'GA' || pubkey === 'GB'
    })

    beforeEach(() => {
        jest.clearAllTimers()
        container.notificationsManager = new NotificationsManager()
        container.emailProvider.sendToAll.mockReset()
        container.emailProvider.sendToAll.mockResolvedValue(undefined)
        container.emailProvider.sendToPubkey.mockReset()
        container.emailProvider.sendToPubkey.mockResolvedValue(undefined)
        statisticsManager.__previousDedupKeys = new Set()
        statisticsManager.__issues = {nodeIssues: {}, clusterIssues: {}, oracleIssues: {}}
    })

    afterAll(() => {
        container.notificationsManager = mockedNotifications
        configManager.allNodePubkeys = allNodePubkeys
        configManager.getCurrentConfigs = getCurrentConfigs
        delete configManager.hasNode
    })

    test('raised, cleared and raised again four times in eight minutes, it mails exactly once', async () => {
        for (let i = 0; i < 8; i++) {
            await round(start + i * 60 * 1000, i % 2 === 1)
            const raised = !!container.notificationsManager._peek('oracle:C1:PRICE_UPDATE_ISSUE')
            expect(raised && !container.notificationsManager._peek('oracle:C1:PRICE_UPDATE_ISSUE').cleared).toBe(i % 2 === 0)
        }

        expect(priceAlertMails()).toBe(1)
    })

    test('still flapping once the hour has passed, it mails a second time, and only then', async () => {
        for (let i = 0; i < 64; i++)
            await round(start + i * 60 * 1000, i % 2 === 1)

        expect(priceAlertMails()).toBe(2)
    })
})

describe('gateway metrics from one node cannot make the round\'s metrics document unsaveable', () => {
    const {isStorableGatewaysMetrics} = StatisticsManager
    const now = 1700000000000
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
     * @param {number} bytes - BSON size the value must have where the round stores it
     * @returns {object}
     */
    function sized(bytes) {
        const overhead = BSON.calculateObjectSize({gatewaysMetrics: {pad: ''}})
        return {pad: 'x'.repeat(bytes - overhead)}
    }

    /**
     * @param {any} gatewaysMetrics - value the node sends
     * @returns {object}
     */
    function answering(gatewaysMetrics) {
        const frame = JSON.stringify({currentTime: now, oracleStatistics: {}, gatewaysMetrics})
        return {isReady: true, send: () => Promise.resolve(JSON.parse(frame))}
    }

    test('an honest node\'s metrics, dotted and $-prefixed keys included, and a node that sends none are storable', () => {
        expect(isStorableGatewaysMetrics(JSON.parse(JSON.stringify(honestMetrics)))).toBe(true)
        expect(isStorableGatewaysMetrics(undefined)).toBe(true)
    })

    test('a key holding a NUL byte is refused at any depth, a value holding one is not', () => {
        //a node's JSON.stringify escapes the byte, and the orchestrator's JSON.parse turns it back into a real NUL
        const topLevel = JSON.parse('{"gw\\u00001":1}')
        const deep = JSON.parse('{"metrics":[{"dataStreams":{"host\\u0000":1}}]}')
        expect(Object.keys(topLevel)).toEqual([`gw${nul}1`])
        expect(Object.keys(deep.metrics[0].dataStreams)).toEqual([`host${nul}`])
        expect(isStorableGatewaysMetrics(topLevel)).toBe(false)
        expect(isStorableGatewaysMetrics(deep)).toBe(false)
        expect(isStorableGatewaysMetrics(JSON.parse('{"value":"a\\u0000b"}'))).toBe(true)
    })

    test('16 levels of nesting are storable and 17 are not', () => {
        expect(isStorableGatewaysMetrics(nested(16))).toBe(true)
        expect(isStorableGatewaysMetrics(nested(17))).toBe(false)
        expect(isStorableGatewaysMetrics(JSON.parse('['.repeat(17) + ']'.repeat(17)))).toBe(false)
    })

    test('512 KiB of BSON is storable and one byte more is not', () => {
        expect(BSON.calculateObjectSize({gatewaysMetrics: sized(512 * 1024)})).toBe(512 * 1024)
        expect(isStorableGatewaysMetrics(sized(512 * 1024))).toBe(true)
        expect(isStorableGatewaysMetrics(sized(512 * 1024 + 1))).toBe(false)
    })

    test('a round keeps only the metrics sent in that round, minus any that cannot be stored', async () => {
        jest.clearAllTimers()
        jest.setSystemTime(now)
        container.connectionManager.getNodeConnection = pubkey => ({GA: answering({gw: 1}), GB: answering(honestMetrics)})[pubkey]
        await statisticsManager.__requestStatistics()
        expect(statisticsManager.__gatewaysMetrics).toEqual({GA: {gw: 1}, GB: honestMetrics})

        const poisoned = {isReady: true, send: () => Promise.resolve(JSON.parse(`{"currentTime":${now},"gatewaysMetrics":{"gw\\u0000":1}}`))}
        container.connectionManager.getNodeConnection = pubkey => ({GA: poisoned, GB: answering(honestMetrics)})[pubkey]
        await statisticsManager.__requestStatistics()
        expect(statisticsManager.__gatewaysMetrics.GA).toBeUndefined()
        expect(statisticsManager.__gatewaysMetrics.GB).toEqual(honestMetrics)

        container.connectionManager.getNodeConnection = pubkey => ({GB: answering(honestMetrics)})[pubkey]
        await statisticsManager.__requestStatistics()
        expect(Object.keys(statisticsManager.__gatewaysMetrics)).toEqual(['GB'])
    })
})

//A key named "__proto__" in a node's frame is a real own property once JSON.parse has built it, and assigning it into a
//fresh object would run the prototype setter instead of storing it.
describe('a node\'s "__proto__" keys stay plain data', () => {
    const hash = 'e'.repeat(64)
    const frame = `{"currentTime":1700000000000,"oracleStatistics":{"__proto__":{"lastOracleTimestamp":5},"C1":{"lastOracleTimestamp":7}},"processedHashes":{"__proto__":["${hash}"],"C1":["${hash}"]}}`

    test('the fixture really carries own "__proto__" keys', () => {
        const parsed = JSON.parse(frame)
        expect(Object.keys(parsed.oracleStatistics)).toEqual(['__proto__', 'C1'])
        expect(Object.keys(parsed.processedHashes)).toEqual(['__proto__', 'C1'])
    })

    test('the normalizer keeps them as own entries and leaves the prototypes alone', () => {
        const {oracleStatistics, processedHashes} = normalizeNodeStatistics(JSON.parse(frame))
        expect(Object.getPrototypeOf(oracleStatistics)).toBe(Object.prototype)
        expect(Object.getPrototypeOf(processedHashes)).toBe(Object.prototype)
        expect(Object.keys(oracleStatistics)).toEqual(['__proto__', 'C1'])
        expect(Object.keys(processedHashes)).toEqual(['__proto__', 'C1'])
        const enumerated = []
        //the same for...in __recordSignersForAllNodes runs, which also lists inherited keys
        //eslint-disable-next-line guard-for-in
        for (const contractId in processedHashes)
            enumerated.push(contractId)
        expect(enumerated).toEqual(['__proto__', 'C1'])
    })

    test('only a list of hashes ever reaches recordSigners', async () => {
        jest.clearAllTimers()
        jest.setSystemTime(1700000000000)
        container.txStatisticsManager.recordSigners.mockClear()
        container.connectionManager.getNodeConnection = pubkey => (pubkey === 'GA' ? {isReady: true, send: () => Promise.resolve(JSON.parse(frame))} : null)
        await statisticsManager.__requestStatistics()
        const calls = container.txStatisticsManager.recordSigners.mock.calls
        expect(calls.map(([contractId]) => contractId)).toEqual(['__proto__', 'C1'])
        expect(calls.every(([, pubkey, hashes]) => pubkey === 'GA' && Array.isArray(hashes) && hashes[0] === hash)).toBe(true)
    })
})

describe('every contract type that has a timeline reaches getTimelines', () => {
    afterEach(() => {
        delete container.configManager.currentConfig
    })

    test('oracle, beam and subscriptions contracts are passed on, and a DAO is not', () => {
        container.txStatisticsManager.getTimelines.mockClear()
        const contracts = [
            {contractId: 'O1', type: 'oracle', timeframe: 300000},
            {contractId: 'B1', type: 'oracle_beam', timeframe: 60000},
            {contractId: 'S1', type: 'subscriptions'},
            {contractId: 'D1', type: 'dao'}
        ]
        container.configManager.currentConfig = {
            contracts: new Map(contracts.map(contract => [contract.contractId, contract])),
            priceHeartbeat: 3600000
        }

        statisticsManager.getStatistics()

        expect(container.txStatisticsManager.getTimelines).toHaveBeenCalledWith(contracts.slice(0, 3), {priceHeartbeat: 3600000})
    })
})

describe('getMetrics bounds its query parameters', () => {
    const MetricsModel = require('../persistence-layer/models/metrics-model')
    let cursor

    beforeEach(() => {
        //records what reaches Mongo: the chain getMetrics builds on MetricsModel.find()
        cursor = {sort: jest.fn(), limit: jest.fn(), skip: jest.fn()}
        cursor.sort.mockReturnValue(cursor)
        cursor.limit.mockReturnValue(cursor)
        cursor.skip.mockResolvedValue(['doc'])
        MetricsModel.find.mockReset()
        MetricsModel.find.mockReturnValue(cursor)
    })

    test('query strings are parsed, and the page size is capped at 100', async () => {
        expect(await statisticsManager.getMetrics({page: '3', limit: '1000000', sortOrder: 'asc'})).toEqual(['doc'])
        expect(cursor.sort).toHaveBeenCalledWith({_id: 1})
        expect(cursor.limit).toHaveBeenCalledWith(100)
        expect(cursor.skip).toHaveBeenCalledWith(200)
    })

    test('absent parameters fall back to the first page of ten, newest first', async () => {
        await statisticsManager.getMetrics({})
        expect(cursor.sort).toHaveBeenCalledWith({_id: -1})
        expect(cursor.limit).toHaveBeenCalledWith(10)
        expect(cursor.skip).toHaveBeenCalledWith(0)
    })

    test('a page below one is read as the first page', async () => {
        await statisticsManager.getMetrics({page: '-4', limit: '0'})
        expect(cursor.limit).toHaveBeenCalledWith(1)
        expect(cursor.skip).toHaveBeenCalledWith(0)
    })

    test('a parameter qs parsed into an object is refused before Mongo is queried', async () => {
        await expect(statisticsManager.getMetrics({limit: {$gt: 0}})).rejects.toThrow('Invalid pagination parameter')
        expect(MetricsModel.find).not.toHaveBeenCalled()
    })
})

afterAll(() => {
    jest.clearAllTimers()
})
