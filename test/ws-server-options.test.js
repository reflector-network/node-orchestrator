/*eslint-disable no-undef */
const {WebSocketServer, WebSocket} = require('ws')
const {wsServerOptions} = require('../server/ws/connection-handler')

describe('WebSocket server options', () => {
    test('declare a 1 MiB payload cap and no compression', () => {
        expect(wsServerOptions).toEqual({noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false})
    })

    test('a frame above maxPayload closes the socket with 1009', async () => {
        const server = new WebSocketServer({...wsServerOptions, noServer: false, port: 0})
        //ws emits 'error' on the per-connection socket synchronously when maxPayload is exceeded; production code
        //always has a listener by then (ChannelBase attaches one on construction), but this raw server does not
        server.on('connection', ws => ws.on('error', () => {}))
        await new Promise(resolve => server.once('listening', resolve))
        const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`)
        await new Promise(resolve => client.once('open', resolve))
        const closed = new Promise(resolve => client.once('close', code => resolve(code)))

        client.send(Buffer.alloc(wsServerOptions.maxPayload + 1))

        await expect(closed).resolves.toBe(1009)
        server.close()
    })
})
