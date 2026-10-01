const dns = require('dns')
const http = require('http')
const https = require('https')
const {default: axios} = require('axios')
const {resolveAndValidate, isPrivateIP} = require('./ssrf-validator')

const requestTimeout = 5000
const maxResponseSize = 1024 * 1024

/**
 * Re-check the address the socket is about to connect to, so a name that resolved to a public address a moment ago
 * cannot be rebound to an internal one. Keeping the original host in the url leaves TLS verification intact.
 * @param {string} hostname - host being connected to
 * @param {object} options - dns.lookup options
 * @param {function} callback - dns.lookup callback
 * @returns {void}
 */
function safeLookup(hostname, options, callback) {
    dns.lookup(hostname, options, (err, address, family) => {
        if (err)
            return callback(err)
        //Node >= 20 calls the agent lookup with {all: true} and happy eyeballs may connect to any answer in the list,
        //so every address has to be public — checking only the first one lets [public, 10.0.0.5] through
        const addresses = Array.isArray(address) ? address.map(a => a.address) : [address]
        const blocked = addresses.find(a => isPrivateIP(a))
        if (blocked !== undefined) {
            const error = new Error(`SSRF blocked: ${hostname} resolved to private IP ${blocked}`)
            error.safeMessage = 'Host resolves to a private address'
            return callback(error)
        }
        return callback(null, address, family)
    })
}

const httpAgent = new http.Agent({lookup: safeLookup})
const httpsAgent = new https.Agent({lookup: safeLookup})

/**
 * Build the error a deadline aborts with. The reason travels on the signal, so it has to carry a safeMessage of its
 * own: it is what the caller is told once axios has discarded its own error in favour of a cancellation.
 * @param {string} message - internal message
 * @param {string} safeMessage - reason that is safe to echo to the caller
 * @returns {Error}
 */
function timeoutError(message, safeMessage) {
    const error = new Error(message)
    error.safeMessage = safeMessage
    return error
}

/**
 * Carry the safe reason across the axios boundary. axios re-wraps a socket-level failure, so the safeMessage set by
 * safeLookup arrives on `error.cause` rather than on the error itself, and a cancelled request reports axios' own
 * generic message instead of the reason the deadline was armed with.
 * @param {Error} error - error raised by the request
 * @param {AbortSignal} signal - deadline signal for this request
 * @returns {Error}
 */
function asSafeError(error, signal) {
    if (error.safeMessage)
        return error
    if (signal.aborted && signal.reason instanceof Error && signal.reason.safeMessage)
        return signal.reason
    if (error.cause?.safeMessage)
        error.safeMessage = error.cause.safeMessage
    return error
}

/**
 * GET a caller-supplied URL under egress guards: the host is validated, a redirect is an error
 * rather than something to follow, the response body is capped and the whole request has a deadline.
 * @param {string} url - absolute http(s) url
 * @param {{headers: object, timeout: number, signal: AbortSignal}} [options] - request headers, deadline in
 * milliseconds, and an outer budget to share
 * @returns {Promise<any>} parsed json body
 */
async function safeGetJson(url, options = {}) {
    const {headers = {}, timeout = requestTimeout, signal} = options
    //axios' `timeout` is a socket-inactivity timer, not a deadline: a host that trickles one byte at a time resets it
    //for as long as it likes. This wall-clock deadline is what bounds the request, and it is armed before the lookup,
    //so resolution, connect and read share one budget instead of each getting its own
    const controller = new AbortController()
    const deadline = setTimeout(
        () => controller.abort(timeoutError(`Gateway request exceeded ${timeout}ms`, 'Gateway request timed out')),
        timeout
    )
    //the caller's budget is composed with this one rather than replacing it, so whichever expires first ends the request
    const onCallerAbort = () => controller.abort(signal.reason)
    if (signal) {
        if (signal.aborted)
            onCallerAbort()
        else
            signal.addEventListener('abort', onCallerAbort, {once: true})
    }
    try {
        await resolveAndValidate(url, {signal: controller.signal})
        const response = await axios.request({
            method: 'GET',
            url,
            headers,
            //kept alongside the deadline: it is still the cheapest way to drop a socket that has gone quiet entirely
            timeout,
            signal: controller.signal,
            maxRedirects: 0,
            maxContentLength: maxResponseSize,
            maxBodyLength: maxResponseSize,
            responseType: 'json',
            httpAgent,
            httpsAgent,
            //this client pins the address it validated onto the agents above, and a proxy would take the request off
            //them and the anti-rebinding guard with it, so an HTTP_PROXY in the environment is deliberately ignored
            proxy: false,
            //a 3xx would take the request off the validated host, so it fails here instead of being followed
            validateStatus: status => status >= 200 && status < 300
        })
        //responseType: 'json' asks axios for a parse, it does not guarantee one: a body that does not parse comes
        //back as raw text, and a caller reading fields off it sees undefined rather than a failure
        if (typeof response.data !== 'object' || response.data === null) {
            const error = new Error(`Response from ${url} is not a JSON object`)
            error.safeMessage = 'Gateway returned a non-JSON response'
            throw error
        }
        return response.data
    } catch (e) {
        throw asSafeError(e, controller.signal)
    } finally {
        clearTimeout(deadline)
        if (signal)
            signal.removeEventListener('abort', onCallerAbort)
    }
}

module.exports = {safeGetJson, safeLookup, timeoutError, requestTimeout, maxResponseSize}
