const logger = require('../logger')
const MessageTypes = require('../server/ws/handlers/message-types')
const container = require('./container')

async function getStatistics() {
    try {
        const nodes = container.configManager.allNodePubkeys()
        const requests = []
        for (const pubkey of nodes) {
            const channel = container.connectionManager.getNodeConnection(pubkey)
            const request = async () => {
                const result = {pubkey, statistics: null}
                try {
                    if (channel) {
                        const statisticsData = await channel.send({type: MessageTypes.STATISTICS_REQUEST})
                        const currentTimestamp = Date.now()
                        statisticsData.timeshift = currentTimestamp - statisticsData.currentTime
                        result.statistics = statisticsData
                    }
                } catch (e) {
                    logger.error(`Error requesting statistics from node ${pubkey}: ${e.message}`)
                }
                return result
            }
            requests.push(request())
        }
        const responses = await Promise.allSettled(requests)
        const nodeStatistics = {}
        for (const response of responses) {
            const {pubkey, statistics} = response.value
            nodeStatistics[pubkey] = statistics
        }
        const configData = container.configManager.getCurrentConfigs()
        addStatistics({
            nodeStatistics,
            currentTimestamp: Date.now(),
            currentConfigHash: configData.currentConfig?.hash,
            pendingConfigHash: configData.pendingConfig?.hash
        })
    } catch (e) {
        logger.error(`Error requesting statistics: ${e.message}`)
        return null
    } finally {
        setTimeout(getStatistics, 10000)
    }
}

function addStatistics(statisticsData) {
    statistics.push(statisticsData)
    if (statistics.length > 100)
        statistics.shift()
}

/**
 * @type {Map<string, any>}
 */
const statistics = []

class StatisticsManager {

    constructor() {
        setTimeout(getStatistics, 10000)
    }

    getStatistics() {
        return statistics
    }
    removeByPubkey(pubkey) {
        statistics.delete(pubkey)
    }
}

module.exports = StatisticsManager