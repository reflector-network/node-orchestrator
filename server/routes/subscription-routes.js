const {getManager} = require('../../domain/subscription-data-provider')
const AuthMode = require('../auth-mode')
const {registerRoute} = require('../route')
const {notFound} = require('../errors')


function subscriptionRoutes(app) {
    /**
     * @openapi
     * /subscriptions/{contractId}/{id}:
     *   get:
     *     summary: Get subscription
     *     tags:
     *       - Subscriptions
     *     parameters:
     *       - name: contractId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *       - name: id
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Subscriptions
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Subscription'
     */
    registerRoute(app, 'subscriptions/:contractId/:id', {method: 'get', authMode: AuthMode.noAuth}, (req) => {
        const manager = getManager(req.params.contractId)
        if (!manager)
            throw notFound()
        const subscription = manager.getSubscriptionById(req.params.id)
        if (!subscription)
            throw notFound()
        return subscription
    })

    /**
     * @openapi
     * /subscriptions/{contractId}/owner/{owner}:
     *   get:
     *     summary: Get subscriptions by owner
     *     tags:
     *       - Subscriptions
     *     parameters:
     *       - name: contractId
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *       - name: owner
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Subscriptions
     *         content:
     *           application/json:
     *             type: array
     *             items: '#/components/schemas/Subscription'
     */
    registerRoute(app, 'subscriptions/:contractId/owner/:owner', {method: 'get', authMode: AuthMode.noAuth}, (req) => {
        const manager = getManager(req.params.contractId)
        if (!manager)
            throw notFound()
        const subscriptions = manager.getSubscriptions(req.params.owner)
        return subscriptions
    })
}

module.exports = subscriptionRoutes