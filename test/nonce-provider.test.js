/*eslint-disable no-undef */
//an in-memory stand-in for the Nonces collection, including the unique-index behaviour tryConsume relies on
jest.mock('../persistence-layer/models/nonce', () => {
    const docs = new Map()
    const indexes = []
    const calls = []
    return {
        __docs: docs,
        __indexes: indexes,
        __calls: calls,
        __buildError: null,
        init() {
            calls.push('init')
            return this.__buildError ? Promise.reject(this.__buildError) : Promise.resolve()
        },
        createIndexes() {
            calls.push('createIndexes')
            return Promise.resolve()
        },
        collection: {
            collectionName: 'nonces',
            indexes() {
                calls.push('indexes')
                return Promise.resolve([...indexes])
            }
        },
        findOne: (query) => ({
            exec: () => {
                const doc = docs.get(query.pubkey)
                return Promise.resolve(doc ? {toPlainObject: () => ({...doc})} : null)
            }
        }),
        findOneAndUpdate: (query, update) => ({
            exec: () => {
                const doc = docs.get(query.pubkey)
                const required = query.nonce && query.nonce.$lt
                if (doc) {
                    if (required !== undefined && !(doc.nonce < required)) {
                        const error = new Error('E11000 duplicate key error collection: nonces index: pubkey_1')
                        error.code = 11000
                        return Promise.reject(error)
                    }
                    Object.assign(doc, update.$set)
                    return Promise.resolve({toPlainObject: () => ({...doc})})
                }
                const created = {pubkey: query.pubkey, nonce: 0, ...(update.$setOnInsert || {}), ...update.$set}
                docs.set(query.pubkey, created)
                return Promise.resolve({toPlainObject: () => ({...created})})
            }
        })
    }
})

const NonceModel = require('../persistence-layer/models/nonce')
const nonceProvider = require('../domain/nonce-provider')

const uniquePubkeyIndex = {name: 'pubkey_1', key: {pubkey: 1}, unique: true}

/**
 * Replace the collection's index list, standing in for whatever the deployed database actually carries
 * @param {object[]} indexes - index descriptions as the driver reports them
 * @returns {void}
 */
function withIndexes(indexes) {
    NonceModel.__indexes.splice(0, NonceModel.__indexes.length, {name: '_id_', key: {_id: 1}}, ...indexes)
}

beforeEach(() => {
    NonceModel.__docs.clear()
    NonceModel.__calls.length = 0
    NonceModel.__buildError = null
    withIndexes([uniquePubkeyIndex])
})

describe('nonceProvider.init', () => {
    test('accepts a collection carrying the unique index', async () => {
        await expect(nonceProvider.init()).resolves.toBeUndefined()
    })

    test('builds the schema indexes before reading them, so an empty database can boot', async () => {
        //the automatic build is awaited first, the explicit one covers autoIndex being off, and only then is the list read
        await nonceProvider.init()
        expect(NonceModel.__calls).toEqual(['init', 'createIndexes', 'indexes'])
    })

    test('duplicate pubkeys refuse the start with a message saying to remove them', async () => {
        const error = new Error('E11000 duplicate key error collection: db.nonces index: pubkey_1 dup key: { pubkey: "GA" }')
        error.code = 11000
        NonceModel.__buildError = error
        await expect(nonceProvider.init()).rejects.toThrow('Replay protection is unavailable: collection \'nonces\' '
            + 'holds more than one document for the same pubkey, so the unique index \'pubkey_1\' cannot be built. '
            + 'Remove the duplicates, keeping one document per pubkey, then start the orchestrator again. Nothing was deleted.')
        expect(NonceModel.__calls).toEqual(['init'])
    })

    test('a conflicting index refuses the start, naming the index found and the remedy', async () => {
        const error = new Error('An existing index has the same name as the requested index but different options')
        error.code = 86
        NonceModel.__buildError = error
        withIndexes([{name: 'pubkey_1', key: {pubkey: 1}, unique: true, sparse: true}, {name: 'nonce_1', key: {nonce: 1}}])
        await expect(nonceProvider.init()).rejects.toThrow('Replay protection is unavailable: collection \'nonces\' '
            + 'already has \'pubkey_1\' on {"pubkey":1} (unique, sparse), which conflicts with the schema index '
            + '\'pubkey_1\' (unique, non-sparse). Drop it so the orchestrator can build \'pubkey_1\', then start it again. '
            + 'Nothing was dropped. (An existing index has the same name as the requested index but different options)')
    })

    test('a conflict reported by code name alone is treated the same way', async () => {
        const error = new Error('Index already exists with a different name: pubkey_unique')
        error.codeName = 'IndexOptionsConflict'
        NonceModel.__buildError = error
        withIndexes([{name: 'pubkey_unique', key: {pubkey: 1}, unique: true}])
        await expect(nonceProvider.init()).rejects.toThrow('already has \'pubkey_unique\' on {"pubkey":1} (unique), '
            + 'which conflicts with the schema index \'pubkey_1\' (unique, non-sparse). Drop it')
    })

    test('any other index build failure refuses the start and keeps the cause', async () => {
        const error = new Error('not authorized on orchestrator to execute command { createIndexes: "nonces" }')
        error.code = 13
        NonceModel.__buildError = error
        await expect(nonceProvider.init()).rejects.toThrow('Replay protection is unavailable: building the unique index '
            + '\'pubkey_1\' on collection \'nonces\' failed: not authorized on orchestrator to execute command '
            + '{ createIndexes: "nonces" }')
    })

    test('refuses to start when the index is missing, naming the collection and the index', async () => {
        //tryConsume relies on the unique index rejecting a duplicate insert
        withIndexes([])
        await expect(nonceProvider.init()).rejects.toThrow(/nonces/)
        await expect(nonceProvider.init()).rejects.toThrow(/pubkey_1/)
    })

    test('refuses to start when the index on pubkey is not unique', async () => {
        withIndexes([{name: 'pubkey_1', key: {pubkey: 1}}])
        await expect(nonceProvider.init()).rejects.toThrow(/unique/)
    })

    test('refuses to start when pubkey is only part of a compound unique index', async () => {
        //uniqueness across {pubkey, nonce} would let every distinct nonce insert its own document
        withIndexes([{name: 'pubkey_1_nonce_1', key: {pubkey: 1, nonce: 1}, unique: true}])
        await expect(nonceProvider.init()).rejects.toThrow(/pubkey_1/)
    })
})

describe('nonceProvider.tryConsume', () => {
    test('the first nonce for a pubkey is consumed', async () => {
        expect(await nonceProvider.tryConsume('GA1', 10)).toBe(true)
        expect(NonceModel.__docs.get('GA1').nonce).toBe(10)
    })

    test('two concurrent requests with the same nonce consume it once', async () => {
        const [first, second] = await Promise.all([
            nonceProvider.tryConsume('GA2', 5),
            nonceProvider.tryConsume('GA2', 5)
        ])
        expect([first, second].filter(Boolean)).toHaveLength(1)
        expect(NonceModel.__docs.get('GA2').nonce).toBe(5)
    })

    test('a lower nonce is refused and does not move the counter back', async () => {
        expect(await nonceProvider.tryConsume('GA3', 20)).toBe(true)
        expect(await nonceProvider.tryConsume('GA3', 19)).toBe(false)
        expect(NonceModel.__docs.get('GA3').nonce).toBe(20)
    })

    test('only the atomic consume is exported', () => {
        //read-then-write is the race tryConsume replaced; leaving it exported keeps the footgun within reach
        expect(nonceProvider.update).toBeUndefined()
    })

    test('the envelope-signature namespace is independent of the request namespace', async () => {
        await nonceProvider.tryConsume('GA4', 100)
        expect(await nonceProvider.getSignatureNonce('GA4')).toBe(0)
        await nonceProvider.updateSignatureNonce('GA4', 7)
        expect(await nonceProvider.getSignatureNonce('GA4')).toBe(7)
        expect(NonceModel.__docs.get('GA4').nonce).toBe(100)
    })
})
