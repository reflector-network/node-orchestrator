import { createHash } from 'crypto'
import cors from 'cors'
import { StrKey, Keypair } from 'stellar-base'
//import { corsWhitelist } from '../config.js'
import configProvider from '../domain/config-provider.js'
import nonceProvider from '../domain/nonce-provider.js'
import { forbidden, unauthorized } from './errors.js'
import { sortObjectKeys } from '@reflector/reflector-shared'

export async function authenticate(req, res, next) {
    try {
        const { authorization } = req.headers
        if (!authorization)
            throw unauthorized('Authorization header is required')

        let [pubkey, signature, nonce] = authorization.split('.')

        if (!pubkey || !signature || !nonce)
            throw unauthorized('Invalid authorization header')

        nonce = parseInt(nonce, 10)

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
        const payloadCopy = { ...payload, nonce }

        const keyPair = Keypair.fromPublicKey(pubkey)

        const messageToSign = `${pubkey}:${JSON.stringify(sortObjectKeys(payloadCopy))}`
        const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
        const isValid = keyPair.verify(messageHash, Buffer.from(signature, 'hex'))
        if (!isValid)
            throw unauthorized('Invalid signature')
        await nonceProvider.update(pubkey, nonce)
        next()
    } catch (err) {
        next(err)
    }
}

const defaultCorsOptions = {
    optionsSuccessStatus: 200
}

const corsWhitelist = ['*']

export const corsMiddleware = {
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
    open: cors({ ...defaultCorsOptions })
}