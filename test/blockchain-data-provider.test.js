/*eslint-disable no-undef */
const schedule = require('@reflector/reflector-shared')
const {maxSubmitAttempts, baseUpdateFee, FEE_MULTIPLIER} = require('../domain/blockchain-data-provider')

describe('blockchain-data-provider submit schedule', () => {
    test('the shared schedule: two attempts, the retry at 8x', () => {
        expect(maxSubmitAttempts).toBe(2)
        expect(maxSubmitAttempts).toBe(schedule.maxSubmitAttempts)
        expect(FEE_MULTIPLIER).toBe(8)
        expect(baseUpdateFee).toBe(10_000_000)
    })
})

test('the module exports only the live helpers', () => {
    const provider = require('../domain/blockchain-data-provider')
    expect(Object.keys(provider).sort()).toEqual(['FEE_MULTIPLIER', 'baseUpdateFee', 'checkUpdateBuilds', 'getUpdateTxHash', 'maxSubmitAttempts'].sort())
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

    test('each attempt of a cluster round is derived with the 60 s cluster envelope', async () => {
        const {provider, buildUpdateTransaction} = load({
            build: () => Promise.resolve({hashHex: 'ab', hasMoreTxns: false, transaction: {toXdr: () => '', sequence: '124'}})
        })
        const sync = 1_800_000_000_000
        await provider.getUpdateTxHash(currentConfig, newConfig, '123', sync, sync, 0)
        await provider.getUpdateTxHash(currentConfig, newConfig, '123', sync, sync, 1)
        expect(buildUpdateTransaction.mock.calls.map(([p]) => [p.fee, p.maxTime])).toEqual([
            [10_000_000, (sync + 40_000) / 1000],
            [80_000_000, (sync + 60_000) / 1000]
        ])
    })

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

    test('the transaction is bounded as the first attempt of the round at the switch time, in whole seconds', async () => {
        const {provider, buildUpdateTransaction} = load({build: () => Promise.resolve(null)})
        jest.useFakeTimers({now: 1_800_000_000_123}) //a clock between two seconds
        try {
            await provider.checkUpdateBuilds(currentConfig, newConfig, 1_800_000_120_000)
        } finally {
            jest.useRealTimers()
        }

        const {maxTime, fee} = buildUpdateTransaction.mock.calls[0][0]
        expect(maxTime).toBe(1_800_000_160) //the switch time + 40 s, the first attempt's bound
        expect(Number.isInteger(maxTime)).toBe(true)
        expect(fee).toBe(10_000_000)
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
