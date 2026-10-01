/*eslint-disable no-undef */
const WebSocket = require('ws')

/**
 * Minimal ws stand-in: readyState flag, spies for ping/send/close/terminate, and a listener registry.
 * close() and terminate() flip readyState but do not emit 'close'. Tests emit events with __emit().
 * @returns {object}
 */
function makeFakeSocket() {
    const listeners = {}
    const register = jest.fn(function (event, fn) {
        listeners[event] = (listeners[event] || []).concat(fn)
        return this
    })
    const socket = {
        readyState: WebSocket.OPEN,
        ping: jest.fn(),
        send: jest.fn((_, cb) => cb && cb()),
        close: jest.fn(function () {
            this.readyState = WebSocket.CLOSED
        }),
        terminate: jest.fn(function () {
            this.readyState = WebSocket.CLOSED
        }),
        addListener: register,
        on: register,
        once: jest.fn(function (event, fn) {
            const wrapper = (...args) => {
                listeners[event] = listeners[event].filter(l => l !== wrapper)
                fn(...args)
            }
            listeners[event] = (listeners[event] || []).concat(wrapper)
            return this
        }),
        removeAllListeners: jest.fn(),
        __emit(event, ...args) {
            for (const fn of [...(listeners[event] || [])])
                fn(...args)
        },
        __listeners: listeners
    }
    return socket
}

module.exports = {makeFakeSocket}
