/*eslint-disable no-undef */
const WebSocket = require('ws')
const container = require('../domain/container')
const IncomingChannel = require('../server/ws/incoming-channel')
const MessageTypes = require('../server/ws/handlers/message-types')
const {makeFakeSocket} = require('./helpers/fake-socket')

const PUBKEY = 'GABCDEF'

describe('ChannelBase pending requests', () => {
    beforeEach(() => {
        jest.useFakeTimers()
        container.handlersManager = {handle: jest.fn(() => undefined)}
        container.connectionManager = {remove: jest.fn()}
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('rejects the pending request when the response handler throws', async () => {
        container.handlersManager.handle = jest.fn(() => {
            throw new Error('Invalid signature')
        })
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, PUBKEY, true)

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: channel.authPayload}})
        const {requestId} = JSON.parse(ws.send.mock.calls[0][0])
        ws.__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: requestId, data: {signature: '00'}}))

        await expect(pending).rejects.toThrow('Invalid signature')
        expect(channel.isValidated).toBe(false)
        channel.close(1000, 'test', true)
    })

    test('resolves the pending request when the response handler succeeds', async () => {
        container.handlersManager.handle = jest.fn((channel) => {
            channel.validated()
        })
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, PUBKEY, true)

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: channel.authPayload}})
        const {requestId} = JSON.parse(ws.send.mock.calls[0][0])
        ws.__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: requestId, data: {signature: 'aa'}}))

        await expect(pending).resolves.toBeUndefined()
        expect(channel.isValidated).toBe(true)
        channel.close(1000, 'test', true)
    })

    test('a timed-out request on one channel does not leave another channel\'s entry behind', async () => {
        const ws1 = makeFakeSocket()
        const ws2 = makeFakeSocket()
        const channel1 = new IncomingChannel(ws1, PUBKEY, true)
        const channel2 = new IncomingChannel(ws2, PUBKEY, true)
        const message = {type: MessageTypes.CONFIG, data: {}} //the same object, as notify() passes it

        const pending1 = channel1.send(message)
        const pending2 = channel2.send(message)
        pending1.catch(() => {})
        pending2.catch(() => {})
        expect(Object.keys(channel1.__requests)).toHaveLength(1)
        expect(Object.keys(channel2.__requests)).toHaveLength(1)

        jest.advanceTimersByTime(5000)

        await expect(pending1).rejects.toThrow('timed out')
        await expect(pending2).rejects.toThrow('timed out')
        expect(Object.keys(channel1.__requests)).toHaveLength(0)
        expect(Object.keys(channel2.__requests)).toHaveLength(0)
        channel1.close(1000, 'test', true)
        channel2.close(1000, 'test', true)
    })

    test('send honours an explicit timeout', async () => {
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, PUBKEY, true)

        const pending = channel.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {}}, 100)
        pending.catch(() => {})
        jest.advanceTimersByTime(99)
        expect(Object.keys(channel.__requests)).toHaveLength(1)
        jest.advanceTimersByTime(1)

        await expect(pending).rejects.toThrow('Request timed out after 100')
        channel.close(1000, 'test', true)
    })
    describe('a request pending on a socket that goes away fails at once', () => {
        /**
         * @returns {{ws: object, channel: IncomingChannel, pending: Promise<Error>}} a channel with one request pending
         */
        function withPendingRequest() {
            const ws = makeFakeSocket()
            const channel = new IncomingChannel(ws, PUBKEY, true)
            const pending = channel.send({type: MessageTypes.LOGS_REQUEST, data: {}}).catch(e => e)
            expect(Object.keys(channel.__requests)).toHaveLength(1)
            return {ws, channel, pending}
        }

        test('when the orchestrator closes the channel', async () => {
            const {channel, pending} = withPendingRequest()

            channel.close(1001, 'Connection replaced', true)

            const error = await pending
            expect(error.message).toBe('Connection closed before the peer answered: 1001 Connection replaced. GABCDEF 2')
            expect(error.connectionClosed).toBe(true)
            expect(channel.__requests).toEqual({})
            expect(jest.getTimerCount()).toBe(2) //the channel's own ping and close timers; the 5 s send deadline is gone
        })

        test('when the socket reports its close', async () => {
            const {ws, channel, pending} = withPendingRequest()

            ws.readyState = WebSocket.CLOSED
            ws.__emit('close', 1006, Buffer.alloc(0))

            const error = await pending
            expect(error.message).toBe('Connection closed before the peer answered: 1006 abnormal. GABCDEF 2')
            expect(error.connectionClosed).toBe(true)
            expect(channel.__requests).toEqual({})
        })

        test('when ws reports a protocol error and has started closing, as for an oversized frame', async () => {
            const {ws, channel, pending} = withPendingRequest()

            ws.readyState = WebSocket.CLOSING
            ws.__emit('error', new RangeError('Max payload size exceeded'))

            const error = await pending
            expect(error.message).toBe('Connection closed before the peer answered: Max payload size exceeded. GABCDEF 2')
            expect(error.connectionClosed).toBe(true)
            expect(channel.__requests).toEqual({})
        })

        test('a request on a socket that is no longer open fails as not connected and leaves nothing pending', async () => {
            const ws = makeFakeSocket()
            const channel = new IncomingChannel(ws, PUBKEY, true)
            ws.readyState = WebSocket.CLOSED
            const timersBefore = jest.getTimerCount()

            const error = await channel.send({type: MessageTypes.LOGS_REQUEST, data: {}}).catch(e => e)

            expect(error.message).toBe('Connection is not open. GABCDEF 2')
            expect(error.notConnected).toBe(true)
            expect(channel.__requests).toEqual({})
            expect(jest.getTimerCount()).toBe(timersBefore)
            expect(ws.send).not.toHaveBeenCalled()
        })

        test('but not on an error that leaves the socket open, such as a frame that is not json', () => {
            const {ws, channel} = withPendingRequest()

            ws.__emit('message', 'not json')

            expect(Object.keys(channel.__requests)).toHaveLength(1)
            channel.close(1000, 'test', true)
        })
    })
})
