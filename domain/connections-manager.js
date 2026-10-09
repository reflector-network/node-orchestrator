/**
 * @typedef {import('../server/ws/incoming-channel-base')} IncomingChannelBase
 * @typedef {import('../server/ws/incoming-channel')} IncomingChannel
 */

const {ValidationError} = require('@reflector/reflector-shared')
const ChannelTypes = require('../server/ws/channel-types')
const container = require('./container')

//Anonymous clients are capped by client address (the socket peer, or the address a trusted proxy forwards, see
//server/ws/connection-handler.js) and in total.
const maxConnectionsPerAddress = 5

const maxAnonymousConnections = 100

//Node connections are capped per pubkey instead, never per address: behind a TLS-terminating proxy every node shares
//the proxy's address, and a per-address cap refused every node past the fifth. handleConnection admits a pubkey only
//when it is a registered node, and registered nodes are a small bounded set, so this bounds node connections without
//any address. Validated and pending connections are counted separately, so a handshake nobody has answered can never
//take a validated slot:
//- validated (handshake passed): at most 2 per pubkey, which lets a reconnecting node register its new connection
//while the old one closes. A further one is refused, before its handshake when both slots are already taken, or when
//it is added if two handshakes for the pubkey completed at once.
//- pending (handshake not answered yet): at most 2 per pubkey. A new handshake past that closes the oldest pending
//one for the pubkey instead of being refused, so the pending handshakes this manager tracks stay bounded at
//2 x nodeCount. An evicted socket leaves the manager at once, and so does its handshake, whose pending challenge is
//rejected on close; connection-handler destroys the socket 1 s after its close frame (refusedSocketGrace).
//Pubkeys are public and anyone can claim one, so a new handshake evicts the oldest pending one for its key: each
//new connection from the real node evicts one, and the real node answers its challenge within a round trip.
//maxPendingPerPubkey sets how many a key may hold, at one pending socket per slot per node.
const maxValidatedPerPubkey = 2

const maxPendingPerPubkey = 2

/**
 * Registered connections: handshake completed, or anonymous
 * @type {Map<string, IncomingChannelBase>}
 */
const connections = new Map()

/**
 * Connections whose handshake is still in progress
 * @type {Map<string, IncomingChannelBase>}
 */
const pendingConnections = new Map()

/**
 * @type {Map<string, IncomingChannel>}
 */
const nodeConnections = new Map()

/**
 * Pending handshakes closed to make room for a newer one; they may no longer register even if their answer arrives
 * @type {WeakSet<IncomingChannelBase>}
 */
const supersededConnections = new WeakSet()

/**
 * @param {Iterable<IncomingChannelBase>} source - connections to look through
 * @param {string} pubkey - node public key
 * @returns {IncomingChannelBase[]} node connections claiming the pubkey, oldest first
 */
function byPubkey(source, pubkey) {
    return [...source].filter(connection => !connection.isAnonymous && connection.pubkey === pubkey)
}

/**
 * Close a pending handshake to make room for a newer one for the same pubkey
 * @param {IncomingChannelBase} connection - pending connection to drop
 */
function supersede(connection) {
    pendingConnections.delete(connection.id)
    supersededConnections.add(connection)
    connection.close(1008, 'Handshake superseded', true)
}

class ConnectionManager {
    /**
     * Reserve a slot for a connection before its handshake starts
     * @param {IncomingChannelBase} connection - connection to track
     */
    track(connection) {
        if (connection.isAnonymous) {
            if (this.countByAddress(connection.remoteAddress) >= maxConnectionsPerAddress)
                throw new ValidationError('Too many connections from address')
            if (this.all(ChannelTypes.ANON).length >= maxAnonymousConnections)
                throw new ValidationError('Too many anonymous connections')
        } else {
            if (this.countValidatedByPubkey(connection.pubkey) >= maxValidatedPerPubkey)
                throw new ValidationError('Too many connections for pubkey')
            const pending = byPubkey(pendingConnections.values(), connection.pubkey)
            for (const oldest of pending.slice(0, pending.length - maxPendingPerPubkey + 1))
                supersede(oldest)
        }
        pendingConnections.set(connection.id, connection)
    }

    /**
     * @param {string} remoteAddress - client address
     * @returns {number} tracked plus registered anonymous connections from that address
     */
    countByAddress(remoteAddress) {
        return this.__count([pendingConnections, connections],
            connection => connection.isAnonymous && connection.remoteAddress === remoteAddress)
    }

    /**
     * @param {string} pubkey - node public key
     * @returns {number} registered connections for that pubkey, whose handshake passed
     */
    countValidatedByPubkey(pubkey) {
        return this.__count([connections], connection => !connection.isAnonymous && connection.pubkey === pubkey)
    }

    /**
     * @param {string} pubkey - node public key
     * @returns {number} connections claiming that pubkey whose handshake is still in progress
     */
    countPendingByPubkey(pubkey) {
        return this.__count([pendingConnections], connection => !connection.isAnonymous && connection.pubkey === pubkey)
    }

    /**
     * @param {Map<string, IncomingChannelBase>[]} maps - connection maps to look through
     * @param {function(IncomingChannelBase): boolean} predicate - connection filter
     * @returns {number} connections in those maps matching the filter
     * @private
     */
    __count(maps, predicate) {
        let count = 0
        for (const connection of maps.flatMap(map => [...map.values()])) {
            if (predicate(connection))
                count++
        }
        return count
    }

    /**
     * @param {IncomingChannelBase} connection - connection to add
     */
    add(connection) {
        pendingConnections.delete(connection.id)
        if (connection.type === ChannelTypes.INCOMING) {
            if (!connection.isValidated)
                throw new ValidationError('Connection is not validated')
            if (supersededConnections.has(connection))
                throw new ValidationError('Handshake superseded')
            if (this.countValidatedByPubkey(connection.pubkey) >= maxValidatedPerPubkey) //it is not registered yet
                throw new ValidationError('Too many connections for pubkey')
            if (connection.isNode) {
                const nodeConnection = nodeConnections.get(connection.pubkey)
                if (nodeConnection && nodeConnection !== connection)
                    nodeConnection.close(1001, 'Connection replaced', true) //only one node connection allowed
                nodeConnections.set(connection.pubkey, connection)
                container.configManager.notifyNodeAboutUpdate(connection.pubkey)
            }
        }
        connections.set(connection.id, connection)
    }

    /**
     * @param {string} id - connection id
     */
    remove(id) {
        pendingConnections.delete(id)
        const connection = connections.get(id)
        if (!connection)
            return
        connections.delete(id)
        connection.close(1001, 'Connection closed', true)
        if (connection.type === ChannelTypes.INCOMING && connection.isNode
            && nodeConnections.get(connection.pubkey) === connection) //the pubkey may already point at a replacement
            nodeConnections.delete(connection.pubkey)
    }

    /**
     * @param {string} id - connection id
     * @returns {IncomingChannelBase}
     */
    get(id) {
        return connections.get(id)
    }

    /**
     * @returns {IncomingChannel[]}
     */
    getNodeConnections() {
        return [...nodeConnections.values()]
    }

    /**
     * @param {string} pubkey - pubkey
     * @returns {IncomingChannel}
     */
    getNodeConnection(pubkey) {
        return nodeConnections.get(pubkey)
    }

    /**
     * @param {string} pubkey - pubkey
     */
    removeByPubkey(pubkey) {
        for (const connection of this.getNodeConnections()) {
            if (connection.pubkey !== pubkey)
                continue
            this.remove(connection.id)
        }
    }

    /**
     * @param {number} channelType - channel type
     * @returns {IncomingChannelBase[]}
     */
    all(channelType = -1) {
        if (channelType !== -1)
            return [...connections.values()].filter(c => c.type === channelType)
        return [...connections.values()]
    }
}

module.exports = ConnectionManager
