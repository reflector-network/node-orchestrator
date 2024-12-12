const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')

function getTargetNode(req) {
    let targetNode = req.pubkey
    if (targetNode === container.appConfig.monitoringKey && req.query.node) {
        targetNode = req.query.node
    }
    return targetNode
}

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
    registerRoute(app, 'logs/trace', {method: 'post'}, async (req) => {
        const node = container.connectionManager.getNodeConnection(getTargetNode(req))
        if (!node)
            throw new Error('Node not found')
        const {isTraceEnabled} = req.body
        await node.send({type: MessageTypes.SET_TRACE, data: {isTraceEnabled}})
    })


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
    registerRoute(app, 'logs', {}, async (req) => {
        const node = container.connectionManager.getNodeConnection(getTargetNode(req))
        if (!node)
            throw new Error('Node not found')
        const logs = await node.send({type: MessageTypes.LOGS_REQUEST})
        return logs
    })


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
    registerRoute(app, 'logs/:logname', {}, async (req, res) => {
        const logFileName = req.params.logname
        const node = container.connectionManager.getNodeConnection(getTargetNode(req))
        if (!node)
            throw new Error('Node not found')
        const logData = await node.send({type: MessageTypes.LOG_FILE_REQUEST, data: {logFileName}})
        //Set headers
        res.setHeader('Content-Disposition', 'attachment; filename=' + logFileName)
        res.setHeader('Content-Type', 'application/octet-stream')
        //Send file
        return logData
    })
}

module.exports = logRoutes