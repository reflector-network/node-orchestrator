const {createHash} = require('crypto')
const cors = require('cors')
const {StrKey, Keypair} = require('stellar-sdk')
//const { corsWhitelist } = require('../config')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const configProvider = require('../domain/config-provider')
const nonceProvider = require('../domain/nonce-provider')
const {forbidden, unauthorized} = require('./errors')

async function validateAuth(req) {
    const {authorization} = req.headers
    if (!authorization)
        throw unauthorized('Authorization header is required')

    const [pubkey, signature, rawNonce] = authorization.split('.')

    if (!pubkey || !signature || !rawNonce)
        throw unauthorized('Invalid authorization header')

    const nonce = parseInt(rawNonce, 10)

    if (!configProvider.hasNode(pubkey))
        throw unauthorized('Pubkey is not registered')


    const lastNonce = (await nonceProvider.get(pubkey)) || 0
    if (isNaN(nonce) || nonce <= lastNonce) {
        throw unauthorized('Invalid nonce')
    }

    const method = req.method.toUpperCase()
    let payload = null
    if (method === 'GET') {
        payload = new URLSearchParams(req.query).toString()
    } else if (method === 'POST' || method === 'PUT') {
        payload = req.body
    } else {
        throw unauthorized('Invalid request method')
    }

    if (!nonce || isNaN(nonce) || nonce <= lastNonce) {
        throw unauthorized('Invalid nonce')
    }

    //copy payload and add nonce to it, to avoid changing the original payload
    const payloadCopy = {...payload, nonce}

    const keyPair = Keypair.fromPublicKey(pubkey)

    const messageToSign = `${pubkey}:${JSON.stringify(sortObjectKeys(payloadCopy))}`
    const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
    const isValid = keyPair.verify(messageHash, Buffer.from(signature, 'hex'))
    if (!isValid)
        throw unauthorized('Invalid signature')
    req.pubkey = pubkey
    await nonceProvider.update(pubkey, nonce)
}

async function authenticate(req, res, next) {
    try {
        await validateAuth(req)
        next()
    } catch (err) {
        next(err)
    }
}

const mightAuthenticate = (req, res, next) => {
    try {

        const {authorization} = req.headers
        if (authorization)
            validateAuth(req)
        next()
    } catch (err) {
        next(err)
    }
}

const defaultCorsOptions = {
    optionsSuccessStatus: 200
}

const corsWhitelist = ['*']

const corsMiddleware = {
    whitelist: cors({
        ...defaultCorsOptions,
        origin(origin, callback) {
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
