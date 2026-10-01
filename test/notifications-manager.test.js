/*eslint-disable no-undef */
//eslint-disable-next-line no-var
var mockContainer = {
    emailProvider: {sendToPubkey: jest.fn().mockResolvedValue(undefined), sendToAll: jest.fn().mockResolvedValue(undefined)},
    appConfig: {monitoringKey: 'GMONITORINGPUBKEY'},
    //GA and GB are the current cluster; any other pubkey is a node that has left it
    configManager: {hasNode: jest.fn(pubkey => pubkey === 'GA' || pubkey === 'GB')}
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

    test('clear removes an item that was never sent', () => {
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

describe('flush concurrency and sweeping', () => {
    const day = hoursToMs(24)
    const t0 = 1800000000000
    let manager
    let nowSpy

    function resetTransport() {
        container.emailProvider.sendToPubkey.mockReset()
        container.emailProvider.sendToPubkey.mockResolvedValue(undefined)
        container.emailProvider.sendToAll.mockReset()
        container.emailProvider.sendToAll.mockResolvedValue(undefined)
    }

    beforeEach(() => {
        manager = new NotificationsManager()
        resetTransport()
        container.configManager.hasNode.mockClear()
        container.appConfig.monitoringKey = 'GMONITORINGPUBKEY'
        nowSpy = null
    })

    afterEach(() => {
        if (nowSpy)
            nowSpy.mockRestore()
        resetTransport()
        container.appConfig.monitoringKey = 'GMONITORINGPUBKEY'
    })

    /**
     * @param {number} now - the value Date.now() returns until the next call
     */
    function pinClock(now) {
        if (!nowSpy)
            nowSpy = jest.spyOn(Date, 'now')
        nowSpy.mockReturnValue(now)
    }

    /**
     * @returns {{promise: Promise<void>, resolve: function}} a send the test settles by hand
     */
    function heldSend() {
        let resolve
        const promise = new Promise(res => {
            resolve = res
        })
        return {promise, resolve}
    }

    function reportNode(pubkey, message, type = 'CONNECTION_ISSUES') {
        manager.report({
            category: 'node',
            scope: pubkey,
            type,
            message,
            recipient: {kind: 'pubkey', pubkey},
            firstSeenAt: Date.now(),
            dedupKey: `node:${pubkey}:${type}`
        })
    }

    function reportVote(tx, firstSeenAt) {
        manager.report({
            category: 'cluster',
            type: 'DAO_VOTE',
            message: 'vote ' + tx,
            recipient: {kind: 'monitoring'},
            firstSeenAt,
            dedupKey: 'dao:vote:' + tx
        })
    }

    function pubkeySends() {
        return container.emailProvider.sendToPubkey.mock.calls.map(([pubkey]) => pubkey)
    }

    test('two overlapping flushes deliver the batch once', async () => {
        const send = heldSend()
        container.emailProvider.sendToPubkey.mockImplementationOnce(() => send.promise)
        reportNode('GA', 'peer down')

        const first = manager.flush()
        const second = manager.flush()
        send.resolve()
        await Promise.all([first, second])

        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(1)
        expect(container.emailProvider.sendToPubkey)
            .toHaveBeenCalledWith('GA', 'Node GA issues', expect.stringContaining('<h3>peer down</h3>'))
        expect(container.emailProvider.sendToAll).not.toHaveBeenCalled()
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBeGreaterThan(0)
        //the second caller - the other timer loop - waits on the pass already running rather than starting its own
        expect(second).toBe(first)
    })

    test('an item reported while a flush is in flight goes out with the next flush, once', async () => {
        const send = heldSend()
        container.emailProvider.sendToPubkey.mockImplementationOnce(() => send.promise)
        reportNode('GA', 'peer down')

        const first = manager.flush()
        //the 60 s round reports a new issue and flushes while the 10 s loop's pass is still sending
        reportNode('GB', 'clock drift', 'TIME_SHIFT')
        const second = manager.flush()
        send.resolve()
        await Promise.all([first, second])
        expect(pubkeySends()).toEqual(['GA'])

        //the lock is released once the pass settles, so the next call runs a fresh pass
        await manager.flush()
        expect(pubkeySends()).toEqual(['GA', 'GB'])
        expect(container.emailProvider.sendToPubkey)
            .toHaveBeenLastCalledWith('GB', 'Node GB issues', expect.stringContaining('<h3>clock drift</h3>'))

        //both are inside their throttle window now
        await manager.flush()
        expect(pubkeySends()).toEqual(['GA', 'GB'])
    })

    test('a pass that throws rejects every caller waiting on it and releases the lock', async () => {
        reportNode('GA', 'peer down')
        container.configManager.hasNode.mockImplementationOnce(() => {
            throw new Error('config not loaded')
        })

        const first = manager.flush()
        const second = manager.flush()
        await expect(first).rejects.toThrow('config not loaded')
        await expect(second).rejects.toThrow('config not loaded')
        expect(container.emailProvider.sendToPubkey).not.toHaveBeenCalled()

        await manager.flush()
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(1)
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledWith('GA', 'Node GA issues', expect.any(String))
    })

    test('a send that fails partway through keeps only the undelivered items, and the next flush retries only those', async () => {
        container.emailProvider.sendToPubkey.mockImplementation(pubkey => (pubkey === 'GA'
            ? Promise.reject(new Error('503 from onesignal'))
            : Promise.resolve()))
        reportNode('GA', 'a down')
        reportNode('GB', 'b down')
        manager.report({
            category: 'cluster',
            type: 'NO_MAJORITY',
            message: 'no majority',
            recipient: {kind: 'all'},
            firstSeenAt: Date.now() - hoursToMs(1),
            dedupKey: 'cluster:NO_MAJORITY'
        })

        //the failure stays inside the flush: the monitoring round that awaits it carries on
        await expect(manager.flush()).resolves.toBeUndefined()
        expect(pubkeySends()).toEqual(['GA', 'GB'])
        expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(1)
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBe(0)
        expect(manager._peek('node:GB:CONNECTION_ISSUES').notificationTimestamp).toBeGreaterThan(0)
        expect(manager._peek('cluster:NO_MAJORITY').notificationTimestamp).toBeGreaterThan(0)

        resetTransport()
        await manager.flush()
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(1)
        expect(container.emailProvider.sendToPubkey)
            .toHaveBeenCalledWith('GA', 'Node GA issues', expect.stringContaining('<h3>a down</h3>'))
        expect(container.emailProvider.sendToAll).not.toHaveBeenCalled()
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBeGreaterThan(0)
        expect(manager._size()).toBe(3)
    })

    test('a transport that throws instead of rejecting is handled the same way', async () => {
        container.emailProvider.sendToPubkey.mockImplementationOnce(() => {
            throw new Error('email provider not configured')
        })
        reportNode('GA', 'a down')

        await expect(manager.flush()).resolves.toBeUndefined()
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBe(0)

        await manager.flush()
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(2)
        expect(manager._peek('node:GA:CONNECTION_ISSUES').notificationTimestamp).toBeGreaterThan(0)
    })

    test('an item cleared while its send is in flight stays cleared, and keeps the throttle of that send', async () => {
        pinClock(t0)
        const send = heldSend()
        container.emailProvider.sendToPubkey.mockImplementationOnce(() => send.promise)
        reportNode('GA', 'peer down')

        const inFlight = manager.flush()
        manager.clear('node:GA:CONNECTION_ISSUES')
        send.resolve()
        await inFlight
        expect(manager._peek('node:GA:CONNECTION_ISSUES')).toMatchObject({cleared: true, notificationTimestamp: t0})

        await manager.flush()
        expect(pubkeySends()).toEqual(['GA']) //cleared, so not sent again

        //a recurrence inside the 24 h window is held back by the mail that already went out
        pinClock(t0 + hoursToMs(23))
        reportNode('GA', 'peer down again')
        await manager.flush()
        expect(pubkeySends()).toEqual(['GA'])
        expect(manager._peek('node:GA:CONNECTION_ISSUES')).toMatchObject({cleared: false, message: 'peer down again'})

        pinClock(t0 + hoursToMs(24) + 1)
        await manager.flush()
        expect(pubkeySends()).toEqual(['GA', 'GA'])
    })

    describe('a cleared alert keeps its throttle', () => {
        const key = 'oracle:C1:PRICE_UPDATE_ISSUE'

        function raise(at) {
            manager.report({
                category: 'oracle',
                scope: 'C1',
                type: 'PRICE_UPDATE_ISSUE',
                message: 'Price update issue with oracle C1.',
                recipient: {kind: 'all'},
                firstSeenAt: at,
                dedupKey: key
            })
        }

        test('a sent alert that clears stays as a tombstone that is not sent', async () => {
            pinClock(t0)
            raise(t0)
            await manager.flush()
            manager.clear(key)

            await manager.flush()
            expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(1)
            expect(manager._peek(key)).toMatchObject({cleared: true, notificationTimestamp: t0})
        })

        test('raised again inside the window, it is revived without a mail and restarts its first-seen time', async () => {
            pinClock(t0)
            raise(t0)
            await manager.flush()
            manager.clear(key)

            pinClock(t0 + hoursToMs(0.5))
            raise(t0 + hoursToMs(0.5))
            await manager.flush()
            expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(1)
            expect(manager._peek(key)).toMatchObject({cleared: false, notificationTimestamp: t0, firstSeenAt: t0 + hoursToMs(0.5)})

            pinClock(t0 + hoursToMs(1) + 1) //the 1 h PRICE_UPDATE_ISSUE window has passed and the alert still stands
            await manager.flush()
            expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(2)
        })

        test('a tombstone is kept until its window passes, then swept', async () => {
            pinClock(t0)
            raise(t0)
            await manager.flush()
            manager.clear(key)

            pinClock(t0 + hoursToMs(1))
            await manager.flush()
            expect(manager._peek(key)).toBeDefined()

            pinClock(t0 + hoursToMs(1) + 1)
            await manager.flush()
            expect(manager._peek(key)).toBeUndefined()
            expect(manager._size()).toBe(0)
        })

        test('raised again once the window has passed, it mails at once', async () => {
            pinClock(t0)
            raise(t0)
            await manager.flush()
            manager.clear(key)

            pinClock(t0 + hoursToMs(1) + 1)
            raise(t0 + hoursToMs(1) + 1)
            await manager.flush()
            expect(container.emailProvider.sendToAll).toHaveBeenCalledTimes(2)
        })

        test('an alert cleared before it was ever sent is dropped at once', () => {
            pinClock(t0)
            raise(t0)
            manager.clear(key)
            expect(manager._peek(key)).toBeUndefined()
        })

        test('an alert cleared while a flush is in flight but never sent by it is swept by that flush', async () => {
            pinClock(t0)
            const send = heldSend()
            container.emailProvider.sendToPubkey.mockImplementationOnce(() => send.promise)
            reportNode('GA', 'peer down')
            const inFlight = manager.flush() //holds the flush open on GA's send
            raise(t0) //reported during the flush, so this pass does not send it
            manager.clear(key)
            expect(manager._peek(key)).toMatchObject({cleared: true, notificationTimestamp: 0})

            send.resolve()
            await inFlight
            expect(manager._peek(key)).toBeUndefined()
            expect(container.emailProvider.sendToAll).not.toHaveBeenCalled()
        })
    })

    test('an item reported during a flush survives that flush\'s sweep, however old its own timestamp', async () => {
        const send = heldSend()
        container.emailProvider.sendToPubkey.mockImplementationOnce(() => send.promise)
        reportNode('GA', 'peer down')

        const inFlight = manager.flush()
        //a DAO vote read on catch-up carries its ledger close time, which can be more than a week in the past
        reportVote('TXOLD', Date.now() - 8 * day)
        send.resolve()
        await inFlight
        expect(manager._peek('dao:vote:TXOLD')).toBeDefined()

        await manager.flush()
        expect(container.emailProvider.sendToPubkey)
            .toHaveBeenLastCalledWith('GMONITORINGPUBKEY', 'Reflector monitoring events', expect.stringContaining('vote TXOLD'))
        expect(manager._peek('dao:vote:TXOLD').notificationTimestamp).toBeGreaterThan(0)
    })

    test('an item whose send failed is kept for the next attempt, however old its own timestamp', async () => {
        container.emailProvider.sendToPubkey.mockRejectedValueOnce(new Error('503 from onesignal'))
        reportVote('TXOLD', Date.now() - 8 * day)

        await manager.flush()
        expect(manager._peek('dao:vote:TXOLD').notificationTimestamp).toBe(0)

        await manager.flush()
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(2)
        expect(container.emailProvider.sendToPubkey)
            .toHaveBeenLastCalledWith('GMONITORINGPUBKEY', 'Reflector monitoring events', expect.stringContaining('vote TXOLD'))
        expect(manager._peek('dao:vote:TXOLD').notificationTimestamp).toBeGreaterThan(0)
    })

    test('an item that can never be delivered is swept once it has been held for more than seven days', async () => {
        pinClock(t0)
        container.appConfig.monitoringKey = null //no recipient, so the item is never marked sent
        //its own timestamp is already past the window; what counts is how long this process has held it
        reportVote('TX1', t0 - 8 * day)

        await manager.flush()
        expect(manager._size()).toBe(1)

        pinClock(t0 + 7 * day)
        await manager.flush()
        expect(manager._size()).toBe(1)

        pinClock(t0 + 7 * day + 1)
        await manager.flush()
        expect(manager._size()).toBe(0)
        expect(container.emailProvider.sendToPubkey).not.toHaveBeenCalled()
    })

    test('a recent undelivered item is kept', async () => {
        container.appConfig.monitoringKey = null
        reportVote('TX2', Date.now())

        await manager.flush()

        expect(manager._size()).toBe(1)
        expect(manager._peek('dao:vote:TX2').notificationTimestamp).toBe(0)
    })

    test('a delivered item is kept for seven days after its send, then swept', async () => {
        pinClock(t0)
        reportVote('TX3', t0)
        await manager.flush()
        expect(manager._peek('dao:vote:TX3').notificationTimestamp).toBe(t0)

        pinClock(t0 + 7 * day)
        await manager.flush()
        expect(manager._size()).toBe(1)

        pinClock(t0 + 7 * day + 1)
        await manager.flush()
        expect(manager._size()).toBe(0)
        expect(container.emailProvider.sendToPubkey).toHaveBeenCalledTimes(1)
    })

    test('an item for a node that has left the cluster is not sent to it', async () => {
        reportNode('GGONE', 'gone down')
        reportNode('GA', 'a down')

        await manager.flush()

        expect(pubkeySends()).toEqual(['GA'])
        expect(container.configManager.hasNode).toHaveBeenCalledWith('GGONE')
        expect(manager._peek('node:GGONE:CONNECTION_ISSUES').notificationTimestamp).toBe(0)
    })
})
