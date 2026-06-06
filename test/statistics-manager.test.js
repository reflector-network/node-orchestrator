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
jest.mock('../persistence-layer/models/metrics-model', () => ({deleteMany: () => ({}), save: async () => {}}))

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
