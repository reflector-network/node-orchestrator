const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const logger = require('../../logger')
const container = require('../../domain/container')
const {isDebugging} = require('../../domain/utils')
const MessageTypes = require('./handlers/message-types')

class ChannelBase {

    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} pubkey - the pubkey of the node
     * */
    constructor(ws, pubkey) {
        if (!ws)
            throw new Error('ws is required')
        this.__ws = ws
        if (this.constructor === ChannelBase)
            throw new Error('ChannelBase is abstract class')
        this.pubkey = pubkey
        this.id = uuidv4()
    }

    /**
     * @type {WebSocket.WebSocket}
     */
    __ws = null

    /**
     * @type {[string]: {resolve: (value: any) => void, reject: (reason?: any) => void}}
     */
    __requests = {}

    /**
     * @type {string}
     */
    pubkey = null

    /**
     * @type {string}
     */
    authPayload = null

    get isOpen() {
        return this.__ws?.readyState === WebSocket.OPEN
    }

    validated() {
        this.__isValidated = true
    }

    __isValidated = false

    //eslint-disable-next-line class-methods-use-this
    get isValidated() {
        return this.__isValidated
    }

    get isReady() {
        return this.isOpen && this.isValidated
    }

    /**
     * @param {any} message - message to send
     * @param {number} [timeout] - response deadline in ms; defaults to 5 s (1 h when debugging)
     * @returns {Promise<any>}
     */
    send(message, timeout = null) {
        return new Promise((resolve, reject) => {
            if (!message.responseId) {
                const requestId = uuidv4()
                message.requestId = requestId
                const requestTimeout = timeout || (isDebugging() ? 60 * 1000 * 60 : 5000)
                const responseTimeout = setTimeout(() => {
                    delete this.__requests[requestId]
                    const error = new Error(`Request timed out after ${requestTimeout}. Message: ${message.type}. ${this.__getConnectionInfo()}`)
                    error.timeout = true
                    reject(error)
                }, requestTimeout)
                this.__requests[requestId] = {
                    resolve,
                    reject,
                    responseTimeout
                }
            }
            try {
                if (!this.__ws || this.__ws.readyState !== WebSocket.OPEN) {
                    const pending = this.__requests[message.requestId]
                    if (pending && !message.responseId) { //nothing was sent, so nothing will answer
                        clearTimeout(pending.responseTimeout)
                        delete this.__requests[message.requestId]
                    }
                    const error = new Error(`Connection is not open. ${this.__getConnectionInfo()}`)
                    error.notConnected = true
                    reject(error)
                    return
                }
                this.__ws.send(JSON.stringify(message), (err) => {
                    if (err) {
                        reject(err)
                    } else {
                        if (message.responseId)
                            resolve()
                    }
                })
            } catch (err) {
                reject(err)
            }
        })
    }

    close(code, reason, terminate = true) {
        if (Buffer.byteLength(reason) > 123) {
            logger.warn(`Reason is too long. Original reason: ${reason}. Truncating to 123 bytes`)
            reason = Buffer.from(reason).subarray(0, 123).toString()
        }
        this.__termination = terminate
        this.__rejectPendingRequests(`${code} ${reason}`)
        const ws = this.__ws
        if (ws) {
            ws.closeTimeout = setTimeout(() => {
                ws.close(code, reason)
            }, 5000)
            if (ws.readyState === WebSocket.CONNECTING) {
                ws.removeAllListeners('open')
                ws.on('open', () => {
                    ws.close(code, reason)
                })
            } else if (ws.readyState === WebSocket.OPEN) {
                ws.close(code, reason)
            } else if (ws.readyState === WebSocket.CLOSED) {
                this.__closeAndInvalidate(ws, code, reason)
            }
        }
    }

    /**
     * Rejects every request still waiting for an answer. Once the socket is going away no answer can arrive, and a
     * caller left waiting would hold its HTTP request open until the send deadline
     * @param {string} reason - why the socket is going away
     * @private
     */
    __rejectPendingRequests(reason) {
        const requests = this.__requests
        this.__requests = {}
        for (const request of Object.values(requests)) {
            clearTimeout(request.responseTimeout)
            const error = new Error(`Connection closed before the peer answered: ${reason}. ${this.__getConnectionInfo()}`)
            error.connectionClosed = true
            request.reject(error)
        }
    }

    /**
     * @protected
     * @returns {WebSocket.WebSocket}
     */
    __assignListeners() {
        return this.__ws
            .addListener('close', (code, reason) => this.__onClose(code, reason))
            .addListener('error', (error) => this.__onError(error))
            .addListener('message', async (message) => await this.__onMessage(message))
    }

    /**
     * @param {any} rawMessage - message from websocket
     * @protected
     */
    async __onMessage(rawMessage) {
        try {
            const message = JSON.parse(rawMessage)
            let result = undefined
            if (message.type !== undefined
                && [MessageTypes.ERROR, MessageTypes.OK].indexOf(message.type) === -1
            ) //message requires handling
                try {
                    result = await container.handlersManager.handle(this, message) || {type: MessageTypes.OK, responseId: message.requestId}
                } catch (e) {
                    logger.debug(e)
                    result = {
                        type: MessageTypes.ERROR,
                        error: e.message,
                        responseId: message.requestId
                    }
                }
            else
                result = message
            if (message.requestId) { //message requires response
                if (!result)
                    result = {type: MessageTypes.ERROR, error: 'No response'}
                else if (result.type === undefined)
                    result = {type: MessageTypes.OK, data: result}
                result.responseId = message.requestId
                await this.send(result)
                return
            }
            if (message.responseId) {
                const request = this.__requests[message.responseId]
                if (request) {
                    delete this.__requests[message.responseId]
                    clearTimeout(request.responseTimeout)
                    if (message.type === MessageTypes.ERROR) {
                        const error = new Error(message.error)
                        error.isPeerError = true
                        request.reject(error)
                    } else if (result.type === MessageTypes.ERROR) { //the handler for the response frame threw
                        const error = new Error(result.error)
                        error.isPeerError = true
                        request.reject(error)
                    } else
                        request.resolve(result.data) //resolve the promise with the result
                }
            }
        } catch (e) {
            this.__onError(e)
        }
    }

    __onClose(code, reason) {
        this.__closeAndInvalidate(this.__ws, code, reason)
    }

    __closeAndInvalidate(ws, code, reason) {
        if (!ws)
            return
        this.__rejectPendingRequests(`${code} ${String(reason || '') || 'abnormal'}`) //ws hands the reason over as a Buffer
        ws.closeTimeout && clearTimeout(ws.closeTimeout)
        if (ws.readyState !== WebSocket.CLOSED) {
            logger.warn(`${this.__getConnectionInfo()} was not closed properly (${ws.readyState}). Terminating...`)
            try {
                ws.terminate()
            } catch (e) {
                logger.error(e)
            }
        }
        if (this.__ws === ws) {
            this.__ws = null
            this.__isValidated = false
        }
        logger.debug(`${this.__getConnectionInfo()} closed with code ${code} and reason ${reason || 'abnormal'}`)
        container.connectionManager.remove(this.id)
    }

    __onError(error) {
        logger.debug(`${this.__getConnectionInfo()} websocket error`)
        logger.debug(error)
        //ws starts closing before it reports a protocol error such as an oversized frame (1009), and the close event
        //follows only once the peer answers the close frame
        if (this.__ws && this.__ws.readyState !== WebSocket.OPEN)
            this.__rejectPendingRequests(error.message)
    }

    __getConnectionInfo() {
        return `${this.pubkey} ${this.type}`
    }
}

module.exports = ChannelBase