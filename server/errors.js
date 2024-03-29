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
function validationError(invalidParamName, message = null, details = null) {
    return this.badRequest(`Invalid parameter: ${invalidParamName}.`, message, details)
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
    validationError,
    notImplemented
}