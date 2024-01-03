const container = require('../../domain/container')
const AuthMode = require('../auth-mode')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')


function logRoutes(app) {
    /**
     * @openapi
     * /logs/trace:
     *   post:
     *     summary: Set trace
     *     tags:
     *       - Logs
     *     requestBody:
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               isTraceEnabled:
     *                 type: boolean
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Ok
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/OkResult'
     */
    registerRoute(app, 'logs/trace', {method: 'post', authMode: AuthMode.noAuth}, () => ({ok: 1}))


    /**
     * @openapi
     * /logs:
     *   get:
     *     summary: Get current node logs
     *     tags:
     *       - Logs
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Array of log names
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     *
     */
    registerRoute(app, 'logs', {authMode: AuthMode.noAuth}, () => ['error.log', 'combined.log'])


    /**
     * @openapi
     * /log/{logname}:
     *   get:
     *     summary: Download log file
     *     tags:
     *       - Logs
     *     parameters:
     *       - name: logname
     *         in: path
     *         required: true
     *         schema:
     *           type: string
     *     security:
     *       - ed25519Auth: []
     *     responses:
     *       200:
     *         description: Log file
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: string
     *
     */
    registerRoute(app, 'log/:logname', {authMode: AuthMode.noAuth}, (req, res) => {
        const filename = req.params.logname
        //Set headers
        res.setHeader('Content-Disposition', 'attachment; filename=' + filename)
        res.setHeader('Content-Type', 'application/octet-stream')
        //Send file
        const testData = 'test data'
        res.send(testData)
    })
}

module.exports = logRoutes