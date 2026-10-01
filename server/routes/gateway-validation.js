const logger = require('../../logger')
const {validateRequestUrl} = require('../../utils/ssrf-validator')
const {safeGetJson, timeoutError, requestTimeout} = require('../../utils/safe-request')
const {badRequest} = require('../errors')

const maxGatewaysPerRequest = 20
//requestTimeout bounds one probe; this bounds the route as a whole. Without it the worst case is maxGatewaysPerRequest
//urls by two probes by requestTimeout, about 200 s of held request. Six probe deadlines - 30 s - is ample for twenty
//gateways that each answer in well under a second, and bounds a caller who supplies twenty slow hosts
const totalValidationBudget = requestTimeout * 6
const maxValidationKeyLength = 256
const maxVersionLength = 64
const binanceTimeUrl = 'https://api.binance.com/api/v3/time'

/**
 * Validate the POST /validate-gateways body before anything reaches the network
 * @param {any} body - request body
 * @returns {{urls: string[], validationKey: string}} deduplicated urls in submission order
 */
function validateGatewaysBody(body) {
    const {urls, validationKey} = body || {}
    if (!Array.isArray(urls))
        throw badRequest('urls must be an array')
    if (urls.length > maxGatewaysPerRequest)
        throw badRequest(`urls must contain at most ${maxGatewaysPerRequest} entries`)
    if (urls.some(url => typeof url !== 'string'))
        throw badRequest('urls must be an array of strings')
    //required rather than optional: an omitted field cannot be what distinguishes this body from a POST /gateways one,
    //so a body that may leave it out is a body the /gateways allowed-keys check accepts and forwards
    if (typeof validationKey !== 'string' || !validationKey || validationKey.length > maxValidationKeyLength)
        throw badRequest('validationKey must be a non-empty string')
    return {urls: [...new Set(urls)], validationKey}
}

/**
 * The host of a caller-supplied url, for the log line. Only the host the caller already knows about: the address it
 * resolved to is the probe result, and a log is one of the places it must not turn up.
 * @param {string} address - gateway base url as supplied
 * @returns {string} host and port, or a placeholder when the string does not name a host
 */
function loggableHost(address) {
    try {
        return new URL(address).host || 'unnamed host'
    } catch (e) {
        return 'unparsable url'
    }
}

/**
 * Probe one gateway. Only messages this module raised itself are echoed to the caller; a transport error is logged and
 * reported as a fixed string, so the endpoint cannot be used to fingerprint internal services.
 * @param {string} address - gateway base url
 * @param {string} [validationKey] - value of the x-gateway-validation header
 * @param {AbortSignal} [signal] - the route's budget, shared by every probe
 * @returns {Promise<{status: string, version: string, error: string}>}
 */
async function validateGateway(address, validationKey, signal) {
    const info = {status: 'unreachable'}
    const headers = validationKey === undefined ? {} : {'x-gateway-validation': validationKey}
    try {
        validateRequestUrl(address)
        const {version} = await safeGetJson(address + '/', {headers, signal})
        //a host that merely answers 200 is not a gateway: the version is what the gateway contract promises, and
        //reporting one alive without it turns the status into a liveness report for any public host
        if (typeof version !== 'string' || !version) {
            const error = new Error('Gateway root did not report a version')
            error.safeMessage = 'Gateway did not report a version'
            throw error
        }
        info.version = version.slice(0, maxVersionLength)
        info.status = 'alive'
        const {serverTime} = await safeGetJson(address + '/gateway?url=' + encodeURIComponent(binanceTimeUrl), {headers, signal})
        if (!serverTime) {
            const error = new Error('Gateway did not proxy the upstream time request')
            error.safeMessage = 'Gateway did not proxy the upstream request'
            throw error
        }
        info.status = 'healthy'
    } catch (e) {
        //the host and a reason, never e.message: on the ssrf path that message names the private address the lookup
        //returned, which is precisely what a probe of an internal network is trying to read back
        logger.debug(`Gateway validation failed for ${loggableHost(address)}: ${e.safeMessage || e.code || 'request failed'}`)
        info.error = e.safeMessage || 'Gateway request failed'
    }
    return info
}

/**
 * Probe every gateway under one wall-clock budget, so the route is bounded however many urls are supplied. A url whose
 * turn never comes reports a timed-out status like any other failure rather than failing the whole request.
 * @param {string[]} urls - deduplicated gateway base urls
 * @param {string} [validationKey] - value of the x-gateway-validation header
 * @param {number} [budget] - total budget for the route in milliseconds
 * @returns {Promise<object>} validation result keyed by url
 */
async function validateGateways(urls, validationKey, budget = totalValidationBudget) {
    const controller = new AbortController()
    const deadline = setTimeout(
        () => controller.abort(timeoutError(`Gateway validation exceeded ${budget}ms`, 'Gateway validation timed out')),
        budget
    )
    const result = {}
    try {
        for (const url of urls) {
            result[url] = await validateGateway(url, validationKey, controller.signal)
        }
    } finally {
        clearTimeout(deadline)
    }
    return result
}

module.exports = {validateGatewaysBody, validateGateway, validateGateways, maxGatewaysPerRequest, totalValidationBudget}
