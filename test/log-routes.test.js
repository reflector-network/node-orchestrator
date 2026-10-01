/*eslint-disable no-undef */
const http = require('http')
const {createHash} = require('crypto')
const express = require('express')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys, getDataHash, verifySignature} = require('@reflector/reflector-shared')

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

const sent = []
const targets = []
const nodeChannel = {
    send: (message) => {
        sent.push(message)
        return Promise.resolve({logFiles: ['combined.log']})
    }
}

jest.mock('../domain/container', () => ({
    configManager: {hasNode: () => true},
    connectionManager: {
        getNodeConnection: (pubkey) => {
            targets.push(pubkey)
            return nodeChannel
        }
    },
    appConfig: {whitelist: ['*'], monitoringKey: 'GMONITOR'}
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const logRoutes = require('../server/routes/log-routes')

const keypair = Keypair.random()
let nonce = Date.now()

/**
 * Builds the route binding the middleware signs: the matched route path with its params substituted,
 * followed by the sorted query string including the nonce
 * @param {string} routePath - route path relative to the app root, without a leading slash
 * @param {object} [query] - query params to bind, excluding the nonce
 * @returns {string}
 */
function signedPath(routePath, query = {}) {
    return routePath + '?' + new URLSearchParams(sortObjectKeys({...query, nonce})).toString()
}

/**
 * Signs a request the way admin-dashboard's api/interface.js does
 * @param {object|string} payload - the payload the middleware will reconstruct
 * @returns {string} authorization header value
 */
function authHeader(payload) {
    const messageHash = createHash('sha256').update(`${keypair.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    const signature = Buffer.from(keypair.sign(messageHash)).toString('hex')
    return `${keypair.publicKey()}.${signature}.${nonce}`
}

function startApp() {
    return new Promise(resolve => {
        const app = express()
        app.use(express.json())
        logRoutes(app)
        //eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => res.status(err.code || 500).json({error: err.message}))
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function request(server, method, path, headers = {}, body = undefined) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body)
        const allHeaders = payload === null
            ? headers
            : {...headers, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}
        const req = http.request({host: '127.0.0.1', port: server.address().port, method, path, headers: allHeaders}, res => {
            let data = ''
            res.on('data', chunk => {
                data += chunk
            })
            res.on('end', () => resolve({status: res.statusCode, body: data}))
        })
        req.on('error', reject)
        if (payload !== null)
            req.write(payload)
        req.end()
    })
}

/**
 * Verifies the relayed signature the way a node does, over the message as it arrives off the wire
 * @param {object} relayed - the data field of the relayed message
 * @returns {boolean}
 */
function verifyAsNode(relayed) {
    const {data, signature, pubkey} = JSON.parse(JSON.stringify(relayed))
    return verifySignature(pubkey, signature, getDataHash(data, pubkey))
}

describe('control messages carry the operator signature', () => {
    let app

    beforeAll(async () => {
        app = await startApp()
    })

    afterAll(async () => {
        await new Promise(resolve => app.close(resolve))
    })

    beforeEach(() => {
        sent.length = 0
        targets.length = 0
        nonce += 1
    })

    test('SET_TRACE relays a payload the node can verify', async () => {
        const body = {isTraceEnabled: true}
        const payload = sortObjectKeys({...body, nonce, path: signedPath('logs/trace')})
        const res = await request(app, 'POST', '/logs/trace', {authorization: authHeader(payload)}, body)

        expect(res.status).toBe(200)
        expect(sent).toHaveLength(1)
        const {data} = sent[0]
        expect(data.isTraceEnabled).toBe(true) //legacy field for a node on the previous release
        expect(data.pubkey).toBe(keypair.publicKey())
        expect(data.data).toEqual({isTraceEnabled: true, nonce, path: `logs/trace?nonce=${nonce}`})
        expect(verifyAsNode(data)).toBe(true)
    })

    test('LOGS_REQUEST relays a payload the node can verify', async () => {
        const payload = signedPath('logs')
        const res = await request(app, 'GET', '/logs', {authorization: authHeader(payload)})

        expect(res.status).toBe(200)
        const {data} = sent[0]
        expect(data.data).toBe(payload)
        expect(data.pubkey).toBe(keypair.publicKey())
        expect(verifyAsNode(data)).toBe(true)
    })

    test('LOG_FILE_REQUEST relays the signed path next to the file name', async () => {
        const payload = signedPath('logs/combined.log')
        const res = await request(app, 'GET', '/logs/combined.log', {authorization: authHeader(payload)})

        expect(res.status).toBe(200)
        const {data} = sent[0]
        expect(data.logFileName).toBe('combined.log')
        expect(data.data).toBe(payload)
        expect(data.data).toContain('combined.log') //the file name is inside the signed payload, not only beside it
        expect(verifyAsNode(data)).toBe(true)
    })

    test('the signed payload commits to the target node', async () => {
        const body = {isTraceEnabled: true}
        const payload = sortObjectKeys({...body, nonce, path: signedPath('logs/trace', {node: 'GTARGET'})})
        const res = await request(app, 'POST', '/logs/trace?node=GTARGET', {authorization: authHeader(payload)}, body)

        expect(res.status).toBe(200)
        expect(sent[0].data.data.path).toBe(`logs/trace?node=GTARGET&nonce=${nonce}`)
        expect(verifyAsNode(sent[0].data)).toBe(true)
    })

    test('a trace request retargeted to another node is refused', async () => {
        //the operator signed a toggle for GTARGET; the query string is not protected by TLS alone, so the
        //binding inside the signed payload is what stops the request reaching GOTHER
        const body = {isTraceEnabled: true}
        const payload = sortObjectKeys({...body, nonce, path: signedPath('logs/trace', {node: 'GTARGET'})})
        const res = await request(app, 'POST', '/logs/trace?node=GOTHER', {authorization: authHeader(payload)}, body)

        expect(res.status).toBe(401)
        expect(targets).toEqual([])
        expect(sent).toEqual([])
    })

    test('a log download retargeted to another node is refused', async () => {
        const res = await request(app, 'GET', '/logs/combined.log?node=GOTHER', {
            authorization: authHeader(signedPath('logs/combined.log', {node: 'GTARGET'}))
        })

        expect(res.status).toBe(401)
        expect(targets).toEqual([])
        expect(sent).toEqual([])
    })

    test('a non-boolean trace flag is refused before anything is sent', async () => {
        const body = {isTraceEnabled: 'yes'}
        const payload = sortObjectKeys({...body, nonce, path: signedPath('logs/trace')})
        const res = await request(app, 'POST', '/logs/trace', {authorization: authHeader(payload)}, body)

        expect(res.status).toBe(400)
        expect(sent).toEqual([])
    })
})
