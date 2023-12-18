const Server = require('./server/index')
const {connect, disconnect} = require('./persistence-layer/index')
const configProvider = require('./domain/config-provider')
const appConfig = require('./domain/app-config')


/**
 * @returns {Promise<{shutdown: function}>}
 */
async function init() {

    await connect(appConfig.dbConnectionString)

    await configProvider.init(appConfig.defaultNodes)

    const server = new Server(appConfig.port)

    function shutdown(code = 0) {

        console.info('Received kill signal, code = ' + code)

        console.info('Closing server.')

        server.close()

        console.info('Server closed.')

        console.info('Disconnecting from database.')

        disconnect()

        console.info('Disconnected from database.')

        process.exit(code)

    }
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

        return server
    } catch (e) {
        console.error(e)
        shutdown(13)
    }
}

module.exports = init