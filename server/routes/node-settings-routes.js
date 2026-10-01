const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')
const {badRequest} = require('../errors')
const {getConnectedNode} = require('./node-relay')
const {checkGatewayUrls, validateGatewaysBody, validateGateways} = require('./gateway-validation')

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
        const node = getConnectedNode(req.pubkey)
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
        //the node refuses a list that breaks its gateway rules and then sends nothing at all rather than go direct, so
        //a list it would refuse is not forwarded; the signed payload itself is relayed untouched
        checkGatewayUrls(urls)
        const node = getConnectedNode(req.pubkey)
        //relay the payload the middleware authenticated instead of rebuilding it, so the node hashes the same
        //bytes the signature covers - the payload now carries the route binding as well as the body
        const data = {data: req.payload, signature: req.signature}
        await node.send({type: MessageTypes.GATEWAYS_POST, data})
    })

    /**
     * @openapi
     * /validate-gateways:
     *   post:
     *     summary: Validate gateways
     *     tags:
     *       - Settings
     *     security:
     *       - ed25519Auth: []
     *     requestBody:
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               urls:
     *                 type: array
     *                 items:
     *                   type: string
     *               validationKey:
     *                 type: string
     *             required: [urls, validationKey]
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