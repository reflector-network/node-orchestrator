const {StrKey} = require('@stellar/stellar-sdk')
const logger = require('../logger')
const container = require('../domain/container')

//one line per key per minute: a stream of forged signatures or replayed nonces must show at the default log level
//without letting its sender fill the log
const windowMs = 60 * 1000

/**
 * Open windows by key: the registered node key a request claimed, otherwise its method and route. A claim for a key
 * outside the node list falls back to the route, so a client cannot open a window per request by varying the key, and
 * the map stays bounded by the node count plus the route count
 * @type {Map<string, {startedAt: number, suppressed: number}>}
 */
const windows = new Map()

/**
 * @param {object} req - request
 * @returns {string|null} the public key the authorization header claims, when it is a well-formed key; the signature
 * and nonce parts of the header are never read here
 */
function getClaimedPubkey(req) {
    const [pubkey] = String(req.headers.authorization || '').split('.')
    return StrKey.isValidEd25519PublicKey(pubkey) ? pubkey : null
}

/**
 * @param {object} req - request
 * @returns {string} the matched route pattern, or the mount path for a router mounted with app.use
 */
function getRoute(req) {
    return ((req.baseUrl || '') + (req.route ? req.route.path : '')) || req.path
}

/**
 * Log a request refused with 401 or 403 at warn: method, route, status, the refusal and the claimed key. The header's
 * signature and nonce stay out of the line, and so does the query
 * @param {object} req - request
 * @param {Error} err - the refusal, an HttpError with code 401 or 403
 */
function logAuthFailure(req, err) {
    const route = getRoute(req)
    const pubkey = getClaimedPubkey(req)
    const isNodeKey = !!pubkey && container.configManager.hasNode(pubkey)
    const key = isNodeKey ? pubkey : `${req.method} ${route}`
    const now = Date.now()
    const window = windows.get(key)
    if (window && now - window.startedAt < windowMs) {
        window.suppressed++
        return
    }
    windows.set(key, {startedAt: now, suppressed: 0})
    let line = `Refused ${req.method} ${route} -> ${err.code}: ${err.message}`
    if (pubkey)
        line += ` (pubkey ${pubkey})`
    if (window?.suppressed)
        line += `; ${window.suppressed} more for this ${isNodeKey ? 'key' : 'route'} in the last minute`
    logger.warn(line)
}

/**
 * Forget every window, for tests
 */
function resetAuthFailureLog() {
    windows.clear()
}

module.exports = {logAuthFailure, resetAuthFailureLog}
