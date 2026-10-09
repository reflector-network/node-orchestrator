/*eslint-disable no-undef */
const http = require('http')
const {createHash} = require('crypto')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')

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

const mockConnection = {node: null, error: null}
const mockUnregistered = new Set()
jest.mock('../domain/container', () => ({
    configManager: {hasNode: pubkey => !mockUnregistered.has(pubkey), history: jest.fn(() => Promise.resolve([]))},
    connectionManager: {
        getNodeConnection: () => {
            if (mockConnection.error)
                throw mockConnection.error
            return mockConnection.node
        }
    },
    appConfig: {whitelist: ['*'], monitoringKey: 'GMONITOR'}
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn(), trace: jest.fn()}))

const container = require('../domain/container')
const logger = require('../logger')
const Server = require('../server')
const {resetAuthFailureLog} = require('../server/auth-failure-log')

const keypair = Keypair.random()
let nonce = Date.now()

/**
 * Signs a GET the way admin-dashboard's api/interface.js does: the route binding with the sorted query and nonce
 * @param {string} routePath - route path without a leading slash, params substituted
 * @param {object} [query] - query params, excluding the nonce
 * @param {Keypair} [signer] - signing key; the suite key by default
 * @returns {string} authorization header value
 */
function authHeader(routePath, query = {}, signer = keypair) {
    const payload = routePath + '?' + new URLSearchParams(sortObjectKeys({...query, nonce})).toString()
    const messageHash = createHash('sha256').update(`${signer.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    const signature = Buffer.from(signer.sign(messageHash)).toString('hex')
    return `${signer.publicKey()}.${signature}.${nonce}`
}

/**
 * Signs a POST the way the orchestrator verifies it: the body with the nonce and the route binding
 * @param {string} routePath - route path without a leading slash
 * @param {object} body - request body
 * @returns {string} authorization header value
 */
function postAuthHeader(routePath, body) {
    const payload = sortObjectKeys({...body, nonce, path: routePath + '?nonce=' + nonce})
    const messageHash = createHash('sha256').update(`${keypair.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    const signature = Buffer.from(keypair.sign(messageHash)).toString('hex')
    return `${keypair.publicKey()}.${signature}.${nonce}`
}

/**
 * @param {object} flags - what ChannelBase sets on the error it rejects a relayed request with
 * @param {string} message - error message
 * @returns {{send: function}} a node channel whose relay fails that way
 */
function failingNode(flags, message) {
    return {send: () => Promise.reject(Object.assign(new Error(message), flags))}
}

function requestWithBody(port, method, path, body, headers = {}) {
    return request(port, method, path, {...headers, 'content-type': 'application/json'}, JSON.stringify(body))
}

function request(port, method, path, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, method, path, headers}, res => {
            let data = ''
            res.on('data', chunk => {
                data += chunk
            })
            res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}))
        })
        req.on('error', reject)
        req.end(body)
    })
}

describe('http error paths', () => {
    let server
    let port

    beforeAll(async () => {
        server = new Server()
        server.init(0)
        await new Promise(resolve => server.server.once('listening', resolve))
        port = server.server.address().port
    })

    afterAll(async () => {
        await new Promise(resolve => server.server.close(resolve))
    })

    beforeEach(() => {
        nonce += 1
        mockConnection.node = null
        mockConnection.error = null
        mockUnregistered.clear()
        container.appConfig.monitoringKey = 'GMONITOR'
        resetAuthFailureLog()
        jest.clearAllMocks()
    })

    test.each([
        ['/logs', 'logs'],
        ['/logs/combined.log', 'logs/combined.log'],
        ['/gateways', 'gateways']
    ])('GET %s for a registered node that is not connected answers 503 and logs a warning', async (path, routePath) => {
        const res = await request(port, 'GET', path, {authorization: authHeader(routePath)})

        expect(res.status).toBe(503)
        expect(JSON.parse(res.body)).toEqual({error: 'Service unavailable. Node is not connected', status: 503})
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(`GET ${path} -> 503: Service unavailable. Node is not connected`)
    })

    test('the monitoring key aiming at a key that is not a node answers 404', async () => {
        container.appConfig.monitoringKey = keypair.publicKey()
        mockUnregistered.add('GSTRANGER')
        const res = await request(port, 'GET', '/logs?node=GSTRANGER', {authorization: authHeader('logs', {node: 'GSTRANGER'})})

        expect(res.status).toBe(404)
        expect(JSON.parse(res.body)).toEqual({error: 'Not found. Node not found', status: 404})
        expect(logger.debug).toHaveBeenCalledWith('GET /logs?node=GSTRANGER -> 404: Not found. Node not found')
        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test.each([
        ['the node refuses the request', {isPeerError: true}, 'Signature or nonce is not valid', 502,
            'Bad gateway. Node refused the request: Signature or nonce is not valid'],
        ['the node does not answer in time', {timeout: true}, 'Request timed out after 5000. Message: 24. GABC 2', 504,
            'Gateway timeout. Node did not answer in time'],
        ['the node connection closes before the answer', {connectionClosed: true},
            'Connection closed before the peer answered: Max payload size exceeded. GABC 2', 502,
            'Bad gateway. Node connection closed before it answered'],
        ['the node connection is no longer open', {notConnected: true}, 'Connection is not open. GABC 2', 503,
            'Service unavailable. Node is not connected']
    ])('a relay in which %s answers its own status and logs a warning without a stack', async (_, flags, message, status, answer) => {
        mockConnection.node = failingNode(flags, message)
        const res = await request(port, 'GET', '/logs/combined.log', {authorization: authHeader('logs/combined.log')})

        expect(res.status).toBe(status)
        expect(JSON.parse(res.body)).toEqual({error: answer, status})
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(`GET /logs/combined.log -> ${status}: ${answer}`)
    })

    test('a node refusal is relayed cut to 512 characters', async () => {
        mockConnection.node = failingNode({isPeerError: true}, 'x'.repeat(2000))
        const res = await request(port, 'GET', '/gateways', {authorization: authHeader('gateways')})

        expect(res.status).toBe(502)
        expect(JSON.parse(res.body).error).toBe('Bad gateway. Node refused the request: ' + 'x'.repeat(512))
    })

    test('a request without credentials answers 401 and is logged at warn with its route', async () => {
        const res = await request(port, 'GET', '/logs')

        expect(res.status).toBe(401)
        expect(JSON.parse(res.body)).toEqual({error: 'Unauthorized. Authorization header is required', status: 401})
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith('Refused GET /logs -> 401: Unauthorized. Authorization header is required')
    })

    test('a forged signature is logged at warn with the claimed pubkey, never the signature or nonce', async () => {
        const [, forgedSignature, sentNonce] = authHeader('logs', {}, Keypair.random()).split('.')
        const res = await request(port, 'GET', '/logs', {authorization: `${keypair.publicKey()}.${forgedSignature}.${sentNonce}`})

        expect(res.status).toBe(401)
        expect(logger.warn).toHaveBeenCalledTimes(1)
        const [line] = logger.warn.mock.calls[0]
        expect(line).toBe(`Refused GET /logs -> 401: Unauthorized. Invalid signature (pubkey ${keypair.publicKey()})`)
        expect(line).not.toContain(forgedSignature)
        expect(line).not.toContain(sentNonce)
    })

    test('the line names the route pattern and leaves the path parameters and query out', async () => {
        const res = await request(port, 'GET', '/logs/combined.log?node=GSOMEONE&prettyPrint', {authorization: 'nothing'})

        expect(res.status).toBe(401)
        expect(logger.warn).toHaveBeenCalledWith('Refused GET /logs/:logname -> 401: Unauthorized. Invalid authorization header')
    })

    test('a claimed pubkey that is not a key is left out of the line', async () => {
        const res = await request(port, 'GET', '/logs', {authorization: 'Bearer abc.def.ghi'})

        expect(res.status).toBe(401)
        expect(logger.warn).toHaveBeenCalledWith('Refused GET /logs -> 401: Unauthorized. Invalid nonce')
    })

    test('a POST refused for its signature names its route and method', async () => {
        const res = await requestWithBody(port, 'POST', '/logs/trace', {isTraceEnabled: true},
            {authorization: authHeader('logs/trace')})

        expect(res.status).toBe(401)
        expect(logger.warn).toHaveBeenCalledWith(`Refused POST /logs/trace -> 401: Unauthorized. Invalid signature (pubkey ${keypair.publicKey()})`)
    })

    test('a 403 from the cors whitelist is logged at warn too', async () => {
        container.appConfig.whitelist = ['https://dashboard.example.com']
        try {
            const res = await request(port, 'GET', '/logs', {origin: 'https://evil.example.com'})

            expect(res.status).toBe(403)
            expect(logger.warn).toHaveBeenCalledWith('Refused GET /logs -> 403: Forbidden. Origin https://evil.example.com is blocked by CORS')
        } finally {
            container.appConfig.whitelist = ['*']
        }
    })

    test('other client errors stay at debug', async () => {
        const res = await requestWithBody(port, 'POST', '/logs/trace', {isTraceEnabled: 'yes'},
            {authorization: postAuthHeader('logs/trace', {isTraceEnabled: 'yes'})})

        expect(res.status).toBe(400)
        expect(logger.debug).toHaveBeenCalledWith('POST /logs/trace -> 400: Bad request. isTraceEnabled must be a boolean')
        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('auth failures are throttled to one line per claimed node key per minute, then report what was held back', async () => {
        const now = jest.spyOn(Date, 'now').mockReturnValue(1758700000000)
        try {
            const forged = key => ({authorization: `${key}.${'00'.repeat(64)}.${++nonce}`})
            for (const path of ['/logs', '/gateways', '/logs', '/metrics'])
                expect((await request(port, 'GET', path, forged(keypair.publicKey()))).status).toBe(401)
            expect(logger.warn).toHaveBeenCalledTimes(1)

            //another key, and the route of a request that claims no key, each get their own line
            await request(port, 'GET', '/logs', forged(Keypair.random().publicKey()))
            await request(port, 'GET', '/logs')
            await request(port, 'GET', '/logs')
            expect(logger.warn).toHaveBeenCalledTimes(3)

            now.mockReturnValue(1758700000000 + 60 * 1000)
            await request(port, 'GET', '/logs', forged(keypair.publicKey()))
            expect(logger.warn).toHaveBeenCalledTimes(4)
            expect(logger.warn).toHaveBeenLastCalledWith(`Refused GET /logs -> 401: Unauthorized. Invalid signature (pubkey ${keypair.publicKey()}); 3 more for this key in the last minute`)
        } finally {
            now.mockRestore()
        }
    })

    test('a flood of unregistered keys is throttled by route, so it cannot open a line per request', async () => {
        const keys = Array.from({length: 5}, () => Keypair.random().publicKey())
        keys.forEach(key => mockUnregistered.add(key))
        for (const key of keys)
            await request(port, 'GET', '/logs', {authorization: `${key}.${'00'.repeat(64)}.${++nonce}`})

        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(`Refused GET /logs -> 401: Unauthorized. Pubkey is not registered (pubkey ${keys[0]})`)
    })

    test('an unexpected failure answers a generic 500 and is logged once at error level', async () => {
        mockConnection.error = new Error('connection table corrupted')
        const res = await request(port, 'GET', '/logs', {authorization: authHeader('logs')})

        expect(res.status).toBe(500)
        expect(JSON.parse(res.body)).toEqual({error: 'Internal server error', status: 500})
        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenCalledWith('connection table corrupted')
    })

    test('a log file is answered as the json envelope it is', async () => {
        mockConnection.node = {send: () => Promise.resolve({logFile: 'line 1\nline 2'})}
        const res = await request(port, 'GET', '/logs/combined.log', {authorization: authHeader('logs/combined.log')})

        expect(res.status).toBe(200)
        expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
        expect(res.headers['content-disposition']).toBeUndefined()
        expect(JSON.parse(res.body)).toEqual({logFile: 'line 1\nline 2'})
    })

    test('a preflight request is answered by the cors middleware', async () => {
        //the final handler of registerRoute's app.options is never reached, but the registration is not dead: without
        //it no route matches OPTIONS, cors never runs, and express answers "GET,HEAD" with no cors headers
        const res = await request(port, 'OPTIONS', '/logs', {
            origin: 'https://dashboard.example.com',
            'access-control-request-method': 'GET'
        })

        expect(res.status).toBe(200)
        expect(res.body).toBe('')
        expect(res.headers['access-control-allow-origin']).toBe('https://dashboard.example.com')
    })
})

describe('config history route', () => {
    let server
    let port

    beforeAll(async () => {
        server = new Server()
        server.init(0)
        await new Promise(resolve => server.server.once('listening', resolve))
        port = server.server.address().port
    })

    afterAll(async () => {
        await new Promise(resolve => server.server.close(resolve))
    })

    test('hands the manager the query alone - there is no public view to select', async () => {
        nonce += 1
        const query = {page: '2', pageSize: '5'}
        const res = await request(port, 'GET', '/config/history?page=2&pageSize=5', {authorization: authHeader('config/history', query)})

        expect(res.status).toBe(200)
        expect(container.configManager.history).toHaveBeenCalledTimes(1)
        expect(container.configManager.history.mock.calls[0]).toEqual([query])
    })
})
