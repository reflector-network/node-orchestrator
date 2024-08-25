const statisticsManager = require('../../domain/statistics-manager')
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
    registerRoute(app, 'statistics', {method: 'get', authMode: AuthMode.noAuth}, () => statisticsManager.getStatistics())
    /**
     * @openapi
     * /metrics:
     *   get:
     *     summary: Get nodes metrics
     *     tags:
     *       - Statistics
     *     responses:
     *       200:
     *         description: Metrics
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Statistics'
     */
    registerRoute(app, 'metrics', {method: 'get', authMode: AuthMode.auth}, () => statisticsManager.getMetrics())
}

module.exports = statisticsRoutes