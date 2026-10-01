const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')
const {badRequest, notFound} = require('../errors')

const traceBodyFields = new Set(['isTraceEnabled'])

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
        const {isTraceEnabled} = req.body
        if (typeof isTraceEnabled !== 'boolean')
            throw badRequest('isTraceEnabled must be a boolean')
        //a body captured from another route must not arrive here carrying extra fields
        if (Object.keys(req.body).some(key => !traceBodyFields.has(key)))
            throw badRequest('unexpected body field')
        const node = container.connectionManager.getNodeConnection(getTargetNode(req))
        if (!node)
            throw notFound('Node not found')
        //the node verifies this signature and, for SET_TRACE, that the signer is its own key, so the
        //relay alone cannot toggle tracing. The bare fields stay for compatibility
        await node.send({
            type: MessageTypes.SET_TRACE,
            data: {isTraceEnabled, data: req.payload, signature: req.signature, pubkey: req.pubkey}
        })
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
        //req.payload is the signed route binding, relayed verbatim so the node hashes the same bytes
        const logs = await node.send({
            type: MessageTypes.LOGS_REQUEST,
            data: {data: req.payload, signature: req.signature, pubkey: req.pubkey}
        })
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
        //logFileName stays for compatibility; the authoritative name is inside the signed payload
        const logData = await node.send({
            type: MessageTypes.LOG_FILE_REQUEST,
            data: {logFileName, data: req.payload, signature: req.signature, pubkey: req.pubkey}
        })
        //Set headers
        res.setHeader('Content-Disposition', 'attachment; filename=' + logFileName)
        res.setHeader('Content-Type', 'application/octet-stream')
        //Send file
        return logData
    })
}

module.exports = logRoutes