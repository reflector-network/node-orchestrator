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

jest.mock('../domain/container', () => ({
    configManager: {hasNode: () => true},
    connectionManager: {getNodeConnection: () => nodeChannel},
    appConfig: {whitelist: ['*'], monitoringKey: 'GMONITOR'},
    nodeSettingsManager: {get: () => ({}), update: () => Promise.resolve()}
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))
//the probe is stubbed so an accepted list never leaves the machine; the rules under test run before it is reached
jest.mock('../utils/safe-request', () => ({
    ...jest.requireActual('../utils/safe-request'),
    safeGetJson: jest.fn(url => Promise.resolve(url.includes('/gateway?url=') ? {serverTime: 1700000000} : {version: '1.2.3'}))
}))

const {safeGetJson} = require('../utils/safe-request')
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
        settingsRoutes(app)
        //eslint-disable-next-line no-unused-vars
        app.use((err, req, res, next) => res.status(err.code || 500).json({error: err.message}))
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function post(server, path, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body)
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

//each route with the body it needs besides the urls
const routes = [
    ['/gateways', urls => ({urls, challenge: 'c1'})],
    ['/validate-gateways', urls => ({urls, validationKey: 'k1'})]
]

const queryRule = 'must not contain a query string or a fragment'
const privateRule = 'must not point at a private address'
const lengthRule = 'must be a non-empty string of at most 2048 characters'

//one entry per rule the node applies, with each distinct spelling that trips it
const refusals = [
    ['an empty string', '', lengthRule],
    ['an oversized url', 'https://gw.example.com/' + 'a'.repeat(2048), lengthRule],
    ['a string that is not an absolute url', 'gw.example.com/base', 'must be an absolute url'],
    ['an ftp url', 'ftp://gw.example.com', 'must use http or https'],
    ['a websocket url', 'ws://gw.example.com', 'must use http or https'],
    ['a file url', 'file:///etc/gateway', 'must use http or https'],
    ['user information on http', 'http://operator:secret@gw.example.com', 'must not contain user information'],
    ['a query string on http', 'http://gw.example.com/?token=abc', queryRule],
    ['a private address on http', 'http://10.20.30.40:8080', privateRule],
    ['a user name', 'https://operator@gw.example.com', 'must not contain user information'],
    ['a password', 'https://:secret@gw.example.com', 'must not contain user information'],
    ['a query string', 'https://gw.example.com/?token=abc', queryRule],
    ['a bare ?', 'https://gw.example.com/?', queryRule],
    ['a fragment', 'https://gw.example.com/#section', queryRule],
    ['a bare #', 'https://gw.example.com#', queryRule],
    ['a private IPv4 address', 'https://10.20.30.40:8443', privateRule],
    ['the metadata address', 'https://169.254.169.254', privateRule],
    ['a private IPv6 address', 'https://[fd00::1]', privateRule],
    ['an IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]', privateRule]
]

//nothing of any url in these tests may come back in an answer: not the scheme, the host, a credential or a query
const urlFragments = /https?:|ftp:|ws:|file:|example\.com|10\.20|169\.254|fd00|ffff|127\.0|operator|secret|token|section|aaaa|etc\/gateway/

const validList = count => new Array(count).fill(0).map((_, i) => `https://gateway-${i}.example.com`)

describe('POST /gateways and /validate-gateways refuse the gateway urls a node refuses', () => {
    let app

    beforeAll(async () => {
        app = await startApp()
    })

    afterAll(async () => {
        await new Promise(resolve => app.close(resolve))
    })

    beforeEach(() => {
        sent.length = 0
        safeGetJson.mockClear()
        nonce += 1
    })

    describe.each(routes)('POST %s', (path, bodyOf) => {
        test.each(refusals)('refuses %s with the rule and the index, never the url', async (_, url, rule) => {
            const res = await post(app, path, bodyOf(['https://good.example.com', url]))

            expect(res.status).toBe(400)
            const {error} = JSON.parse(res.body)
            expect(error).toBe(`Bad request. urls[1] ${rule}`)
            expect(error).not.toMatch(urlFragments)
            if (url)
                expect(error).not.toContain(url)
            //refused before anything is forwarded to the node or probed
            expect(sent).toEqual([])
            expect(safeGetJson).not.toHaveBeenCalled()
        })

        test('accepts ten https gateways', async () => {
            const urls = validList(10)
            const res = await post(app, path, bodyOf(urls))

            expect(res.status).toBe(200)
            if (path === '/gateways') {
                expect(sent).toHaveLength(1)
                expect(sent[0].data.data.urls).toEqual(urls)
            } else {
                const result = JSON.parse(res.body)
                expect(Object.keys(result)).toEqual(urls)
                expect(Object.values(result).every(info => info.status === 'healthy')).toBe(true)
            }
        })

        test('accepts ten http gateways of the shape the dashboard builds', async () => {
            //the dashboard's Add form only produces http://<public ip>:<port>, and the gateway image serves plain http
            const urls = new Array(10).fill(0).map((_, i) => `http://93.184.216.${i + 1}:8080`)
            const res = await post(app, path, bodyOf(urls))

            expect(res.status).toBe(200)
            if (path === '/gateways')
                expect(sent[0].data.data.urls).toEqual(urls)
            else
                expect(Object.keys(JSON.parse(res.body))).toEqual(urls)
        })

        test('refuses eleven http gateways', async () => {
            const urls = new Array(11).fill(0).map((_, i) => `http://93.184.216.${i + 1}:8080`)
            const res = await post(app, path, bodyOf(urls))

            expect(res.status).toBe(400)
            expect(JSON.parse(res.body).error).toBe('Bad request. urls must contain at most 10 entries')
            expect(sent).toEqual([])
            expect(safeGetJson).not.toHaveBeenCalled()
        })

        test('refuses eleven https gateways', async () => {
            const res = await post(app, path, bodyOf(validList(11)))

            expect(res.status).toBe(400)
            const {error} = JSON.parse(res.body)
            expect(error).toBe('Bad request. urls must contain at most 10 entries')
            expect(error).not.toMatch(urlFragments)
            expect(sent).toEqual([])
            expect(safeGetJson).not.toHaveBeenCalled()
        })

        test('counts the list as submitted, so repeated entries still count against the cap', async () => {
            const urls = [...validList(10), 'https://gateway-0.example.com']
            const res = await post(app, path, bodyOf(urls))

            expect(res.status).toBe(400)
            expect(JSON.parse(res.body).error).toBe('Bad request. urls must contain at most 10 entries')
        })

        test('accepts an empty list, which is how a node is told it has no gateways', async () => {
            const res = await post(app, path, bodyOf([]))

            expect(res.status).toBe(200)
        })
    })

    test('POST /gateways forwards an accepted url exactly as signed, leaving the normalisation to the node', async () => {
        //the node strips the trailing slash itself; rewriting the list here would break the signature it checks
        const res = await post(app, '/gateways', {urls: ['https://Gateway.Example.com/'], challenge: 'c1'})

        expect(res.status).toBe(200)
        expect(sent[0].data.data.urls).toEqual(['https://Gateway.Example.com/'])
    })
})
