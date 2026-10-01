const logger = require('./logger')
const nonceProvider = require('./domain/nonce-provider')
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

    //replay protection is only atomic while the unique index exists, and a silent index-build failure would disable it
    //without a trace, so the index is built here, then checked, and the service refuses to come up rather than serving
    //requests it cannot protect
    await nonceProvider.init()

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