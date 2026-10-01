/*eslint-disable no-undef */
//Every cluster issue the statistics loop raises is followed from StatisticsManager through the real NotificationsManager
//and EmailProvider down to axios, the one place a message leaves the process, which is stubbed, so nothing reaches
//OneSignal. A jest.mock factory may only close over `mock`-prefixed vars
jest.useFakeTimers()
//eslint-disable-next-line no-var
var mockRequest = jest.fn()
//eslint-disable-next-line no-var
var mockSettings = new Map()
//eslint-disable-next-line no-var
var mockNodes = []
//eslint-disable-next-line no-var
var mockContainer = {
    appConfig: {monitoringKey: null},
    configManager: {
        allNodePubkeys: () => [...mockNodes],
        hasNode: pubkey => mockNodes.includes(pubkey)
    },
    nodeSettingsManager: {
        settings: mockSettings,
        get: pubkey => mockSettings.get(pubkey) || {}
    },
    emailProvider: null,
    notificationsManager: null
}
jest.mock('axios', () => ({default: {request: mockRequest}}))
jest.mock('../domain/container', () => mockContainer)
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))
jest.mock('../persistence-layer/models/metrics-model', () => ({deleteMany: () => Promise.resolve({})}))

const EmailProvider = require('../domain/email-provider')
const NotificationsManager = require('../domain/notifications/notifications-manager')
const StatisticsManager = require('../domain/statistics/statistics-manager')

const hourMs = 60 * 60 * 1000

let statisticsManager

/**
 * Raise every issue the statistics loop addresses to the whole cluster, old enough to clear each type's minimum age
 */
function raiseClusterIssues() {
    const seen = Date.now() - 7 * hourMs
    statisticsManager.__issues = {
        nodeIssues: {},
        clusterIssues: {
            NO_MAJORITY: {type: 'NO_MAJORITY', message: 'No majority of nodes available', timestamp: seen},
            CLUSTER_UPDATE_ISSUE: {type: 'CLUSTER_UPDATE_ISSUE', message: 'Cluster update issue.', timestamp: seen}
        },
        oracleIssues: {
            ORACLE1: {PRICE_UPDATE_ISSUE: {type: 'PRICE_UPDATE_ISSUE', message: 'Price update issue with oracle ORACLE1.', timestamp: seen}}
        }
    }
    statisticsManager.__reportIssues()
}

beforeAll(() => {
    //the constructor only schedules its loops; the fake clock is never advanced far enough to run them
    statisticsManager = new StatisticsManager()
})

beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockResolvedValue({data: {id: 'notification-id'}})
    mockSettings.clear()
    mockNodes.length = 0
    mockContainer.appConfig.monitoringKey = null
    mockContainer.emailProvider = new EmailProvider({apiKey: 'API-KEY', appId: 'APP-ID', from: 'Reflector'})
    mockContainer.notificationsManager = new NotificationsManager()
    statisticsManager.__previousDedupKeys = new Set()
})

describe('cluster issue email reaches the monitoring key whether or not it is a node', () => {
    test('a monitoring key outside the cluster gets every cluster issue, a node that has left does not', async () => {
        mockNodes.push('GA', 'GB')
        mockSettings.set('GA', {emails: ['ga@x.com']})
        mockSettings.set('GB', {emails: ['gb@x.com']})
        mockSettings.set('GGONE', {emails: ['gone@x.com']})
        mockSettings.set('GMONITOR', {emails: ['ops@x.com']})
        mockContainer.appConfig.monitoringKey = 'GMONITOR'

        raiseClusterIssues()
        await mockContainer.notificationsManager.flush()

        expect(mockRequest).toHaveBeenCalledTimes(1)
        const {data} = mockRequest.mock.calls[0][0]
        expect(data.email_subject).toBe('Cluster issues')
        expect(data.include_external_user_ids).toEqual(['ops@x.com', 'ga@x.com', 'gb@x.com'])
        expect(data.email_body).toBe('<html><body><h1>Cluster issues</h1><hr/>'
            + '<h3>No majority of nodes available</h3>'
            + '<h3>Cluster update issue.</h3>'
            + '<h3>Price update issue with oracle ORACLE1.</h3>'
            + '</body></html>')
    })

    test('a monitoring key that is also a node is sent each cluster issue once', async () => {
        mockNodes.push('GA', 'GMONITOR')
        mockSettings.set('GA', {emails: ['ga@x.com']})
        mockSettings.set('GMONITOR', {emails: ['ops@x.com']})
        mockContainer.appConfig.monitoringKey = 'GMONITOR'

        raiseClusterIssues()
        await mockContainer.notificationsManager.flush()

        expect(mockRequest).toHaveBeenCalledTimes(1)
        expect(mockRequest.mock.calls[0][0].data.include_external_user_ids).toEqual(['ops@x.com', 'ga@x.com'])
    })

    test('without a monitoring key the audience is the current nodes alone', async () => {
        mockNodes.push('GA')
        mockSettings.set('GA', {emails: ['ga@x.com']})
        mockSettings.set('GGONE', {emails: ['gone@x.com']})

        raiseClusterIssues()
        await mockContainer.notificationsManager.flush()

        expect(mockRequest).toHaveBeenCalledTimes(1)
        expect(mockRequest.mock.calls[0][0].data.include_external_user_ids).toEqual(['ga@x.com'])
    })
})
