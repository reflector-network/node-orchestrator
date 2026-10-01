/*eslint-disable no-undef */
const dns = require('dns')
const http = require('http')
//the real resolver refuses 127.0.0.1, where the stub gateways live, so only the address checks are stubbed out and
//the transport behaviour can be exercised. validateRequestUrl stays real: the scheme check is part of what is tested.
jest.mock('../utils/ssrf-validator', () => ({
    validateRequestUrl: jest.requireActual('../utils/ssrf-validator').validateRequestUrl,
    resolveAndValidate: (urlString) => Promise.resolve({url: new URL(urlString), resolvedIp: '127.0.0.1'}),
    isPrivateIP: () => false
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const logger = require('../logger')
const {safeGetJson} = require('../utils/safe-request')
const {validateGatewaysBody, validateGateway, validateGateways} = require('../server/routes/gateway-validation')

function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function urlOf(server) {
    return `http://127.0.0.1:${server.address().port}`
}

/**
 * A responder that answers one byte at a time, which resets a socket-inactivity timer for as long as it keeps writing
 * @param {number} intervalMs - delay between bytes
 * @param {number} padding - length of the padded value, so the whole body takes intervalMs * padding to arrive
 * @returns {function} request handler
 */
function trickling(intervalMs, padding) {
    const body = '{"version":"' + 'x'.repeat(padding) + '"}'
    return (req, res) => {
        res.writeHead(200, {'content-type': 'application/json'})
        let sent = 0
        const timer = setInterval(() => {
            if (sent >= body.length) {
                clearInterval(timer)
                res.end()
                return
            }
            res.write(body[sent])
            sent++
        }, intervalMs)
        res.on('close', () => clearInterval(timer))
    }
}

describe('validateGatewaysBody', () => {
    test('refuses a body without a urls array', () => {
        expect(() => validateGatewaysBody({})).toThrow('urls must be an array')
        expect(() => validateGatewaysBody({urls: 'http://a'})).toThrow('urls must be an array')
    })

    test('refuses more urls than the cap', () => {
        const urls = new Array(21).fill(0).map((_, i) => `http://gateway-${i}.example.com`)
        expect(() => validateGatewaysBody({urls})).toThrow('at most 20')
    })

    test('refuses non-string entries and a non-string validation key', () => {
        expect(() => validateGatewaysBody({urls: ['http://a.example.com', 42]})).toThrow('urls must be an array of strings')
        expect(() => validateGatewaysBody({urls: [], validationKey: {}})).toThrow('validationKey must be a non-empty string')
    })

    test('refuses a body that simply omits the validation key', () => {
        //an optional field cannot carry the POST /gateways allowed-keys check: a body that may leave it out is a body
        //that check accepts
        expect(() => validateGatewaysBody({urls: ['http://a.example.com']})).toThrow('validationKey must be a non-empty string')
        expect(() => validateGatewaysBody({urls: ['http://a.example.com'], validationKey: ''})).toThrow('validationKey must be a non-empty string')
    })

    test('deduplicates while keeping the order', () => {
        const body = {urls: ['http://b.example.com', 'http://a.example.com', 'http://b.example.com'], validationKey: 'k1'}
        const {urls} = validateGatewaysBody(body)
        expect(urls).toEqual(['http://b.example.com', 'http://a.example.com'])
    })
})

describe('safeGetJson', () => {
    test('sends the validation header and returns the parsed body', async () => {
        const seen = []
        const server = await startServer((req, res) => {
            seen.push({url: req.url, key: req.headers['x-gateway-validation']})
            res.setHeader('content-type', 'application/json')
            res.end('{"version":"1.2.3"}')
        })
        try {
            const body = await safeGetJson(urlOf(server) + '/', {headers: {'x-gateway-validation': 'k1'}})
            expect(body).toEqual({version: '1.2.3'})
            expect(seen).toEqual([{url: '/', key: 'k1'}])
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('treats a redirect as a failure instead of following it', async () => {
        let followed = false
        const target = await startServer((req, res) => {
            followed = true
            res.end('{"version":"leaked"}')
        })
        const server = await startServer((req, res) => {
            res.writeHead(302, {location: urlOf(target) + '/'})
            res.end()
        })
        try {
            await expect(safeGetJson(urlOf(server) + '/')).rejects.toThrow()
            expect(followed).toBe(false)
        } finally {
            await new Promise(resolve => server.close(resolve))
            await new Promise(resolve => target.close(resolve))
        }
    })

    test('abandons a server that never answers', async () => {
        const pending = []
        const server = await startServer((req, res) => {
            pending.push(res)
        })
        try {
            await expect(safeGetJson(urlOf(server) + '/', {timeout: 200})).rejects.toThrow()
        } finally {
            for (const res of pending)
                res.destroy()
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('refuses a body over the cap', async () => {
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end('{"padding":"' + 'x'.repeat(1200000) + '"}')
        })
        try {
            await expect(safeGetJson(urlOf(server) + '/')).rejects.toThrow()
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('abandons a responder that trickles bytes to keep the socket busy', async () => {
        //62 bytes one every 150 ms, so only the wall-clock deadline ends the read
        const server = await startServer(trickling(150, 48))
        const started = Date.now()
        try {
            await expect(safeGetJson(urlOf(server) + '/', {timeout: 500})).rejects.toThrow()
            expect(Date.now() - started).toBeLessThan(4000)
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    }, 20000)

    test('refuses a body that is not a json object', async () => {
        //responseType: 'json' does not enforce anything - axios hands back the raw text when it cannot parse it,
        //and a caller that destructures it gets undefined fields instead of an error
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'text/html')
            res.end('<html><body>not a gateway</body></html>')
        })
        try {
            await expect(safeGetJson(urlOf(server) + '/'))
                .rejects.toMatchObject({safeMessage: 'Gateway returned a non-JSON response'})
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('ignores a proxy in the environment so egress stays on the pinned agent', async () => {
        const proxied = []
        const proxy = await startServer((req, res) => {
            proxied.push(req.url)
            res.setHeader('content-type', 'application/json')
            res.end('{"version":"VIA-PROXY"}')
        })
        const gateway = await startServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end('{"version":"direct"}')
        })
        //a named host, because axios does not route an address literal through a proxy; the agent lookup answers with
        //the loopback listener started here, so the request cannot leave the machine whichever route it takes
        jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) =>
            (options && options.all ? callback(null, [{address: '127.0.0.1', family: 4}]) : callback(null, '127.0.0.1', 4)))
        process.env.HTTP_PROXY = urlOf(proxy)
        try {
            const body = await safeGetJson(`http://gateway.example.com:${gateway.address().port}/`)
            expect(body).toEqual({version: 'direct'})
            expect(proxied).toEqual([])
        } finally {
            delete process.env.HTTP_PROXY
            jest.restoreAllMocks()
            await new Promise(resolve => proxy.close(resolve))
            await new Promise(resolve => gateway.close(resolve))
        }
    })
})

describe('validateGateway', () => {
    test('reports healthy when both probes answer', async () => {
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(req.url.startsWith('/gateway') ? '{"serverTime":1700000000}' : '{"version":"1.2.3"}')
        })
        try {
            const info = await validateGateway(urlOf(server), 'k1')
            expect(info).toEqual({status: 'healthy', version: '1.2.3'})
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('never echoes a transport error to the caller', async () => {
        const server = await startServer((req, res) => {
            res.writeHead(500)
            res.end('boom')
        })
        try {
            const info = await validateGateway(urlOf(server), 'k1')
            expect(info.status).toBe('unreachable')
            expect(info.error).toBe('Gateway request failed')
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('does not call a host that answers with a web page alive', async () => {
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'text/html')
            res.end('<html><body>not a gateway</body></html>')
        })
        try {
            const info = await validateGateway(urlOf(server), 'k1')
            expect(info.status).toBe('unreachable')
            expect(info.error).toBe('Gateway returned a non-JSON response')
            expect(info.version).toBeUndefined()
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('does not call a host that answers json without a version alive', async () => {
        //the version is what the gateway contract promises; without it the status is a liveness report for an
        //arbitrary public host rather than a statement about a gateway
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end('{"ok":1}')
        })
        try {
            const info = await validateGateway(urlOf(server), 'k1')
            expect(info.status).toBe('unreachable')
            expect(info.error).toBe('Gateway did not report a version')
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })

    test('refuses a url that is not http(s) before any request', async () => {
        const info = await validateGateway('file:///etc/passwd', 'k1')
        expect(info).toEqual({status: 'unreachable', error: 'Blocked URL scheme'})
    })

    test('logs the host it was given and never the address it resolved to', async () => {
        //the rebinding path is caught at the socket, and the error naming the private address must not reach the
        //logs either
        jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => {
            const error = new Error(`SSRF blocked: ${hostname} resolved to private IP 10.11.12.13`)
            error.safeMessage = 'Host resolves to a private address'
            callback(error)
        })
        logger.debug.mockClear()
        try {
            const info = await validateGateway('http://rebind.example.com', 'k1')
            //and the safe reason survives the axios boundary instead of degrading to the generic string
            expect(info.error).toBe('Host resolves to a private address')
            const logged = logger.debug.mock.calls.map(call => call.join(' ')).join('\n')
            expect(logged).toContain('rebind.example.com')
            expect(logged).not.toContain('10.11.12.13')
        } finally {
            jest.restoreAllMocks()
        }
    })
})

describe('validateGateways', () => {
    test('bounds the whole route and still answers for every url', async () => {
        const pending = []
        const servers = []
        for (let i = 0; i < 6; i++) {
            servers.push(await startServer((req, res) => {
                pending.push(res)
            }))
        }
        const urls = servers.map(urlOf)
        const started = Date.now()
        try {
            const result = await validateGateways(urls, 'k1', 600)
            //a url whose turn never came is reported like any other failure rather than failing the whole request
            expect(Object.keys(result)).toEqual(urls)
            for (const url of urls) {
                expect(result[url].status).toBe('unreachable')
                expect(typeof result[url].error).toBe('string')
            }
            //without the outer budget this is six urls, each waiting out its own per-request deadline
            expect(Date.now() - started).toBeLessThan(5000)
        } finally {
            for (const res of pending)
                res.destroy()
            for (const server of servers)
                await new Promise(resolve => server.close(resolve))
        }
    })

    test('answers for every url when they all respond', async () => {
        const server = await startServer((req, res) => {
            res.setHeader('content-type', 'application/json')
            res.end(req.url.startsWith('/gateway') ? '{"serverTime":1700000000}' : '{"version":"1.2.3"}')
        })
        try {
            const result = await validateGateways([urlOf(server)], 'k1')
            expect(result).toEqual({[urlOf(server)]: {status: 'healthy', version: '1.2.3'}})
        } finally {
            await new Promise(resolve => server.close(resolve))
        }
    })
})
