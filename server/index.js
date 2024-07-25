const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const {WebSocketServer} = require('ws')
const {ValidationError} = require('@reflector/reflector-shared')
const {StrKey} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const container = require('../domain/container')
const MessageTypes = require('./ws/handlers/message-types')
const registerSwaggerRoute = require('./swagger')
const {HttpError, badRequest} = require('./errors')
const configRoutes = require('./routes/config-routes')
const IncomingChannel = require('./ws/incoming-channel')
const AnonIncomingChannel = require('./ws/anon-incoming-channel')
const statisticsRoutes = require('./routes/statistics-routes')
const logRoutes = require('./routes/log-routes')
const settingsRoutes = require('./routes/node-settings-routes')
const subscriptionRoutes = require('./routes/subscription-routes')

function normalizePort(val) {
    const port = parseInt(val, 10)
    if (isNaN(port))
        return val
    if (port >= 0)
        return port
    throw new Error('Invalid port')
}

class Server {
    init(port) {
        this.port = normalizePort(port)
        //create Express server instance
        this.app = express()

        //set basic Express settings
        this.app.disable('x-powered-by')

        this.app.use(bodyParser.json())
        this.app.use(bodyParser.urlencoded({extended: false}))

        //register routes
        registerSwaggerRoute(this.app)
        configRoutes(this.app)
        statisticsRoutes(this.app)
        logRoutes(this.app)
        settingsRoutes(this.app)
        subscriptionRoutes(this.app)

        const wss = new WebSocketServer({noServer: true})

        wss.on('connection', async function connection(ws, req) {
            try {
                const {pubkey, app} = req.headers
                let connection = null
                if (pubkey) {
                    if (!StrKey.isValidEd25519PublicKey(pubkey))
                        throw new ValidationError('pubkey is invalid')
                    if (!container.configManager.hasNode(pubkey))
                        throw new ValidationError('pubkey is not registered')
                    connection = new IncomingChannel(ws, pubkey, app === 'node')
                    await connection.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: connection.authPayload}})
                } else {
                    connection = new AnonIncomingChannel(ws, req.headers['x-forwarded-for'] || req.socket.remoteAddress)
                }
                container.connectionManager.add(connection)
                logger.debug(`New connection from ${connection.ip || connection.pubkey} established`)
            } catch (e) {
                if (!(e instanceof ValidationError))
                    logger.error(e)
                ws.close(1008, e.message)
            }
        })

        //error handler
        this.app.use((err, req, res, next) => {
            if (err) {
                if (process.env.NODE_ENV === 'test')
                    logger.error(err.message)
                else
                    logger.error(err)

                if (res.headersSent)
                    return next(err)
                if (err instanceof ValidationError)
                    err = badRequest(err.message, err.details)
                if (err instanceof HttpError)
                    return res.status(err.code).json({error: err.message, status: err.code})
                //unhandled error
                logger.error(err)
                res.status(500).json({error: 'Internal server error', status: 500})
            }
            res.status((err && err.code) || 500).end()
        })

        //set API port
        this.app.set('port', this.port)

        //instantiate server
        this.server = http.createServer(this.app)

        this.server.listen(this.port)
        this.server.on('listening', () => logger.info('Http server listening on ' + this.server.address().address + ':' + this.port))
        this.server.on('error', (error) => {
            if (error.syscall !== 'listen')
                throw error
            const bind = typeof this.port === 'string' ? 'Pipe ' + this.port : 'Port ' + this.port
            switch (error.code) {
                case 'EACCES': {
                    logger.error(bind + ' requires elevated privileges')
                    break
                }
                case 'EADDRINUSE': {
                    logger.error(bind + ' is already in use')
                    break
                }
                default:
                    logger.error(error)
            }
            throw error
        })

        //Integrate WebSocket server with HTTP server
        this.server.on('upgrade', (request, socket, head) => {
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request)
            })
        })
    }

    close() {
        this.server.close()
    }
}

module.exports = Server