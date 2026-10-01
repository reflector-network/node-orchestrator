/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const {makeFakeSocket} = require('./helpers/fake-socket')

jest.mock('../logger', () => ({debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn()}))

const nodeKeypair = Keypair.random()
const NODE_PUBKEY = nodeKeypair.publicKey()
//a seven-node cluster, more nodes than a per-address cap would admit behind a TLS proxy
const clusterKeypairs = [nodeKeypair, ...Array.from({length: 6}, () => Keypair.random())]
const clusterPubkeys = new Set(clusterKeypairs.map(kp => kp.publicKey()))

/**
 * Builds a fake upgrade request for handleConnection.
 * @param {object} headers - request headers, e.g. {pubkey, app, 'x-forwarded-for'}
 * @param {string} [remoteAddress] - remote address of the socket
 * @returns {object} fake http.IncomingMessage-like object
 */
function makeRequest(headers, remoteAddress = '10.0.0.1') {
    return {headers, socket: {remoteAddress}}
}

/**
 * Loads fresh module instances so the ConnectionManager maps start empty.
 * @param {string[]} [trustedProxies] - app config trustedProxies; omitted means no app config at all
 * @returns {object} fresh {container, logger, MessageTypes, IncomingChannel, handleConnection, handshakeTimeout}
 */
function load(trustedProxies) {
    jest.resetModules()
    const container = require('../domain/container')
    const logger = require('../logger')
    const ConnectionManager = require('../domain/connections-manager')
    const HandlersManager = require('../server/ws/handlers/handlers-manager')
    if (trustedProxies)
        container.appConfig = {trustedProxies}
    container.configManager = {
        hasNode: (pubkey) => clusterPubkeys.has(pubkey),
        notifyNodeAboutUpdate: jest.fn(),
        getConfigMessage: jest.fn(() => ({type: 3, data: {}}))
    }
    container.connectionManager = new ConnectionManager()
    container.handlersManager = new HandlersManager()
    const {LogTokenProvider} = require('../domain/log-token-provider')
    container.logTokenProvider = new LogTokenProvider()
    const MessageTypes = require('../server/ws/handlers/message-types')
    const IncomingChannel = require('../server/ws/incoming-channel')
    const {handleConnection, handshakeTimeout} = require('../server/ws/connection-handler')
    return {container, logger, MessageTypes, IncomingChannel, handleConnection, handshakeTimeout}
}

function handshakeFrame(ws, MessageTypes) {
    const frame = JSON.parse(ws.send.mock.calls[0][0])
    expect(frame.type).toBe(MessageTypes.HANDSHAKE_REQUEST)
    return frame
}

/**
 * Runs a node through the full handshake with a valid signature
 * @param {Function} handleConnection - handler under test
 * @param {object} MessageTypes - message type constants
 * @param {Keypair} kp - node keypair
 * @param {string} remoteAddress - socket peer address
 * @returns {Promise<object>} the fake socket
 */
async function connectNode(handleConnection, MessageTypes, kp, remoteAddress) {
    const ws = makeFakeSocket()
    const pending = handleConnection(ws, makeRequest({pubkey: kp.publicKey(), app: 'node'}, remoteAddress))
    if (!ws.send.mock.calls.length) { //refused before the challenge
        await pending
        return ws
    }
    const frame = handshakeFrame(ws, MessageTypes)
    const signature = Buffer.from(kp.sign(Buffer.from(frame.data.payload))).toString('hex')
    ws.__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature}}))
    await pending
    return ws
}

/**
 * Opens an anonymous connection
 * @param {Function} handleConnection - handler under test
 * @param {string} remoteAddress - socket peer address
 * @param {string} [forwardedFor] - x-forwarded-for header
 * @returns {Promise<object>} the fake socket
 */
async function connectAnon(handleConnection, remoteAddress, forwardedFor) {
    const ws = makeFakeSocket()
    await handleConnection(ws, makeRequest(forwardedFor === undefined ? {} : {'x-forwarded-for': forwardedFor}, remoteAddress))
    return ws
}

describe('handleConnection', () => {
    beforeEach(() => {
        jest.useFakeTimers()
    })

    afterEach(() => {
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('registers a node whose handshake response verifies', async () => {
        const {container, MessageTypes, handleConnection} = load()
        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        const frame = handshakeFrame(ws, MessageTypes)
        const signature = Buffer.from(nodeKeypair.sign(Buffer.from(frame.data.payload))).toString('hex')
        ws.__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature}}))
        await pending

        const registered = container.connectionManager.getNodeConnection(NODE_PUBKEY)
        expect(registered).toBeDefined()
        expect(registered.isValidated).toBe(true)
        expect(registered.remoteAddress).toBe('10.0.0.1')
        expect(ws.close).not.toHaveBeenCalled()
        expect(container.configManager.notifyNodeAboutUpdate).toHaveBeenCalledWith(NODE_PUBKEY)

        expect(ws.send).toHaveBeenCalledTimes(2)
        const tokenFrame = JSON.parse(ws.send.mock.calls[1][0])
        expect(tokenFrame.type).toBe(MessageTypes.LOG_TOKEN)
        expect(tokenFrame.data.token).toMatch(/^[0-9a-f]{64}$/)
        expect(container.logTokenProvider.verify(tokenFrame.data.token)).toBe(NODE_PUBKEY)
    })

    test('a client that fails the handshake gets no log token', async () => {
        const {container, MessageTypes, handleConnection} = load()
        const issue = jest.spyOn(container.logTokenProvider, 'issue')
        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        const frame = handshakeFrame(ws, MessageTypes)
        ws.__emit('message', JSON.stringify({type: MessageTypes.OK, responseId: frame.requestId}))
        await pending

        expect(issue).not.toHaveBeenCalled()
        expect(ws.send).toHaveBeenCalledTimes(1)
    })

    test('an OK frame answering the challenge does not register the client', async () => {
        const {container, logger, MessageTypes, handleConnection} = load()
        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        const frame = handshakeFrame(ws, MessageTypes)
        ws.__emit('message', JSON.stringify({type: MessageTypes.OK, responseId: frame.requestId}))
        await pending

        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBeUndefined()
        expect(container.connectionManager.all()).toEqual([])
        expect(ws.close).toHaveBeenCalledWith(1008, 'Handshake failed')
        expect(container.configManager.notifyNodeAboutUpdate).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('a HANDSHAKE_RESPONSE with a garbage signature does not register the client', async () => {
        const {container, logger, MessageTypes, handleConnection} = load()
        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        const frame = handshakeFrame(ws, MessageTypes)
        ws.__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature: '00'}}))
        await pending

        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBeUndefined()
        expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid signature')
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('a validated node connection survives an impostor that fails the handshake', async () => {
        const {container, MessageTypes, IncomingChannel, handleConnection} = load()
        const honestWs = makeFakeSocket()
        const honest = new IncomingChannel(honestWs, NODE_PUBKEY, true)
        honest.remoteAddress = '10.0.0.2'
        honest.validated()
        container.connectionManager.add(honest)

        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        const frame = handshakeFrame(ws, MessageTypes)
        ws.__emit('message', JSON.stringify({type: MessageTypes.OK, responseId: frame.requestId}))
        await pending

        expect(honestWs.close).not.toHaveBeenCalled()
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBe(honest)
        expect(container.connectionManager.getNodeConnections()).toEqual([honest])
    })

    test('a refused socket is terminated when the grace after its close frame has passed', async () => {
        const {handleConnection} = load()
        const {refusedSocketGrace} = require('../server/ws/connection-handler')
        const ws = makeFakeSocket()
        ws.close.mockImplementation(() => {}) //the peer never answers the close frame, so the socket stays open
        await handleConnection(ws, makeRequest({pubkey: Keypair.random().publicKey()}))
        expect(ws.close).toHaveBeenCalledWith(1008, 'pubkey is not registered')

        await jest.advanceTimersByTimeAsync(refusedSocketGrace - 1)
        expect(ws.terminate).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(1)
        expect(ws.terminate).toHaveBeenCalledTimes(1)
    })

    test('a refused socket that closes within the grace is not terminated', async () => {
        const {handleConnection} = load()
        const {refusedSocketGrace} = require('../server/ws/connection-handler')
        const ws = makeFakeSocket()
        await handleConnection(ws, makeRequest({pubkey: Keypair.random().publicKey()}))
        ws.__emit('close', 1008, Buffer.from('pubkey is not registered'))

        await jest.advanceTimersByTimeAsync(refusedSocketGrace)
        expect(ws.terminate).not.toHaveBeenCalled()
    })

    test('a client that never answers is closed at the handshake deadline', async () => {
        const {container, MessageTypes, handleConnection, handshakeTimeout} = load()
        const ws = makeFakeSocket()
        const pending = handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}))
        handshakeFrame(ws, MessageTypes)

        await jest.advanceTimersByTimeAsync(handshakeTimeout - 1)
        expect(ws.close).not.toHaveBeenCalled()
        await jest.advanceTimersByTimeAsync(1)
        await pending

        expect(ws.close).toHaveBeenCalledWith(1008, expect.stringContaining('Request timed out after 10000'))
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBeUndefined()
        expect(container.connectionManager.countByAddress('10.0.0.1')).toBe(0)
    })

    test('an unknown pubkey is refused before any handshake', async () => {
        const {container, handleConnection} = load()
        const ws = makeFakeSocket()
        await handleConnection(ws, makeRequest({pubkey: Keypair.random().publicKey(), app: 'node'}))

        expect(ws.send).not.toHaveBeenCalled()
        expect(ws.close).toHaveBeenCalledWith(1008, 'pubkey is not registered')
        expect(container.connectionManager.all()).toEqual([])
    })

    test('seven nodes arriving from one address all connect', async () => {
        //behind a TLS-terminating proxy every node shares the proxy's address
        const {container, MessageTypes, handleConnection} = load()
        const sockets = []
        for (const kp of clusterKeypairs)
            sockets.push(await connectNode(handleConnection, MessageTypes, kp, '10.0.0.100'))

        for (const ws of sockets)
            expect(ws.close).not.toHaveBeenCalled()
        const registered = container.connectionManager.getNodeConnections()
        expect(registered.map(c => c.pubkey).sort()).toEqual([...clusterPubkeys].sort())
        expect(registered.every(c => c.isValidated && c.remoteAddress === '10.0.0.100')).toBe(true)
    })

    test('an impostor holding two pending handshakes does not stop the real node', async () => {
        const {container, MessageTypes, handleConnection, handshakeTimeout} = load()
        const impostors = [makeFakeSocket(), makeFakeSocket()]
        const stalled = impostors.map(ws => handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}, '198.51.100.9')))
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(2)

        const real = await connectNode(handleConnection, MessageTypes, nodeKeypair, '10.0.0.7')

        expect(impostors[0].close).toHaveBeenCalledWith(1008, 'Handshake superseded') //the oldest one
        expect(impostors[1].close).not.toHaveBeenCalled()
        expect(real.close).not.toHaveBeenCalled()
        const registered = container.connectionManager.getNodeConnection(NODE_PUBKEY)
        expect(registered.isValidated).toBe(true)
        expect(registered.remoteAddress).toBe('10.0.0.7')
        expect(container.connectionManager.countValidatedByPubkey(NODE_PUBKEY)).toBe(1)
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(1)

        await jest.advanceTimersByTimeAsync(handshakeTimeout)
        await Promise.all(stalled)
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBe(registered)
        expect(real.close).not.toHaveBeenCalled()
    })

    test('a third connection while two are validated is refused before its handshake', async () => {
        const {container, MessageTypes, handleConnection} = load()
        const first = await connectNode(handleConnection, MessageTypes, nodeKeypair, '10.0.0.7')
        const second = await connectNode(handleConnection, MessageTypes, nodeKeypair, '10.0.0.8') //a reconnect
        //the first socket was told to close, but until its close event arrives it still holds a validated slot
        expect(first.close).toHaveBeenCalledWith(1001, 'Connection replaced')
        expect(second.close).not.toHaveBeenCalled()
        expect(container.connectionManager.countValidatedByPubkey(NODE_PUBKEY)).toBe(2)

        const third = makeFakeSocket()
        await handleConnection(third, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}, '10.0.0.9'))

        expect(third.send).not.toHaveBeenCalled()
        expect(third.close).toHaveBeenCalledWith(1008, 'Too many connections for pubkey')
        expect(container.connectionManager.countValidatedByPubkey(NODE_PUBKEY)).toBe(2)
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(0)
    })

    test('an evicted handshake is closed and removed, leaving nothing behind', async () => {
        const {container, MessageTypes, handleConnection, handshakeTimeout} = load()
        const sockets = [makeFakeSocket(), makeFakeSocket(), makeFakeSocket()]
        const pending = sockets.map(ws => handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}, '198.51.100.9')))

        expect(sockets[0].close).toHaveBeenCalledWith(1008, 'Handshake superseded')
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(2)
        expect(container.connectionManager.all()).toEqual([])

        //the evicted client answers its challenge anyway: it must not register
        const frame = handshakeFrame(sockets[0], MessageTypes)
        const signature = Buffer.from(nodeKeypair.sign(Buffer.from(frame.data.payload))).toString('hex')
        sockets[0].__emit('message', JSON.stringify({type: MessageTypes.HANDSHAKE_RESPONSE, responseId: frame.requestId, data: {signature}}))
        await pending[0]
        expect(sockets[0].close).toHaveBeenLastCalledWith(1008, 'Handshake superseded')
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY)).toBeUndefined()
        expect(container.connectionManager.all()).toEqual([])

        await jest.advanceTimersByTimeAsync(handshakeTimeout)
        await Promise.all(pending)
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(0)
        expect(container.connectionManager.countValidatedByPubkey(NODE_PUBKEY)).toBe(0)
        expect(container.connectionManager.all()).toEqual([])
        expect(container.connectionManager.getNodeConnections()).toEqual([])
    })

    test('a pending slot held by a handshake is freed at the deadline', async () => {
        const {container, MessageTypes, handleConnection, handshakeTimeout} = load()
        const stalled = [makeFakeSocket(), makeFakeSocket()]
        const pending = stalled.map(ws => handleConnection(ws, makeRequest({pubkey: NODE_PUBKEY, app: 'node'}, '10.0.0.7')))
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(2)

        await jest.advanceTimersByTimeAsync(handshakeTimeout)
        await Promise.all(pending)
        expect(container.connectionManager.countPendingByPubkey(NODE_PUBKEY)).toBe(0)

        const ws = await connectNode(handleConnection, MessageTypes, nodeKeypair, '10.0.0.7')
        expect(ws.close).not.toHaveBeenCalled()
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY).isValidated).toBe(true)
    })

    test('the sixth anonymous connection from one address is refused', async () => {
        const {container, handleConnection} = load()
        for (let i = 0; i < 5; i++)
            expect((await connectAnon(handleConnection, '10.0.0.9')).close).not.toHaveBeenCalled()
        const sixth = await connectAnon(handleConnection, '10.0.0.9')

        expect(sixth.close).toHaveBeenCalledWith(1008, 'Too many connections from address')
        expect(container.connectionManager.countByAddress('10.0.0.9')).toBe(5)
        expect((await connectAnon(handleConnection, '10.0.0.10')).close).not.toHaveBeenCalled()
    })

    test('behind a trusted proxy anonymous clients are counted by their forwarded address', async () => {
        const {container, handleConnection} = load(['10.0.0.100'])
        for (let i = 0; i < 5; i++) {
            expect((await connectAnon(handleConnection, '10.0.0.100', '198.51.100.1, 203.0.113.1')).close).not.toHaveBeenCalled()
            expect((await connectAnon(handleConnection, '10.0.0.100', '203.0.113.2')).close).not.toHaveBeenCalled()
        }
        const sixth = await connectAnon(handleConnection, '10.0.0.100', '203.0.113.1')

        expect(sixth.close).toHaveBeenCalledWith(1008, 'Too many connections from address')
        expect(container.connectionManager.countByAddress('203.0.113.1')).toBe(5)
        expect(container.connectionManager.countByAddress('203.0.113.2')).toBe(5)
        expect(container.connectionManager.countByAddress('10.0.0.100')).toBe(0)
        const ips = container.connectionManager.all().map(c => c.ip)
        expect(ips.filter(ip => ip === '203.0.113.1')).toHaveLength(5)
        expect(ips.filter(ip => ip === '203.0.113.2')).toHaveLength(5)
    })

    test('a forged x-forwarded-for from an untrusted peer is ignored', async () => {
        const {container, handleConnection} = load(['10.0.0.100'])
        for (let i = 0; i < 5; i++)
            expect((await connectAnon(handleConnection, '10.0.0.9', `203.0.113.${i}`)).close).not.toHaveBeenCalled()
        const sixth = await connectAnon(handleConnection, '10.0.0.9', '203.0.113.99, 10.0.0.100')

        expect(sixth.close).toHaveBeenCalledWith(1008, 'Too many connections from address')
        const anon = container.connectionManager.all()
        expect(anon).toHaveLength(5)
        expect(anon.every(c => c.ip === '10.0.0.9' && c.remoteAddress === '10.0.0.9')).toBe(true)
    })

    test('a trusted proxy that forwards no usable address counts against the proxy itself', async () => {
        //a missing, empty or malformed right-most entry stops the walk at the proxy: a client behind it cannot pick
        //its bucket through a hop the proxy did not write as an address
        const {container, handleConnection} = load(['10.0.0.100'])
        for (const header of [undefined, '', 'garbage', '203.0.113.5, garbage', '203.0.113.6, '])
            expect((await connectAnon(handleConnection, '10.0.0.100', header)).close).not.toHaveBeenCalled()
        const sixth = await connectAnon(handleConnection, '10.0.0.100', 'not-an-ip')

        expect(sixth.close).toHaveBeenCalledWith(1008, 'Too many connections from address')
        const anon = container.connectionManager.all()
        expect(anon.map(c => c.ip)).toEqual(Array(5).fill('10.0.0.100'))
        expect(anon.map(c => c.remoteAddress)).toEqual(Array(5).fill('10.0.0.100'))
        expect(container.connectionManager.countByAddress('10.0.0.100')).toBe(5)
        expect(container.connectionManager.countByAddress('203.0.113.5')).toBe(0)
    })

    test('an IPv6 peer with a zone id is recorded under one lowercase spelling', async () => {
        const {container, handleConnection} = load(['fe80::100%eth0'])
        await connectAnon(handleConnection, 'FE80::9%ETH0')
        await connectAnon(handleConnection, 'fe80::9%eth0')
        //a trusted proxy written with a zone id is matched too
        await connectAnon(handleConnection, 'FE80::100%eth0', '203.0.113.8')

        expect(container.connectionManager.all().map(c => c.ip)).toEqual(['fe80::9%eth0', 'fe80::9%eth0', '203.0.113.8'])
        expect(container.connectionManager.countByAddress('fe80::9%eth0')).toBe(2)
    })

    test('with no trusted proxies the header never reaches the channel ip', async () => {
        const {container, handleConnection} = load()
        await connectAnon(handleConnection, '10.0.0.9', '203.0.113.5')
        expect(container.connectionManager.all()[0].ip).toBe('10.0.0.9')
    })

    test('an IPv4-mapped IPv6 peer is normalised and shares the IPv4 bucket', async () => {
        const {container, MessageTypes, handleConnection} = load(['10.0.0.100'])
        for (let i = 0; i < 3; i++)
            await connectAnon(handleConnection, '::ffff:10.0.0.9')
        for (let i = 0; i < 2; i++)
            await connectAnon(handleConnection, '10.0.0.9')
        const sixth = await connectAnon(handleConnection, '::ffff:10.0.0.9')

        expect(sixth.close).toHaveBeenCalledWith(1008, 'Too many connections from address')
        expect(container.connectionManager.all().map(c => c.ip)).toEqual(Array(5).fill('10.0.0.9'))
        //a mapped proxy address is still recognised as the trusted proxy
        await connectAnon(handleConnection, '::ffff:10.0.0.100', '203.0.113.7')
        expect(container.connectionManager.countByAddress('203.0.113.7')).toBe(1)
        //and a node's recorded address is normalised the same way
        await connectNode(handleConnection, MessageTypes, nodeKeypair, '::ffff:10.0.0.50')
        expect(container.connectionManager.getNodeConnection(NODE_PUBKEY).remoteAddress).toBe('10.0.0.50')
    })

    test('an anonymous client is registered without a handshake', async () => {
        const {container, handleConnection} = load()
        const ws = makeFakeSocket()
        await handleConnection(ws, makeRequest({}, '10.0.0.9'))

        expect(ws.send).not.toHaveBeenCalled()
        expect(container.connectionManager.all()).toHaveLength(1)
        expect(container.connectionManager.all()[0].isAnonymous).toBe(true)
        expect(container.connectionManager.all()[0].remoteAddress).toBe('10.0.0.9')
    })
})
