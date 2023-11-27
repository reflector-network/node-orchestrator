import Server from './server/index.js'
import {connect, disconnect} from './persistence-layer/index.js'
import configProvider from './domain/config-provider.js'
import fs from 'fs'


/**
 * @returns {Promise<{shutdown: function}>}
 */
async function init() {
    if (!fs.existsSync('./home/app.config.json'))
        throw new Error('app.config.json not found')
    const config = JSON.parse(fs.readFileSync('./home/app.config.json'))

    await connect(config.dbConnectionString)
    
    await configProvider.init(config.defaultNodes)

    const server = new Server(config.port)

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

export default init