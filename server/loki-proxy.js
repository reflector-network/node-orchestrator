const express = require('express')
const {createProxyMiddleware} = require('http-proxy-middleware')
const container = require('../domain/container')
const {authenticate} = require('./middlewares')
const {unauthorized} = require('./errors')

//read-only Loki query endpoints, as paths relative to the /loki-proxy mount point
const readOnlyPaths = [
    /^\/loki\/api\/v1\/query$/,
    /^\/loki\/api\/v1\/query_range$/,
    /^\/loki\/api\/v1\/labels$/,
    /^\/loki\/api\/v1\/label\/[^/]+\/values$/,
    /^\/loki\/api\/v1\/series$/,
    /^\/loki\/api\/v1\/index\/stats$/
]

const pushPath = '/loki/api/v1/push'

/**
 * @param {string} pathname - request path relative to the mount point
 * @param {{method: string}} req - request
 * @returns {boolean}
 */
function isAllowedLokiRequest(pathname, req) {
    if (req.method !== 'GET')
        return false
    return readOnlyPaths.some(pattern => pattern.test(pathname))
}

/**
 * @param {object} req - request
 * @returns {string|null} bearer token from the Authorization header
 */
function getBearerToken(req) {
    const [scheme, token] = (req.headers.authorization || '').split(' ')
    if (scheme !== 'Bearer' || !token)
        return null
    return token
}

/**
 * Promtail on every node pushes with the token the orchestrator issued over the node's verified WebSocket
 * channel. When appConfig.lokiPushAuth is 'optional' (a rollout escape hatch, not the default), pushes without a valid token are still accepted.
 * @param {object} req - request
 * @param {object} res - response
 * @param {function} next - next middleware
 * @returns {void}
 */
function authenticatePush(req, res, next) {
    const token = getBearerToken(req)
    const pubkey = token ? container.logTokenProvider.verify(token) : null
    if (pubkey) {
        req.pubkey = pubkey
        return next()
    }
    if (container.appConfig.lokiPushAuth === 'optional')
        return next()
    return next(unauthorized('Invalid log token'))
}

/**
 * Mounts the Loki proxy: pushes carry a node's log token, everything else needs a signed request and is read-only.
 * @param {object} app - Express app instance
 * @param {string} lokiUrl - Loki base URL; nothing is mounted when empty
 */
function registerLokiProxy(app, lokiUrl) {
    if (!lokiUrl)
        return
    const proxy = createProxyMiddleware({target: lokiUrl, changeOrigin: true})
    const router = express.Router()
    router.post(pushPath, authenticatePush, proxy)
    router.use(authenticate, (req, res, next) => {
        if (!isAllowedLokiRequest(req.path, req))
            return res.status(404).json({error: 'Not found', status: 404})
        return proxy(req, res, next)
    })
    app.use('/loki-proxy', router)
}

module.exports = {registerLokiProxy, isAllowedLokiRequest, authenticatePush, getBearerToken}
