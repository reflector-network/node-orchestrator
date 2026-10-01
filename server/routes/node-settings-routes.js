const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')
const {badRequest, notFound} = require('../errors')
const {validateGatewaysBody, validateGateways} = require('./gateway-validation')

//a POST /validate-gateways body is {urls, validationKey}: it must not pass the POST /gateways shape check, because
//the forwarded message would then clear the node's challenge with `challenge: undefined`. The check only holds because
//validationKey is required there - an optional field would simply be absent from the captured body
const gatewaysBodyFields = new Set(['urls', 'challenge'])
//a signed body is valid on any POST route, so every route that persists or forwards one states the keys it accepts
const nodeSettingsBodyFields = new Set(['emails'])

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
        const {emails} = req.body || {}
        if (!Array.isArray(emails) || emails.some(email => typeof email !== 'string'))
            throw badRequest('emails must be an array of strings')
        if (Object.keys(req.body).some(key => !nodeSettingsBodyFields.has(key)))
            throw badRequest('unexpected body field')
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
        const {urls, challenge} = req.body
        if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string'))
            throw badRequest('urls must be an array of strings')
        if (challenge !== undefined && typeof challenge !== 'string')
            throw badRequest('challenge must be a string')
        if (Object.keys(req.body).some(key => !gatewaysBodyFields.has(key)))
            throw badRequest('unexpected body field')
        const node = container.connectionManager.getNodeConnection(req.pubkey)
        if (!node)
            throw notFound('Node not found')
        //relay the payload the middleware authenticated instead of rebuilding it, so the node hashes the same
        //bytes the signature covers - the payload now carries the route binding as well as the body
        const data = {data: req.payload, signature: req.signature}
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
    registerRoute(app, 'validate-gateways', {method: 'post'}, (req) => {
        const {urls, validationKey} = validateGatewaysBody(req.body)
        return validateGateways(urls, validationKey)
    })
}

module.exports = settingsRoutes