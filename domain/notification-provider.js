const logger = require('../logger')
const container = require('./container')

const notificationProvider = {
    /**
     * Broadcast a message to every ready channel of the given type. Each channel gets its own copy, because
     * ChannelBase.send() stamps a requestId onto the object it is handed.
     * @param {any} message - message to send
     * @param {number} [channelType] - channel type filter, -1 for all
     */
    async notify(message, channelType = -1) {
        const channels = container.connectionManager.all(channelType).filter(channel => channel.isReady)
        await Promise.allSettled(channels.map(channel => channel.send({...message})))
    },
    /**
     * @param {any} message - message to send
     * @param {string} pubkey - node public key
     */
    async notifyNode(message, pubkey) {
        try {
            const channel = container.connectionManager.getNodeConnection(pubkey)
            if (!channel?.isReady)
                return
            await channel.send({...message})
        } catch (e) {
            logger.error(`Error notifying node ${pubkey}: ${e.message}`)
        }
    }
}

module.exports = notificationProvider