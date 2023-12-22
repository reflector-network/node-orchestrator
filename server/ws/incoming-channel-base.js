const WebSocket = require('ws')
const ChannelBase = require('./channel-base')

/**
 * Handles the ws channel and its events. Restarts on failure.
 */
class IncomingChannelBase extends ChannelBase {


    /**
     * @param {WebSocket.WebSocket} ws - ws instance
     * @param {string} pubkey - the pubkey of the node
     */
    constructor(ws, pubkey) {
        super(ws, pubkey)
        this.__assignListeners()
        if (process.env.NODE_ENV !== 'development')
            this.__startPingPong()
    }

    __pingTimeout

    __pongTimeout

    __assignListeners() {
        super.__assignListeners()
        this.__ws
            .addListener('ping', () => this.__onPing())
            .addListener('pong', () => this.__onPong())
    }

    __onClose(code, reason) {
        super.__onClose(code, reason)
        clearTimeout(this.__pingTimeout)
        clearTimeout(this.__pongTimeout)
    }

    __onPing() {
        this._ws.pong()
    }

    __onPong() {
        clearTimeout(this.__pongTimeout)
    }

    __startPingPong() {
        if (this.__ws?.readyState !== WebSocket.OPEN) {
            super.close(1001, 'Connection closed due to inactivity', true)
            return
        }
        this.__ws.ping()

        this.__pongTimeout = setTimeout(() => {
            super.close(1001, 'Connection closed due to inactivity', true)
        }, 500)

        this.pingTimeout = setTimeout(() => {
            this.__startPingPong()
        }, 1000)
    }
}

module.exports = IncomingChannelBase