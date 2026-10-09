/*eslint-disable no-undef */
const path = require('path')
const {
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

const minute = 60 * 1000
const hour = 60 * minute
const start = 1800000000000 //on the two-minute sync grid

//the pending config is processed by a loop that sleeps until the switch time of the update that was pending when it last
//ran. Votes change which update is pending, so the loop has to wake for the new state: otherwise an update that turns
//PENDING after a far-off one was withdrawn waits for the old switch time, while the nodes apply it on their own
describe('the pending config loop follows the votes', () => {
    async function clusterWithFarPendingUpdate() {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const loaded = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps,
            now: start
        })
        const far = changedConfig(config)
        await submit(loaded.configManager, getSignedEnvelope(far, a, {timestamp: start + 3 * hour}))
        await submit(loaded.configManager, getSignedEnvelope(far, b, {timestamp: start + 3 * hour}))
        expect(loaded.configManager.getCurrentConfigs().pendingConfig.config.status).toBe('pending')
        await jest.advanceTimersByTimeAsync(10 * 1000) //the loop runs and goes to sleep until the far switch time
        return {...loaded, nodeKps, config, far}
    }

    test('an update that turns PENDING after a far-off one was withdrawn is applied at its own switch time', async () => {
        const {configManager, model, nodeKps, config, far} = await clusterWithFarPendingUpdate()
        const [a, b] = nodeKps
        await submit(configManager, getSignedEnvelope(far, a, {rejected: true, timestamp: start + 3 * hour}))
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()

        //a change that needs no transaction: the nodes apply it at the switch time without the orchestrator
        const near = structuredClone(config)
        near.nodes[nodeKps[2].publicKey()].url = 'ws://127.0.0.1:3999'
        await submit(configManager, getSignedEnvelope(near, a))
        const scheduled = configManager.getCurrentConfigs().pendingConfig.config.timestamp
        await submit(configManager, getSignedEnvelope(near, b, {timestamp: scheduled}))
        const pending = configManager.getCurrentConfigs().pendingConfig.config
        expect(pending.status).toBe('pending')
        expect(pending.timestamp).toBeLessThan(start + 10 * minute)

        await jest.advanceTimersByTimeAsync(pending.timestamp - Date.now() + 5 * 1000)

        expect(model.__get(pending.id).status).toBe('applied')
        expect(configManager.getCurrentConfigs().currentConfig.config.id).toBe(pending.id)
    })

    test('a vote while a pass is running does not start a second one', async () => {
        const {configManager, nodeKps, far} = await clusterWithFarPendingUpdate()
        const {getUpdateTxHash} = require(path.resolve(__dirname, '..', 'domain', 'blockchain-data-provider.js'))
        //a third, late vote on the far update: the loop is woken, finds the switch time ahead and sleeps again
        await submit(configManager, getSignedEnvelope(far, nodeKps[2], {timestamp: start + 3 * hour}))
        await jest.advanceTimersByTimeAsync(minute)

        expect(getUpdateTxHash).not.toHaveBeenCalled()
        expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('pending')
    })
})
