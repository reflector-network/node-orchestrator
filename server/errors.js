const logger = require('../logger')

class HttpError extends Error {
    constructor(message) {
        super(message)
    }

    /**
     * @type {Number}
     */
    code

    /**
     * @type {any}
     */
    details

    /**
     * @type {Error}
     */
    internalError

    toString() {
        return `Error: ${this.message}\nCode: ${this.code}`
    }
}

function generateError({message, code, details}) {
    //todo: implement custom Error class with customized toString serialization which displays code and original message details
    const error = new HttpError(message)
    error.code = code || 0
    error.details = details
    return error
}

function withDetails(message, details) {
    if (!details) return message
    return `${message} ${details}`
}

function handleSystemError(error) {
    logger.error(error)
}
function genericError(internalError) {
    return generateError({
        message: 'Error occurred. If this error persists, please contact our support team.',
        code: 0,
        internalError
    })
}
function badRequest(message = null, details = null) {
    return generateError({
        message: withDetails('Bad request.', message),
        code: 400,
        details
    })
}
function forbidden(message = null, details = null) {
    return generateError({
        message: withDetails('Forbidden.', message),
        code: 403,
        details
    })
}
function unauthorized(message = null, details = null) {
    return generateError({
        message: withDetails('Unauthorized.', message),
        code: 401,
        details
    })
}
function notFound(message = null, details = null) {
    return generateError({
        message: withDetails('Not found.', message),
        code: 404,
        details
    })
}
function badGateway(message = null) {
    return generateError({message: withDetails('Bad gateway.', message), code: 502})
}
function serviceUnavailable(message = null) {
    return generateError({message: withDetails('Service unavailable.', message), code: 503})
}
function gatewayTimeout(message = null) {
    return generateError({message: withDetails('Gateway timeout.', message), code: 504})
}

//a node's own refusal is relayed to the operator, cut to a length that cannot flood the answer or the log
const maxPeerErrorLength = 512

/**
 * Maps a failed request relayed to a node onto the answer that says what went wrong, using the flags ChannelBase sets
 * on the error it rejects with. These are expected conditions of a node, not faults of the orchestrator
 * @param {Error} error - error a relayed request was rejected with
 * @returns {HttpError|null} the answer to give, or null when the error did not come from a relay
 */
function fromRelayError(error) {
    let relayed = null
    if (error.isPeerError)
        relayed = badGateway('Node refused the request: ' + String(error.message).substring(0, maxPeerErrorLength))
    else if (error.timeout)
        relayed = gatewayTimeout('Node did not answer in time')
    else if (error.connectionClosed)
        relayed = badGateway('Node connection closed before it answered')
    else if (error.notConnected)
        relayed = serviceUnavailable('Node is not connected')
    if (relayed)
        relayed.isRelayError = true
    return relayed
}

/**
 * @param {string} invalidParamName - name of the parameter that failed validation
 * @param {string} [message] - additional detail
 * @param {any} [details] - structured detail
 * @returns {Error}
 */
function validationError(invalidParamName, message = null, details = null) {
    return badRequest(`Invalid parameter: ${invalidParamName}. ${message || ''}`.trim(), details)
}
function notImplemented() {
    return new Error('Not implemented')
}

module.exports = {
    HttpError,
    handleSystemError,
    genericError,
    badRequest,
    forbidden,
    unauthorized,
    notFound,
    badGateway,
    serviceUnavailable,
    gatewayTimeout,
    fromRelayError,
    validationError,
    notImplemented
}