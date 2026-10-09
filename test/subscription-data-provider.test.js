/*eslint-disable no-undef */
jest.mock('../domain/container', () => ({
    appConfig: {getNetworkConfig: () => ({urls: ['http://rpc.example.com']})}
}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))
jest.mock('../utils/rpc-helper', () => ({
    getSubscriptionEvents: jest.fn(),
    loadSubscriptions: jest.fn(),
    loadSubscription: jest.fn(),
    getLatestLedgerSequence: jest.fn(() => Promise.resolve(5)),
    EventsOutOfRangeError: jest.requireActual('../utils/rpc-helper').EventsOutOfRangeError
}))

//the sdk is real: the events are encoded as the contract publishes them and decoded by the provider's own
//scValToNative call, so the id type the cache sees is the one the RPC delivers, not one a fixture assumes
const {xdr, nativeToScVal, scValToNative, Keypair, Address} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const {getSubscriptionEvents, loadSubscriptions, loadSubscription} = require('../utils/rpc-helper')
const {SubscriptionContractManager} = require('../domain/subscription-data-provider')

const contractId = 'CSUB'
const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey()

//2^53 + 1: a balance a double cannot hold, so a deduction that goes through Number lands on the wrong value
const bigBalance = 9007199254740993n
const created = 1700000000000n
const day = 86400000n
const chargedAt = created + day

const sym = value => xdr.ScVal.scvSymbol(value)
const u64 = value => nativeToScVal(value, {type: 'u64'})
const field = (key, val) => new xdr.ScMapEntry({key: sym(key), val})

/**
 * @param {string} asset - asset code
 * @param {string} source - price source
 * @returns {xdr.ScVal} the contract's `TickerAsset` struct
 */
function tickerScVal(asset, source) {
    return xdr.ScVal.scvMap([field('asset', xdr.ScVal.scvString(asset)), field('source', xdr.ScVal.scvString(source))])
}

/**
 * @param {{balance: bigint, updated: bigint, status: number}} state - mutable subscription fields, status defaulting to active
 * @returns {xdr.ScVal} the contract's `Subscription` struct, fields in key order as soroban encodes it
 */
function subscriptionScVal({balance, updated, status = 0}) {
    return xdr.ScVal.scvMap([
        field('balance', u64(balance)),
        field('base', tickerScVal('BTC', 'exchanges')),
        field('heartbeat', xdr.ScVal.scvU32(60)),
        field('owner', new Address(owner).toScVal()),
        field('quote', tickerScVal('USD', 'forex')),
        field('status', xdr.ScVal.scvU32(status)),
        field('threshold', xdr.ScVal.scvU32(50)),
        field('updated', u64(updated)),
        field('webhook', xdr.ScVal.scvBytes(Buffer.from('encrypted-webhook')))
    ])
}

/**
 * @param {bigint} id - subscription id
 * @param {{balance: bigint, updated: bigint, status: number}} state - subscription state, status defaulting to active
 * @returns {object} a stored subscription as the shared getSubscriptions/getSubscriptionById return it
 */
function storedSubscription(id, state) {
    return {id, ...scValToNative(subscriptionScVal(state))}
}

/**
 * @param {string} kind - lifecycle topic
 * @param {xdr.ScVal} value - event data
 * @param {boolean} legacy - topics of the contract before its standardised events: (reflector, kind, owner)
 * @returns {{topic: xdr.ScVal[], value: xdr.ScVal}} raw event as rpc.Server.getEvents returns it
 */
function ownerEvent(kind, value, legacy = false) {
    const ownerTopic = new Address(owner).toScVal()
    const topic = legacy
        ? [sym('reflector'), sym(kind), ownerTopic]
        : [sym('reflector'), sym('triggers'), sym(kind), ownerTopic]
    return {topic, value}
}

//the event data each contract function publishes (reflector-subscription-contract/src/lib.rs)
const events = {
    created: (id, state, legacy) => ownerEvent('created', xdr.ScVal.scvVec([u64(id), subscriptionScVal(state)]), legacy),
    deposited: (id, state, amount, legacy) =>
        ownerEvent('deposited', xdr.ScVal.scvVec([u64(id), subscriptionScVal(state), u64(amount)]), legacy),
    charged: (id, charge, now, legacy) => ownerEvent('charged', xdr.ScVal.scvVec([u64(id), u64(charge), u64(now)]), legacy),
    suspended: (id, now, legacy) => ownerEvent('suspended', xdr.ScVal.scvVec([u64(id), u64(now)]), legacy),
    //the only bare value: `cancel` publishes the u64 id on its own
    cancelled: (id, legacy) => ownerEvent('cancelled', u64(id), legacy),
    triggered: now => ({
        topic: [sym('reflector'), sym('triggers'), sym('triggered')],
        value: xdr.ScVal.scvVec([u64(now), xdr.ScVal.scvBytes(Buffer.alloc(32, 1))])
    }),
    updated: fee => ({topic: [sym('reflector'), sym('triggers'), sym('updated'), sym('fee')], value: u64(fee)})
}

/**
 * @param {object[]} snapshot - stored subscriptions the contract holds, null where an id was removed
 * @returns {Promise<SubscriptionContractManager>} a manager that loaded the snapshot and does not re-arm its timer
 */
async function startManager(snapshot) {
    loadSubscriptions.mockResolvedValueOnce(snapshot)
    const instance = new SubscriptionContractManager(contractId)
    instance.network = 'pubnet'
    await instance.__loadSubscriptionsData()
    return instance
}

/**
 * @param {SubscriptionContractManager} instance - manager
 * @param {object[]} page - raw events
 * @returns {Promise<void>}
 */
async function feed(instance, page) {
    getSubscriptionEvents.mockResolvedValueOnce({events: page, lastLedger: 5})
    await instance.__processLastEvents()
}

/**
 * @param {SubscriptionContractManager} instance - manager
 * @returns {object} a deep copy of the cache, keyed as the map keys it
 */
function cacheOf(instance) {
    return structuredClone(Object.fromEntries(instance.__subscriptions))
}

beforeEach(() => {
    jest.clearAllMocks()
    getSubscriptionEvents.mockReset()
    loadSubscriptions.mockReset()
    loadSubscription.mockReset()
})

describe('subscription lifecycle events', () => {
    test('the RPC delivers ids as bigints while the cache is keyed by their string form', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])

        expect(scValToNative(events.cancelled(11n).value)).toBe(11n)
        expect([...instance.__subscriptions.keys()]).toEqual(['11'])
    })

    test.each([['current', false], ['legacy', true]])('%s topics: a cancelled event removes the subscription', async (_, legacy) => {
        const instance = await startManager([
            storedSubscription(11n, {balance: 100n, updated: created}),
            storedSubscription(12n, {balance: 200n, updated: created})
        ])

        await feed(instance, [events.cancelled(11n, legacy)])

        expect(instance.getSubscriptionById('11')).toBeUndefined()
        expect(instance.getSubscriptionById('12').balance).toBe('200')
        expect(logger.error).not.toHaveBeenCalled()
    })

    test.each([['current', false], ['legacy', true]])('%s topics: a charged event deducts the charge and moves updated to the charge time', async (_, legacy) => {
        const instance = await startManager([storedSubscription(11n, {balance: bigBalance, updated: created})])

        await feed(instance, [events.charged(11n, 2n, chargedAt, legacy)])

        expect(instance.getSubscriptionById('11')).toMatchObject({
            balance: '9007199254740991',
            updated: '1700086400000',
            lastCharge: 1700086400000,
            status: 0
        })
    })

    test('a suspended event marks the subscription suspended and keeps it, as the contract keeps it', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 3n, updated: created})])

        await feed(instance, [events.charged(11n, 3n, chargedAt), events.suspended(11n, chargedAt)])

        expect(instance.getSubscriptionById('11')).toMatchObject({status: 1, balance: '0', updated: '1700086400000'})
        expect(instance.getSubscriptions(owner).map(s => s.id)).toEqual(['11'])
    })

    test('created and deposited store the state the event carries, and a deposit revives a suspended subscription', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 0n, updated: chargedAt, status: 1})])

        await feed(instance, [
            events.created(13n, {balance: 700n, updated: chargedAt}),
            events.deposited(11n, {balance: 300n, updated: chargedAt}, 400n)
        ])

        expect(instance.getSubscriptionById('13')).toEqual({
            id: '13',
            base: {asset: 'BTC', source: 'exchanges'},
            quote: {asset: 'USD', source: 'forex'},
            balance: '700',
            status: 0,
            updated: '1700086400000',
            lastCharge: 1700086400000,
            owner,
            threshold: 50,
            webhook: Buffer.from('encrypted-webhook').toString('base64'),
            heartbeat: 60
        })
        expect(instance.getSubscriptionById('11')).toMatchObject({status: 0, balance: '300'})
    })

    test('triggered and updated events leave the cache as it was and are not reported as unknown', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])
        const before = cacheOf(instance)

        await feed(instance, [events.triggered(chargedAt), events.updated(5n)])

        expect(cacheOf(instance)).toEqual(before)
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('an unknown topic is reported and the rest of the page still applies', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])

        await feed(instance, [ownerEvent('renamed', u64(11n)), events.cancelled(11n)])

        expect(logger.error).toHaveBeenCalledWith('Unknown event type: renamed')
        expect(instance.getSubscriptionById('11')).toBeUndefined()
    })

    test('a value that carries no u64 id is reported rather than keyed as a string of it', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])
        const before = cacheOf(instance)

        await feed(instance, [ownerEvent('charged', xdr.ScVal.scvVoid()), ownerEvent('suspended', xdr.ScVal.scvVec([]))])

        expect(logger.error).toHaveBeenCalledTimes(2)
        expect(loadSubscription).not.toHaveBeenCalled()
        expect(cacheOf(instance)).toEqual(before)
    })
})

describe('replay and order', () => {
    //state before the page: 11 and 12 active, 14 suspended, 15 active with less than a day's fee left
    const before = () => [
        storedSubscription(11n, {balance: bigBalance, updated: created}),
        storedSubscription(12n, {balance: 1000n, updated: created}),
        null, //13 is created in the page
        storedSubscription(14n, {balance: 5n, updated: created, status: 1}),
        storedSubscription(15n, {balance: 3n, updated: created})
    ]
    //one charge run, a creation, a cancellation and a revival, in ledger order
    const page = () => [
        events.charged(11n, 2n, chargedAt),
        events.charged(15n, 3n, chargedAt),
        events.suspended(15n, chargedAt),
        events.created(13n, {balance: 700n, updated: chargedAt}),
        events.cancelled(12n),
        events.deposited(14n, {balance: 305n, updated: created}, 400n)
    ]
    //what the contract holds once the page has happened
    const after = () => [
        storedSubscription(11n, {balance: 9007199254740991n, updated: chargedAt}),
        null,
        storedSubscription(13n, {balance: 700n, updated: chargedAt}),
        storedSubscription(14n, {balance: 305n, updated: created}),
        storedSubscription(15n, {balance: 0n, updated: chargedAt, status: 1})
    ]

    test('applying a page leaves the cache as a snapshot of the contract taken afterwards', async () => {
        const live = await startManager(before())
        await feed(live, page())

        const reloaded = await startManager(after())

        expect(cacheOf(live)).toEqual(cacheOf(reloaded))
    })

    test('the same page applied twice leaves the cache as applying it once', async () => {
        const once = await startManager(before())
        await feed(once, page())
        const twice = await startManager(before())
        await feed(twice, page())
        await feed(twice, page())

        expect(cacheOf(twice)).toEqual(cacheOf(once))
        expect(twice.getSubscriptionById('11').balance).toBe('9007199254740991')
    })

    test('a page re-read from its last ledger, the boundary event delivered again, changes nothing', async () => {
        const once = await startManager(before())
        await feed(once, page())
        const reread = await startManager(before())
        await feed(reread, page().slice(0, 2))
        await feed(reread, page().slice(1)) //getEvents starts at the previous latestLedger, inclusive

        expect(cacheOf(reread)).toEqual(cacheOf(once))
    })

    test('a restart replays the page over a snapshot that already includes it and still matches the contract', async () => {
        const restarted = await startManager(after())
        await feed(restarted, page())

        const reloaded = await startManager(after())

        expect(cacheOf(restarted)).toEqual(cacheOf(reloaded))
        expect(loadSubscription).not.toHaveBeenCalled()
    })
})

describe('events for a subscription the cache has never seen', () => {
    test('a cancelled event for an unknown id changes nothing and loads nothing', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])
        const before = cacheOf(instance)

        await feed(instance, [events.cancelled(99n)])

        expect(cacheOf(instance)).toEqual(before)
        expect(loadSubscription).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('a deposited event for an unknown id adds the state it carries', async () => {
        const instance = await startManager([])

        await feed(instance, [events.deposited(20n, {balance: 450n, updated: created}, 50n)])

        expect(instance.getSubscriptionById('20')).toMatchObject({id: '20', balance: '450', status: 0})
        expect(loadSubscription).not.toHaveBeenCalled()
    })

    test('a charged event for an unknown id loads the stored subscription instead of dropping the event', async () => {
        const instance = await startManager([])
        loadSubscription.mockResolvedValueOnce(storedSubscription(16n, {balance: 998n, updated: chargedAt}))

        await feed(instance, [events.charged(16n, 2n, chargedAt)])

        expect(loadSubscription).toHaveBeenCalledWith(contractId, '16', ['http://rpc.example.com'])
        //the stored state already includes this charge, so it is not deducted a second time
        expect(instance.getSubscriptionById('16')).toMatchObject({balance: '998', updated: '1700086400000'})
    })

    test('a suspended event for an unknown id takes the stored state, which a later deposit may already have revived', async () => {
        const instance = await startManager([])
        loadSubscription.mockResolvedValueOnce(storedSubscription(16n, {balance: 400n, updated: chargedAt}))

        await feed(instance, [events.suspended(16n, chargedAt)])

        expect(instance.getSubscriptionById('16')).toMatchObject({status: 0, balance: '400'})
    })

    test('an id the contract no longer holds is not added', async () => {
        const instance = await startManager([])
        loadSubscription.mockResolvedValueOnce(null)

        await feed(instance, [events.charged(16n, 2n, chargedAt)])

        expect(instance.getSubscriptionById('16')).toBeUndefined()
        //a cancelled subscription is the expected answer here, not a failure to report
        expect(logger.error).not.toHaveBeenCalled()
    })

    test('a failed load is reported and the rest of the page still applies', async () => {
        const instance = await startManager([storedSubscription(11n, {balance: 100n, updated: created})])
        loadSubscription.mockRejectedValueOnce(new Error('rpc down'))

        await feed(instance, [events.charged(16n, 2n, chargedAt), events.cancelled(11n)])

        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(instance.getSubscriptionById('16')).toBeUndefined()
        expect(instance.getSubscriptionById('11')).toBeUndefined()
    })
})
