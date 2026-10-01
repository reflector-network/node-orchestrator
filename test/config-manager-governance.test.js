/*eslint-disable no-undef */
const {
    FAR_FUTURE,
    CONTRACT_ID,
    getNodeKeypairs,
    buildConfig,
    changedConfig,
    getSignedEnvelope,
    makeDoc,
    acceptedSignature,
    rejectedSignature,
    submit,
    loadConfigManager
} = require('./helpers/config-manager-harness')

afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
})

describe('getConfigMessage', () => {
    test('omits rejected signatures from the envelopes sent to nodes', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b, c] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(c), rejectedSignature(b)],
                status: 'pending',
                timestamp: FAR_FUTURE,
                isBlockchainUpdate: true
            })
        ]
        const {configManager} = await loadConfigManager({docs, nodeKps})

        const message = configManager.getConfigMessage()

        expect(message.data.pendingConfig).toBeDefined()
        expect(message.data.pendingConfig.signatures.map(s => s.pubkey)).toEqual([a.publicKey(), c.publicKey()])
        expect(message.data.pendingConfig.signatures.some(s => s.rejected)).toBe(false)
        expect(message.data.currentConfig.signatures).toHaveLength(2)
        expect(message.data.currentConfig.config.clusterSecret).toBe('seed-cluster-secret') //nodes need the secret
    })
})

describe('vote change persistence', () => {
    test('a flipped vote lands in signatures[N] and nowhere inside config', async () => {
        const nodeKps = getNodeKeypairs(4) //majority 3, so two votes keep the envelope in VOTING
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const {configManager, model} = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps
        })

        await submit(configManager, getSignedEnvelope(proposed, a))
        await submit(configManager, getSignedEnvelope(proposed, b))
        const pendingId = configManager.getCurrentConfigs().pendingConfig.config.id
        expect(model.__get(pendingId).status).toBe('voting')

        await submit(configManager, getSignedEnvelope(proposed, b, {rejected: true}))

        const stored = model.__get(pendingId)
        expect(stored.signatures).toHaveLength(2)
        expect(stored.signatures[1]).toMatchObject({pubkey: b.publicKey(), rejected: true})
        expect(stored.config.signatures).toBeUndefined()
        expect(stored.status).toBe('voting')
        expect(configManager.getCurrentConfigs().pendingConfig.config.signatures[1].rejected).toBe(true)
    })
})

describe('PENDING lifecycle', () => {
    test('an expired PENDING envelope is rejected and nodes are told to clear it', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(b)],
                status: 'pending',
                timestamp: FAR_FUTURE,
                expirationDate: Date.now() - 1000,
                isBlockchainUpdate: true
            })
        ]
        const {configManager, model, notificationProvider, MessageTypes} = await loadConfigManager({docs, nodeKps})

        await jest.advanceTimersByTimeAsync(1000) //processPendingConfig ran during init; updateItems waits one second before notifying

        expect(model.__get('pending-1').status).toBe('rejected')
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
        const configMessages = notificationProvider.notify.mock.calls.map(call => call[0]).filter(m => m.type === MessageTypes.CONFIG)
        expect(configMessages).toHaveLength(1)
        expect(configMessages[0].data.pendingConfig).toBeUndefined()
    })

    test('a vote on an expired PENDING envelope is refused with the expiry error', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b, c] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(b)],
                status: 'pending',
                timestamp: FAR_FUTURE,
                expirationDate: Date.now() + 5000,
                isBlockchainUpdate: true
            })
        ]
        const {configManager} = await loadConfigManager({docs, nodeKps})
        jest.setSystemTime(Date.now() + 6000) //past the expiry, without running the recursive processPendingConfig tick

        const vote = getSignedEnvelope(proposed, c, {rejected: true, timestamp: FAR_FUTURE})

        await expect(submit(configManager, vote)).rejects.toThrow('Pending config already expired')
    })

    test('a signer who flips to reject drops a PENDING envelope back to VOTING and nodes clear it', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const {configManager, model, notificationProvider, MessageTypes} = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps
        })
        await submit(configManager, getSignedEnvelope(proposed, a))
        await submit(configManager, getSignedEnvelope(proposed, b))
        const pending = configManager.getCurrentConfigs().pendingConfig.config
        expect(pending.status).toBe('pending')
        notificationProvider.notify.mockClear()

        await submit(configManager, getSignedEnvelope(proposed, b, {rejected: true, timestamp: pending.timestamp}))
        await jest.advanceTimersByTimeAsync(1000)

        expect(model.__get(pending.id).status).toBe('voting')
        expect(model.__get(pending.id).signatures[1]).toMatchObject({pubkey: b.publicKey(), rejected: true})
        expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('voting')
        const configMessage = notificationProvider.notify.mock.calls.map(call => call[0]).find(m => m.type === MessageTypes.CONFIG)
        expect(configMessage.data.pendingConfig).toBeUndefined()
    })

    test('the initiator withdrawing rejects a PENDING envelope', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const {configManager, model} = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps
        })
        await submit(configManager, getSignedEnvelope(proposed, a))
        await submit(configManager, getSignedEnvelope(proposed, b))
        const pending = configManager.getCurrentConfigs().pendingConfig.config

        await submit(configManager, getSignedEnvelope(proposed, a, {rejected: true, timestamp: pending.timestamp}))
        await jest.advanceTimersByTimeAsync(1000)

        expect(model.__get(pending.id).status).toBe('rejected')
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })
})

describe('envelope submission binding', () => {
    async function votingCluster() {
        const nodeKps = getNodeKeypairs(4) //majority 3, so single votes keep the envelope in VOTING
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const loaded = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps
        })
        return {...loaded, nodeKps, proposed}
    }

    test('an envelope signed by someone other than the authenticated caller is refused', async () => {
        const {configManager, nodeKps, proposed} = await votingCluster()
        const [a, b] = nodeKps
        const envelope = getSignedEnvelope(proposed, a)

        await expect(configManager.create(envelope, b.publicKey()))
            .rejects.toThrow('Envelope must be signed by the authenticated caller')
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })

    test('an anonymous submission is refused', async () => {
        const {configManager, nodeKps, proposed} = await votingCluster()
        const [a] = nodeKps

        await expect(configManager.create(getSignedEnvelope(proposed, a), undefined))
            .rejects.toThrow('Envelope must be signed by the authenticated caller')
    })

    test('a replayed signature is refused and the stored nonce is not lowered', async () => {
        const {configManager, nonceProvider, nodeKps, proposed} = await votingCluster()
        const [a] = nodeKps
        const envelope = getSignedEnvelope(proposed, a)

        await submit(configManager, envelope)
        expect(await nonceProvider.getSignatureNonce(a.publicKey())).toBe(envelope.signatures[0].nonce)

        await expect(submit(configManager, envelope)).rejects.toThrow('Signature nonce is outdated')
        expect(await nonceProvider.getSignatureNonce(a.publicKey())).toBe(envelope.signatures[0].nonce)
        expect(configManager.getCurrentConfigs().pendingConfig.config.signatures).toHaveLength(1)
    })

    test('nonces are tracked per signer, so a second voter is not blocked by the first', async () => {
        const {configManager, nodeKps, proposed} = await votingCluster()
        const [a, b] = nodeKps

        await submit(configManager, getSignedEnvelope(proposed, a))
        await submit(configManager, getSignedEnvelope(proposed, b))

        const signatures = configManager.getCurrentConfigs().pendingConfig.config.signatures
        expect(signatures.map(s => s.pubkey)).toEqual([a.publicKey(), b.publicKey()])
    })

    test('a signature nonce that is not a positive safe integer is refused', async () => {
        const {configManager, nodeKps, proposed} = await votingCluster()
        const [a] = nodeKps
        const envelope = getSignedEnvelope(proposed, a)
        envelope.signatures[0].nonce = Number.MAX_SAFE_INTEGER + 2

        //the nonce is mutated after signing, so the message matters less than the fact that the nonce is what is
        //refused: under 7.1.4 the manager's own range check throws, under 7.2.0 `Signature.__setNonce` throws first
        await expect(submit(configManager, envelope)).rejects.toThrow(/nonce/i)
    })

    test('two proposals submitted at the same time leave one voting document', async () => {
        const {configManager, model, nodeKps, proposed} = await votingCluster()
        const [a, b] = nodeKps
        const other = structuredClone(proposed)
        other.contracts[CONTRACT_ID].period = 8888888

        const results = await Promise.allSettled([
            submit(configManager, getSignedEnvelope(proposed, a)),
            submit(configManager, getSignedEnvelope(other, b))
        ])

        const rejected = results.filter(r => r.status === 'rejected')
        expect(rejected).toHaveLength(1)
        expect(rejected[0].reason.message).toBe('Pending config already exists')
        expect(model.__all().filter(d => d.status === 'voting')).toHaveLength(1)
    })

    test('anonymous broadcasts carry no signatures', async () => {
        const {configManager, notificationProvider, nodeKps, proposed} = await votingCluster()
        const [a] = nodeKps

        await submit(configManager, getSignedEnvelope(proposed, a))

        const broadcast = notificationProvider.notify.mock.calls.map(call => call[0]).find(m => m.type === 'config-created')
        expect(broadcast).toBeDefined()
        expect(broadcast.data.signatures).toBeUndefined()
        expect(broadcast.data.config.clusterSecret).toBeUndefined()
    })
})

describe('shared envelope verifier', () => {
    async function cluster(nodeKps) {
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const loaded = await loadConfigManager({
            docs: [makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'})],
            nodeKps
        })
        return {...loaded, config}
    }

    test('a node the proposal adds cannot vote on it', async () => {
        const nodeKps = getNodeKeypairs(4)
        const newcomer = getNodeKeypairs(5)[4]
        const {configManager} = await cluster(nodeKps)
        const proposed = buildConfig([...nodeKps, newcomer])

        await expect(submit(configManager, getSignedEnvelope(proposed, newcomer)))
            .rejects.toThrow('Signature pubkey doesn\'t exist in config nodes')
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })

    test('a node the proposal removes still votes on it', async () => {
        const nodeKps = getNodeKeypairs(4)
        const leaving = nodeKps[3]
        const {configManager} = await cluster(nodeKps)
        const proposed = buildConfig(nodeKps.slice(0, 3))

        await submit(configManager, getSignedEnvelope(proposed, leaving))

        const pending = configManager.getCurrentConfigs().pendingConfig.config
        expect(pending.status).toBe('voting')
        expect(pending.signatures.map(s => s.pubkey)).toEqual([leaving.publicKey()])
    })

    test('a signature over a different payload is refused', async () => {
        const nodeKps = getNodeKeypairs(4)
        const [a] = nodeKps
        const {configManager, config} = await cluster(nodeKps)
        const proposed = changedConfig(config)
        const envelope = getSignedEnvelope(proposed, a)
        envelope.signatures[0].signature = envelope.signatures[0].signature.replace(/^../, 'ff')

        await expect(submit(configManager, envelope)).rejects.toThrow('Invalid signature')
    })
})

describe('apply step atomicity', () => {
    test('the new envelope is marked applied before the old one is replaced', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied', updatedAt: 1000}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(b)],
                status: 'pending',
                timestamp: 1000, //update time already reached
                updatedAt: 2000,
                isBlockchainUpdate: false //no chain interaction: the status change is the whole apply step
            })
        ]
        const {configManager, model} = await loadConfigManager({docs, nodeKps})

        await jest.advanceTimersByTimeAsync(1000) //processPendingConfig ran during init; updateItems waits a second

        expect(model.__updates.map(u => [u.id, u.update.status])).toEqual([
            ['pending-1', 'applied'],
            ['applied-1', 'replaced']
        ])
        expect(model.__get('pending-1').status).toBe('applied')
        expect(model.__get('applied-1').status).toBe('replaced')
        expect(configManager.getCurrentConfigs().pendingConfig).toBeNull()
    })

    test('init adopts the newest applied envelope and repairs the interrupted pair', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const newer = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-old', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied', updatedAt: 1000}),
            makeDoc({id: 'applied-new', config: newer, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied', updatedAt: 2000})
        ]
        const {configManager, model} = await loadConfigManager({docs, nodeKps})

        const current = configManager.getCurrentConfigs().currentConfig.config
        expect(current.id).toBe('applied-new')
        expect(model.__get('applied-old').status).toBe('replaced')
        expect(model.__get('applied-new').status).toBe('applied')
    })
})

describe('pending config reschedule does not overflow setTimeout', () => {
    test('a pending config far in the future reschedules with the clamped delay instead of busy-looping', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        //90 days out, comfortably past the ~24.8-day limit where a raw ms delay overflows setTimeout's 32-bit clamp
        const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 90
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied'}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(b)],
                status: 'pending',
                timestamp: farFuture,
                isBlockchainUpdate: false
            })
        ]
        //init() already ran processPendingConfig once and scheduled the first reschedule before this line returns
        await loadConfigManager({docs, nodeKps})

        const maxDelay = 2147483647 //Node's largest valid setTimeout delay
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout')

        //fires the timer scheduled by init(); the handler must reschedule exactly once, not thousands of times
        await jest.advanceTimersByTimeAsync(maxDelay)

        expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
        expect(setTimeoutSpy.mock.calls[0][1]).toBe(maxDelay)

        //nowhere near the ~65 remaining days until the pending config's timestamp; a busy loop would refire almost immediately
        await jest.advanceTimersByTimeAsync(100)
        expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    })
})

describe('per-hash update confirmation', () => {
    test('each recorded transaction hash is confirmed on its own, never the joined string', async () => {
        const nodeKps = getNodeKeypairs(3)
        const [a, b] = nodeKps
        const config = buildConfig(nodeKps)
        const proposed = changedConfig(config)
        const docs = [
            makeDoc({id: 'applied-1', config, signatures: [acceptedSignature(a), acceptedSignature(b)], status: 'applied', updatedAt: 1000}),
            makeDoc({
                id: 'pending-1',
                config: proposed,
                signatures: [acceptedSignature(a), acceptedSignature(b)],
                status: 'pending',
                timestamp: 1000, //update time already reached
                updatedAt: 2000,
                txHash: 'hash-one,hash-two',
                hasMoreTxns: false,
                isBlockchainUpdate: true //the chain path is what calls getUpdateTx
            })
        ]
        const {model, rpcHelper} = await loadConfigManager({docs, nodeKps})

        await jest.advanceTimersByTimeAsync(1000)

        //one lookup per hash, each with its own value, never one of the whole comma-joined string
        expect(rpcHelper.getUpdateTx.mock.calls.map(call => call[0])).toEqual(['hash-one', 'hash-two'])
        expect(model.__get('pending-1').status).toBe('applied')
    })
})
