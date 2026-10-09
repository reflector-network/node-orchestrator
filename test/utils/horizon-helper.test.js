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

const http = require('http')
const {NotFoundError} = require('@stellar/stellar-sdk')
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
            if (r && r.status404) //what the sdk raises for an http 404, with horizon's problem body
                return Promise.reject(new NotFoundError('Not Found', {status: 404}))
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

describe('getLastTransactions cursor safety', () => {
    //a server that answers the first ledger and then fails; ledgers() answers the freshness probe
    function failingAfterFirstLedger() {
        let call = 0
        const txBuilder = {
            forLedger: () => txBuilder,
            limit: () => txBuilder,
            order: () => txBuilder,
            call: () => {
                call++
                if (call === 1)
                    return Promise.resolve({records: [{hash: 'H1', ledger_attr: 101}], next: () => Promise.resolve({records: []})})
                return Promise.reject(new Error('horizon 503'))
            }
        }
        const ledgerBuilder = {
            order: () => ledgerBuilder,
            limit: () => ledgerBuilder,
            ledger: () => ledgerBuilder,
            call: () => Promise.resolve({records: [{sequence: 300}], closed_at: new Date().toISOString()})
        }
        return {transactions: () => txBuilder, ledgers: () => ledgerBuilder}
    }

    test('a failure part way through leaves the cursor where it started', async () => {
        makeServerRequest.mockImplementation((urls, ctor, requestFn) => requestFn(failingAfterFirstLedger()))

        const result = await getLastTransactions(['http://horizon.example.com'], 100)

        expect(result.lastLedger).toBe(100) //not 101: the ledger that was scanned is re-scanned rather than lost
        expect(result.txs).toEqual([])
    })
})

/**
 * Records of one ledger, with paging tokens laid out as horizon's TOIDs are (ledger in the high 32 bits, application
 * order below), so they sort by ledger and then by position
 * @param {number} seq - ledger sequence
 * @param {number} count - number of transactions in the ledger
 * @returns {Array<{hash: string, paging_token: string, ledger: number}>}
 */
function ledgerRecords(seq, count) {
    return Array.from({length: count}, (_, i) => ({
        hash: `L${seq}-${i}`,
        paging_token: ((BigInt(seq) << 32n) | (BigInt(i + 1) << 12n)).toString(),
        ledger: seq
    }))
}

/**
 * Starts a loopback server answering the three horizon routes getLastTransactions calls, paging the way horizon does:
 * the records after `cursor` in paging-token order, a `next` link carrying the last token served, and a
 * problem+json 404 for a ledger past the head. The real sdk call builder parses every response.
 * @param {Object} options - server behaviour
 * @param {number} options.head - latest closed ledger; transactions of any later ledger answer 404
 * @param {Object<number, Array<object>>} options.ledgers - transaction records by ledger sequence
 * @param {Function} [options.fail] - (ledger, cursor) => true turns that transactions request into a 503
 * @param {string} [options.notFound] - how a 404 is answered: 'problem' is horizon's problem body, 'bare' has no body
 * and no content type, 'html' is the text/html page a proxy serves
 * @returns {Promise<{url: string, requests: Array<{ledger: number, cursor: string}>, close: Function}>}
 */
function startLoopbackHorizon({head, ledgers, fail = () => false, notFound: notFoundKind = 'problem'}) {
    const requests = []
    const send = (res, status, body) => {
        res.writeHead(status, {'content-type': status === 200 ? 'application/hal+json' : 'application/problem+json'})
        res.end(body === undefined ? '' : JSON.stringify(body))
    }
    const notFound = res => {
        if (notFoundKind === 'bare') {
            res.writeHead(404)
            return res.end()
        }
        if (notFoundKind === 'html') {
            res.writeHead(404, {'content-type': 'text/html'})
            return res.end('<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center></body></html>')
        }
        send(res, 404, {type: 'https://stellar.org/horizon-errors/not_found', title: 'Resource Missing', status: 404})
    }
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1')
        const [, seqPart, sub] = url.pathname.split('/').filter(Boolean)
        const closedAt = new Date().toISOString()
        if (seqPart === undefined) //ledgers?order=desc&limit=1
            return send(res, 200, {_links: {}, _embedded: {records: [{sequence: head, closed_at: closedAt}]}})
        const seq = Number(seqPart)
        if (sub === undefined) { //ledgers/{seq}, the freshness probe
            if (seq > head)
                return notFound(res)
            return send(res, 200, {sequence: seq, closed_at: closedAt})
        }
        const cursor = url.searchParams.get('cursor') || ''
        const limit = Number(url.searchParams.get('limit'))
        requests.push({ledger: seq, cursor})
        if (fail(seq, cursor))
            return send(res, 503, {type: 'https://stellar.org/horizon-errors/service_unavailable', title: 'Service Unavailable', status: 503})
        if (seq > head)
            return notFound(res)
        const records = (ledgers[seq] || [])
            .filter(r => cursor === '' || BigInt(r.paging_token) > BigInt(cursor))
            .slice(0, limit)
        const link = c => ({href: `/ledgers/${seq}/transactions?cursor=${c}&limit=${limit}&order=asc`})
        const nextCursor = records.length ? records[records.length - 1].paging_token : cursor
        send(res, 200, {
            _links: {self: link(cursor), next: link(nextCursor), prev: link(cursor)},
            _embedded: {records: records.map(r => ({...r, _links: {self: {href: `/transactions/${r.hash}`}, ledger: {href: `/ledgers/${seq}`}}}))}
        })
    })
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise(done => {
            server.closeAllConnections()
            server.close(done)
        })
    })))
}

describe('getLastTransactions against a loopback horizon', () => {
    const {makeServerRequest: realMakeServerRequest} = jest.requireActual('../../utils/request-helper')
    let servers = []

    async function horizon(options) {
        const server = await startLoopbackHorizon(options)
        servers.push(server)
        return server
    }

    beforeEach(() => {
        //the real retry loop: each url in turn, the first that answers wins
        makeServerRequest.mockImplementation(realMakeServerRequest)
    })

    afterEach(async () => {
        await Promise.all(servers.map(s => s.close()))
        servers = []
    })

    test('an empty ledger is stepped over and the 404 at the head stops the scan without advancing', async () => {
        const a = await horizon({head: 102, ledgers: {101: [], 102: ledgerRecords(102, 1)}})

        const result = await getLastTransactions([a.url], 100)

        expect(result.txs.map(t => t.hash)).toEqual(['L102-0'])
        expect(result.txs[0].ledger_attr).toBe(102)
        expect(result.lastLedger).toBe(102)
        expect(a.requests.map(r => r.ledger)).toEqual([101, 102, 103])
    })

    test('nothing new at the head leaves the cursor unchanged', async () => {
        const a = await horizon({head: 102, ledgers: {102: ledgerRecords(102, 1)}})

        const result = await getLastTransactions([a.url], 102)

        expect(result).toEqual({txs: [], lastLedger: 102})
        expect(a.requests).toEqual([{ledger: 103, cursor: ''}])
    })

    test('a ledger of exactly one full page follows the next link and reads every record once', async () => {
        const full = ledgerRecords(101, 200)
        const a = await horizon({head: 102, ledgers: {101: full, 102: ledgerRecords(102, 1)}})

        const result = await getLastTransactions([a.url], 100)

        expect(result.txs.map(t => t.hash)).toEqual([...full.map(r => r.hash), 'L102-0'])
        expect(result.lastLedger).toBe(102)
        //the full page was followed by one more request carrying the last token served, which came back empty
        expect(a.requests.filter(r => r.ledger === 101)).toEqual([
            {ledger: 101, cursor: ''},
            {ledger: 101, cursor: full[199].paging_token}
        ])
    })

    test('a ledger one record over a page reads both pages and each record once', async () => {
        const records = ledgerRecords(101, 201)
        const a = await horizon({head: 101, ledgers: {101: records}})

        const result = await getLastTransactions([a.url], 100)

        expect(result.txs.map(t => t.hash)).toEqual(records.map(r => r.hash))
        expect(result.lastLedger).toBe(101)
    })

    test('a failure on a later page makes the next url restart from the starting ledger, reading nothing twice', async () => {
        const ledgers = {101: ledgerRecords(101, 3), 102: ledgerRecords(102, 250), 103: ledgerRecords(103, 1)}
        //the first url completes ledger 101, serves the first page of 102, then fails on its second page
        const a = await horizon({head: 103, ledgers, fail: (seq, cursor) => seq === 102 && cursor !== ''})
        const b = await horizon({head: 103, ledgers})

        const result = await getLastTransactions([a.url, b.url], 100)

        const expected = [...ledgers[101], ...ledgers[102], ...ledgers[103]].map(r => r.hash)
        expect(result.txs.map(t => t.hash)).toEqual(expected) //ledger 101 included, and no record of 102 repeated
        expect(result.lastLedger).toBe(103)
        expect(a.requests.map(r => r.ledger)).toEqual([101, 102, 102])
        expect(b.requests[0]).toEqual({ledger: 101, cursor: ''}) //the retry started over, not at 102
    })

    test('when every url fails part way through, the original cursor comes back', async () => {
        const ledgers = {101: ledgerRecords(101, 3), 102: ledgerRecords(102, 250)}
        const fail = (seq, cursor) => seq === 102 && cursor !== ''
        const a = await horizon({head: 102, ledgers, fail})
        const b = await horizon({head: 102, ledgers, fail})

        const result = await getLastTransactions([a.url, b.url], 100)

        expect(result).toEqual({txs: [], lastLedger: 100})
        expect(b.requests[0]).toEqual({ledger: 101, cursor: ''})
    })

    test.each([
        ['with no body at all', 'bare'],
        ['with a proxy\'s html page for a body', 'html']
    ])('a 404 %s stops the scan at the head like horizon\'s own', async (_, notFound) => {
        //the head is read from the http status, not from the status horizon puts in its problem body, so a proxy that
        //drops or replaces that body neither stalls the scan nor makes it skip
        const a = await horizon({head: 102, ledgers: {101: ledgerRecords(101, 2), 102: ledgerRecords(102, 1)}, notFound})

        const first = await getLastTransactions([a.url], 100)

        expect(first.txs.map(t => t.hash)).toEqual(['L101-0', 'L101-1', 'L102-0'])
        expect(first.lastLedger).toBe(102)
        expect(a.requests.map(r => r.ledger)).toEqual([101, 102, 103])

        //and the next call picks up from there: nothing new yet, and nothing read twice
        const second = await getLastTransactions([a.url], first.lastLedger)
        expect(second).toEqual({txs: [], lastLedger: 102})
    })

    test('any other error on a ledger\'s first page is a failure, not the head, so the next url is tried', async () => {
        const ledgers = {101: ledgerRecords(101, 2), 102: ledgerRecords(102, 1)}
        const a = await horizon({head: 102, ledgers, fail: seq => seq === 102})
        const b = await horizon({head: 102, ledgers})

        const result = await getLastTransactions([a.url, b.url], 100)

        expect(result.txs.map(t => t.hash)).toEqual(['L101-0', 'L101-1', 'L102-0'])
        expect(result.lastLedger).toBe(102)
        expect(a.requests.map(r => r.ledger)).toEqual([101, 102]) //the 503 at 102 ended this url's attempt
        expect(b.requests.map(r => r.ledger)).toEqual([101, 102, 103])
    })

    test('the transaction cap stops at a ledger boundary and the next call resumes at the following ledger', async () => {
        //the 10 000 cap is crossed on the first page of ledger 102, so a scan that stopped there would drop its second page
        const ledgers = {101: ledgerRecords(101, 9_900), 102: ledgerRecords(102, 300), 103: ledgerRecords(103, 2)}
        const a = await horizon({head: 103, ledgers})

        const first = await getLastTransactions([a.url], 100)
        expect(first.txs).toHaveLength(10_200)
        expect(first.lastLedger).toBe(102) //ledger 102 was read whole even though the cap fell inside it; 103 was not started

        const second = await getLastTransactions([a.url], first.lastLedger)
        expect(second.txs.map(t => t.hash)).toEqual(['L103-0', 'L103-1'])
        expect(second.lastLedger).toBe(103)

        //across the two calls every record arrives exactly once
        const all = [...first.txs, ...second.txs].map(t => t.hash)
        expect(all).toEqual([...ledgers[101], ...ledgers[102], ...ledgers[103]].map(r => r.hash))
    }, 30000)
})
