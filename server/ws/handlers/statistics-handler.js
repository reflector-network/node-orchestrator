const ChannelTypes = require('../channel-types')
const BaseHandler = require('./base-handler')

class StatisticsHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.INCOMING]

    /**
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        return message.data
    }
}

module.exports = StatisticsHandler