

/**
 * @typedef {import('../server/ws/incoming-channel-base')} IncomingChannelBase
 * @typedef {import('../server/ws/incoming-channel')} IncomingChannel
 */

const ChannelTypes = require('../server/ws/channel-types')
const container = require('./container')

/**
 * @type {Map<string, IncomingChannelBase>}
 */
const connections = new Map()

/**
 * @type {Map<string, IncomingChannel>}
 */
const nodeConnections = new Map()

class ConnectionManager {
    /**
     * @param {IncomingChannelBase} connection - connection to add
     */
    add(connection) {
        const presentedConnection = [connections.values()].filter(c => c.pubkey === connection.pubkey && c.ip === connection.ip)
        if (presentedConnection.length > 3)
            throw new Error('Too many connections')
        if (connection.type === ChannelTypes.INCOMING) {
            if (connection.isNode) {
                const nodeConnection = nodeConnections.get(connection.pubkey)
                if (nodeConnection)
                    nodeConnection.close(1001, 'Connection closed', true) //only one node connection allowed
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
        const connection = connections.get(id)
        if (!connection)
            return
        connections.delete(id)
        connection.close(1001, 'Connection closed', true)
        if (connection.type === ChannelTypes.INCOMING) {
            if (connection.isNode) {
                nodeConnections.delete(connection.pubkey)
            }
        }
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
        for (const connection of ConnectionManager.values()) {
            if (connection.pubkey !== pubkey)
                continue
            ConnectionManager.remove(connection.id)
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