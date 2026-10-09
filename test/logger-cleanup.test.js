/*eslint-disable no-undef */
const http = require('http')
const axios = require('axios')
const {ConfigEnvelope} = require('@reflector/reflector-shared')
const {redactString, cleanup, filterError, errorSerializer} = require('../logger-cleanup')

//the real logger writes through rotating-file-stream. Swapping only that layer for a memory sink keeps the test off
//the filesystem while leaving logger.js itself - its serializers and its redact paths - exactly as it ships.
const mockSinks = []
jest.mock('rotating-file-stream', () => ({
    createStream: () => {
        const sink = {
            chunks: [],
            write(chunk) {
                sink.chunks.push(chunk)
            }
        }
        mockSinks.push(sink)
        return sink
    }
}))

const logger = require('../logger')
const {getNodeKeypairs, buildConfig, getSignedEnvelope} = require('./helpers/config-manager-harness')

describe('redactString', () => {
    test('masks a stellar secret seed', () => {
        const line = 'loaded secret SAPXRLLSLC5WLVW5YPDCGQYBDTZV6TJEXXXQCGFLHUFKG5AXGEN7KEKY for node'
        const result = redactString(line)
        expect(result).not.toContain('SAPXRLLSLC5WLVW5YPDCGQYBDTZV6TJEXXXQCGFLHUFKG5AXGEN7KEKY')
        expect(result).toContain('[redacted]')
    })

    test('keeps a public key', () => {
        const pubkey = 'GCEBYD3K3IYSYLK5EQEK72RVAH2AHZUYSFFG4IOXUS5AOINLMXJRMDRA'
        expect(redactString(`node ${pubkey} joined`)).toContain(pubkey)
    })

    test('masks rsa private key material', () => {
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'
        expect(redactString(`secret: ${pem}`)).toBe('secret: [redacted]')
    })

    test('masks bearer and basic credentials', () => {
        expect(redactString('authorization: Basic c2VjcmV0OnBhc3M=')).toBe('authorization: [redacted]')
        expect(redactString('authorization: Bearer abc.def-ghi')).toBe('authorization: [redacted]')
    })

    test('masks api keys carried in a query string', () => {
        //a url loses its path and query altogether; a query string on its own keeps what is not a key
        expect(redactString('GET https://api.example.com/v1?apiKey=SUPERSECRET&symbol=BTC failed')).toBe('GET https://api.example.com failed')
        expect(redactString('query ?apiKey=SUPERSECRET&symbol=BTC&access_key=SECRET2&key=SECRET3'))
            .toBe('query ?apiKey=[redacted]&symbol=BTC&access_key=[redacted]&key=[redacted]')
    })

    test('masks the middle of an ipv4 address and the body of an ipv6 address', () => {
        expect(redactString('peer 203.0.113.9 connected')).toBe('peer 203.***.***.9 connected')
        const masked = redactString('peer 2001:db8:85a3::8a2e:370:7334 connected')
        expect(masked).toContain('2001:***:7334')
        expect(masked).not.toContain('85a3')
    })

    test('leaves a clock-like string alone', () => {
        expect(redactString('took 12:34:56')).toBe('took 12:34:56')
    })
})

describe('cleanup', () => {
    test('does not mutate the object it is given', () => {
        const source = {url: 'https://rpc.example.com/v1?apiKey=SUPERSECRET', nested: {ip: '203.0.113.9'}}
        const snapshot = JSON.parse(JSON.stringify(source))
        const result = cleanup(source)
        expect(source).toEqual(snapshot)
        expect(result.url).not.toContain('SUPERSECRET')
        expect(result.nested.ip).toBe('203.***.***.9')
        expect(Object.getOwnPropertyNames(source)).not.toContain('circular-ref-tag')
    })

    test('keeps only the scheme, host and port of an error url: provider keys live in the path too', () => {
        const err = new Error('request failed')
        err.url = 'https://rpc.example.com/v1/SECRETPATHKEY123'
        expect(cleanup(err).url).toBe('https://rpc.example.com')
        err.url = 'http://127.0.0.1:8000/v1/SECRETPATHKEY123?apiKey=SUPERSECRET'
        expect(cleanup(err).url).toBe('http://127.***.***.1:8000')
        const nested = new Error('outer', {cause: [err]})
        expect(errorSerializer(nested).cause[0].url).toBe('http://127.***.***.1:8000')
        err.url = 'not a url'
        expect(cleanup(err).url).toBeUndefined()
    })

    test('stops at a bounded depth', () => {
        let deep = {leaf: 'end'}
        for (let i = 0; i < 20; i++)
            deep = {child: deep}
        expect(JSON.stringify(cleanup(deep))).toContain('[truncated]')
    })

    test('survives a circular graph', () => {
        const node = {name: 'a'}
        node.self = node
        expect(cleanup(node)).toEqual({name: 'a', self: '[circular]'})
    })

    test('caps a long array', () => {
        expect(cleanup(new Array(500).fill('x'))).toHaveLength(50)
    })
})

describe('filterError', () => {
    test('drops the axios config, request and response graphs', () => {
        const err = new Error('Request failed with status code 401')
        err.isAxiosError = true
        err.code = 'ERR_BAD_REQUEST'
        err.config = {
            url: 'https://mainnet.stellar.validationcloud.io/v1/SUPERSECRETKEY',
            headers: {authorization: 'Basic SUPERSECRETKEY'},
            data: '{"app_id":"x"}'
        }
        err.request = {socket: {}}
        err.response = {status: 401, config: err.config}

        const filtered = filterError(err)

        expect(filtered.config).toBeUndefined()
        expect(filtered.request).toBeUndefined()
        expect(filtered.response).toBeUndefined()
        expect(filtered.status).toBe(401)
        expect(filtered.code).toBe('ERR_BAD_REQUEST')
        expect(filtered.url).toBe('https://mainnet.stellar.validationcloud.io')
        expect(JSON.stringify({...filtered, message: filtered.message})).not.toContain('SUPERSECRETKEY')
    })

    test('leaves an ordinary error alone', () => {
        const err = new Error('boom')
        expect(filterError(err)).toBe(err)
    })
})

//These values are planted in a genuine request against a loopback server, so the errors below carry whatever axios
//really attaches rather than what a hand-written fixture guesses it attaches.
const planted = {
    pathSecret: 'PlantedPathKey01',
    querySecret: 'PlantedQueryKey02',
    tokenSecret: 'PlantedBearerToken03',
    requestBodySecret: 'PlantedRequestBody04',
    responseBodySecret: 'PlantedResponseBody05'
}

/**
 * @param {function} handler - request handler
 * @returns {Promise<object>} a listening loopback server
 */
function startServer(handler) {
    return new Promise(resolve => {
        const server = http.createServer(handler)
        server.listen(0, '127.0.0.1', () => resolve(server))
    })
}

/**
 * Bind a loopback port and release it again, so a connection to it is refused
 * @returns {Promise<number>} a port with nothing listening on it
 */
async function closedPort() {
    const server = await startServer(() => {})
    const {port} = server.address()
    await new Promise(resolve => server.close(resolve))
    return port
}

/**
 * @param {Promise} request - a request expected to fail
 * @returns {Promise<Error>} the axios error it rejected with
 */
async function failedRequest(request) {
    let error
    try {
        await request
    } catch (e) {
        error = e
    }
    if (!error)
        throw new Error('the request was expected to fail but it succeeded')
    return error
}

/**
 * @returns {string} everything both log streams have been handed since the last reset
 */
function allOutput() {
    return mockSinks.map(sink => sink.chunks.join('')).join('')
}

/**
 * @returns {object} the last entry written to the combined stream
 */
function lastEntry() {
    const lines = mockSinks[1].chunks.join('').split('\n').filter(line => line.length > 0)
    return JSON.parse(lines[lines.length - 1])
}

function resetOutput() {
    for (const sink of mockSinks)
        sink.chunks.length = 0
}

describe('real axios failures through the production logger', () => {
    let server
    let baseUrl
    let rejected
    let refused

    beforeAll(async () => {
        server = await startServer((req, res) => {
            res.writeHead(401, {'content-type': 'application/json'})
            res.end(JSON.stringify({error: planted.responseBodySecret}))
        })
        baseUrl = `http://127.0.0.1:${server.address().port}`
        rejected = await failedRequest(axios.post(
            `${baseUrl}/v1/${planted.pathSecret}?apiKey=${planted.querySecret}`,
            {payload: planted.requestBodySecret},
            {headers: {authorization: `Bearer ${planted.tokenSecret}`}}
        ))
        refused = await failedRequest(axios.get(`http://127.0.0.1:${await closedPort()}/v1/${planted.pathSecret}`))
    })

    afterAll(async () => {
        await new Promise(resolve => server.close(resolve))
    })

    beforeEach(() => resetOutput())

    //without this the assertions below could all pass against an error that never carried anything worth hiding
    test('the fixture really does carry every planted secret before serialisation', () => {
        expect(rejected.isAxiosError).toBe(true)
        expect(rejected.config.headers.authorization).toContain(planted.tokenSecret)
        expect(rejected.config.url).toContain(planted.pathSecret)
        expect(rejected.config.url).toContain(planted.querySecret)
        expect(rejected.config.data).toContain(planted.requestBodySecret)
        expect(JSON.stringify(rejected.response.data)).toContain(planted.responseBodySecret)
        expect(refused.code).toBe('ECONNREFUSED')
    })

    test('no planted secret survives a log of the rejected request', () => {
        logger.error({err: rejected}, 'request failed')
        const output = allOutput()
        expect(output).toContain('request failed')
        for (const [name, secret] of Object.entries(planted))
            expect([name, output.includes(secret)]).toEqual([name, false])
        expect(output).not.toContain('authorization')
        expect(output).not.toContain('Bearer')
    })

    test('the request, response and config graphs never reach the stream', () => {
        logger.error({err: rejected}, 'request failed')
        const entry = lastEntry()
        expect(entry.err.config).toBeUndefined()
        expect(entry.err.request).toBeUndefined()
        expect(entry.err.response).toBeUndefined()
        expect(allOutput()).not.toContain('socket')
    })

    test('what an operator needs is still there', () => {
        logger.error({err: rejected}, 'request failed')
        const entry = lastEntry()
        expect(entry.err.status).toBe(401)
        expect(entry.err.message).toBe('Request failed with status code 401')
        expect(entry.err.url).toBe(`http://127.***.***.1:${server.address().port}`)
    })

    test('a refused connection keeps its code and masks the address', () => {
        logger.error({err: refused}, 'probe failed')
        const entry = lastEntry()
        expect(entry.err.code).toBe('ECONNREFUSED')
        expect(entry.err.message).toContain('127.***.***.1')
        expect(entry.err.message).not.toContain('127.0.0.1')
        expect(allOutput()).not.toContain(planted.pathSecret)
    })

    test('a bare error argument is filtered the same way', () => {
        logger.error(rejected)
        const output = allOutput()
        for (const [name, secret] of Object.entries(planted))
            expect([name, output.includes(secret)]).toEqual([name, false])
    })

    test('the module level serializer drops the graphs too', () => {
        const serialized = JSON.stringify(errorSerializer(rejected))
        for (const [name, secret] of Object.entries(planted))
            expect([name, serialized.includes(secret)]).toEqual([name, false])
    })

    test('a secret interpolated into a message is redacted', () => {
        const seed = 'SAPXRLLSLC5WLVW5YPDCGQYBDTZV6TJEXXXQCGFLHUFKG5AXGEN7KEKY'
        logger.error(`node started with secret ${seed}`)
        expect(allOutput()).not.toContain(seed)
        expect(allOutput()).toContain('[redacted]')
    })

    //cleanup keeps an allowlist of error properties rather than redacting what it recognises, so an error that never
    //reaches filterError - a wrapped one, or a home-grown one carrying context - still cannot smuggle a field out
    test('an error property outside the allowlist is dropped, not merely censored', () => {
        const err = new Error('save failed')
        err.code = 'E_SAVE'
        err.sessionToken = 'PlantedSessionToken06'
        logger.error({err}, 'save failed')
        const output = allOutput()
        expect(output).toContain('E_SAVE')
        expect(output).not.toContain('PlantedSessionToken06')
        expect(output).not.toContain('sessionToken')
    })

    test('serialising an axios error does not mutate it', () => {
        const before = JSON.stringify({
            url: rejected.config.url,
            auth: rejected.config.headers.authorization,
            data: rejected.config.data,
            status: rejected.response.status
        })
        logger.error({err: rejected}, 'request failed')
        expect(JSON.stringify({
            url: rejected.config.url,
            auth: rejected.config.headers.authorization,
            data: rejected.config.data,
            status: rejected.response.status
        })).toBe(before)
        expect(Object.getOwnPropertyNames(rejected)).not.toContain('circular-ref-tag')
    })
})

//fast-redact's leading * matches exactly one path segment, so every depth needs a path of its own. A config item logged
//under a key puts the cluster secret four segments down: {item: {envelope: {config: {clusterSecret}}}}
describe('secret keys are censored at every depth a log call reaches', () => {
    const depths = [1, 2, 3, 4]
    const cases = ['clusterSecret', 'apiKey', 'secret'].flatMap(name => depths.map(depth => [name, depth]))

    /**
     * @param {string} name - key that holds the secret
     * @param {number} depth - path segments down to the key; 1 is the top level of the logged object
     * @param {string} value - the planted secret
     * @returns {object}
     */
    function nested(name, depth, value) {
        let result = {[name]: value, visible: `Visible${name}${depth}`}
        for (let level = depth - 1; level > 0; level--)
            result = {[`level${level}`]: result}
        return result
    }

    /**
     * @param {string} name - secret key
     * @param {number} depth - its depth
     * @returns {string}
     */
    function plantedFor(name, depth) {
        return `Planted${name}AtDepth${depth}`
    }

    /**
     * The line must have been written, its non-secret sibling must have survived and the secret must not have
     * @param {string} name - secret key
     * @param {number} depth - its depth
     */
    function expectCensored(name, depth) {
        const output = allOutput()
        expect(output).toContain(`Visible${name}${depth}`)
        expect(output).toContain('[redacted]')
        expect(output).not.toContain(plantedFor(name, depth))
    }

    beforeEach(() => resetOutput())

    test('the fixture puts the key at the depth it claims', () => {
        expect(nested('secret', 1, 'x')).toEqual({secret: 'x', visible: 'Visiblesecret1'})
        expect(nested('secret', 4, 'x')).toEqual({level1: {level2: {level3: {secret: 'x', visible: 'Visiblesecret4'}}}})
    })

    test.each(cases)('%s %i segment(s) down in the logged object', (name, depth) => {
        logger.error(nested(name, depth, plantedFor(name, depth)), 'probe')
        expectCensored(name, depth)
    })

    test.each(cases)('%s %i segment(s) down in an object interpolated into the message', (name, depth) => {
        logger.error('state %j', nested(name, depth, plantedFor(name, depth)))
        expectCensored(name, depth)
    })

    //logger.error(a, b) and console.error(a, b) make b the message, which the msg serializer wraps one level down
    test.each(cases.filter(([, depth]) => depth <= 2))('%s %i segment(s) down in an object passed as the message', (name, depth) => {
        logger.error({}, nested(name, depth, plantedFor(name, depth)))
        expectCensored(name, depth)
    })

    test.each(cases.filter(([, depth]) => depth <= 2))('%s %i segment(s) down in the details of an error', (name, depth) => {
        const err = new Error('rejected')
        err.details = nested(name, depth, plantedFor(name, depth))
        logger.error({err}, 'probe')
        expectCensored(name, depth)
    })

    test('a real config envelope loses its cluster secret however it is wrapped', () => {
        const planted = 'PlantedClusterSecret07'
        const nodeKps = getNodeKeypairs(2)
        const config = buildConfig(nodeKps)
        config.clusterSecret = planted
        const envelope = new ConfigEnvelope(getSignedEnvelope(config, nodeKps[0]))
        expect(envelope.config.clusterSecret).toBe(planted)
        expect(JSON.stringify({item: {envelope}})).toContain(planted)
        for (const payload of [envelope.config, envelope, {envelope}, {item: {envelope}}]) {
            resetOutput()
            logger.info(payload, 'config')
            const output = allOutput()
            expect(output).toContain(envelope.config.systemAccount)
            expect(output).not.toContain(planted)
        }
    })
})

//an rpc provider key often lives in the url path (https://provider/<key>), where the query-key pattern never looks:
//every url that reaches a log line keeps its scheme, host and port only
describe('a url reaches a log line as its scheme, host and port only', () => {
    const {safeUrl, msgSerializer} = require('../logger-cleanup')
    const keyedUrl = 'https://rpc.example/v1/SECRETKEY123/'

    beforeEach(() => resetOutput())

    test('safeUrl keeps the scheme, host and port, and drops userinfo, path, query and fragment', () => {
        expect(safeUrl(keyedUrl)).toBe('https://rpc.example')
        expect(safeUrl('https://user:pass@rpc.example:8443/v1/SECRETKEY123/?key=abc#frag')).toBe('https://rpc.example:8443')
        expect(safeUrl('not a url')).toBeUndefined()
        expect(safeUrl(undefined)).toBeUndefined()
    })

    test('a url inside any logged string loses everything after its host', () => {
        expect(redactString(`request to ${keyedUrl} failed`)).toBe('request to https://rpc.example failed')
        expect(redactString('POST https://user:pass@rpc.example:8443/v1/SECRETKEY123/?key=abc#frag timed out'))
            .toBe('POST https://rpc.example:8443 timed out')
        expect(redactString('wss://node.example:30347/SECRETKEY123 closed')).toBe('wss://node.example:30347 closed')
        expect(redactString('http://10.1.2.3:8000/v1/SECRETKEY123')).toBe('http://10.***.***.3:8000')
        expect(redactString('at file:///app/utils/rpc-helper.js:10:5')).toBe('at file:///app/utils/rpc-helper.js:10:5')
    })

    test('a failed rpc request logs its url as the host, at debug and in every error it logs', async () => {
        const {makeServerRequest} = require('../utils/request-helper')
        const debug = jest.spyOn(logger, 'debug')
        const failure = () => {
            const err = new Error(`Request failed with status code 403 for ${keyedUrl}`)
            err.isAxiosError = true
            err.config = {url: keyedUrl, headers: {}}
            err.response = {status: 403, config: {url: keyedUrl}}
            return Promise.reject(err)
        }
        try {
            const thrown = await makeServerRequest([keyedUrl], url => url, failure).catch(e => e)
            logger.error({err: thrown}, 'rpc request failed')
            expect(debug).toHaveBeenCalledTimes(1)
            const [line] = debug.mock.calls[0]
            expect(line.startsWith('Request to https://rpc.example failed. Error: ')).toBe(true)
            expect(msgSerializer(line)).toBe('Request to https://rpc.example failed. Error: Request failed with status code 403 for https://rpc.example')
        } finally {
            debug.mockRestore()
        }
        const output = allOutput()
        expect(output).toContain('rpc request failed')
        expect(output).not.toContain('SECRETKEY123')
        const lines = mockSinks[1].chunks.join('').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))
        //the per-url error, then the aggregate whose cause holds it
        expect(lines.map(line => line.err.url)).toEqual(['https://rpc.example', undefined])
        //cleanup copies a nested error into an Error, whose message and stack JSON does not carry
        expect(lines[1].err.cause).toEqual([{name: 'Error'}])
    })
})
