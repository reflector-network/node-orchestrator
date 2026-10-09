/*eslint-disable no-undef */
const {
    CONTRACT_ID,
    getNodeKeypairs,
    buildConfig,
    changedConfig,
    getSignedEnvelope,
    makeDoc,
    acceptedSignature,
    submit,
    loadConfigManager
} = require('./helpers/config-manager-harness')

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

const syncGrid = 2 * 60 * 1000

//a proposal whose transaction can never be built would sit PENDING until it expires, blocking every other proposal, so
//the orchestrator builds it once before accepting it
describe('a proposal is built before it is accepted', () => {
    async function appliedCluster(nodeCount = 3) {
        const nodeKps = getNodeKeypairs(nodeCount)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps.slice(0, 3))
        const loaded = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps: nodeKps.slice(0, 3)
        })
        return {...loaded, nodeKps, config}
    }

    /**
     * @param {string} message - the rpc's simulation error
     * @returns {Error} what reflector-shared throws when the host refused the transaction
     */
    function refusal(message) {
        return Object.assign(new Error(message), {code: 'SIMULATION_REJECTED'})
    }

    test('a proposal whose transaction cannot be built is refused with the reason, and nothing is stored', async () => {
        const {configManager, model, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        blockchainDataProvider.checkUpdateBuilds.mockRejectedValue(refusal('HostError: Error(Contract, #5)'))

        await expect(submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0])))
            .rejects.toThrow('The update transaction cannot be built: HostError: Error(Contract, #5)')

        expect(model.__all().map(doc => doc.id)).toEqual(['applied-1'])
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })

    test('the refusal is a validation error, so the route answers 400 rather than 500', async () => {
        const {ValidationError} = require('@reflector/reflector-shared')
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        blockchainDataProvider.checkUpdateBuilds.mockRejectedValue(refusal('HostError: Error(Storage, MissingValue)'))

        const error = await submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0])).catch(err => err)

        expect(error.constructor.name).toBe(ValidationError.name)
        expect(error.message).toBe('The update transaction cannot be built: HostError: Error(Storage, MissingValue)')
    })

    test('a validation error from the build is a refusal too', async () => {
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        //required after the harness reset the module registry, so it is the class the config manager loaded
        const {ValidationError} = require('@reflector/reflector-shared')
        blockchainDataProvider.checkUpdateBuilds.mockRejectedValue(new ValidationError('Wasm hash is not valid: x'))

        const error = await submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0])).catch(err => err)

        expect(error.constructor.name).toBe(ValidationError.name)
        expect(error.message).toBe('The update transaction cannot be built: Wasm hash is not valid: x')
    })

    //a request that failed, or an error stellar-rpc reports for itself, says nothing about the proposal: it is not refused
    //as unbuildable, the reply asks to submit it again (503), and nothing is stored
    test.each([
        ['every rpc url failed', 'Failed to make request. See logs for details.'],
        ['the rpc reported its own error', 'preflight queue full']
    ])('a check that could not run is not a refusal: %s', async (label, message) => {
        const {configManager, model, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        blockchainDataProvider.checkUpdateBuilds.mockRejectedValue(new Error(message))

        const error = await submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0])).catch(err => err)

        expect(error.constructor.name).toBe('HttpError')
        expect(error.code).toBe(503)
        expect(error.message).toBe(`Service unavailable. The update transaction could not be checked right now, submit the proposal again: ${message}`)
        expect(model.__all().map(doc => doc.id)).toEqual(['applied-1'])
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })

    test('a long simulation error is cut short in the reply', async () => {
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        blockchainDataProvider.checkUpdateBuilds.mockRejectedValue(refusal('x'.repeat(5000)))

        const error = await submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0])).catch(err => err)

        expect(error.message.length).toBeLessThanOrEqual(600)
        expect(error.message.endsWith('...')).toBe(true)
    })

    test('the check builds the proposed config against the current one at the switch time the update would get', async () => {
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        //whole seconds, off the sync grid: getTimestamp rounds it up onto the grid
        const offGrid = Math.floor(Date.now() / 1000) * 1000 + 60 * 60 * 1000 + 1000
        const switchTime = Math.ceil(offGrid / syncGrid) * syncGrid

        await submit(configManager, getSignedEnvelope(changedConfig(config), nodeKps[0], {timestamp: offGrid}))

        expect(blockchainDataProvider.checkUpdateBuilds).toHaveBeenCalledTimes(1)
        const [current, proposed, timestamp] = blockchainDataProvider.checkUpdateBuilds.mock.calls[0]
        expect(current.contracts.get(CONTRACT_ID).period).toBe(config.contracts[CONTRACT_ID].period)
        expect(proposed.contracts.get(CONTRACT_ID).period).toBe(9999999)
        expect(timestamp).toBe(switchTime)
        expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('voting')
    })

    test('a node set change has nothing to simulate and is not checked', async () => {
        const {configManager, blockchainDataProvider, nodeKps} = await appliedCluster(4)

        await submit(configManager, getSignedEnvelope(buildConfig(nodeKps), nodeKps[0]))

        expect(blockchainDataProvider.checkUpdateBuilds).not.toHaveBeenCalled()
        expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('voting')
    })

    test('a change with no transaction is not checked', async () => {
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        const proposed = structuredClone(config)
        proposed.nodes[nodeKps[2].publicKey()].url = 'ws://127.0.0.1:3999' //a node url lives off chain

        await submit(configManager, getSignedEnvelope(proposed, nodeKps[0]))

        expect(blockchainDataProvider.checkUpdateBuilds).not.toHaveBeenCalled()
        expect(configManager.getCurrentConfigs().pendingConfig.config.isBlockchainUpdate).toBe(false)
    })

    test('a vote on a stored proposal is not checked again', async () => {
        const {configManager, blockchainDataProvider, nodeKps, config} = await appliedCluster()
        const proposed = changedConfig(config)
        await submit(configManager, getSignedEnvelope(proposed, nodeKps[0]))
        blockchainDataProvider.checkUpdateBuilds.mockClear()

        await submit(configManager, getSignedEnvelope(proposed, nodeKps[1]))

        expect(blockchainDataProvider.checkUpdateBuilds).not.toHaveBeenCalled()
        expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('pending')
    })

    test('the first config of a cluster is not checked', async () => {
        const nodeKps = getNodeKeypairs(3)
        const {configManager, blockchainDataProvider} = await loadConfigManager({docs: [], nodeKps})

        await submit(configManager, getSignedEnvelope(buildConfig(nodeKps), nodeKps[0]))

        expect(blockchainDataProvider.checkUpdateBuilds).not.toHaveBeenCalled()
    })
})
