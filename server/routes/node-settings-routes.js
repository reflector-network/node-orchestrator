const container = require('../../domain/container')
const {registerRoute} = require('../route')


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

}

module.exports = settingsRoutes