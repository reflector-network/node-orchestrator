import mongoose from 'mongoose'

/**
 * @type {mongoose.Mongoose}
 * @private
 */
let __connection = null

export async function connect(connectionString) {
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
        const { auth } = db.options
        const target = `${auth ? auth.user + '@' : ''}${db.databaseName}`

        console.log('Connected to database ' + target)
    } catch (e) {
        console.error(e)
    }
}

export function disconnect() {
    __connection.close()
    __connection = null
}