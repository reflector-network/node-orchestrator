/*eslint-disable no-undef */
const http = require('http')
const {createHash} = require('crypto')
const express = require('express')
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
jest.mock('../domain/container', () => ({
    configManager: {hasNode: () => true},
    appConfig: {lokiPushAuth: 'required'},
    logTokenProvider: new (require('../domain/log-token-provider').LogTokenProvider)()
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const {registerLokiProxy, isAllowedLokiRequest} = require('../server/loki-proxy')
const container = require('../domain/container')

const keypair = Keypair.random()
let nonce = Date.now()

/**
 * Signs a GET the way admin-dashboard's getApi() does: path + '?' + sorted query including the nonce.
 * @param {string} relativePath - signed path, relative to the app root (no leading slash)
 * @param {object} query - query params to sign, excluding the nonce
 * @returns {string} authorization header value: `pubkey.signature.nonce`
 */
function authHeader(relativePath, query) {
    nonce += 1
    const payload = relativePath + '?' + new URLSearchParams(sortObjectKeys({...query, nonce})).toString()
    const messageHash = createHash('sha256').update(`${keypair.publicKey()}:${JSON.stringify(payload)}`, 'utf8').digest()
    const signature = Buffer.from(keypair.sign(messageHash)).toString('hex')
    return `${keypair.publicKey()}.${signature}.${nonce}`
}

function startStubLoki(received) {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            received.push({method: req.method, url: req.url})
            res.setHeader('content-type', 'application/json')
            res.end('{"status":"success"}')
        })
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function startApp(lokiUrl) {
    return new Promise(resolve => {
        const app = express()
        registerLokiProxy(app, lokiUrl)
        //eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => res.status(err.code || 500).json({error: err.message}))
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function request(server, method, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port: server.address().port, method, path, headers}, res => {
            let body = ''
            res.on('data', chunk => {
                body += chunk
            })
            res.on('end', () => resolve({status: res.statusCode, body}))
        })
        req.on('error', reject)
        req.end()
    })
}

describe('isAllowedLokiRequest', () => {
    test('allows read-only GET query endpoints', () => {
        expect(isAllowedLokiRequest('/loki/api/v1/query', {method: 'GET'})).toBe(true)
        expect(isAllowedLokiRequest('/loki/api/v1/query_range', {method: 'GET'})).toBe(true)
        expect(isAllowedLokiRequest('/loki/api/v1/labels', {method: 'GET'})).toBe(true)
        expect(isAllowedLokiRequest('/loki/api/v1/label/app/values', {method: 'GET'})).toBe(true)
        expect(isAllowedLokiRequest('/loki/api/v1/series', {method: 'GET'})).toBe(true)
    })

    test('refuses writes, deletes and other methods', () => {
        expect(isAllowedLokiRequest('/loki/api/v1/push', {method: 'POST'})).toBe(false)
        expect(isAllowedLokiRequest('/loki/api/v1/push', {method: 'GET'})).toBe(false)
        expect(isAllowedLokiRequest('/loki/api/v1/delete', {method: 'GET'})).toBe(false)
        expect(isAllowedLokiRequest('/loki/api/v1/query_range', {method: 'POST'})).toBe(false)
    })
})

describe('/loki-proxy', () => {
    const received = []
    let loki
    let app

    beforeAll(async () => {
        loki = await startStubLoki(received)
        app = await startApp(`http://127.0.0.1:${loki.address().port}`)
    })

    afterAll(async () => {
        await new Promise(resolve => app.close(resolve))
        await new Promise(resolve => loki.close(resolve))
    })

    beforeEach(() => {
        received.length = 0
        container.appConfig.lokiPushAuth = 'required'
    })

    test('refuses an unauthenticated query', async () => {
        const res = await request(app, 'GET', '/loki-proxy/loki/api/v1/query_range?query=%7Bapp%3D%22x%22%7D')
        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    test('proxies an unauthenticated push while lokiPushAuth is optional', async () => {
        container.appConfig.lokiPushAuth = 'optional'
        const res = await request(app, 'POST', '/loki-proxy/loki/api/v1/push')
        expect(res.status).toBe(200)
        expect(received).toEqual([{method: 'POST', url: '/loki/api/v1/push'}])
    })

    test('refuses an unauthenticated push when lokiPushAuth is required', async () => {
        container.appConfig.lokiPushAuth = 'required'
        const res = await request(app, 'POST', '/loki-proxy/loki/api/v1/push')
        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    test('proxies a push carrying a valid log token when lokiPushAuth is required', async () => {
        container.appConfig.lokiPushAuth = 'required'
        const token = container.logTokenProvider.issue(keypair.publicKey())
        const res = await request(app, 'POST', '/loki-proxy/loki/api/v1/push', {authorization: `Bearer ${token}`})
        expect(res.status).toBe(200)
        expect(received).toEqual([{method: 'POST', url: '/loki/api/v1/push'}])
    })

    test('refuses a push carrying an unknown token when lokiPushAuth is required', async () => {
        container.appConfig.lokiPushAuth = 'required'
        const res = await request(app, 'POST', '/loki-proxy/loki/api/v1/push', {authorization: `Bearer ${'0'.repeat(64)}`})
        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    test('a token never grants read access', async () => {
        const token = container.logTokenProvider.issue(keypair.publicKey())
        const res = await request(app, 'GET', '/loki-proxy/loki/api/v1/labels', {authorization: `Bearer ${token}`})
        expect(res.status).toBe(401)
        expect(received).toEqual([])
    })

    test('proxies a signed read-only query', async () => {
        const query = {query: '{app="x"}'}
        const res = await request(app, 'GET', '/loki-proxy/loki/api/v1/query_range?' + new URLSearchParams(query).toString(), {
            authorization: authHeader('loki-proxy/loki/api/v1/query_range', query)
        })
        expect(res.status).toBe(200)
        expect(received).toHaveLength(1)
        expect(received[0].method).toBe('GET')
        expect(received[0].url.startsWith('/loki/api/v1/query_range?')).toBe(true)
    })

    test('refuses a signed request to a non-query endpoint', async () => {
        const res = await request(app, 'GET', '/loki-proxy/loki/api/v1/delete', {
            authorization: authHeader('loki-proxy/loki/api/v1/delete', {})
        })
        expect(res.status).toBe(404)
        expect(received).toEqual([])
    })
})
