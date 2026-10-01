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

const sent = []
const nodeChannel = {
    send: (message) => {
        sent.push(message)
        return Promise.resolve({})
    }
}

const updated = []
jest.mock('../domain/container', () => ({
    configManager: {hasNode: () => true},
    connectionManager: {getNodeConnection: () => nodeChannel},
    appConfig: {whitelist: ['*'], monitoringKey: 'GMONITOR'},
    nodeSettingsManager: {
        get: () => ({}),
        update: (pubkey, settings) => {
            updated.push({pubkey, settings})
            return Promise.resolve()
        }
    }
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const logRoutes = require('../server/routes/log-routes')
const settingsRoutes = require('../server/routes/node-settings-routes')

const keypair = Keypair.random()
let nonce = Date.now()

/**
 * Signs a request the way admin-dashboard's api/interface.js does
 * @param {object} payload - the payload the middleware will reconstruct
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
        settingsRoutes(app)
        //eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => res.status(err.code || 500).json({error: err.message}))
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function post(server, path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
        //a POST signature covers the route binding as well as the body, so that it cannot be retargeted
        const routeBinding = path.substring(1) + '?' + new URLSearchParams(sortObjectKeys({nonce})).toString()
        const headers = {
            authorization: authHeader(sortObjectKeys({...body, nonce, path: routeBinding})),
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
        }
        const req = http.request({host: '127.0.0.1', port: server.address().port, method: 'POST', path, headers}, res => {
            let data = ''
            res.on('data', chunk => {
                data += chunk
            })
            res.on('end', () => resolve({status: res.statusCode, body: data}))
        })
        req.on('error', reject)
        req.write(payload)
        req.end()
    })
}

describe('forwarding routes check their body shape', () => {
    let app

    beforeAll(async () => {
        app = await startApp()
    })

    afterAll(async () => {
        await new Promise(resolve => app.close(resolve))
    })

    beforeEach(() => {
        sent.length = 0
        updated.length = 0
        nonce += 1
    })

    test('a validation body is not accepted as a gateway update', async () => {
        //the captured body passes the field-by-field checks: urls are strings and challenge is simply absent,
        //so without the allowed-keys check it would be forwarded and clear the node's challenge
        const res = await post(app, '/gateways', {urls: ['http://gateway.example.com'], validationKey: 'k1'})

        expect(res.status).toBe(400)
        expect(JSON.parse(res.body).error).toContain('unexpected body field')
        expect(sent).toEqual([])
    })

    test('POST /gateways still forwards a well-formed body', async () => {
        const res = await post(app, '/gateways', {urls: ['https://gateway.example.com'], challenge: 'c1'})

        expect(res.status).toBe(200)
        expect(sent).toHaveLength(1)
        expect(sent[0].data.data).toEqual({
            urls: ['https://gateway.example.com'],
            challenge: 'c1',
            nonce,
            path: `gateways?nonce=${nonce}`
        })
    })

    test('POST /logs/trace refuses a body carrying anything besides the trace flag', async () => {
        const res = await post(app, '/logs/trace', {isTraceEnabled: true, urls: ['http://gateway.example.com']})

        expect(res.status).toBe(400)
        expect(JSON.parse(res.body).error).toContain('unexpected body field')
        expect(sent).toEqual([])
    })

    test('POST /logs/trace still forwards the trace flag on its own', async () => {
        const res = await post(app, '/logs/trace', {isTraceEnabled: true})

        expect(res.status).toBe(200)
        expect(sent).toHaveLength(1)
        expect(sent[0].data.isTraceEnabled).toBe(true)
    })

    test('POST /validate-gateways refuses a body without the validation key', async () => {
        //the key is what makes a validation body distinguishable from a gateway update: it cannot be optional
        const res = await post(app, '/validate-gateways', {urls: ['http://gateway.example.com']})

        expect(res.status).toBe(400)
        expect(JSON.parse(res.body).error).toContain('validationKey must be a non-empty string')
        expect(sent).toEqual([])
    })

    test('POST /settings/node refuses a body carrying anything besides the emails', async () => {
        const res = await post(app, '/settings/node', {emails: ['a@b.com'], arbitrary: {deep: [1, 2, 3]}})

        expect(res.status).toBe(400)
        expect(JSON.parse(res.body).error).toContain('unexpected body field')
        expect(updated).toEqual([])
    })

    test('POST /settings/node refuses a captured gateway body with a bad request rather than a crash', async () => {
        const res = await post(app, '/settings/node', {urls: ['http://gateway.example.com'], challenge: 'c1'})

        expect(res.status).toBe(400)
        expect(updated).toEqual([])
    })

    test('POST /settings/node still accepts the email list the dashboard sends', async () => {
        const res = await post(app, '/settings/node', {emails: ['a@b.com']})

        expect(res.status).toBe(200)
        expect(updated).toEqual([{pubkey: keypair.publicKey(), settings: {emails: ['a@b.com']}}])
    })
})
