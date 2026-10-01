const {randomBytes} = require('crypto')

/**
 * How long a superseded token stays valid, so a node that reconnects and receives a new token keeps shipping
 * logs while promtail still holds the previous one
 */
const supersededTokenTtl = 60 * 60 * 1000

/**
 * Issues bearer tokens for the Loki push path. A token is minted for a node once its WebSocket handshake
 * verified, travels to the node over that channel, and is presented by promtail on every push.
 */
class LogTokenProvider {
    /**
     * @type {Map<string, {pubkey: string, expiresAt: number|null}>}
     */
    __tokens = new Map()

    /**
     * Current token per node
     * @type {Map<string, string>}
     */
    __current = new Map()

    /**
     * Mint a fresh token for a node; the node's previous token stays valid for the grace period
     * @param {string} pubkey - node public key
     * @returns {string} 64-character hex token
     */
    issue(pubkey) {
        const previous = this.__current.get(pubkey)
        if (previous && this.__tokens.has(previous))
            this.__tokens.get(previous).expiresAt = Date.now() + supersededTokenTtl
        const token = randomBytes(32).toString('hex')
        this.__tokens.set(token, {pubkey, expiresAt: null})
        this.__current.set(pubkey, token)
        this.__evictExpired()
        return token
    }

    /**
     * @param {string} token - bearer token presented on a push
     * @returns {string|null} the node public key the token belongs to, or null
     */
    verify(token) {
        if (typeof token !== 'string' || token.length !== 64)
            return null
        const entry = this.__tokens.get(token)
        if (!entry)
            return null
        if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
            this.__tokens.delete(token)
            return null
        }
        return entry.pubkey
    }

    /**
     * Drop every token of a node, for example when it leaves the cluster
     * @param {string} pubkey - node public key
     */
    revoke(pubkey) {
        for (const [token, entry] of this.__tokens) {
            if (entry.pubkey === pubkey)
                this.__tokens.delete(token)
        }
        this.__current.delete(pubkey)
    }

    __evictExpired() {
        const now = Date.now()
        for (const [token, entry] of this.__tokens) {
            if (entry.expiresAt !== null && entry.expiresAt < now)
                this.__tokens.delete(token)
        }
    }
}

module.exports = {LogTokenProvider, supersededTokenTtl}
