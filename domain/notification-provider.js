const logger = require('../logger')
const container = require('./container')

const notificationProvider = {
    async notify (message, channelType = -1) {
        const channels = container.connectionManager.all(channelType)
        await Promise.allSettled(channels.map(channel => channel.send(message)))
    },
    async notifyNode(message, pubkey) {
        try {
            const channel = container.connectionManager.getNodeConnection(pubkey)
            await channel.send(message)
        } catch (e) {
            logger.error(`Error notifying node ${pubkey}: ${e.message}`)
        }
    }
}

module.exports = notificationProvider