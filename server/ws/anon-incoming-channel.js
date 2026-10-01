const ChannelTypes = require('./channel-types')
const IncomingChannelBase = require('./incoming-channel-base')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class AnonIncomingChannel extends IncomingChannelBase {
    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} ip - client address as connection-handler resolves it, never the raw x-forwarded-for header
     */
    constructor(ws, ip) {
        super(ws, null)
        this.ip = ip
        this.validated()
    }

    __getConnectionInfo() {
        return `${this.ip} ${this.type}`
    }

    isAnonymous = true

    type = ChannelTypes.ANON
}

module.exports = AnonIncomingChannel