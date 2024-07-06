const logger = require('./logger')
const {connect, disconnect} = require('./persistence-layer/index')

/**
 * @typedef {import('./domain/container')} Container
 */

/**
 * @param {Container} container
 * @returns {Promise<{shutdown: function}>}
 */
async function init(container) {

    await connect(container.appConfig.dbConnectionString)

    await container.configManager.init(container.appConfig.defaultNodes)

    await container.nodeSettingsManager.init()

    container.server.init(container.appConfig.port)

    async function shutdown(code = 0) {

        logger.info('Received kill signal, code = ' + code)

        logger.info('Closing server.')

        container.server.close()

        logger.info('Server closed.')

        logger.info('Disconnecting from database.')

        await disconnect()

        logger.info('Disconnected from database.')

        process.exit(code)

    }

    container.app = {shutdown}

    try {
        process.on('unhandledRejection', (reason, p) => {
            logger.error({err: reason}, 'Unhandled Rejection at: Promise')
        })

        process.on('SIGINT', async () => {
            await shutdown()
        })

        process.on('SIGTERM', async () => {
            await shutdown()
        })

        return container.server
    } catch (e) {
        logger.error(e)
        await shutdown(13)
    }
}

module.exports = init