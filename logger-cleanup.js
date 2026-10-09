const path = require('path')
const net = require('net')
const pino = require('pino')

const basePath = path.resolve(path.resolve(process.cwd()), '..') + path.sep

const maxDepth = 6
const maxEntries = 50

//Stellar secret seeds, RSA key material, http credentials and api keys must never reach a log file. A url keeps its
//scheme, host and port only: rpc and data providers put api keys in the path (https://provider/<key>) as often as in
//the query, so no part of the path is safe to keep. reflector-node src/utils/log-redaction.js cuts
//urls the same way
const seedPattern = /\bS[A-Z2-7]{55}\b/g
const rsaKeyPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
const credentialsPattern = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi
const apiKeyQueryPattern = /([?&](?:api[-_]?key|apikey|access[-_]?key|access[-_]?token|auth[-_]?token|token|secret|key)=)[^&\s"']+/gi
//an http or websocket url: scheme, optional userinfo, the host and port, then whatever follows up to a blank or a quote.
//file urls - stack frames - keep their paths
const urlPattern = /\b((?:https?|wss?):\/\/)(?:[^\s/?#@"'<>`]*@)?([^\s/?#"'<>`]*)[^\s"'<>`]*/gi
const ipv4Pattern = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/g
const ipv6Candidate = /(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}/g

/**
 * @param {string} address - ipv6 address
 * @returns {string} the address with everything between the first and last group masked
 */
function maskIpv6(address) {
    const parts = address.split(':')
    return `${parts[0]}:***:${parts[parts.length - 1]}`
}

/**
 * Redact credentials and network detail from a log string
 * @param {string} value - string to redact
 * @returns {string}
 */
function redactString(value) {
    return value
        .replaceAll(basePath, './')
        .replace(urlPattern, '$1$2')
        .replace(rsaKeyPattern, '[redacted]')
        .replace(seedPattern, '[redacted]')
        .replace(credentialsPattern, '[redacted]')
        .replace(apiKeyQueryPattern, '$1[redacted]')
        .replace(ipv4Pattern, '$1.***.***.$4')
        .replace(ipv6Candidate, match => (net.isIPv6(match) ? maskIpv6(match) : match))
        .replaceAll('\\', '/')
}

/**
 * Build a redacted copy of a value. The original is never modified, the walk is depth- and breadth-bounded, and a
 * repeated reference is reported instead of followed.
 * @param {any} data - value to copy
 * @param {number} [depth] - current depth
 * @param {WeakSet} [seen] - objects already visited
 * @returns {any}
 */
function cleanup(data, depth = 0, seen = new WeakSet()) {
    if (typeof data === 'string')
        return redactString(data)
    if (!data || typeof data !== 'object')
        return data
    if (data instanceof Date)
        return data
    if (depth >= maxDepth)
        return '[truncated]'
    if (seen.has(data))
        return '[circular]'
    seen.add(data)
    if (Array.isArray(data))
        return data.slice(0, maxEntries).map(item => cleanup(item, depth + 1, seen))
    if (data instanceof Error) {
        const copy = new Error(redactString(data.message || ''))
        copy.name = data.name
        copy.stack = redactString(data.stack || '')
        for (const key of ['code', 'status', 'details'])
            if (data[key] !== undefined)
                copy[key] = cleanup(data[key], depth + 1, seen)
        if (data.url !== undefined) //its scheme, host and port only, as filterError keeps it
            copy.url = cleanup(safeUrl(data.url), depth + 1, seen)
        if (data.cause !== undefined)
            copy.cause = cleanup(data.cause, depth + 1, seen)
        return copy
    }
    const result = {}
    for (const key of Object.getOwnPropertyNames(data).slice(0, maxEntries))
        result[key] = cleanup(data[key], depth + 1, seen)
    return result
}

/**
 * @param {string} [url] - request url
 * @returns {string|undefined} scheme, host and port only - no userinfo, path, query or fragment; undefined when it is
 * not a url
 */
function safeUrl(url) {
    if (typeof url !== 'string')
        return undefined
    try {
        const {protocol, host} = new URL(url)
        return `${protocol}//${host}`
    } catch (e) {
        return undefined
    }
}

/**
 * Replace an axios-shaped error with a small one. pino's error serializer copies every enumerable property, and an
 * axios error carries the request headers, the request body and the full url.
 * @param {any} err - error to filter
 * @returns {any} the same error when it is not axios-shaped
 */
function filterError(err) {
    if (!err || typeof err !== 'object')
        return err
    if (!err.isAxiosError && !err.config && !err.request && !err.response)
        return err
    const filtered = new Error(err.message)
    filtered.name = err.name
    filtered.stack = err.stack
    if (err.code !== undefined)
        filtered.code = err.code
    const status = err.response && err.response.status !== undefined ? err.response.status : err.status
    if (status !== undefined)
        filtered.status = status
    const url = safeUrl(err.config && err.config.url)
    if (url !== undefined)
        filtered.url = url
    return filtered
}

/**
 * @param {any} err - error to serialize
 * @returns {any}
 */
function errorSerializer(err) {
    return pino.stdSerializers.err(cleanup(filterError(err)))
}

/**
 * @param {any} msg - message to serialize
 * @returns {any}
 */
function msgSerializer(msg) {
    const cleaned = cleanup(msg)
    return typeof cleaned === 'string' ? cleaned : {msg: cleaned}
}

module.exports = {redactString, safeUrl, cleanup, filterError, errorSerializer, msgSerializer}
