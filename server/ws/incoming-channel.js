const {v4: uuidv4} = require('uuid')
const IncomingChannelBase = require('./incoming-channel-base')
const ChannelTypes = require('./channel-types')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class IncomingChannel extends IncomingChannelBase {


    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} pubkey - the pubkey of the node
     * @param {boolean} isNode - is the node
     */
    constructor(ws, pubkey, isNode) {
        super(ws, pubkey)
        if (!pubkey)
            throw new Error('pubkey is required')
        this.isNode = isNode
    }

    authPayload = uuidv4()

    type = ChannelTypes.INCOMING
}

module.exports = IncomingChannel