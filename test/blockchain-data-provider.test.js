/*eslint-disable no-undef */
const {__getMaxTime, maxSubmitAttempts, baseUpdateFee, FEE_MULTIPLIER} = require('../domain/blockchain-data-provider')

describe('blockchain-data-provider submit schedule', () => {
    test('attempt 0 (iteration 1) gives 30s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 1) - syncTs / 1000).toBe(30)
    })

    test('attempt 1 (iteration 2) gives 45s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 2) - syncTs / 1000).toBe(45)
    })

    test('attempt 2 (iteration 3) gives 60s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 3) - syncTs / 1000).toBe(60)
    })

    test('exports parity constants', () => {
        expect(maxSubmitAttempts).toBe(3)
        expect(baseUpdateFee).toBe(10_000_000)
        expect(FEE_MULTIPLIER).toBe(8)
    })
})

test('the module exports only the live helpers', () => {
    const provider = require('../domain/blockchain-data-provider')
    expect(Object.keys(provider).sort()).toEqual(['FEE_MULTIPLIER', '__getMaxTime', 'baseUpdateFee', 'checkUpdateBuilds', 'getUpdateTxHash', 'maxSubmitAttempts'].sort())
})

describe('checkUpdateBuilds', () => {
    const path = require('path')
    const root = path.resolve(__dirname, '..')

    function load({build, sequence = '123'}) {
        jest.resetModules()
        const buildUpdateTransaction = jest.fn(build)
        const getAccountSequence = jest.fn(() => Promise.resolve(sequence))
        jest.doMock('@reflector/reflector-shared', () => ({...jest.requireActual('@reflector/reflector-shared'), buildUpdateTransaction}))
        jest.doMock(path.join(root, 'utils', 'rpc-helper.js'), () => ({getAccountSequence}))
        jest.doMock(path.join(root, 'logger.js'), () => ({debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn()}))
        jest.doMock(path.join(root, 'domain', 'container.js'), () => ({
            appConfig: {getNetworkConfig: () => ({urls: ['http://rpc.test'], passphrase: 'Test SDF Network ; September 2015'})}
        }))
        const provider = require(path.join(root, 'domain', 'blockchain-data-provider.js'))
        return {provider, buildUpdateTransaction, getAccountSequence}
    }

    const currentConfig = {network: 'testnet', systemAccount: require('@stellar/stellar-sdk').Keypair.random().publicKey()}
    const newConfig = {}

    afterEach(() => jest.resetModules())

    test('builds the update from the system account\'s current sequence at the given switch time', async () => {
        const {provider, buildUpdateTransaction, getAccountSequence} = load({
            build: () => Promise.resolve({hashHex: 'ab', hasMoreTxns: false, transaction: {toXdr: () => '', sequence: '124'}})
        })

        await expect(provider.checkUpdateBuilds(currentConfig, newConfig, 1_800_000_000_000)).resolves.toBeUndefined()

        expect(getAccountSequence).toHaveBeenCalledWith(currentConfig)
        const options = buildUpdateTransaction.mock.calls[0][0]
        expect(options.currentConfig).toBe(currentConfig)
        expect(options.newConfig).toBe(newConfig)
        expect(options.timestamp).toBe(1_800_000_000_000)
        expect(options.account.accountId()).toBe(currentConfig.systemAccount)
        expect(options.account.sequenceNumber()).toBe('123')
    })

    test('a build that fails, such as a failed simulation, rejects with its error', async () => {
        const {provider} = load({build: () => Promise.reject(new Error('HostError: Error(Contract, #5)'))})

        await expect(provider.checkUpdateBuilds(currentConfig, newConfig, 1)).rejects.toThrow('HostError: Error(Contract, #5)')
    })

    test('an update with nothing left to do on chain passes', async () => {
        const {provider} = load({build: () => Promise.resolve(null)})

        await expect(provider.checkUpdateBuilds(currentConfig, newConfig, 1)).resolves.toBeUndefined()
    })
})
