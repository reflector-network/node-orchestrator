/*eslint-disable no-undef */
const ChannelTypes = require('../server/ws/channel-types')

function makeConnection({
    id,
    pubkey = null,
    type = ChannelTypes.INCOMING,
    isNode = true,
    isValidated = true,
    remoteAddress = '10.0.0.1',
    isAnonymous = false
}) {
    return {id, pubkey, type, isNode, isValidated, remoteAddress, isAnonymous, close: jest.fn()}
}

describe('ConnectionManager', () => {
    let manager
    let container

    beforeEach(() => {
        jest.resetModules() //the manager keeps module-level maps
        container = require('../domain/container')
        container.configManager = {notifyNodeAboutUpdate: jest.fn()}
        const ConnectionManager = require('../domain/connections-manager')
        manager = new ConnectionManager()
    })

    test('refuses to add an unvalidated incoming connection', () => {
        const connection = makeConnection({id: 'c1', pubkey: 'GA', isValidated: false})
        expect(() => manager.add(connection)).toThrow('Connection is not validated')
        expect(manager.getNodeConnection('GA')).toBeUndefined()
        expect(container.configManager.notifyNodeAboutUpdate).not.toHaveBeenCalled()
    })

    test('a validated replacement evicts the previous node connection and is notified', () => {
        const old = makeConnection({id: 'old', pubkey: 'GA'})
        const replacement = makeConnection({id: 'new', pubkey: 'GA'})
        manager.add(old)
        manager.add(replacement)
        expect(old.close).toHaveBeenCalledWith(1001, 'Connection replaced', true)
        expect(manager.getNodeConnection('GA')).toBe(replacement)
        expect(container.configManager.notifyNodeAboutUpdate).toHaveBeenCalledTimes(2)
    })

    test('the replacement keeps its mapping when the superseded socket closes later', () => {
        const old = makeConnection({id: 'old', pubkey: 'GA'})
        const replacement = makeConnection({id: 'new', pubkey: 'GA'})
        manager.add(old)
        manager.add(replacement)

        manager.remove('old') //the old socket's close event arrives after the replacement was mapped

        expect(manager.getNodeConnection('GA')).toBe(replacement)
        expect(manager.getNodeConnections()).toEqual([replacement])
    })

    test('nodes are not capped per address: seven nodes behind one proxy all connect', () => {
        //every node arrives from the proxy's address when TLS is terminated in front of the orchestrator
        for (let i = 0; i < 7; i++) {
            const connection = makeConnection({id: `c${i}`, pubkey: `G${i}`})
            manager.track(connection)
            manager.add(connection)
        }
        expect(manager.getNodeConnections().map(c => c.pubkey)).toEqual(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'])
        expect(manager.countByAddress('10.0.0.1')).toBe(0) //the per-address count is for anonymous clients only
    })

    test('a third validated connection for a pubkey is refused before its handshake', () => {
        const first = makeConnection({id: 'v1', pubkey: 'GA'})
        const second = makeConnection({id: 'v2', pubkey: 'GA'})
        manager.add(first)
        manager.add(second) //replaces first as the node mapping; first stays registered until its socket closes

        expect(manager.countValidatedByPubkey('GA')).toBe(2)
        expect(() => manager.track(makeConnection({id: 'v3', pubkey: 'GA', isValidated: false})))
            .toThrow('Too many connections for pubkey')
        expect(manager.countPendingByPubkey('GA')).toBe(0)
        expect(() => manager.track(makeConnection({id: 'b1', pubkey: 'GB', isValidated: false}))).not.toThrow()
    })

    test('two handshakes completing together cannot register a third validated connection', () => {
        manager.add(makeConnection({id: 'v1', pubkey: 'GA'}))
        const racing = [makeConnection({id: 'r1', pubkey: 'GA'}), makeConnection({id: 'r2', pubkey: 'GA'})]
        for (const connection of racing)
            manager.track(connection) //both admitted while only one slot was taken
        manager.add(racing[0])

        expect(() => manager.add(racing[1])).toThrow('Too many connections for pubkey')
        expect(manager.countValidatedByPubkey('GA')).toBe(2)
        expect(manager.getNodeConnection('GA')).toBe(racing[0])
        expect(manager.get('r2')).toBeUndefined()
        expect(manager.countPendingByPubkey('GA')).toBe(0)
    })

    test('a new handshake past two pending closes the oldest pending one for the pubkey', () => {
        const pending = [1, 2, 3].map(i => makeConnection({id: `p${i}`, pubkey: 'GA', isValidated: false}))
        manager.track(pending[0])
        manager.track(pending[1])
        manager.track(makeConnection({id: 'b1', pubkey: 'GB', isValidated: false}))
        manager.track(pending[2])

        expect(pending[0].close).toHaveBeenCalledWith(1008, 'Handshake superseded', true)
        expect(pending[1].close).not.toHaveBeenCalled()
        expect(pending[2].close).not.toHaveBeenCalled()
        expect(manager.countPendingByPubkey('GA')).toBe(2)
        expect(manager.countPendingByPubkey('GB')).toBe(1)
    })

    test('a superseded handshake leaves no trace and cannot register if its answer arrives late', () => {
        const evicted = makeConnection({id: 'p1', pubkey: 'GA', isValidated: false})
        manager.track(evicted)
        manager.track(makeConnection({id: 'p2', pubkey: 'GA', isValidated: false}))
        manager.track(makeConnection({id: 'p3', pubkey: 'GA', isValidated: false}))

        evicted.isValidated = true //its signature arrived after it was closed
        expect(() => manager.add(evicted)).toThrow('Handshake superseded')
        expect(manager.get('p1')).toBeUndefined()
        expect(manager.getNodeConnection('GA')).toBeUndefined()
        expect(manager.countValidatedByPubkey('GA')).toBe(0)
        expect(manager.countPendingByPubkey('GA')).toBe(2)
        manager.remove('p1') //its socket's close event
        expect(manager.countPendingByPubkey('GA')).toBe(2)
        expect(container.configManager.notifyNodeAboutUpdate).not.toHaveBeenCalled()
    })

    test('pending handshakes never take a validated slot', () => {
        manager.track(makeConnection({id: 'p1', pubkey: 'GA', isValidated: false}))
        manager.track(makeConnection({id: 'p2', pubkey: 'GA', isValidated: false}))
        const real = makeConnection({id: 'real', pubkey: 'GA'})
        manager.track(real)
        manager.add(real)
        const second = makeConnection({id: 'second', pubkey: 'GA'})
        manager.track(second)
        manager.add(second)

        expect(manager.countValidatedByPubkey('GA')).toBe(2)
        expect(manager.getNodeConnection('GA')).toBe(second)
    })

    test('closing a pending node connection frees its pending slot', () => {
        manager.track(makeConnection({id: 'c1', pubkey: 'GA', isValidated: false}))
        manager.track(makeConnection({id: 'c2', pubkey: 'GA', isValidated: false}))
        expect(manager.countPendingByPubkey('GA')).toBe(2)
        manager.remove('c1')
        expect(manager.countPendingByPubkey('GA')).toBe(1)
    })

    test('per-address cap counts pending and registered anonymous connections', () => {
        const anon = (id, remoteAddress = '10.0.0.1') =>
            makeConnection({id, type: ChannelTypes.ANON, isNode: false, isAnonymous: true, remoteAddress})
        for (let i = 0; i < 4; i++)
            manager.track(anon(`a${i}`))
        const registered = anon('a4')
        manager.track(registered)
        manager.add(registered)
        //node connections from the same address do not use up the anonymous allowance
        manager.track(makeConnection({id: 'n1', pubkey: 'GA'}))

        expect(manager.countByAddress('10.0.0.1')).toBe(5)
        expect(() => manager.track(anon('a5'))).toThrow('Too many connections from address')
        expect(() => manager.track(anon('other', '10.0.0.2'))).not.toThrow()
    })

    test('closing a pending anonymous connection frees its address slot', () => {
        manager.track(makeConnection({id: 'a1', type: ChannelTypes.ANON, isNode: false, isAnonymous: true}))
        expect(manager.countByAddress('10.0.0.1')).toBe(1)
        manager.remove('a1')
        expect(manager.countByAddress('10.0.0.1')).toBe(0)
    })

    test('anonymous connections are capped globally', () => {
        for (let i = 0; i < 100; i++) {
            const connection = makeConnection({
                id: `a${i}`,
                type: ChannelTypes.ANON,
                isNode: false,
                isAnonymous: true,
                remoteAddress: `10.0.${Math.floor(i / 4)}.${i % 4}`
            })
            manager.track(connection)
            manager.add(connection)
        }
        const extra = makeConnection({id: 'a100', type: ChannelTypes.ANON, isNode: false, isAnonymous: true, remoteAddress: '10.9.0.1'})
        expect(() => manager.track(extra)).toThrow('Too many anonymous connections')
    })
})
