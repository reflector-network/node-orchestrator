const container = require('../../domain/container')
const {registerRoute} = require('../route')
const MessageTypes = require('../ws/handlers/message-types')
const {badRequest} = require('../errors')
const {getConnectedNode} = require('./node-relay')

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
        const node = getConnectedNode(getTargetNode(req))
        //the signed payload, signature and key go along so that the node verifies them itself: the node
        //released with this orchestrator accepts SET_TRACE only when its own key signed it and reads isTraceEnabled from
        //the signed payload; the bare copy beside it is read only by nodes of the previous release
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
     *         description: Log file names and the node's trace flag
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 logFiles:
     *                   type: array
     *                   items:
     *                     type: string
     *                 isTraceEnabled:
     *                   type: boolean
     *
     */
    registerRoute(app, 'logs', {}, async (req) => {
        const node = getConnectedNode(getTargetNode(req))
        //req.payload is the signed route binding, relayed verbatim so that the node hashes the same bytes; it refuses a
        //request aimed at another node, and one without a node parameter unless its own key signed it
        const logs = await node.send({
            type: MessageTypes.LOGS_REQUEST,
            data: {data: req.payload, signature: req.signature, pubkey: req.pubkey}
        })
        return logs
    })


    /**
     * @openapi
     * /logs/{logname}:
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
     *               type: object
     *               properties:
     *                 logFile:
     *                   type: string
     *
     */
    registerRoute(app, 'logs/:logname', {}, async (req) => {
        const logFileName = req.params.logname
        const node = getConnectedNode(getTargetNode(req))
        //the node checks that the bare logFileName is the file named inside the signed route binding, so a relay cannot
        //swap the file the operator asked for
        //the node answers {logFile: <contents>} and the dashboard reads it with res.json(), so it goes out as the json
        //it is - an octet-stream type and an attachment name built from the path parameter only mislabelled it
        return await node.send({
            type: MessageTypes.LOG_FILE_REQUEST,
            data: {logFileName, data: req.payload, signature: req.signature, pubkey: req.pubkey}
        })
    })
}

module.exports = logRoutes