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
     *     summary: Get metrics
     *     tags:
     *       - Statistics
     *     parameters:
     *       - in: query
     *         name: page
     *         schema:
     *           type: integer
     *       - in: query
     *         name: limit
     *         schema:
     *           type: integer
     *       - in: query
     *         name: sort
     *         description: asc or desc
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Metrics
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 $ref: '#/components/schemas/Metrics'
     */
    registerRoute(app, 'metrics', {method: 'get', authMode: AuthMode.auth}, async (req) => (await statisticsManager.getMetrics(req.query)).map(m => m.toPlainObject()))
}

module.exports = statisticsRoutes