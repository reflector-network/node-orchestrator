const container = require('../../../domain/container')
const BaseHandler = require('./base-handler')

class ConfigRequestHandler extends BaseHandler {
    handle() {
        return container.configManager.getConfigMessage()
    }
}

module.exports = ConfigRequestHandler