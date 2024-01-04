const WebSocket = require('ws')
const {v4: uuidv4} = require('uuid')
const logger = require('../../logger')
const contrainer = require('../../domain/container')
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

    removeAllListeners() {
        this.__ws?.removeAllListeners()
    }

    /**
     * @param {any} message - message to send
     * @returns {Promise<any>}
     */
    send(message) {
        return new Promise((resolve, reject) => {
            if (!message.responseId) {
                message.requestId = uuidv4()
                const responseTimeout = setTimeout(() => {
                    delete this.__requests[message.requestId]
                    const error = new Error('Request timed out')
                    error.timeout = true
                    reject(error)
                }, 5000000)
                this.__requests[message.requestId] = {
                    resolve,
                    reject,
                    responseTimeout
                }
            }
            try {
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
        this.__termination = terminate
        if (this.__ws) {
            this.__ws.removeAllListeners()
            this.__ws.closeTimeout = setTimeout(() => {
                if (this.__ws.readyState !== WebSocket.CLOSED) {
                    logger.debug('Server did not close connection in time, forcefully closing')
                    this.__ws.terminate()
                }
            }, 5000)
            if (this.__ws.readyState === WebSocket.CONNECTING || this.__ws.readyState === WebSocket.OPEN) {
                this.__ws.close(code, reason)
            }
        }
        this.__isValidated = false
    }

    /**
     * @protected
     */
    __assignListeners() {
        this.__ws
            .addListener('close', (code, reason) => this.__onClose(code, reason))
            .addListener('error', (error) => this.__onError(error))
            .addListener('message', async (message) => await this.__onMessage(message))
    }

    /**
     * @protected
     */
    __onOpen() {
        this.__assignListeners()
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
                    result = await contrainer.handlersManager.handle(this, message) || {type: MessageTypes.OK, responseId: message.requestId}
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
                    if (message.type === MessageTypes.ERROR)
                        request.reject(new Error(message.error))
                    else
                        request.resolve(result.data) //resolve the promise with the result
                }
            }
        } catch (e) {
            this.__onError(e)
        }
    }

    __onClose(code, reason) {
        if (this.__ws) {
            this.__ws.closeTimeout && clearTimeout(this.__ws.closeTimeout)
            this.__ws.terminate()
            this.__ws = null
            this.__isValidated = false
            contrainer.connectionManager.remove(this.id)
        }
        logger.debug(`${this.__getConnectionInfo()} closed with code ${code} and reason ${reason}`)
    }

    __onError(error) {
        logger.debug(`${this.__getConnectionInfo()} websocket error`)
        logger.debug(error)
    }

    __getConnectionInfo() {
        return `${this.pubkey} ${this.type}`
    }
}

module.exports = ChannelBase