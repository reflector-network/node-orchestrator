const {getTransactions} = require('../../utils/horizon-helper')

/*eslint-disable no-undef */
jest.mock('../../domain/container', () => ({
    appConfig: {
        getNetworkConfig: jest.fn(() => ({
            horizonUrls: ['https://horizon-testnet.stellar.org']
        }))
    }
}))

jest.mock('../../logger', () => ({
    error: jest.fn((error) => {
        console.error(`Error: ${error.msg}`, error.err)
    })
}))

describe('getTransactions', () => {

    test('should fetch transactions successfully', async () => {
        const result = await getTransactions('GBWBQG4XNB3N5JW3VYK6IQRAA75QGA2LNKEDGDOFVYRLQF7R2Z2EFAEU')
        console.log('Fetched transactions:', result)
    })
})