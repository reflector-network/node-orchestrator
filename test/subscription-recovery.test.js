/*eslint-disable no-undef */
//The recovery paths run against a fake Soroban RPC placed behind the SDK's own HTTP client, so the SDK's JSON-RPC layer
//turns a refusal into the error it really throws and rpc-helper handles it as it would in production. The shared
//loaders the chain-state load goes through are stubbed where they would reach the RPC. Nothing leaves the process.
//A jest.mock factory may only close over `mock`-prefixed vars
jest.useFakeTimers()
//eslint-disable-next-line no-var
var mockRpc = {oldest: 0, latest: 0, events: [], requests: [], failedPageReads: 0}
//eslint-disable-next-line no-var
var mockLoaders = {state: jest.fn(), list: jest.fn(), one: jest.fn()}
/**
 * Answer one JSON-RPC request as stellar-rpc does. getEvents refuses a startLedger outside [oldest, latest]; while
 * failedPageReads is above zero, a page read in range fails with an internal error instead and counts it down. The
 * limit-1 read rpc-helper uses to learn the oldest ledger is never failed
 * @param {{method: string, params: any}} body - JSON-RPC request body
 * @returns {object} JSON-RPC response body
 */
//eslint-disable-next-line no-var
var mockAnswer = function ({method, params}) {
    if (method !== 'getEvents')
        throw new Error('unexpected method ' + method)
    mockRpc.requests.push({startLedger: params.startLedger, limit: params.pagination?.limit})
    if (params.startLedger !== undefined && (params.startLedger < mockRpc.oldest || params.startLedger > mockRpc.latest))
        return {
            jsonrpc: '2.0',
            id: 1,
            error: {
                code: -32600,
                message: `startLedger must be between the oldest ledger: ${mockRpc.oldest} and the latest ledger: ${mockRpc.latest} for this rpc instance.`
            }
        }
    if (params.pagination?.limit !== 1 && mockRpc.failedPageReads > 0) {
        mockRpc.failedPageReads--
        return {jsonrpc: '2.0', id: 1, error: {code: -32603, message: 'internal error'}}
    }
    const events = params.pagination?.limit === 1 ? [] : mockRpc.events.filter(event => event.ledger >= params.startLedger)
    return {jsonrpc: '2.0', id: 1, result: {events, latestLedger: mockRpc.latest, oldestLedger: mockRpc.oldest, cursor: ''}}
}

jest.mock('../domain/container', () => ({appConfig: {getNetworkConfig: () => ({urls: ['http://rpc.example.com']})}}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))
jest.mock('@reflector/reflector-shared', () => ({
    getSubscriptionsContractState: (...args) => mockLoaders.state(...args),
    getSubscriptions: (...args) => mockLoaders.list(...args),
    getSubscriptionById: (...args) => mockLoaders.one(...args)
}))
jest.mock('@stellar/stellar-sdk', () => {
    const actual = jest.requireActual('@stellar/stellar-sdk')
    class FakeRpcServer extends actual.rpc.Server {
        constructor(url, options) {
            super(url, options)
            this.httpClient.post = (postUrl, body) => Promise.resolve({data: mockAnswer(body)})
            //sdk 17 decodes the ledger header and close meta of a getLatestLedger answer, which a fake cannot supply
            //cheaply; the sequence is all rpc-helper reads, so this one call is answered above the JSON-RPC layer
            this.getLatestLedger = () => Promise.resolve({id: 'ledger-hash', sequence: mockRpc.latest, protocolVersion: 23})
        }
    }
    return {...actual, rpc: {...actual.rpc, Server: FakeRpcServer}}
})

const {xdr, nativeToScVal, scValToNative, Keypair, Address} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const {SubscriptionContractManager} = require('../domain/subscription-data-provider')

const contractId = 'CSUB'
const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()
const created = 1700000000000n
const chargedOn = created + 86400000n
const minuteMs = 60 * 1000

const sym = value => xdr.ScVal.scvSymbol(value)
const u64 = value => nativeToScVal(value, {type: 'u64'})
const field = (key, val) => new xdr.ScMapEntry({key: sym(key), val})

/**
 * @param {{balance: bigint, updated: bigint}} state - mutable subscription fields
 * @returns {xdr.ScVal} the contract's `Subscription` struct
 */
function subscriptionScVal({balance, updated}) {
    const ticker = (asset, source) => xdr.ScVal.scvMap([field('asset', xdr.ScVal.scvString(asset)), field('source', xdr.ScVal.scvString(source))])
    return xdr.ScVal.scvMap([
        field('balance', u64(balance)),
        field('base', ticker('BTC', 'exchanges')),
        field('heartbeat', xdr.ScVal.scvU32(60)),
        field('owner', new Address(owner).toScVal()),
        field('quote', ticker('USD', 'forex')),
        field('status', xdr.ScVal.scvU32(0)),
        field('threshold', xdr.ScVal.scvU32(50)),
        field('updated', u64(updated)),
        field('webhook', xdr.ScVal.scvBytes(Buffer.from('encrypted-webhook')))
    ])
}

/**
 * @param {bigint} id - subscription id
 * @param {{balance: bigint, updated: bigint}} state - subscription state
 * @returns {object} a stored subscription as the shared getSubscriptions returns it
 */
function stored(id, state) {
    return {id, ...scValToNative(subscriptionScVal(state))}
}

/**
 * @param {number} ledger - ledger the event was published in
 * @param {string} kind - lifecycle topic
 * @param {xdr.ScVal} value - event data
 * @returns {object} the event as the getEvents JSON-RPC result carries it
 */
function rawEvent(ledger, kind, value) {
    return {
        type: 'contract',
        ledger,
        ledgerClosedAt: '2026-09-01T00:00:00Z',
        contractId: '',
        id: `${ledger}-${kind}`,
        pagingToken: `${ledger}-${kind}`,
        inSuccessfulContractCall: true,
        txHash: '00'.repeat(32),
        topic: [sym('reflector'), sym('triggers'), sym(kind), new Address(owner).toScVal()].map(topic => topic.toXDR('base64')),
        value: value.toXDR('base64')
    }
}

/**
 * Point the stubbed loaders at a chain state
 * @param {object[]} snapshot - stored subscriptions, null where an id was removed
 */
function chainState(snapshot) {
    mockLoaders.state.mockResolvedValue({lastSubscriptionId: BigInt(snapshot.length)})
    mockLoaders.list.mockResolvedValue(snapshot)
}

/**
 * @returns {SubscriptionContractManager}
 */
function newManager() {
    const manager = new SubscriptionContractManager(contractId)
    manager.network = 'pubnet'
    return manager
}

let manager

beforeEach(() => {
    jest.clearAllMocks()
    mockLoaders.state.mockReset()
    mockLoaders.list.mockReset()
    mockRpc.oldest = 1000
    mockRpc.latest = 2000
    mockRpc.events = []
    mockRpc.requests = []
    mockRpc.failedPageReads = 0
    manager = null
})

afterEach(() => {
    manager?.stop()
    jest.clearAllTimers()
})

/**
 * @param {number} ledger - ledger the event was published in
 * @param {bigint} id - subscription id
 * @returns {object} a `cancelled` event
 */
function cancelledAt(ledger, id) {
    return rawEvent(ledger, 'cancelled', u64(id))
}

/**
 * @param {number} ledger - ledger the event was published in
 * @param {bigint} id - subscription id
 * @param {bigint} charge - amount deducted
 * @param {bigint} now - charge time
 * @returns {object} a `charged` event
 */
function chargedAt(ledger, id, charge, now) {
    return rawEvent(ledger, 'charged', xdr.ScVal.scvVec([u64(id), u64(charge), u64(now)]))
}

describe('a failed initial load is retried until it succeeds', () => {
    test('each failure is logged with the next delay, the delay doubles, and events are read once the load succeeds', async () => {
        mockLoaders.state
            .mockRejectedValueOnce(new Error('rpc unavailable'))
            .mockRejectedValueOnce(new Error('rpc unavailable'))
        chainState([stored(1n, {balance: 100n, updated: created})])
        manager = newManager()

        await manager.start()
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenLastCalledWith('Loading subscriptions of contract CSUB failed (attempt 1), retrying in 5s: rpc unavailable')

        await jest.advanceTimersByTimeAsync(4999)
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(1)
        expect(mockLoaders.state).toHaveBeenCalledTimes(2)
        expect(logger.error).toHaveBeenLastCalledWith('Loading subscriptions of contract CSUB failed (attempt 2), retrying in 10s: rpc unavailable')
        expect(manager.getSubscriptionById('1')).toBeUndefined()
        expect(manager.__lastLedger).toBeNull()
        expect(mockRpc.requests).toEqual([])

        await jest.advanceTimersByTimeAsync(9999)
        expect(mockLoaders.state).toHaveBeenCalledTimes(2)
        await jest.advanceTimersByTimeAsync(1)
        expect(mockLoaders.state).toHaveBeenCalledTimes(3)
        expect(logger.error).toHaveBeenCalledTimes(2)
        expect(logger.info).toHaveBeenCalledWith('Loaded subscriptions of contract CSUB after 3 attempts')
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '100'})
        //the event loop starts only now, from the ledger read before the snapshot
        expect(mockRpc.requests).toEqual([{startLedger: 2000, limit: 100}])
        expect(manager.__lastLedger).toBe(2000)
    })

    test('the first read starts at the ledger read before the snapshot, so an event during a slow load is applied', async () => {
        //the chain moves on while the snapshot loads: 1 is cancelled in ledger 2010, after the snapshot read it
        mockLoaders.state.mockImplementationOnce(() => {
            mockRpc.latest = 2030
            mockRpc.events = [cancelledAt(2010, 1n)]
            return Promise.resolve({lastSubscriptionId: 2n})
        })
        mockLoaders.list.mockResolvedValue([stored(1n, {balance: 100n, updated: created}), stored(2n, {balance: 200n, updated: created})])
        manager = newManager()

        await manager.start()

        expect(mockRpc.requests).toEqual([{startLedger: 2000, limit: 100}])
        expect(manager.getSubscriptionById('1')).toBeUndefined()
        expect(manager.getSubscriptionById('2')).toMatchObject({balance: '200'})
        expect(manager.__lastLedger).toBe(2030)
    })

    test('the delay stops growing at five minutes', async () => {
        mockLoaders.state.mockRejectedValue(new Error('rpc unavailable'))
        manager = newManager()

        await manager.start()
        const delays = []
        for (let attempt = 1; attempt <= 8; attempt++) {
            const [message] = logger.error.mock.calls[attempt - 1]
            const seconds = Number(/retrying in (\d+)s/.exec(message)[1])
            delays.push(seconds)
            await jest.advanceTimersByTimeAsync(seconds * 1000)
        }
        expect(delays).toEqual([5, 10, 20, 40, 80, 160, 300, 300])
        expect(mockLoaders.state).toHaveBeenCalledTimes(9)
    })

    test('a manager stopped during the backoff makes no further attempt', async () => {
        mockLoaders.state.mockRejectedValue(new Error('rpc unavailable'))
        manager = newManager()

        await manager.start()
        manager.stop()
        await jest.advanceTimersByTimeAsync(10 * minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(jest.getTimerCount()).toBe(0)
    })

    test.each([
        ['fails', deferred => deferred.reject(new Error('rpc unavailable'))],
        ['succeeds', deferred => deferred.resolve({lastSubscriptionId: 0n})]
    ])('a manager stopped while its load is in flight neither retries nor reads events when the load %s', async (_, settle) => {
        const deferred = {}
        mockLoaders.state.mockReturnValueOnce(new Promise((resolve, reject) => Object.assign(deferred, {resolve, reject})))
        mockLoaders.list.mockResolvedValue([])
        manager = newManager()

        const started = manager.start()
        manager.stop()
        settle(deferred)
        await started
        await jest.advanceTimersByTimeAsync(10 * minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(mockRpc.requests).toEqual([])
        expect(jest.getTimerCount()).toBe(0)
    })
})

describe('a cursor the RPC no longer holds events for reloads chain state', () => {
    /**
     * Start a manager over two subscriptions, read one window of events, then move the RPC forward past its
     * retention: while the orchestrator was cut off, 1 was charged, 2 cancelled and 3 created. The snapshot taken
     * after the outage holds all three, and the charge was published in ledger 200000, the latest one when the
     * snapshot is taken, so the read after the reload replays it over a snapshot that already holds it
     * @returns {Promise<void>}
     */
    async function afterLongOutage() {
        chainState([stored(1n, {balance: 100n, updated: created}), stored(2n, {balance: 200n, updated: created})])
        manager = newManager()
        await manager.start()
        expect(manager.__lastLedger).toBe(2000)

        mockRpc.oldest = 100000
        mockRpc.latest = 200000
        mockRpc.events = [chargedAt(200000, 1n, 2n, chargedOn)]
        chainState([stored(1n, {balance: 98n, updated: chargedOn}), null, stored(3n, {balance: 700n, updated: chargedOn})])
        mockRpc.requests = []
        jest.clearAllMocks()
    }

    test('the refused read reloads the subscriptions and resumes from the snapshot ledger without charging twice', async () => {
        await afterLongOutage()

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockRpc.requests).toEqual([
            {startLedger: 2000, limit: 100}, //refused: 2000 is older than the oldest ledger held
            {startLedger: 200000, limit: 1}, //reads the oldest ledger the RPC holds
            {startLedger: 200000, limit: 100} //after the reload, from the ledger read before the snapshot
        ])
        expect(logger.warn).toHaveBeenCalledWith('Ledger 2000 is outside the event retention of the RPC (oldest ledger 100000), reloading the subscriptions of contract CSUB from chain state')
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '98', updated: '1700086400000'})
        expect(manager.getSubscriptionById('2')).toBeUndefined()
        expect(manager.getSubscriptionById('3')).toMatchObject({balance: '700'})
        expect(manager.__lastLedger).toBe(200000)
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Error processing events'))

        //the next round reads on from the new cursor and reloads nothing
        mockRpc.requests = []
        await jest.advanceTimersByTimeAsync(minuteMs)
        expect(mockRpc.requests).toEqual([{startLedger: 200000, limit: 100}])
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '98'})
    })

    test('the refused read that triggers the reload is not logged as an error', async () => {
        await afterLongOutage()

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(1) //the reload ran
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('a read refused for another reason still logs the underlying error', async () => {
        chainState([stored(1n, {balance: 100n, updated: created})])
        manager = newManager()
        await manager.start()
        jest.clearAllMocks()
        mockRpc.failedPageReads = 1

        await jest.advanceTimersByTimeAsync(minuteMs)

        const logged = logger.error.mock.calls.map(([entry]) => entry)
        expect(logged.some(entry => /internal error/.test(entry?.message))).toBe(true)
    })

    test('reads that keep failing after a reload do not skip an event published just after the snapshot', async () => {
        await afterLongOutage()
        //1 is cancelled five ledgers after the snapshot; then the RPC fails every page read for seventeen rounds - the
        //read that follows the reload and sixteen more - while the chain moves on twelve ledgers a round
        mockRpc.events.push(cancelledAt(200005, 1n))
        mockRpc.failedPageReads = 17

        for (let round = 1; round <= 17; round++) {
            await jest.advanceTimersByTimeAsync(minuteMs)
            mockRpc.latest += 12
        }
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '98'})
        expect(mockRpc.latest).toBe(200204)

        mockRpc.requests = []
        await jest.advanceTimersByTimeAsync(minuteMs)

        //the cancellation is applied first of all: a read from latest-180 (200024) would have passed it by
        expect(manager.getSubscriptionById('1')).toBeUndefined()
        expect(mockRpc.requests).toEqual([{startLedger: 200000, limit: 100}])
        expect(manager.getSubscriptionById('3')).toMatchObject({balance: '700'})
        expect(manager.__lastLedger).toBe(200204)
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
    })

    test('a read refused for another reason keeps the cursor and the cache, and reloads nothing', async () => {
        chainState([stored(1n, {balance: 100n, updated: created})])
        manager = newManager()
        await manager.start()
        mockRpc.requests = []
        jest.clearAllMocks()
        mockRpc.failedPageReads = 1

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockRpc.requests).toEqual([{startLedger: 2000, limit: 100}, {startLedger: 2000, limit: 1}])
        expect(mockLoaders.state).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenLastCalledWith('Error processing events: Failed to make request. See logs for details.')
        expect(manager.__lastLedger).toBe(2000)
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '100'})

        mockRpc.requests = []
        await jest.advanceTimersByTimeAsync(minuteMs)
        expect(mockRpc.requests).toEqual([{startLedger: 2000, limit: 100}])
    })

    test('a reload that fails keeps the old cache and cursor, and is tried once more on the next round only', async () => {
        await afterLongOutage()
        mockLoaders.state.mockRejectedValueOnce(new Error('rpc unavailable'))

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenLastCalledWith('Error processing events: rpc unavailable')
        expect(manager.getSubscriptionById('2')).toMatchObject({balance: '200'})
        expect(manager.__lastLedger).toBe(2000)

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(2)
        expect(manager.getSubscriptionById('2')).toBeUndefined()
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '98'})
        expect(manager.__lastLedger).toBe(200000)
    })

    test('an RPC that keeps less than fifteen minutes of events recovers after the reload', async () => {
        await afterLongOutage()
        //retention of 100 ledgers, well under the 180 a read from latest-180 would need
        mockRpc.oldest = 199900

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockRpc.requests).toEqual([
            {startLedger: 2000, limit: 100},
            {startLedger: 200000, limit: 1},
            {startLedger: 200000, limit: 100}
        ])
        expect(manager.__lastLedger).toBe(200000)
        //the refused read from 2000 is reported by the request helper; no round ends in an error
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Error processing events'))

        //the chain moves on inside the short retention; the next round reads from the cursor and applies what it finds
        mockRpc.latest = 200060
        mockRpc.oldest = 199960
        mockRpc.events.push(cancelledAt(200030, 3n))
        mockRpc.requests = []
        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockRpc.requests).toEqual([{startLedger: 200000, limit: 100}])
        expect(manager.getSubscriptionById('3')).toBeUndefined()
        expect(manager.getSubscriptionById('1')).toMatchObject({balance: '98'})
        expect(manager.__lastLedger).toBe(200060)
        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(logger.error).not.toHaveBeenCalledWith(expect.stringContaining('Error processing events'))
    })

    test('a snapshot that takes longer than the retention is reloaded on the next round, never twice in one', async () => {
        await afterLongOutage()
        //the first reload is so slow that the ledger read before it has left the retention when it finishes
        mockLoaders.state.mockImplementationOnce(() => {
            mockRpc.oldest = 200100
            mockRpc.latest = 200300
            return Promise.resolve({lastSubscriptionId: 3n})
        })

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(1)
        expect(logger.error).toHaveBeenLastCalledWith('Error processing events: Ledger 200000 is outside the event retention of the RPC (oldest ledger 200100)')
        expect(manager.__lastLedger).toBe(200000)

        await jest.advanceTimersByTimeAsync(minuteMs)

        expect(mockLoaders.state).toHaveBeenCalledTimes(2)
        expect(manager.__lastLedger).toBe(200300)
        expect(mockRpc.requests.slice(-1)).toEqual([{startLedger: 200300, limit: 100}])
    })
})

describe('makeServerRequest keeps logging at error for callers that expect no refusal', () => {
    const {makeServerRequest} = require('../utils/request-helper')
    const refusals = urls => urls.map(url => new Error(`refused by ${url}`))

    test('without quiet every per-url error is logged at error, and all of them travel as the cause', async () => {
        const errors = refusals(['http://a.example', 'http://b.example'])
        let call = 0
        const request = makeServerRequest(['http://a.example', 'http://b.example'], url => url, () => Promise.reject(errors[call++]))

        const thrown = await request.catch(err => err)

        expect(thrown.message).toBe('Failed to make request. See logs for details.')
        expect(thrown.cause).toEqual(errors)
        expect(logger.error.mock.calls).toEqual([[errors[0]], [errors[1]]])
    })

    test('with quiet nothing is logged at error, and the errors still travel as the cause', async () => {
        const errors = refusals(['http://a.example'])
        const thrown = await makeServerRequest(['http://a.example'], url => url, () => Promise.reject(errors[0]), {quiet: true})
            .catch(err => err)

        expect(thrown.cause).toEqual(errors)
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.debug).toHaveBeenCalledWith('Request to http://a.example failed. Error: refused by http://a.example')
    })
})
