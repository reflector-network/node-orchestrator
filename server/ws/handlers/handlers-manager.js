const MessageTypes = require('./message-types')
const HandshakeResponseHandler = require('./handshake-response-handler')
const StatisticsHandler = require('./statistics-handler')

/**
 * @typedef {import('../channels/channel-base')} ChannelBase
 */

class HandlersManager {

    constructor() {
        this.handlers = {
            [MessageTypes.HANDSHAKE_RESPONSE]: new HandshakeResponseHandler(),
            [MessageTypes.STATISTICS]: new StatisticsHandler()
        }
    }

    /**
     * @param {ChannelBase} channel - channel type
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const handler = this.handlers[message.type]
        if (!handler)
            throw new Error(`Message type ${message.type} is not supported`)
        if (!handler.allowAnonymous && !channel.isValidated)
            throw new Error(`Message type ${message.type} is not allowed for anonymous channel`)
        if (!handler.allowedChannelTypes & channel)
            throw new Error(`Message type ${message.type} is not supported for channel ${channel}`)
        return await handler.handle(channel, message)
    }
}

module.exports = HandlersManager