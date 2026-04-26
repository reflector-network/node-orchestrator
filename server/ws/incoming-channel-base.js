const WebSocket = require('ws')
const {isDebugging} = require('../../domain/utils')
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
        this.__startPingPong()
    }

    __pingTimeout

    __pongTimeout

    /**
     * Number of consecutive pong timeouts since last proof-of-life.
     * Reset whenever a pong or any application message arrives.
     * @type {number}
     */
    __missedPongs = 0

    /**
     * Timestamp (ms) of the most recent inbound pong or application message.
     * @type {number}
     */
    __lastMessageAt = 0

    /**
     * @param {number} staleThresholdMs - max age in ms for this channel to count as fresh
     * @returns {boolean}
     */
    isFresh(staleThresholdMs) {
        return Date.now() - this.__lastMessageAt <= staleThresholdMs
    }

    __assignListeners() {
        return super.__assignListeners()
            .addListener('pong', () => this.__onPong())
    }

    __onClose(code, reason) {
        this.__pingTimeout && clearTimeout(this.__pingTimeout)
        this.__pongTimeout && clearTimeout(this.__pongTimeout)
        this.__pingTimeout = null
        this.__pongTimeout = null
        super.__onClose(code, reason)
    }

    __onPong() {
        this.__onProofOfLife()
    }

    /**
     * Treat an inbound pong or application message as proof of peer liveness:
     * clear the in-flight pong timer, reset the missed-pong counter, ensure
     * the next ping is scheduled, and stamp the channel's last-message time.
     * Mirrors reflector-node's ChannelBase.__onProofOfLife so a steady stream
     * of gossip does not silently halt the keepalive cycle when a single
     * pong is lost.
     * @protected
     */
    __onProofOfLife() {
        this.__missedPongs = 0
        this.__lastMessageAt = Date.now()
        if (this.__pongTimeout) {
            clearTimeout(this.__pongTimeout)
            this.__pongTimeout = null
        }
        this.__pingTimeout = this.__pingTimeout || setTimeout(() => {
            this.__pingTimeout = null
            this.__startPingPong()
        }, 10000)
    }

    __startPingPong() {
        if (this.__ws?.readyState !== WebSocket.OPEN) {
            super.close(1001, `Connection closed due to state ${this.__ws?.readyState}`, true)
            return
        }

        //4s/attempt tolerates event-loop blocks, TCP retransmits and head-of-line
        //blocking behind larger gossip frames. Three consecutive misses signal a
        //genuinely unresponsive peer (~12s of cold-start silence, up to ~22s
        //after a prior proof-of-life because of the 10s inter-ping delay).
        //Mirror of reflector-node's ChannelBase.
        const timeout = isDebugging() ? 60 * 1000 * 60 : 4000
        this.__pongTimeout = setTimeout(() => {
            this.__missedPongs += 1
            if (this.__missedPongs >= 3) {
                super.close(1001, `Connection closed after ${this.__missedPongs} missed pongs ${this.__getConnectionInfo()}`, true)
                return
            }
            this.__startPingPong()
        }, timeout)

        this.__ws.ping()
    }

    async __onMessage(data) {
        this.__onProofOfLife()
        await super.__onMessage(data)
    }
}

module.exports = IncomingChannelBase
