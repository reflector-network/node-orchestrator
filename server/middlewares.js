const {createHash} = require('crypto')
const cors = require('cors')
const {Keypair} = require('@stellar/stellar-sdk')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const container = require('../domain/container')
const nonceProvider = require('../domain/nonce-provider')
const {forbidden, unauthorized} = require('./errors')

/**
 * Builds the route binding a request signature must cover: the matched route path with its params substituted,
 * followed by the query string sorted in code-unit order and carrying the nonce
 * @param {object} req - request object
 * @param {number} nonce - request nonce
 * @returns {string}
 */
function buildRouteBinding(req, nonce) {
    let path = req.route ? req.route.path : (req.baseUrl || '') + req.path //app.use mounts carry no route
    if (req.params) {
        const props = Object.getOwnPropertyNames(req.params)
        for (const prop of props) {
            path = path.replace(`:${prop}`, req.params[prop])
        }
    }
    if (path.startsWith('/'))
        path = path.substring(1)
    return path + '?' + new URLSearchParams(sortObjectKeys({...req.query, nonce})).toString()
}

async function validateAuth(req) {
    const {authorization} = req.headers
    if (!authorization)
        throw unauthorized('Authorization header is required')

    const [pubkey, signature, rawNonce] = authorization.split('.')

    if (!pubkey || !signature || !rawNonce)
        throw unauthorized('Invalid authorization header')

    const nonce = parseInt(rawNonce, 10)
    if (!Number.isSafeInteger(nonce) || nonce <= 0)
        throw unauthorized('Invalid nonce')

    if (!container.configManager.hasNode(pubkey))
        throw unauthorized('Pubkey is not registered')

    //cheap rejection of an obvious replay; the authoritative check is the atomic consume below
    const lastNonce = (await nonceProvider.get(pubkey)) || 0
    if (nonce <= lastNonce)
        throw unauthorized('Invalid nonce')

    const method = req.method.toUpperCase()
    let payload = null
    if (method === 'GET') {
        payload = buildRouteBinding(req, nonce)
    } else if (method === 'POST' || method === 'PUT') {
        //the body alone does not say where the request is aimed, so a signature over it can be retargeted by
        //rewriting the query string - logs/trace?node=<other pubkey> being the concrete case. The route binding
        //goes into the signed payload, and the middleware value wins over a body field of the same name
        payload = sortObjectKeys({...req.body, nonce, path: buildRouteBinding(req, nonce)})
    } else {
        throw unauthorized('Invalid request method')
    }

    const keyPair = Keypair.fromPublicKey(pubkey)

    const messageToSign = `${pubkey}:${JSON.stringify(payload)}`
    const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
    const isValid = keyPair.verify(messageHash, Buffer.from(signature, 'hex'))
    if (!isValid)
        throw unauthorized('Invalid signature')
    //burn the nonce only once the signature checked out, so an unauthenticated party cannot lock a node out,
    //and burn it atomically, so two copies of one signed request cannot both proceed
    if (!await nonceProvider.tryConsume(pubkey, nonce))
        throw unauthorized('Invalid nonce')
    req.payload = payload
    req.pubkey = pubkey
    req.nonce = nonce
    req.signature = signature
}

async function authenticate(req, res, next) {
    try {
        await validateAuth(req)
        next()
    } catch (err) {
        next(err)
    }
}

const mightAuthenticate = async (req, res, next) => {
    try {
        const {authorization} = req.headers
        if (authorization)
            await validateAuth(req)
        next()
    } catch (err) {
        next(err)
    }
}

const defaultCorsOptions = {
    optionsSuccessStatus: 200
}

const corsMiddleware = {
    whitelist: cors({
        ...defaultCorsOptions,
        origin(origin, callback) {
            const corsWhitelist = container.appConfig.whitelist || []
            if (!origin) return callback(null, true)
            if (corsWhitelist.includes(origin) || corsWhitelist.includes('*')) {
                callback(null, true)
            } else {
                callback(forbidden(`Origin ${origin} is blocked by CORS`))
            }
        }
    }),
    open: cors({...defaultCorsOptions})
}

module.exports = {
    authenticate,
    corsMiddleware,
    mightAuthenticate
}
