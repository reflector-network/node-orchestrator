const {Horizon, xdr} = require('@stellar/stellar-sdk')
const container = require('../domain/container')
const logger = require('../logger')
const {makeServerRequest} = require('./request-helper')


/**
 * @param {string} url - server URL
 * @returns {Horizon.Server}
 */
function getServer(url) {
    return new Horizon.Server(url, {allowHttp: true})
}

/**
 * Fetches transactions for a given account from Horizon servers, starting from a specified ledger.
 * The function handles pagination and ensures that it does not fetch transactions beyond the specified last ledger.
 * @param {string} account - The Stellar account ID for which to fetch transactions.
 * @param {string[]} urls - An array of Horizon server URLs to query.
 * @param {number} lastLedger - The ledger number from which to start fetching transactions. Transactions from this ledger and earlier will be ignored.
 * @param {number} maxDepth - How long to go back in history, in milliseconds. Transactions older than (current time - maxDepth) will be ignored.
 * @returns {Promise<any[]>} - A promise that resolves to an array of transactions.
 */
async function getLastTransactionsForAccount(account, urls, lastLedger = 0, maxDepth = 24 * 60 * 60 * 1000) {
    /**
     * @param {Horizon.Server} server
     * @returns {Promise<any[]>}
     */
    const transactionsRequestFn = async (server) => {
        const limit = 100
        //build the initial request
        let txsRequest = () => server.transactions()
            .forAccount(account)
            .limit(limit)
            .order('desc')
            .call()

        let hasMore = true
        const txs = []
        //loop until we have enough transactions or no more transactions are available
        while (hasMore) {
            const transactions = await txsRequest()
            for (const tx of transactions.records) {
                txs.push(tx)
            }
            if (
                transactions.records.length === 0
                || transactions.records.length < limit
                || transactions.records.some(tx => tx.ledger_attr <= lastLedger)
                || transactions.records.some(tx => new Date(tx.created_at).getTime() < Date.now() - maxDepth)
            ) {
                hasMore = false
            } else {
                txsRequest = transactions.next
            }
        }
        return txs.sort((a, b) => a.ledger_attr - b.ledger_attr)
    }

    try {
        return await makeServerRequest(urls, getServer, transactionsRequestFn)
    } catch (err) {
        logger.error({err, msg: `Error fetching transactions for account ${account}`})
        return []
    }
}

/**
 * Fetches transactions for a given account from Horizon servers, starting from a specified ledger.
 * The function handles pagination and ensures that it does not fetch transactions beyond the specified last ledger.
 * @param {string} account - The Stellar account ID for which to fetch transactions.
 * @param {string[]} urls - An array of Horizon server URLs to query.
 * @param {number} lastLedger - The ledger number from which to start fetching transactions. Transactions from this ledger and earlier will be ignored.
 * @param {number} maxDepth - How long to go back in history, in milliseconds. Transactions older than (current time - maxDepth) will be ignored.
 * @returns {Promise<any[]>} - A promise that resolves to an array of transactions.
 */
async function getLastTransactions(urls, lastLedger = 0) {

    if (lastLedger > 0) {
        const ledgerCloseTime = await getLedgerCloseTime(urls, lastLedger)
        if (Date.now() - ledgerCloseTime.getTime() > 24 * 60 * 60 * 1000) {
            logger.warn({msg: `Last ledger ${lastLedger} is too old, fetching the latest transactions instead`})
            lastLedger = 0
        }
    }
    if (lastLedger === 0) {
        lastLedger = (await getLastLedger(urls)) - 100 //add some buffer
    }

    /**
     * @param {Horizon.Server} server
     * @returns {Promise<{txs: any[], lastLedger: number}>}
     */
    const transactionsRequestFn = async (server) => {
        const maxTotalTxs = 10_000
        const txs = []
        const limit = 200
        let maxLedgerReached = false
        while (txs.length < maxTotalTxs && !maxLedgerReached) {
            //build the initial request
            let txsRequest = () => server.transactions()
                .forLedger(lastLedger + 1)
                .limit(limit)
                .order('asc')
                .call()
                .catch(err => {
                    if (err?.response?.status === 404) {
                        logger.trace({err, msg: `Ledger ${lastLedger} not found, assuming max ledger reached`})
                        maxLedgerReached = true
                        return {records: []}
                    }
                    throw err
                })

            let hasMore = true
            //loop until we have enough transactions or no more transactions are available
            while (hasMore) {
                const transactions = await txsRequest()
                for (const tx of transactions.records) {
                    txs.push(tx)
                }
                if (
                    transactions.records.length === 0
                || transactions.records.length < limit
                ) {
                    hasMore = false
                } else {
                    txsRequest = transactions.next
                }
            }
            lastLedger++
        }
        return {txs, lastLedger}
    }

    try {
        return await makeServerRequest(urls, getServer, transactionsRequestFn)
    } catch (err) {
        logger.error({err, msg: `Error fetching transactions`})
        return []
    }
}

async function getLastLedger(urls) {
    /**
     * @param {Horizon.Server}
     * @return {Promise<number>}
     */
    const lastLedgerRequestFn = async (server) => {
        const ledger = await server.ledgers().order('desc').limit(1).call()
        return ledger.records[0].sequence
    }
    return await makeServerRequest(urls, getServer, lastLedgerRequestFn)
}

async function getLedgerCloseTime(urls, ledgerSequence) {
    /**
     * @param {Horizon.Server}
     * @return {Promise<>}
     */
    const lastLedgerRequestFn = async (server) => {
        const ledger = await server.ledgers().ledger(ledgerSequence).call()
        return new Date(ledger.closed_at)
    }
    return await makeServerRequest(urls, getServer, lastLedgerRequestFn)
}

module.exports = {
    getLastTransactionsForAccount,
    getLastTransactions
}