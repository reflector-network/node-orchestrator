const container = require('../../domain/container')
const {notFound, serviceUnavailable} = require('../errors')

/**
 * The connection to relay a request to. A key that is not a node is a wrong target (404); a node that has no
 * connection right now is a passing condition the caller can retry (503)
 * @param {string} pubkey - target node public key
 * @returns {IncomingChannel}
 */
function getConnectedNode(pubkey) {
    const node = container.connectionManager.getNodeConnection(pubkey)
    if (node)
        return node
    if (!container.configManager.hasNode(pubkey))
        throw notFound('Node not found')
    const error = serviceUnavailable('Node is not connected')
    error.isRelayError = true
    throw error
}

module.exports = {getConnectedNode}
