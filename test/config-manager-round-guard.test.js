/*eslint-disable no-undef */
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

const second = 1000
const hour = 60 * 60 * second
const switchTime = 1800000000000 //on the 2-minute sync grid
const grid = 2 * 60 * second

//a vote change that rejects a PENDING update while a round is in flight leaves the nodes holding a signed transaction
//that can still land, after the orchestrator dropped the update: the chain would then hold a change no config describes
describe('a vote on a PENDING update cannot change while a round is in flight', () => {
    /**
     * Loads a cluster whose update is PENDING with every given node's approval, the clock an hour before its switch time,
     * so the init tick only schedules the round. The test moves the clock without running timers
     * @param {{nodeCount: number, signers: number, allowEarlySubmission: boolean}} [options] - cluster size, approvals and
     * whether the update may be submitted early
     * @returns {Promise<object>}
     */
    async function pendingCluster({nodeCount = 3, signers = 2, allowEarlySubmission = false} = {}) {
        const nodeKps = getNodeKeypairs(nodeCount)
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: nodeKps.slice(0, 2).map(acceptedSignature), status: 'applied', updatedAt: 1000}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: nodeKps.slice(0, signers).map(acceptedSignature),
                status: 'pending',
                timestamp: allowEarlySubmission ? switchTime + 24 * hour : switchTime,
                isBlockchainUpdate: true,
                allowEarlySubmission,
                updatedAt: 2000
            })
        ]
        const loaded = await loadConfigManager({docs, nodeKps, now: switchTime - hour})
        return {...loaded, nodeKps, proposed}
    }

    //a vote on a PENDING envelope carries its stored switch time
    function withdraw({nodeKps, proposed}) {
        return getSignedEnvelope(proposed, nodeKps[0], {rejected: true, timestamp: switchTime})
    }

    test('the initiator cannot withdraw during the round at the switch time', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime + 30 * second)

        await expect(submit(cluster.configManager, withdraw(cluster))).rejects.toThrow('An update round is in progress, try again in a minute')

        expect(cluster.model.__get('pending-1').status).toBe('pending')
    })

    test('a signer cannot flip to reject until the round\'s last attempt and its poll are over', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime + 61 * second - 1)
        const flip = getSignedEnvelope(cluster.proposed, cluster.nodeKps[1], {rejected: true, timestamp: switchTime})

        await expect(submit(cluster.configManager, flip)).rejects.toThrow('An update round is in progress')
    })

    test('the window opens 15 seconds before the tick', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime - 15 * second)

        await expect(submit(cluster.configManager, withdraw(cluster))).rejects.toThrow('An update round is in progress')
    })

    test('before the window the initiator withdraws', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime - 16 * second)

        await submit(cluster.configManager, withdraw(cluster))

        expect(cluster.model.__get('pending-1').status).toBe('rejected')
    })

    test('between the rounds of an update that keeps failing, the initiator withdraws', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime + 61 * second)

        await submit(cluster.configManager, withdraw(cluster))

        expect(cluster.model.__get('pending-1').status).toBe('rejected')
    })

    test('every later tick of a failing update opens the window again', async () => {
        const cluster = await pendingCluster()
        jest.setSystemTime(switchTime + 3 * grid + 10 * second)

        await expect(submit(cluster.configManager, withdraw(cluster))).rejects.toThrow('An update round is in progress')
    })

    test('with early submission allowed every tick is a round, even before the switch time', async () => {
        const cluster = await pendingCluster({allowEarlySubmission: true})
        jest.setSystemTime(switchTime + 20 * second)

        await expect(submit(cluster.configManager, getSignedEnvelope(cluster.proposed, cluster.nodeKps[0], {
            rejected: true,
            timestamp: switchTime + 24 * hour
        }))).rejects.toThrow('An update round is in progress')
    })

    test('a new approval during a round is accepted: it cannot drop the update', async () => {
        const cluster = await pendingCluster({nodeCount: 4, signers: 3})
        jest.setSystemTime(switchTime + 30 * second)

        await submit(cluster.configManager, getSignedEnvelope(cluster.proposed, cluster.nodeKps[3], {timestamp: switchTime}))

        expect(cluster.model.__get('pending-1').signatures).toHaveLength(4)
        expect(cluster.model.__get('pending-1').status).toBe('pending')
    })
})
