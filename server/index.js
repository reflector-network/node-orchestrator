const http = require('http')
const express = require('express')
const bodyParser = require('body-parser')
const {WebSocketServer} = require('ws')
const {ValidationError} = require('@reflector/reflector-shared')
const logger = require('../logger')
const container = require('../domain/container')
const registerSwaggerRoute = require('./swagger')
const {HttpError, badRequest} = require('./errors')
const configRoutes = require('./routes/config-routes')
const registerLokiProxy = require('./loki-proxy').registerLokiProxy
const {handleConnection, isNodeUpgrade, nodeWsServerOptions, wsServerOptions} = require('./ws/connection-handler')
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

        registerLokiProxy(this.app, container.appConfig.lokiUrl)

        //two servers because ws fixes the frame cap per server: nodes answer with whole log files, anonymous clients
        //only listen, so they keep the small cap
        const wss = new WebSocketServer(wsServerOptions)
        const nodeWss = new WebSocketServer(nodeWsServerOptions)
        for (const wsServer of [wss, nodeWss])
            wsServer.on('connection', (ws, req) => handleConnection(ws, req))

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
            const target = isNodeUpgrade(request) ? nodeWss : wss
            target.handleUpgrade(request, socket, head, (ws) => {
                target.emit('connection', ws, request)
            })
        })
    }

    close() {
        this.server.close()
    }
}

module.exports = Server