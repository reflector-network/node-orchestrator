const {StrKey} = require('@stellar/stellar-sdk')
const {ValidationError} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const {resolveClientAddress} = require('../../utils/client-address')
const container = require('../../domain/container')
const MessageTypes = require('./handlers/message-types')
const IncomingChannel = require('./incoming-channel')
const AnonIncomingChannel = require('./anon-incoming-channel')

/**
 * Deadline for the challenge-response handshake, in ms
 */
const handshakeTimeout = 10000

/**
 * How long a socket the server refused, superseded or failed at the handshake gets to answer its close frame, in ms.
 * ws itself would wait 30 s for that answer and keep reading until then; the grace lets an honest client receive the
 * close code and reason, and the socket is destroyed after it
 */
const refusedSocketGrace = 1000

/**
 * Options for the WebSocketServer that anonymous clients connect to. They only receive configuration broadcasts, so
 * what they send is small and 1 MiB is generous; compression is off because it costs CPU per connection.
 */
const wsServerOptions = {
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false
}

/**
 * Options for the WebSocketServer that node connections use. A node answers LOG_FILE_REQUEST with the whole file in
 * one frame, and rotation at 2M leaves files a little past 2 MiB. JSON-encoding the file into the answer escapes every
 * quote and backslash of its pino lines: measured on 497 real node and orchestrator logs, the frame is 1.03-1.18 times
 * the file (median 1.09), and the largest was 2 577 349 bytes (2.46 MiB) for a 2 193 077-byte file. 4 MiB leaves 1.6
 * times that. A frame over the cap still closes the connection with 1009.
 *
 * Memory: ws buffers a message up to maxPayload per socket. A socket gets this cap only when its upgrade names a
 * registered node key (isNodeUpgrade). The sockets ConnectionManager holds are bounded per registered key: 2 validated and 2 pending, so at most
 * 4 x nodeCount x 4 MiB (320 MiB for 20 nodes). A socket the orchestrator refused, superseded or failed at the
 * handshake leaves the manager at once and is destroyed refusedSocketGrace (1 s) after its close frame, rather than
 * after ws's 30 s close timeout.
 */
const nodeWsServerOptions = {
    ...wsServerOptions,
    maxPayload: 4 * 1024 * 1024
}

/**
 * The address a connection is counted and logged under. Anonymous connections are capped per address, so it must not
 * be forgeable: it is the socket peer, normalised, and `x-forwarded-for` is read only when that peer is listed in the
 * `trustedProxies` app config setting (see utils/client-address.js). Node connections are capped per pubkey and use it
 * for logs only, so the WebSocket port works both exposed directly and behind a TLS-terminating proxy.
 * @param {http.IncomingMessage} req - upgrade request
 * @returns {string}
 */
function getRemoteAddress(req) {
    return resolveClientAddress(req.socket?.remoteAddress, req.headers['x-forwarded-for'],
        container.appConfig?.trustedProxies)
}

/**
 * Whether an upgrade goes to the node WebSocketServer and its larger frame cap: it must name a registered node key.
 * Any other upgrade, a claim for an unknown key included, gets the anonymous cap, and handleConnection refuses the
 * unknown key right after the upgrade as before.
 * @param {http.IncomingMessage} req - upgrade request
 * @returns {boolean}
 */
function isNodeUpgrade(req) {
    const {pubkey} = req.headers
    return !!pubkey && StrKey.isValidEd25519PublicKey(pubkey) && container.configManager.hasNode(pubkey)
}

/**
 * Destroy a socket the server has refused once the grace after its close frame has passed, unless it closed by then
 * @param {WebSocket} ws - refused socket, already sent its close frame
 */
function terminateAfterGrace(ws) {
    const timer = setTimeout(() => ws.terminate(), refusedSocketGrace)
    ws.once('close', () => clearTimeout(timer))
}

//ws rejects close reasons longer than 123 bytes
function truncateReason(reason) {
    return Buffer.byteLength(reason) > 123 ? Buffer.from(reason).subarray(0, 123).toString() : reason
}

/**
 * Hands a freshly issued Loki push token to a node over its verified channel. A node running an older release
 * answers with an ERROR for the unknown message type; that is logged at debug and nothing else changes.
 * @param {IncomingChannel} connection - validated node connection
 */
async function sendLogToken(connection) {
    try {
        const token = container.logTokenProvider.issue(connection.pubkey)
        await connection.send({type: MessageTypes.LOG_TOKEN, data: {token}})
    } catch (e) {
        logger.debug(`Log token not delivered to ${connection.pubkey}: ${e.message}`)
    }
}

/**
 * Handles a new WebSocket connection. A node connection is registered only after its handshake response verified;
 * an anonymous connection is registered right away.
 * @param {WebSocket} ws - accepted socket
 * @param {http.IncomingMessage} req - upgrade request
 */
async function handleConnection(ws, req) {
    const remoteAddress = getRemoteAddress(req)
    let connection = null
    try {
        const {pubkey, app} = req.headers
        if (pubkey) {
            if (!StrKey.isValidEd25519PublicKey(pubkey))
                throw new ValidationError('pubkey is invalid')
            if (!container.configManager.hasNode(pubkey))
                throw new ValidationError('pubkey is not registered')
            connection = new IncomingChannel(ws, pubkey, app === 'node')
        } else {
            connection = new AnonIncomingChannel(ws, remoteAddress)
        }
        connection.remoteAddress = remoteAddress
        container.connectionManager.track(connection)
        if (!connection.isAnonymous) {
            await connection.send({type: MessageTypes.HANDSHAKE_REQUEST, data: {payload: connection.authPayload}}, handshakeTimeout)
            if (!connection.isValidated)
                throw new ValidationError('Handshake failed')
        }
        container.connectionManager.add(connection)
        if (connection.isNode)
            sendLogToken(connection)
        logger.debug(`New connection from ${connection.ip || connection.pubkey} established`)
    } catch (e) {
        if (!(e instanceof ValidationError) && !e.timeout && !e.isPeerError && !e.connectionClosed)
            logger.error(e)
        else
            logger.debug(`Connection from ${remoteAddress} rejected: ${e.message}`)
        if (connection)
            container.connectionManager.remove(connection.id)
        //a request rejected because its channel closed means the socket is already closing, with its own code and reason
        if (!e.connectionClosed)
            ws.close(1008, truncateReason(e.message))
        //every refusal before the connection registers ends here: a failed check, a cap, a failed or superseded
        //handshake. A validated connection closes elsewhere and keeps the normal close handshake
        terminateAfterGrace(ws)
    }
}

module.exports = {
    handleConnection,
    handshakeTimeout,
    refusedSocketGrace,
    wsServerOptions,
    nodeWsServerOptions,
    isNodeUpgrade
}
