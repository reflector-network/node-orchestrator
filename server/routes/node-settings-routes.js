const {sign} = require('@stellar/stellar-sdk')
const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')


function settingsRoutes(app) {
    /**
     * @openapi
     * /settings/node:
     *   get:
     *     summary: Get current node settings
     *     tags:
     *       - Settings
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/NodeSettings'
     */
    registerRoute(app, 'settings/node', {}, (req) => {
        const settings = container.nodeSettingsManager.get(req.pubkey)
        return settings
    })


    /**
     * @openapi
     * /settings/node:
     *   post:
     *     summary: Updates current node settings
     *     tags:
     *       - Settings
     *     requestBody:
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/NodeSettings'
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/OkResult'
     *
     */
    registerRoute(app, 'settings/node', {method: 'post'}, async (req) => {
        const settings = await container.nodeSettingsManager.update(req.pubkey, req.body)
        return settings
    })


    /**
     * @openapi
     * /gateways:
     *   get:
     *     summary: Get current node gateways
     *     tags:
     *       - Settings
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/OkResult'
     *
     */
    registerRoute(app, 'gateways', {method: 'get'}, async (req) => {
        const node = container.connectionManager.getNodeConnection(req.pubkey)
        if (!node)
            throw new Error('Node not found')
        const data = {
            data: {payload: req.payload},
            signature: req.signature
        }
        const gateways = await node.send({type: MessageTypes.GATEWAYS_GET, data})
        return gateways
    })


    /**
     * @openapi
     * /gateways:
     *   post:
     *     summary: Post current node gateways
     *     tags:
     *       - Settings
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/OkResult'
     *
     */
    registerRoute(app, 'gateways', {method: 'post'}, async (req) => {
        const node = container.connectionManager.getNodeConnection(req.pubkey)
        if (!node)
            throw new Error('Node not found')
        const data = {data: {...req.body, nonce: req.nonce}, signature: req.signature}
        await node.send({type: MessageTypes.GATEWAYS_POST, data})
    })

    /**
     * @openapi
     * /gateways:
     *   post:
     *     summary: Validate gateways
     *     tags:
     *       - Settings
     *     security:
     *       - ed25519Auth: []
     *     requestBody:
     *       content:
     *         application/json
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/OkResult'
     *
     */
    registerRoute(app, 'validate-gateways', {method: 'post'}, async (req) => {
        const {urls, validationKey} = req.body
        const result = {}
        for (const url of urls) {
            const info = await validateGateway(url, validationKey)
            result[url] = info
        }
        return result
    })
}

async function validateGateway(address, validationKey) {
    const validatedGateways = {}
    const prev = validatedGateways[address]
    if (prev?.status === 'healthy')
        return prev
    const info = {status: 'unreachable'}
    validatedGateways[address] = info
    try {
        const {version} = await fetchGateway(address + '/', validationKey)
        info.version = version
        info.status = 'alive'

        const {serverTime} = await fetchGateway(address + '/gateway?url=' + encodeURIComponent('https://api.binance.com/api/v3/time'), validationKey)
        if (!serverTime)
            throw new Error('Failed to check proxy connection with Binance API')
        info.status = 'healthy'
    } catch (e) {
        console.error(e)
        info.error = e.message
    }
    return info
}

async function fetchGateway(address, validationKey) {
    const res = await fetch(address, {headers: {'x-gateway-validation': validationKey}})
    return await res.json()
}

module.exports = settingsRoutes