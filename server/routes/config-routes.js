const configProvider = require('../../domain/config-provider')
const {registerRoute} = require('../route')


function configRoutes(app) {
    /**
     * @openapi
     * /config/history:
     *   get:
     *     summary: Get config history
     *     tags:
     *       - Config
     *     parameters:
     *       - in: query
     *         name: limit
     *         description: Limit
     *         schema:
     *           type: integer
     *       - in: query
     *         name: page
     *         description: Page
     *         schema:
     *           type: integer
     *       - in: query
     *         name: status
     *         description: Status
     *         schema:
     *           type: string
     *           enum: [pending, applied, rejected, voting, replaced]
     *       - in: query
     *         name: initiator
     *         description: Initiator
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Config
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/Config'
     */
    registerRoute(app, 'config/history', {method: 'get', allowAnonymous: true}, async (req) => await configProvider.history(req.query, !!req.pubkey))

    /**
     * @openapi
     * /config:
     *   get:
     *     summary: Get current config
     *     tags:
     *       - Config
     *     responses:
     *       200:
     *         description: Config
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 currentConfig:
     *                   type: object
     *                   properties:
     *                     config:
     *                       $ref: '#/components/schemas/Config'
     *                     hash:
     *                       type: string
     *                 pendingConfig:
     *                   type: object
     *                   properties:
     *                     config:
     *                       $ref: '#/components/schemas/Config'
     *                     hash:
     *                       type: string
     *       404:
     *         description: Config not found
     */
    registerRoute(app, 'config', {method: 'get', allowAnonymous: true}, (req) => configProvider.getCurrentConfigs(!!req.pubkey))

    /**
     * @openapi
     * /config:
     *   post:
     *     summary: Create new config
     *     tags:
     *       - Config
     *     requestBody:
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/Config'
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Signature added
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Config'
     *       404:
     *         description: Config not found
     */
    registerRoute(app, 'config', {method: 'post'}, async (req, res) => {
        await configProvider.create(req.body)
        return {ok: 1}
    })
}

module.exports = configRoutes