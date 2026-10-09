/*eslint-disable no-undef */
//Real sockets end to end: the HTTP server from server/index.js, its upgrade dispatch, the ws servers and a ws client
//playing the node. What these tests pin - the frame cap a connection gets and what happens to a request pending on a
//socket that dies - only shows on a real socket, not on the fake one the unit tests use.
const http = require('http')
const net = require('net')
const {createHash, randomBytes} = require('crypto')
const {WebSocket} = require('ws')
const {Keypair} = require('@stellar/stellar-sdk')

const mockNonces = new Map()
/*eslint-disable require-await */
jest.mock('../domain/nonce-provider', () => ({
    get: async (pubkey) => mockNonces.get(pubkey) || 0,
    tryConsume: async (pubkey, nonce) => {
        if ((mockNonces.get(pubkey) || 0) >= nonce)
            return false
        mockNonces.set(pubkey, nonce)
        return true
    }
}))
/*eslint-enable require-await */
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn(), trace: jest.fn()}))

const container = require('../domain/container')
const ConnectionManager = require('../domain/connections-manager')
const HandlersManager = require('../server/ws/handlers/handlers-manager')
const {LogTokenProvider} = require('../domain/log-token-provider')
const MessageTypes = require('../server/ws/handlers/message-types')
const {wsServerOptions, nodeWsServerOptions, isNodeUpgrade, refusedSocketGrace} = require('../server/ws/connection-handler')
const Server = require('../server')

const nodeKeypair = Keypair.random()
const pubkey = nodeKeypair.publicKey()
let nonce = Date.now()

/**
 * A log file shaped like the node's pino output: JSON lines full of quotes, with escaped backslashes and newlines in
 * the messages, which is what inflates the frame when the node JSON-encodes the file into its answer
 * @param {number} bytes - file size
 * @returns {string}
 */
function pinoLog(bytes) {
    const line = JSON.stringify({
        level: 30,
        time: 1758700000000,
        ctxId: 'c0ffee',
        msg: 'Price round {"contract":"CAA2NN3T","path":"C:\\reflector\\home\\logs"} submitted\n  at runner-base.js:125'
    }) + '\n'
    return line.repeat(Math.ceil(bytes / line.length)).substring(0, bytes)
}

/**
 * Signs a GET the way admin-dashboard's api/interface.js does
 * @param {string} routePath - route path without the leading slash
 * @returns {string} authorization header value
 */
function authHeader(routePath) {
    nonce += 1
    const payload = `${routePath}?nonce=${nonce}`
    const messageHash = createHash('sha256').update(`${pubkey}:${JSON.stringify(payload)}`, 'utf8').digest()
    const signature = Buffer.from(nodeKeypair.sign(messageHash)).toString('hex')
    return `${pubkey}.${signature}.${nonce}`
}

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, method: 'GET', path, headers}, res => {
            const chunks = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}))
        })
        req.on('error', reject)
        req.end()
    })
}

async function waitFor(predicate, timeout = 3000) {
    const started = Date.now()
    while (!predicate()) {
        if (Date.now() - started > timeout)
            throw new Error('condition not met in time')
        await new Promise(resolve => setTimeout(resolve, 10))
    }
}

/**
 * Connects a ws client as the node: it answers the handshake challenge, acknowledges every other request, and hands
 * each request it gets to `onRequest` first
 * @param {number} port - server port
 * @param {function(WebSocket, object): boolean} [onRequest] - returns true when it answered the request itself
 * @returns {Promise<WebSocket>} the client once the orchestrator registered the node connection
 */
async function connectNode(port, onRequest = () => false) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {headers: {pubkey, app: 'node'}})
    ws.on('error', () => {})
    ws.on('message', raw => {
        const message = JSON.parse(raw)
        if (message.type === MessageTypes.HANDSHAKE_REQUEST) {
            const signature = Buffer.from(nodeKeypair.sign(Buffer.from(message.data.payload))).toString('hex')
            ws.send(JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: message.requestId, data: {signature}}))
            return
        }
        if (!message.requestId || onRequest(ws, message))
            return
        ws.send(JSON.stringify({type: MessageTypes.OK, responseId: message.requestId}))
    })
    await waitFor(() => container.connectionManager.getNodeConnection(pubkey)?.isReady)
    return ws
}

function closed(ws) {
    return new Promise(resolve => ws.once('close', code => resolve(code)))
}

describe('WebSocket frame caps and pending requests on a dying socket', () => {
    let server
    let port
    let clients

    beforeAll(async () => {
        container.appConfig = {whitelist: ['*']}
        container.configManager = {hasNode: key => key === pubkey, notifyNodeAboutUpdate: jest.fn()}
        container.connectionManager = new ConnectionManager()
        container.handlersManager = new HandlersManager()
        container.logTokenProvider = new LogTokenProvider()
        server = new Server()
        server.init(0)
        await new Promise(resolve => server.server.once('listening', resolve))
        port = server.server.address().port
    })

    beforeEach(() => {
        clients = []
    })

    afterEach(async () => {
        for (const client of clients) {
            if (client.readyState !== WebSocket.CLOSED) {
                const done = closed(client)
                client.terminate()
                await done
            }
        }
        await waitFor(() => !container.connectionManager.getNodeConnection(pubkey))
    })

    afterAll(async () => {
        await new Promise(resolve => server.server.close(resolve))
    })

    test('a node answers a 2 MiB rotated log file in one frame, and the operator gets the file', async () => {
        const logFile = pinoLog(2097336) //a rotated node log: rotation at 2M lands a little past 2 MiB
        let frameBytes = 0
        const node = await connectNode(port, (ws, message) => {
            if (message.type !== MessageTypes.LOG_FILE_REQUEST)
                return false
            const frame = JSON.stringify({type: MessageTypes.OK, data: {logFile}, responseId: message.requestId})
            frameBytes = Buffer.byteLength(frame)
            ws.send(frame)
            return true
        })
        clients.push(node)

        const res = await get(port, '/logs/combined.log', {authorization: authHeader('logs/combined.log')})

        expect(res.status).toBe(200)
        expect(JSON.parse(res.body).logFile).toBe(logFile)
        //the escaping took the frame well past the file size, and past the anonymous cap twice over
        expect(frameBytes).toBeGreaterThan(2.3 * 1024 * 1024)
        expect(frameBytes).toBeLessThan(nodeWsServerOptions.maxPayload)
        expect(node.readyState).toBe(WebSocket.OPEN)
    }, 15000)

    test('an anonymous client is still held to 1 MiB: a 1.5 MB frame closes it with 1009', async () => {
        const anon = new WebSocket(`ws://127.0.0.1:${port}`)
        anon.on('error', () => {})
        clients.push(anon)
        await new Promise(resolve => anon.once('open', resolve))
        await waitFor(() => container.connectionManager.all().length === 1)
        const code = closed(anon)

        anon.send(JSON.stringify({type: MessageTypes.OK, data: 'x'.repeat(1500000)}))

        await expect(code).resolves.toBe(1009)
    }, 15000)

    test('a request pending on a node connection is rejected as soon as the socket closes, not at the deadline', async () => {
        const node = await connectNode(port, (ws, message) => {
            if (message.type !== MessageTypes.LOGS_REQUEST)
                return false
            ws.terminate() //the node process dies with the request in hand
            return true
        })
        clients.push(node)
        const channel = container.connectionManager.getNodeConnection(pubkey)
        const started = Date.now()

        const error = await channel.send({type: MessageTypes.LOGS_REQUEST, data: {}}).catch(e => e)

        expect(Date.now() - started).toBeLessThan(1000) //the send deadline is 5 s
        expect(error).toBeInstanceOf(Error)
        expect(error.connectionClosed).toBe(true)
        expect(error.timeout).toBeUndefined()
        expect(error.message).toMatch(/^Connection closed before the peer answered/)
        expect(Object.keys(channel.__requests)).toEqual([])
    }, 15000)

    test('an answer over the node cap is refused with 1009 and its request fails at once, naming the cause', async () => {
        const node = await connectNode(port, (ws, message) => {
            if (message.type !== MessageTypes.LOG_FILE_REQUEST)
                return false
            ws.send(JSON.stringify({type: MessageTypes.OK, data: {logFile: 'x'.repeat(nodeWsServerOptions.maxPayload)}, responseId: message.requestId}))
            return true
        })
        clients.push(node)
        const code = closed(node)
        const channel = container.connectionManager.getNodeConnection(pubkey)
        const started = Date.now()

        const error = await channel.send({type: MessageTypes.LOG_FILE_REQUEST, data: {}}).catch(e => e)

        expect(Date.now() - started).toBeLessThan(1000)
        expect(error.connectionClosed).toBe(true)
        expect(error.message).toContain('Max payload size exceeded')
        await expect(code).resolves.toBe(1009)
    }, 15000)
})

/**
 * A client that performs the WebSocket upgrade by hand and then reads frames without ever answering one - not even
 * the close frame, which a ws client would answer at once. ws waits 30 s for that answer before it drops the socket
 * @param {number} port - server port
 * @param {object} headers - extra upgrade headers
 * @returns {{socket: net.Socket, frames: {opcode: number, payload: Buffer}[], closed: Promise<number>}} the socket, the
 * frames it received, and the time its connection ended
 */
function silentClient(port, headers = {}) {
    const socket = net.connect(port, '127.0.0.1')
    const frames = []
    let buffer = Buffer.alloc(0)
    let upgraded = false
    socket.on('error', () => {})
    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        if (!upgraded) {
            const end = buffer.indexOf('\r\n\r\n')
            if (end < 0)
                return
            upgraded = true
            buffer = buffer.subarray(end + 4)
        }
        //server frames are never masked
        while (buffer.length >= 2) {
            let length = buffer[1] & 0x7f
            let offset = 2
            if (length === 126) {
                if (buffer.length < 4)
                    return
                length = buffer.readUInt16BE(2)
                offset = 4
            } else if (length === 127) {
                if (buffer.length < 10)
                    return
                length = Number(buffer.readBigUInt64BE(2))
                offset = 10
            }
            if (buffer.length < offset + length)
                return
            frames.push({opcode: buffer[0] & 0x0f, payload: buffer.subarray(offset, offset + length)})
            buffer = buffer.subarray(offset + length)
        }
    })
    const closed = new Promise(resolve => socket.once('close', () => resolve(Date.now())))
    const lines = ['GET / HTTP/1.1', `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)]
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    return {socket, frames, closed}
}

/**
 * @param {{opcode: number, payload: Buffer}[]} frames - frames a silent client received
 * @returns {{code: number, reason: string}|null} the close frame among them
 */
function closeFrame(frames) {
    const frame = frames.find(f => f.opcode === 0x8)
    return frame ? {code: frame.payload.readUInt16BE(0), reason: frame.payload.subarray(2).toString()} : null
}

describe('a socket the server refuses is released after a short grace, not the 30 s close timeout', () => {
    let server
    let port
    let sockets

    beforeAll(async () => {
        container.appConfig = {whitelist: ['*']}
        container.configManager = {hasNode: key => key === pubkey, notifyNodeAboutUpdate: jest.fn()}
        container.connectionManager = new ConnectionManager()
        container.handlersManager = new HandlersManager()
        container.logTokenProvider = new LogTokenProvider()
        server = new Server()
        server.init(0)
        await new Promise(resolve => server.server.once('listening', resolve))
        port = server.server.address().port
    })

    beforeEach(() => {
        sockets = []
    })

    afterEach(async () => {
        for (const socket of sockets)
            socket.destroy()
        await waitFor(() => container.connectionManager.countPendingByPubkey(pubkey) === 0
            && container.connectionManager.all().length === 0)
    })

    afterAll(async () => {
        await new Promise(resolve => server.server.close(resolve))
    })

    /**
     * @param {object} [headers] - upgrade headers
     * @returns {{socket: net.Socket, frames: object[], closed: Promise<number>}}
     */
    function open(headers) {
        const client = silentClient(port, headers)
        sockets.push(client.socket)
        return client
    }

    test('the grace is one second', () => {
        expect(refusedSocketGrace).toBe(1000)
    })

    test('a claim for an unregistered key gets its close frame, then its socket is destroyed after the grace', async () => {
        const started = Date.now()
        const client = open({pubkey: Keypair.random().publicKey()})

        const closedAt = await client.closed

        expect(closeFrame(client.frames)).toEqual({code: 1008, reason: 'pubkey is not registered'})
        expect(closedAt - started).toBeGreaterThanOrEqual(refusedSocketGrace - 50)
        expect(closedAt - started).toBeLessThan(refusedSocketGrace + 1500)
    }, 10000)

    test('a superseded handshake is destroyed after the grace', async () => {
        const first = open({pubkey, app: 'node'})
        await waitFor(() => first.frames.some(frame => frame.opcode === 0x1)) //its challenge; the channel also pings
        open({pubkey, app: 'node'})
        await waitFor(() => container.connectionManager.countPendingByPubkey(pubkey) === 2)
        const started = Date.now()
        open({pubkey, app: 'node'}) //the third evicts the oldest

        const closedAt = await first.closed

        expect(closeFrame(first.frames)).toEqual({code: 1008, reason: 'Handshake superseded'})
        expect(closedAt - started).toBeGreaterThanOrEqual(refusedSocketGrace - 50)
        expect(closedAt - started).toBeLessThan(refusedSocketGrace + 1500)
    }, 10000)

    test('an anonymous client over its address cap is destroyed after the grace', async () => {
        const admitted = Array.from({length: 5}, () => open())
        await waitFor(() => container.connectionManager.all().length === 5)
        const started = Date.now()
        const refused = open()

        const closedAt = await refused.closed

        expect(closeFrame(refused.frames)).toEqual({code: 1008, reason: 'Too many connections from address'})
        expect(closedAt - started).toBeLessThan(refusedSocketGrace + 1500)
        expect(admitted.every(client => !client.socket.destroyed)).toBe(true)
    }, 10000)

    test('a validated node connection closed by the server keeps the normal close handshake', async () => {
        const node = await connectNode(port)
        node._socket.pause() //it stops reading, so it never answers the close frame
        const channel = container.connectionManager.getNodeConnection(pubkey)
        const serverSide = channel.__ws //the orchestrator's end; a paused client would not notice its own socket close

        container.connectionManager.remove(channel.id)
        expect(serverSide.readyState).toBe(WebSocket.CLOSING)
        await new Promise(resolve => setTimeout(resolve, refusedSocketGrace + 1000))

        expect(serverSide.readyState).toBe(WebSocket.CLOSING) //still waiting on the close handshake, as before
        const closed = new Promise(resolve => serverSide.once('close', resolve))
        node.terminate()
        await closed
    }, 10000)
})

describe('which upgrades get the node frame cap', () => {
    beforeAll(() => {
        container.configManager = {hasNode: key => key === pubkey}
    })

    test('the caps: 1 MiB for anonymous clients, 4 MiB for node connections, both without compression', () => {
        expect(wsServerOptions).toEqual({noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false})
        expect(nodeWsServerOptions).toEqual({noServer: true, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false})
    })

    test.each([
        ['a registered node pubkey', {pubkey, app: 'node'}, true],
        ['no pubkey header', {}, false],
        ['an unregistered pubkey', {pubkey: Keypair.random().publicKey()}, false],
        ['a pubkey that is not a valid key', {pubkey: 'GNOTAKEY'}, false]
    ])('%s -> node server: %s', (_, headers, expected) => {
        expect(isNodeUpgrade({headers})).toBe(expected)
    })
})
