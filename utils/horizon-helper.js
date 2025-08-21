const {Horizon} = require('@stellar/stellar-sdk')
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

async function getTransactions(account, network) {
    const {horizonUrls} = container.appConfig.getNetworkConfig(network)
    const maxTx = 10
    const minDate = new Date(Date.now() - 60 * 60 * 1000) //1 hour ago

    /**
     * @param {Horizon.Server} server
     * @returns {Promise<any[]>}
     */
    const transactionsRequestFn = async (server) => {
        const txs = []
        let hasMore = true

        //fetch transactions in descending order, filtering by account and date
        const fetchTransactions = async (requestFn) => {
            const transactions = await requestFn()
            for (const tx of transactions.records) {
                if (tx.source_account === account) {
                    txs.push({hash: tx.hash, created_at: tx.created_at})
                }
                if (txs.length === maxTx) break
            }
            return transactions
        }

        //build the initial request
        let txsRequest = () => server.transactions()
            .forAccount(account)
            .limit(100)
            .order('desc')
            .call()

        //loop until we have enough transactions or no more transactions are available
        while (hasMore) {
            const transactions = await fetchTransactions(txsRequest)

            if (
                txs.length === maxTx ||
                transactions.records.length === 0 ||
                new Date(transactions.records[transactions.records.length - 1].created_at) < minDate
            ) {
                hasMore = false
            } else {
                txsRequest = () => transactions.next()
            }
        }

        //filter transactions by date
        return txs.filter(tx => new Date(tx.created_at) > minDate)
    }

    try {
        return await makeServerRequest(horizonUrls, getServer, transactionsRequestFn)
    } catch (err) {
        logger.error({err, msg: `Error fetching transactions for account ${account}`})
        return []
    }
}

module.exports = {
    getTransactions
}