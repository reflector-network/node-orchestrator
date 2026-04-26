/*eslint-disable no-undef */
const WebSocket = require('ws')
const IncomingChannel = require('../server/ws/incoming-channel')

function makeFakeSocket() {
    const listeners = {}
    return {
        readyState: WebSocket.OPEN,
        ping: jest.fn(),
        close: jest.fn(),
        terminate: jest.fn(),
        send: jest.fn((_, cb) => cb && cb()),
        addListener: jest.fn(function (event, fn) {
            listeners[event] = (listeners[event] || []).concat(fn)
            return this
        }),
        on: jest.fn(function (event, fn) {
            listeners[event] = (listeners[event] || []).concat(fn)
            return this
        }),
        removeAllListeners: jest.fn(),
        __emit(event, ...args) {
            for (const fn of (listeners[event] || []))
                fn(...args)
        },
        __listeners: listeners
    }
}

describe('IncomingChannelBase keepalive', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })
    afterEach(() => {
        jest.useRealTimers()
    })

    test('survives 2 missed pongs and stays open', () => {
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, 'GABCDEF', true)

        //first pong attempt sent on construction
        expect(ws.ping).toHaveBeenCalledTimes(1)

        //miss 1 → re-arm, no close
        jest.advanceTimersByTime(4000)
        expect(ws.ping).toHaveBeenCalledTimes(2)
        expect(ws.close).not.toHaveBeenCalled()

        //miss 2 → re-arm, no close
        jest.advanceTimersByTime(4000)
        expect(ws.ping).toHaveBeenCalledTimes(3)
        expect(ws.close).not.toHaveBeenCalled()

        //pong recovers — counter resets
        ws.__emit('pong')
        //next ping cycle will start after 10s scheduling delay
        jest.advanceTimersByTime(10_000)
        expect(ws.close).not.toHaveBeenCalled()

        channel.close(1000, 'test', true)
    })

    test('closes after 3 consecutive missed pongs', () => {
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, 'GABCDEF', true)

        jest.advanceTimersByTime(4000) //miss 1
        jest.advanceTimersByTime(4000) //miss 2
        jest.advanceTimersByTime(4000) //miss 3 → close

        expect(ws.close).toHaveBeenCalledWith(1001, expect.stringContaining('missed pongs'))
        channel.close(1000, 'test', true)
    })

    test('inbound message resets pong timer and stamps lastMessageAt', async () => {
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, 'GABCDEF', true)

        //2 misses bring us close to the close threshold
        jest.advanceTimersByTime(4000)
        jest.advanceTimersByTime(4000)

        //inbound message clears state
        ws.__emit('message', JSON.stringify({type: 200}))
        await Promise.resolve() //let the async handler flush
        expect(channel.isFresh(1000)).toBe(true)
        expect(ws.close).not.toHaveBeenCalled()

        //one more 4s window without a pong → only first miss after reset, still alive
        jest.advanceTimersByTime(10_000) //ping schedule delay
        jest.advanceTimersByTime(4000) //miss 1 after reset
        expect(ws.close).not.toHaveBeenCalled()

        channel.close(1000, 'test', true)
    })

    test('isFresh returns false past the threshold', () => {
        const ws = makeFakeSocket()
        const channel = new IncomingChannel(ws, 'GABCDEF', true)

        ws.__emit('pong') //stamp lastMessageAt
        jest.advanceTimersByTime(2000)
        expect(channel.isFresh(1500)).toBe(false)
        expect(channel.isFresh(2500)).toBe(true)

        channel.close(1000, 'test', true)
    })
})
