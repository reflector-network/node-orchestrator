/*eslint-disable no-undef */
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const container = require('../domain/container')
const notificationProvider = require('../domain/notification-provider')
const ChannelTypes = require('../server/ws/channel-types')

function makeChannel(isReady) {
    return {isReady, send: jest.fn((message) => Promise.resolve(message))}
}

describe('notificationProvider', () => {
    test('notify sends only to ready channels, each with its own message copy', async () => {
        const ready1 = makeChannel(true)
        const ready2 = makeChannel(true)
        const notReady = makeChannel(false)
        container.connectionManager = {all: jest.fn(() => [ready1, notReady, ready2])}
        const message = {type: 3, data: {x: 1}}

        await notificationProvider.notify(message, ChannelTypes.INCOMING)

        expect(container.connectionManager.all).toHaveBeenCalledWith(ChannelTypes.INCOMING)
        expect(notReady.send).not.toHaveBeenCalled()
        expect(ready1.send).toHaveBeenCalledTimes(1)
        expect(ready2.send).toHaveBeenCalledTimes(1)
        const sent1 = ready1.send.mock.calls[0][0]
        const sent2 = ready2.send.mock.calls[0][0]
        expect(sent1).toEqual(message)
        expect(sent1).not.toBe(message)
        expect(sent1).not.toBe(sent2)
    })

    test('notifyNode skips a node whose channel is not ready', async () => {
        const channel = makeChannel(false)
        container.connectionManager = {getNodeConnection: jest.fn(() => channel)}

        await notificationProvider.notifyNode({type: 3}, 'GA')

        expect(channel.send).not.toHaveBeenCalled()
    })

    test('notifyNode sends a copy to a ready node channel', async () => {
        const channel = makeChannel(true)
        container.connectionManager = {getNodeConnection: jest.fn(() => channel)}
        const message = {type: 3, data: {}}

        await notificationProvider.notifyNode(message, 'GA')

        expect(channel.send).toHaveBeenCalledTimes(1)
        expect(channel.send.mock.calls[0][0]).toEqual(message)
        expect(channel.send.mock.calls[0][0]).not.toBe(message)
    })
})
