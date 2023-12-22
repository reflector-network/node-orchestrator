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

    container.server.init(container.appConfig.port)

    function shutdown(code = 0) {

        console.info('Received kill signal, code = ' + code)

        console.info('Closing server.')

        container.server.close()

        console.info('Server closed.')

        console.info('Disconnecting from database.')

        disconnect()

        console.info('Disconnected from database.')

        process.exit(code)

    }

    container.app = {shutdown}

    try {
        process.on('unhandledRejection', (reason, p) => {
            console.error('Unhandled Rejection at: Promise')
            console.error(reason)
        })

        process.on('SIGINT', () => {
            shutdown()
        })

        process.on('SIGTERM', () => {
            shutdown()
        })

        return container.server
    } catch (e) {
        console.error(e)
        shutdown(13)
    }
}

module.exports = init