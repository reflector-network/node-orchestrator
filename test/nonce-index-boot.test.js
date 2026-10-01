/*eslint-disable no-undef */
//These tests need a real MongoDB on 127.0.0.1:27017, as config-manager.test.js does: what they pin is how the boot
//check behaves against a database that has no nonces collection yet, one that already carries the index, and one whose
//documents make the unique index impossible to build, none of which a mocked model can reproduce. Each test loads a
//fresh module graph, as a fresh process would, against its own database, and every database is dropped afterwards.
jest.mock('../logger', () => ({debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn(), trace: jest.fn()}))

const {MongoClient} = require('mongoose').mongo

const server = 'mongodb://127.0.0.1:27017/'
const databasePrefix = 'reflector-orchestrator-test-nonce-index-'
const used = new Set()

let client

/**
 * @param {string} name - scenario name
 * @returns {object} the driver database handle, a database reserved for the scenario, dropped before and after the file
 */
function database(name) {
    used.add(databasePrefix + name)
    return client.db(databasePrefix + name)
}

/**
 * Boot the nonce layer the way app.js does: the model is compiled when the provider is required, before connect()
 * @param {string} name - scenario name
 * @returns {Promise<{nonceProvider: object, disconnect: function}>}
 */
async function boot(name) {
    jest.resetModules()
    const nonceProvider = require('../domain/nonce-provider')
    const {connect, disconnect} = require('../persistence-layer')
    await connect(server + databasePrefix + name)
    return {nonceProvider, disconnect}
}

/**
 * @param {object} db - driver database handle
 * @returns {Promise<{collections: string[], indexes: object[], docs: object[]}>}
 */
async function snapshot(db) {
    const collections = (await db.listCollections().toArray()).map(c => c.name)
    if (!collections.includes('nonces'))
        return {collections, indexes: [], docs: []}
    const nonces = db.collection('nonces')
    return {
        collections,
        indexes: await nonces.indexes(),
        docs: await nonces.find().sort({_id: 1}).toArray()
    }
}

/**
 * @param {string} found - how the refusal describes the existing index
 * @returns {string} the refusal up to the server's own error text, which follows in parentheses
 */
function conflictMessage(found) {
    return `Replay protection is unavailable: collection 'nonces' already has ${found}, which conflicts with the schema `
        + 'index \'pubkey_1\' (unique, non-sparse). Drop it so the orchestrator can build \'pubkey_1\', then start it '
        + 'again. Nothing was dropped. ('
}

/**
 * @param {string} name - scenario name
 * @returns {Promise<Error|undefined>} what nonceProvider.init() rejected with
 */
async function bootAndInit(name) {
    const {nonceProvider, disconnect} = await boot(name)
    try {
        return await nonceProvider.init().then(() => undefined, e => e)
    } finally {
        await disconnect()
    }
}

beforeAll(async () => {
    client = await MongoClient.connect(server, {directConnection: true, serverSelectionTimeoutMS: 3000})
    for (const name of ['empty', 'healthy', 'duplicates', 'non-unique', 'other-name', 'sparse'])
        await database(name).dropDatabase()
})

afterAll(async () => {
    for (const name of used)
        await client.db(name).dropDatabase()
    await client.close()
})

describe('nonceProvider.init against MongoDB', () => {
    test('an empty database builds the unique index and boots', async () => {
        const db = database('empty')
        expect((await snapshot(db)).collections).toEqual([])

        const {nonceProvider, disconnect} = await boot('empty')
        try {
            await expect(nonceProvider.init()).resolves.toBeUndefined()

            const {indexes} = await snapshot(db)
            const pubkeyIndex = indexes.find(index => index.name === 'pubkey_1')
            expect(pubkeyIndex.key).toEqual({pubkey: 1})
            expect(pubkeyIndex.unique).toBe(true)
            //the index is what makes a replay fail, so prove the booted layer refuses one
            expect(await nonceProvider.tryConsume('GBOOT', 5)).toBe(true)
            expect(await nonceProvider.tryConsume('GBOOT', 5)).toBe(false)
            expect(await db.collection('nonces').countDocuments({pubkey: 'GBOOT'})).toBe(1)
        } finally {
            await disconnect()
        }
    })

    test('a database that already carries the index is left unchanged', async () => {
        const db = database('healthy')
        await db.collection('nonces').insertOne({pubkey: 'GKEEP', nonce: 42, signatureNonce: 3})
        await db.collection('nonces').createIndex({pubkey: 1}, {unique: true, background: true})
        const before = await snapshot(db)

        const {nonceProvider, disconnect} = await boot('healthy')
        try {
            await expect(nonceProvider.init()).resolves.toBeUndefined()
        } finally {
            await disconnect()
        }

        expect(await snapshot(db)).toEqual(before)
        expect(before.docs).toEqual([expect.objectContaining({pubkey: 'GKEEP', nonce: 42, signatureNonce: 3})])
    })

    test('duplicate pubkeys refuse the start with instructions and nothing is deleted', async () => {
        const db = database('duplicates')
        await db.collection('nonces').insertMany([
            {pubkey: 'GDUP', nonce: 5, signatureNonce: 0},
            {pubkey: 'GDUP', nonce: 9, signatureNonce: 0},
            {pubkey: 'GONE', nonce: 1, signatureNonce: 0}
        ])
        const before = await snapshot(db)

        const {nonceProvider, disconnect} = await boot('duplicates')
        let error
        try {
            error = await nonceProvider.init().catch(e => e)
        } finally {
            await disconnect()
        }

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toBe('Replay protection is unavailable: collection \'nonces\' holds more than one '
            + 'document for the same pubkey, so the unique index \'pubkey_1\' cannot be built. Remove the duplicates, '
            + 'keeping one document per pubkey, then start the orchestrator again. Nothing was deleted.')
        const after = await snapshot(db)
        expect(after).toEqual(before)
        expect(after.indexes.map(index => index.name)).toEqual(['_id_'])
    })

    test('a non-unique index on pubkey still refuses the start, naming it and the remedy', async () => {
        const db = database('non-unique')
        await db.collection('nonces').createIndex({pubkey: 1})
        const before = await snapshot(db)

        const error = await bootAndInit('non-unique')

        const expected = conflictMessage('\'pubkey_1\' on {"pubkey":1} (not unique)')
        expect(error).toBeInstanceOf(Error)
        expect(error.message.slice(0, expected.length)).toBe(expected)
        expect(error.message.endsWith(')')).toBe(true)
        expect(await snapshot(db)).toEqual(before)
    })

    test('a unique index on pubkey under another name refuses the start, naming it and the remedy', async () => {
        //an operator who followed the old refusal text could have built exactly this; boot never drops it by itself
        const db = database('other-name')
        await db.collection('nonces').createIndex({pubkey: 1}, {unique: true, name: 'pubkey_unique'})
        const before = await snapshot(db)

        const error = await bootAndInit('other-name')

        const expected = conflictMessage('\'pubkey_unique\' on {"pubkey":1} (unique)')
        expect(error).toBeInstanceOf(Error)
        expect(error.message.slice(0, expected.length)).toBe(expected)
        expect(await snapshot(db)).toEqual(before)
    })

    test('a sparse unique pubkey_1 refuses the start, naming it and the remedy', async () => {
        const db = database('sparse')
        await db.collection('nonces').createIndex({pubkey: 1}, {unique: true, sparse: true})
        const before = await snapshot(db)

        const error = await bootAndInit('sparse')

        const expected = conflictMessage('\'pubkey_1\' on {"pubkey":1} (unique, sparse)')
        expect(error).toBeInstanceOf(Error)
        expect(error.message.slice(0, expected.length)).toBe(expected)
        expect(await snapshot(db)).toEqual(before)
    })
})
