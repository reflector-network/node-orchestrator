const container = require('../../domain/container')
const AuthMode = require('../auth-mode')
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
    registerRoute(app, 'config/history', {method: 'get'}, async (req) => await container.configManager.history(req.query, !!req.pubkey))

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
     *                       $ref: '#/components/schemas/ConfigEnvelope'
     *                     hash:
     *                       type: string
     *                 pendingConfig:
     *                   type: object
     *                   properties:
     *                     config:
     *                       $ref: '#/components/schemas/ConfigEnvelope'
     *                     hash:
     *                       type: string
     *       404:
     *         description: Config not found
     */
    registerRoute(app, 'config', {method: 'get', authMode: AuthMode.mightAuth}, (req) => container.configManager.getCurrentConfigs(!req.pubkey))

    /**
     * @openapi
     * /config:
     *   post:
     *     summary: Create new config proposal or vote for existing one
     *     tags:
     *       - Config
     *     requestBody:
     *       content:
     *         application/json:
     *           schema:
     *             $ref: '#/components/schemas/ConfigEnvelope'
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Config submitted
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Config'
     *       404:
     *         description: Config not found
     */
    registerRoute(app, 'config', {method: 'post'}, async (req, res) => {
        await container.configManager.create(req.body)
        return {ok: 1}
    })

    /**
     * @openapi
     * /nodes:
     *   get:
     *     summary: Get node public keys list
     *     tags:
     *       - Config
     *     responses:
     *       200:
     *         description: Node public keys list
     *         content:
     *           application/json:
     *           schema:
     *             type: array
     *             items:
     *               type: string
     *       404:
     *         description: Config not found
     */
    registerRoute(app, 'nodes', {authMode: AuthMode.noAuth}, () => container.configManager.allNodePubkeys())
}

module.exports = configRoutes