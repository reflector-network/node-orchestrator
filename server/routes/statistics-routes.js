const container = require('../../domain/container')
const AuthMode = require('../auth-mode')
const {registerRoute} = require('../route')


function statisticsRoutes(app) {
    /**
     * @openapi
     * /statistics:
     *   get:
     *     summary: Get nodes statistics
     *     tags:
     *       - Statistics
     *     responses:
     *       200:
     *         description: Statistics
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Statistics'
     */
    registerRoute(app, 'statistics', {method: 'get', authMode: AuthMode.noAuth}, () => container.statisticsManager.getStatistics())
}

module.exports = statisticsRoutes