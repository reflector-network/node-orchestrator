/*eslint-disable no-undef */
//the transport is stubbed at axios, the one place a message leaves the process, so nothing here reaches OneSignal and
//every assertion reads what would have been sent. A jest.mock factory may only close over `mock`-prefixed vars
//eslint-disable-next-line no-var
var mockRequest = jest.fn()
//eslint-disable-next-line no-var
var mockSettings = new Map()
//eslint-disable-next-line no-var
var mockNodes = []
//eslint-disable-next-line no-var
var mockContainer = {
    nodeSettingsManager: {
        settings: mockSettings,
        get: pubkey => mockSettings.get(pubkey) || {}
    },
    configManager: {
        allNodePubkeys: () => [...mockNodes],
        hasNode: pubkey => mockNodes.includes(pubkey)
    },
    appConfig: {monitoringKey: null},
    emailProvider: null
}
jest.mock('axios', () => ({default: {request: mockRequest}}))
jest.mock('../domain/container', () => mockContainer)
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const EmailProvider = require('../domain/email-provider')
const NotificationsManager = require('../domain/notifications/notifications-manager')

/**
 * @param {string} pubkey - node public key
 * @param {string[]} emails - the node's stored addresses
 * @param {boolean} [inCluster] - whether the node is in the current cluster config
 */
function addNode(pubkey, emails, inCluster = true) {
    mockSettings.set(pubkey, {emails})
    if (inCluster)
        mockNodes.push(pubkey)
}

/**
 * @returns {Array<string[]>} the recipient list of every request made, in order
 */
function sentRecipients() {
    return mockRequest.mock.calls.map(([options]) => options.data.include_external_user_ids)
}

let provider

beforeEach(() => {
    mockRequest.mockReset()
    mockRequest.mockResolvedValue({data: {id: 'notification-id'}})
    mockSettings.clear()
    mockNodes.length = 0
    mockContainer.appConfig.monitoringKey = null
    provider = new EmailProvider({apiKey: 'API-KEY', appId: 'APP-ID', from: 'Reflector'})
})

describe('EmailProvider.sendToAll recipients', () => {
    test('sends one message that reaches every current node address once', async () => {
        addNode('GA', ['a@x.com', 'b@x.com'])
        addNode('GB', ['b@x.com', 'c@x.com'])
        //the same mailbox under another spelling is still one person
        addNode('GC', ['A@X.com'])

        await provider.sendToAll('Cluster issues', '<html>body</html>')

        expect(mockRequest).toHaveBeenCalledTimes(1)
        const [options] = mockRequest.mock.calls[0]
        expect(options.method).toBe('POST')
        expect(options.url).toBe('https://api.onesignal.com/api/v1/notifications')
        expect(options.headers.authorization).toBe('Basic API-KEY')
        expect(options.data).toEqual({
            app_id: 'APP-ID',
            include_external_user_ids: ['a@x.com', 'b@x.com', 'c@x.com'],
            channel_for_external_user_ids: 'external_id',
            email_subject: 'Cluster issues',
            email_body: '<html>body</html>',
            email_from_name: 'Reflector'
        })
    })

    test('leaves out a node that has left the cluster, although its settings are still stored', async () => {
        addNode('GA', ['a@x.com'])
        addNode('GGONE', ['former@x.com'], false)

        await provider.sendToAll('Cluster issues', 'body')

        expect(sentRecipients()).toEqual([['a@x.com']])
    })

    test('sends nothing when no current node has an address', async () => {
        addNode('GA', [])
        addNode('GGONE', ['former@x.com'], false)

        await provider.sendToAll('Cluster issues', 'body')

        expect(mockRequest).not.toHaveBeenCalled()
    })

    test('stops at 200 addresses, counted after duplicates are removed', async () => {
        //fifty nodes share five addresses, fifty more have five of their own: 255 distinct addresses, but the first
        //250 entries of the concatenated lists are the five shared ones repeated
        const shared = [0, 1, 2, 3, 4].map(j => `shared${j}@x.com`)
        for (let i = 0; i < 50; i++)
            addNode(`GS${i}`, shared)
        const own = []
        for (let i = 0; i < 50; i++) {
            const emails = [0, 1, 2, 3, 4].map(j => `node${i}-${j}@x.com`)
            own.push(...emails)
            addNode(`GU${i}`, emails)
        }

        await provider.sendToAll('Cluster issues', 'body')

        expect(mockRequest).toHaveBeenCalledTimes(1)
        const [recipients] = sentRecipients()
        expect(recipients).toHaveLength(200)
        expect(new Set(recipients).size).toBe(200)
        expect(recipients).toEqual([...shared, ...own.slice(0, 195)])
    })
})

describe('EmailProvider.sendToAll and the monitoring key', () => {
    test('the monitoring key gets the message although it is not a node, and comes first', async () => {
        addNode('GA', ['a@x.com'])
        addNode('GMONITOR', ['ops@x.com'], false)
        addNode('GGONE', ['former@x.com'], false)
        mockContainer.appConfig.monitoringKey = 'GMONITOR'

        await provider.sendToAll('Cluster issues', 'body')

        expect(sentRecipients()).toEqual([['ops@x.com', 'a@x.com']])
    })

    test('the monitoring key keeps its place when the node addresses alone would fill the cap', async () => {
        const emails = new Array(250).fill(0).map((_, i) => `legacy${i}@x.com`)
        addNode('GA', emails)
        addNode('GMONITOR', ['ops@x.com'], false)
        mockContainer.appConfig.monitoringKey = 'GMONITOR'

        await provider.sendToAll('Cluster issues', 'body')

        expect(sentRecipients()).toEqual([['ops@x.com', ...emails.slice(0, 199)]])
    })

    test('a monitoring key that is also a node has its settings read once', async () => {
        addNode('GMONITOR', ['ops@x.com'])
        addNode('GA', ['a@x.com'])
        mockContainer.appConfig.monitoringKey = 'GMONITOR'
        const get = jest.spyOn(mockSettings, 'get')

        try {
            await provider.sendToAll('Cluster issues', 'body')
            //the pubkey list is de-duplicated before any address is looked up, not left to send() to repair
            expect(get.mock.calls).toEqual([['GMONITOR'], ['GA']])
        } finally {
            get.mockRestore()
        }
        expect(sentRecipients()).toEqual([['ops@x.com', 'a@x.com']])
    })

    test('a monitoring key without stored addresses changes nothing', async () => {
        addNode('GA', ['a@x.com'])
        mockContainer.appConfig.monitoringKey = 'GMONITOR'

        await provider.sendToAll('Cluster issues', 'body')

        expect(sentRecipients()).toEqual([['a@x.com']])
    })
})

describe('EmailProvider.sendToPubkey recipients', () => {
    test('sends to that node\'s addresses only', async () => {
        addNode('GA', ['a@x.com', 'b@x.com'])
        addNode('GB', ['c@x.com'])

        await provider.sendToPubkey('GA', 'Node GA issues', 'body')

        expect(sentRecipients()).toEqual([['a@x.com', 'b@x.com']])
    })

    test('a list stored before the per-node cap existed is still sent to at most 200 addresses', async () => {
        const emails = new Array(250).fill(0).map((_, i) => `legacy${i}@x.com`)
        addNode('GA', emails)

        await provider.sendToPubkey('GA', 'Node GA issues', 'body')

        expect(sentRecipients()).toEqual([emails.slice(0, 200)])
    })

    test('sends nothing for a node without addresses', async () => {
        await provider.sendToPubkey('GNONE', 'Node GNONE issues', 'body')
        expect(mockRequest).not.toHaveBeenCalled()
    })
})

describe('EmailProvider.send deadline', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    test('a request that never settles is abandoned at the deadline, so the caller sees a failure', async () => {
        let signal
        mockRequest.mockImplementationOnce(options => new Promise((resolve, reject) => {
            signal = options.signal
            //what axios does: its listener receives the abort Event, not the reason, and rejects with a bare 'canceled'
            signal.addEventListener('abort', () => reject(new Error('canceled')))
        }))

        const outcome = provider.send(['a@x.com'], 'subject', 'body').then(() => null, e => e)
        await jest.advanceTimersByTimeAsync(14999)
        expect(signal.aborted).toBe(false)
        await jest.advanceTimersByTimeAsync(1)

        const error = await outcome
        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('Email request exceeded 15000ms')
        expect(signal.aborted).toBe(true)
    })

    test('a request that settles leaves no timer behind', async () => {
        await provider.send(['a@x.com'], 'subject', 'body')
        expect(mockRequest).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(0)
    })

    test('a request that fails leaves no timer behind and passes the failure on', async () => {
        mockRequest.mockRejectedValueOnce(new Error('503 from onesignal'))
        await expect(provider.send(['a@x.com'], 'subject', 'body')).rejects.toThrow('503 from onesignal')
        expect(jest.getTimerCount()).toBe(0)
    })
})

describe('a OneSignal request that never answers does not wedge the notifications flush', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.useRealTimers()
    })

    test('the flush settles at the deadline, keeps the item, and the next flush sends it', async () => {
        mockContainer.emailProvider = provider
        addNode('GA', ['a@x.com'])
        mockRequest.mockImplementationOnce(options => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('canceled')))
        }))
        const manager = new NotificationsManager()
        manager.report({
            category: 'node',
            scope: 'GA',
            type: 'CONNECTION_ISSUES',
            message: 'peer down',
            recipient: {kind: 'pubkey', pubkey: 'GA'},
            firstSeenAt: Date.now(),
            dedupKey: 'node:GA:CONNECTION_ISSUES'
        })

        const first = manager.flush()
        let settled = false
        first.then(() => {
            settled = true
        })
        await jest.advanceTimersByTimeAsync(14999)
        expect(settled).toBe(false)
        //the other timer loop waits on the hung pass instead of sending the same item again
        expect(manager.flush()).toBe(first)
        expect(mockRequest).toHaveBeenCalledTimes(1)

        await jest.advanceTimersByTimeAsync(1)
        await expect(first).resolves.toBeUndefined()
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBe(0)

        await manager.flush()
        expect(sentRecipients()).toEqual([['a@x.com'], ['a@x.com']])
        expect(mockRequest.mock.calls[1][0].data.email_subject).toBe('Node GA issues')
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBeGreaterThan(0)
        expect(jest.getTimerCount()).toBe(0)
    })
})
