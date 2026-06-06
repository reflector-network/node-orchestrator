/*eslint-disable no-undef */
//drive the real pagination logic in horizon-helper against fake Horizon servers,
//with makeServerRequest mocked so no network calls happen.
jest.mock('../../domain/container', () => ({}))
jest.mock('../../logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn()
}))
jest.mock('../../utils/request-helper', () => ({makeServerRequest: jest.fn()}))

const {makeServerRequest} = require('../../utils/request-helper')
const {getLastTransactionsForAccount, getLastTransactions} = require('../../utils/horizon-helper')

const nowIso = () => new Date().toISOString()

//fake server whose .transactions() builder yields the given pages in order, paging via .next
function accountServer(pages) {
    function page(i) {
        const p = pages[i] || {records: []}
        return {records: p.records, next: () => Promise.resolve(page(i + 1))}
    }
    const builder = {
        forAccount: () => builder,
        limit: () => builder,
        order: () => builder,
        call: () => Promise.resolve(page(0))
    }
    return {transactions: () => builder}
}

//fake server for getLastTransactions: ledgers() reports lastSeq; transactions().call()
//walks `txResponses` (each entry is {records} or {status404:true}) one ledger at a time.
function ledgerServer({txResponses = [], lastSeq = 0}) {
    let i = 0
    const txBuilder = {
        forLedger: () => txBuilder,
        limit: () => txBuilder,
        order: () => txBuilder,
        call: () => {
            const r = txResponses[i++]
            if (r && r.status404) {
                const err = new Error('not found')
                err.response = {status: 404}
                return Promise.reject(err)
            }
            return Promise.resolve({records: (r && r.records) || [], next: () => Promise.resolve({records: []})})
        }
    }
    const ledgerBuilder = {
        order: () => ledgerBuilder,
        limit: () => ledgerBuilder,
        ledger: () => ledgerBuilder,
        call: () => Promise.resolve({records: [{sequence: lastSeq}]})
    }
    return {transactions: () => txBuilder, ledgers: () => ledgerBuilder}
}

beforeEach(() => {
    makeServerRequest.mockReset()
})

describe('getLastTransactionsForAccount', () => {
    function driveWith(server) {
        makeServerRequest.mockImplementation((urls, ctor, requestFn) => requestFn(server))
    }

    test('returns transactions sorted by ledger ascending and stops on a short page', async () => {
        driveWith(accountServer([{records: [
            {ledger_attr: 5, created_at: nowIso()},
            {ledger_attr: 3, created_at: nowIso()}
        ]}]))
        const result = await getLastTransactionsForAccount('GACCOUNT', ['http://h'])
        expect(result.map(t => t.ledger_attr)).toEqual([3, 5])
    })

    test('paginates through full pages via .next until a short page is reached', async () => {
        const full = {records: Array.from({length: 100}, (_, k) => ({ledger_attr: 100 + k, created_at: nowIso()}))}
        const tail = {records: [{ledger_attr: 300, created_at: nowIso()}]}
        driveWith(accountServer([full, tail]))
        const result = await getLastTransactionsForAccount('GACCOUNT', ['http://h'], 0, 24 * 60 * 60 * 1000)
        expect(result).toHaveLength(101)
        //sorted ascending
        for (let k = 1; k < result.length; k++)
            expect(result[k].ledger_attr).toBeGreaterThanOrEqual(result[k - 1].ledger_attr)
    })

    test('stops paginating once a transaction older than maxDepth is seen', async () => {
        const recent = Date.now()
        const full = {records: Array.from({length: 100}, (_, k) => ({ledger_attr: 100 + k, created_at: new Date(recent).toISOString()}))}
        //mark one record as 10 minutes old; maxDepth is 5 minutes
        full.records[50].created_at = new Date(recent - 10 * 60 * 1000).toISOString()
        const tail = {records: [{ledger_attr: 999, created_at: new Date(recent).toISOString()}]}
        driveWith(accountServer([full, tail]))
        const result = await getLastTransactionsForAccount('GACCOUNT', ['http://h'], 0, 5 * 60 * 1000)
        expect(result).toHaveLength(100) //the tail page was never fetched
        expect(result.some(t => t.ledger_attr === 999)).toBe(false)
    })

    test('returns an empty array when the request fails', async () => {
        makeServerRequest.mockRejectedValue(new Error('all servers down'))
        const result = await getLastTransactionsForAccount('GACCOUNT', ['http://h'])
        expect(result).toEqual([])
    })
})

describe('getLastTransactions', () => {
    test('derives the start ledger from the latest ledger and collects until a 404', async () => {
        const server = ledgerServer({
            lastSeq: 1000,
            txResponses: [
                {records: [{hash: 'A'}, {hash: 'B'}]}, //ledger 901
                {status404: true} //ledger 902 - signals max ledger reached
            ]
        })
        makeServerRequest.mockImplementation((urls, ctor, requestFn) => requestFn(server))
        const result = await getLastTransactions(['http://h'], 0)
        expect(result.txs.map(t => t.hash)).toEqual(['A', 'B'])
        //start = 1000 - 100 = 900; one ledger consumed before the 404
        expect(result.lastLedger).toBe(901)
    })

    test('returns the start ledger and no txs when the transactions request fails', async () => {
        const server = ledgerServer({lastSeq: 1000})
        //first call (getLastLedger) succeeds, second call (transactions) throws
        makeServerRequest
            .mockImplementationOnce((urls, ctor, requestFn) => requestFn(server))
            .mockImplementationOnce(() => { throw new Error('horizon unavailable') })
        const result = await getLastTransactions(['http://h'], 0)
        expect(result.txs).toEqual([])
        expect(result.lastLedger).toBe(900)
    })
})
