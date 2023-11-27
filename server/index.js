import http from 'http'
import express from 'express'
import bodyParser from 'body-parser'
import registerSwaggerRoute from './swagger.js'
import { HttpError, badRequest } from './errors.js'
import configRoutes from './routes/config-routes.js'
import { WebSocketServer } from 'ws'
import { ValidationError } from '@reflector/reflector-shared'

function normalizePort(val) {
    const port = parseInt(val, 10)
    if (isNaN(port))
        return val
    if (port >= 0)
        return port
    throw new Error('Invalid port')
}

class Server {
    constructor(port) {
        this.port = normalizePort(port)
        this.init()
    }

    init() {
        //create Express server instance
        this.app = express()

        //set basic Express settings
        this.app.disable('x-powered-by')

        this.app.use(bodyParser.json())
        this.app.use(bodyParser.urlencoded({ extended: false }))

        //register routes
        registerSwaggerRoute(this.app)
        configRoutes(this.app)

        const wss = new WebSocketServer({ noServer: true })

        wss.on('connection', function connection(ws) {
            ws.on('message', function incoming(message) {
                console.log('received: %s', message)
            })
        })

        //error handler
        this.app.use((err, req, res, next) => {
            if (err) {
                if (process.env.NODE_ENV === 'test')
                    console.error(err.message)
                else
                    console.error(err)

                if (res.headersSent)
                    return next(err)
                if (err instanceof ValidationError)
                    err = badRequest(err.message, err.details)
                if (err instanceof HttpError)
                    return res.status(err.code).json({ error: err.message, status: err.code })
                //unhandled error
                console.error(err)
                res.status(500).json({ error: 'Internal server error', status: 500 })
            }
            res.status((err && err.code) || 500).end()
        })

        //set API port
        this.app.set('port', this.port)

        //instantiate server
        this.server = http.createServer(this.app)

        this.server.listen(this.port)
        this.server.on('listening', () => console.log('Http server listening on ' + this.server.address().address + ':' + this.port))
        this.server.on('error', (error) => {
            if (error.syscall !== 'listen')
                throw error
            const bind = typeof this.port === 'string' ? 'Pipe ' + this.port : 'Port ' + this.port
            switch (error.code) {
                case 'EACCES':
                    console.error(bind + ' requires elevated privileges')
                    process.exit(1)
                case 'EADDRINUSE':
                    console.error(bind + ' is already in use')
                    process.exit(1)
                default:
                    throw error
            }
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

export default Server