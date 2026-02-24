const mongoose = require('mongoose')
const logger = require('../logger')

/**
 * @type {mongoose.Mongoose}
 * @private
 */
let __connection = null

async function connect(connectionString) {
    try {
        const options = {
            appname: 'reflector-node-orchestrator',
            promoteValues: true,
            promoteLongs: false,
            directConnection: true,
            retryWrites: true
        }
        __connection = await mongoose.connect(connectionString, options)

        const db = __connection.connection.db
        const {auth} = db.options
        const target = `${auth ? auth.user + '@' : ''}${db.databaseName}`

        logger.info('Connected to database ' + target)
    } catch (e) {
        logger.error(e)
    }
}

async function dropDatabase() {
    if (!__connection)
        return
    await __connection.connection.db.dropDatabase()
}

async function disconnect() {
    await __connection?.connection?.close()
    __connection = null
}

module.exports = {
    connect,
    dropDatabase,
    disconnect
}