/*eslint-disable no-undef */
//eslint-disable-next-line no-var
var mockContainer = {
    emailProvider: {sendToPubkey: jest.fn().mockResolvedValue(undefined), sendToAll: jest.fn().mockResolvedValue(undefined)},
    appConfig: {monitoringKey: 'GMONITORINGPUBKEY'}
}

jest.mock('../domain/container', () => mockContainer)

jest.mock('../logger', () => ({
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
}))

const container = require('../domain/container')
const NotificationsManager = require('../domain/notifications/notifications-manager')

describe('NotificationsManager report/clear', () => {
    let manager

    beforeEach(() => {
        jest.resetModules()
        jest.isolateModules(() => {
            manager = new NotificationsManager()
        })
        container.emailProvider.sendToPubkey.mockClear()
        container.emailProvider.sendToAll.mockClear()
    })

    test('report inserts a new item keyed by dedupKey', () => {
        manager.report({
            category: 'oracle',
            scope: 'C1',
            type: 'PRICE_SPIKE',
            message: 'spike 1',
            recipient: {kind: 'monitoring'},
            firstSeenAt: 100,
            dedupKey: 'oracle:C1:asset:0:PRICE_SPIKE'
        })
        expect(manager._size()).toBe(1)
    })

    test('report on existing dedupKey updates message but preserves firstSeenAt and notificationTimestamp', () => {
        const key = 'oracle:C1:asset:0:PRICE_SPIKE'
        manager.report({category: 'oracle', scope: 'C1', type: 'PRICE_SPIKE', message: 'm1', recipient: {kind: 'monitoring'}, firstSeenAt: 100, dedupKey: key})
        const before = manager._peek(key)
        before.notificationTimestamp = 999 //simulate previously sent
        manager.report({category: 'oracle', scope: 'C1', type: 'PRICE_SPIKE', message: 'm2', recipient: {kind: 'monitoring'}, firstSeenAt: 200, dedupKey: key})
        const after = manager._peek(key)
        expect(after.message).toBe('m2')
        expect(after.firstSeenAt).toBe(100)
        expect(after.notificationTimestamp).toBe(999)
    })

    test('clear removes the item', () => {
        const key = 'cluster:NO_MAJORITY'
        manager.report({category: 'cluster', type: 'NO_MAJORITY', message: 'm', recipient: {kind: 'all'}, firstSeenAt: 1, dedupKey: key})
        manager.clear(key)
        expect(manager._size()).toBe(0)
    })

    test('clear on unknown key is a no-op', () => {
        expect(() => manager.clear('missing')).not.toThrow()
        expect(manager._size()).toBe(0)
    })
})

describe('NotificationsManager flush', () => {
    let manager

    beforeEach(() => {
        jest.resetModules()
        jest.isolateModules(() => {
            manager = new NotificationsManager()
        })
        container.emailProvider.sendToPubkey.mockClear()
        container.emailProvider.sendToAll.mockClear()
        container.appConfig.monitoringKey = 'GMONITORINGPUBKEY'
    })

    test('flush groups items by recipient and sends one email per group', async () => {
        const t = Date.now() - 1000 * 60 * 60 * 7 //7 hours old to clear all min-age guards
        manager.report({category: 'node', scope: 'GA', type: 'NODE_UNAVAILABLE', message: 'a down', recipient: {kind: 'pubkey', pubkey: 'GA'}, firstSeenAt: t, dedupKey: 'node:GA:NODE_UNAVAILABLE'})
        manager.report({category: 'node', scope: 'GB', type: 'NODE_UNAVAILABLE', message: 'b down', recipient: {kind: 'pubkey', pubkey: 'GB'}, firstSeenAt: t, dedupKey: 'node:GB:NODE_UNAVAILABLE'})
        manager.report({category: 'cluster', type: 'NO_MAJORITY', message: 'no maj', recipient: {kind: 'all'}, firstSeenAt: t, dedupKey: 'cluster:NO_MAJORITY'})
        manager.report({category: 'oracle', scope: 'C1', type: 'PRICE_SPIKE', message: 'spike', recipient: {kind: 'monitoring'}, firstSeenAt: t, dedupKey: 'oracle:C1:asset:0:PRICE_SPIKE'})

        await manager.flush()

        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(3) //GA, GB, monitoringKey
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledWith('GA', expect.stringContaining('Node GA'), expect.any(String))
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledWith('GB', expect.stringContaining('Node GB'), expect.any(String))
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledWith('GMONITORINGPUBKEY', 'Reflector monitoring events', expect.any(String))
        expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(1)
        expect(container.emailProvider.sendToAll).toHaveBeenCalledWith('Cluster issues', expect.any(String))
    })

    test('flush skips items whose shouldSend is false', async () => {
        const recent = Date.now() //too recent for min-age threshold
        manager.report({category: 'cluster', type: 'NO_MAJORITY', message: 'm', recipient: {kind: 'all'}, firstSeenAt: recent, dedupKey: 'cluster:NO_MAJORITY'})
        await manager.flush()
        expect(container.emailProvider.sendToAll).not.toHaveBeenCalled()
    })

    test('flush with monitoring recipient is a no-op when monitoringKey is unset', async () => {
        container.appConfig.monitoringKey = null
        const t = Date.now() - hoursToMs(7)
        manager.report({category: 'oracle', scope: 'C1', type: 'PRICE_SPIKE', message: 'm', recipient: {kind: 'monitoring'}, firstSeenAt: t, dedupKey: 'oracle:C1:asset:0:PRICE_SPIKE'})
        await manager.flush()
        expect(container.emailProvider.sendToPubkey).not.toHaveBeenCalled()
    })

    test('flush marks items as sent on success', async () => {
        const t = Date.now() - hoursToMs(7)
        const key = 'cluster:NO_MAJORITY'
        manager.report({category: 'cluster', type: 'NO_MAJORITY', message: 'm', recipient: {kind: 'all'}, firstSeenAt: t, dedupKey: key})
        await manager.flush()
        expect(manager._peek(key).notificationTimestamp).toBeGreaterThan(0)
    })

    test('flush does NOT mark items as sent on email failure', async () => {
        container.emailProvider.sendToAll.mockRejectedValueOnce(new Error('boom'))
        const t = Date.now() - hoursToMs(7)
        const key = 'cluster:NO_MAJORITY'
        manager.report({category: 'cluster', type: 'NO_MAJORITY', message: 'm', recipient: {kind: 'all'}, firstSeenAt: t, dedupKey: key})
        await manager.flush()
        expect(manager._peek(key).notificationTimestamp).toBe(0)
    })

    test('flush sweeps items older than 7 days after dispatch', async () => {
        const t = Date.now() - hoursToMs(7)
        const key = 'dao:ballot:abc'
        manager.report({category: 'cluster', type: 'DAO_BALLOT_CREATED', message: 'm', recipient: {kind: 'monitoring'}, firstSeenAt: t, dedupKey: key})
        await manager.flush()
        //simulate 8 days passing
        manager._peek(key).notificationTimestamp = Date.now() - hoursToMs(24 * 8)
        await manager.flush()
        expect(manager._size()).toBe(0)
    })
})

function hoursToMs(h) {
    return 1000 * 60 * 60 * h
}
