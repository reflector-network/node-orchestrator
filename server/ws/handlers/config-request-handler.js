const container = require('../../../domain/container')
const ChannelTypes = require('../channel-types')
const BaseHandler = require('./base-handler')

class ConfigRequestHandler extends BaseHandler {

    allowedChannelTypes = [ChannelTypes.INCOMING]

    handle() {
        return container.configManager.getConfigMessage()
    }
}

module.exports = ConfigRequestHandler