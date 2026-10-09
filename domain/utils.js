const {getMajority, ValidationError} = require('@reflector/reflector-shared')
const ConfigStatus = require('./config-status')

function computeUpdateStatus(signatures, totalNodesCount, isInitConfig = false) {
    const majority = getMajority(totalNodesCount)
    const availableVotes = totalNodesCount - signatures.length
    const rejectedCount = signatures.filter(sig => sig.rejected).length
    const acceptedCount = signatures.filter(sig => !sig.rejected).length

    if (acceptedCount >= majority) {
        return isInitConfig ? ConfigStatus.APPLIED : ConfigStatus.PENDING
    } else if (rejectedCount >= majority //rejected by majority
        || availableVotes + acceptedCount < majority) { //not enough votes left to reach majority
        return ConfigStatus.REJECTED
    }
    return ConfigStatus.VOTING
}

const mailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+$/

function isDebugging() {
    const isDebug = process.env.DEBUG === 'true'
    return isDebug
}

/**
 * Nodes verify every signature against the payload hash without the rejected flag, so rejected votes
 * must not travel to them.
 * @param {{signatures: {rejected: boolean}[]}} rawEnvelope - plain envelope
 * @returns {object} shallow copy with rejected signatures removed; falsy input is returned as is
 */
function stripRejectedSignatures(rawEnvelope) {
    if (!rawEnvelope)
        return rawEnvelope
    return {...rawEnvelope, signatures: rawEnvelope.signatures.filter(signature => !signature.rejected)}
}

/**
 * Parse a pagination parameter that arrived from a query string. Express parses the query with qs, so a parameter can
 * be an object or an array; anything that is not a safe integer is refused rather than handed to Mongo.
 * @param {any} value - raw query parameter
 * @param {number} fallback - value used when the parameter is absent
 * @param {number} min - lower bound
 * @param {number} max - upper bound
 * @returns {number}
 */
function parseBoundedInt(value, fallback, min, max) {
    if (value === undefined || value === null || value === '')
        return fallback
    const parsed = typeof value === 'number' ? value : parseInt(value, 10)
    if (!Number.isSafeInteger(parsed))
        throw new ValidationError('Invalid pagination parameter')
    return Math.min(Math.max(parsed, min), max)
}

module.exports = {
    isDebugging,
    computeUpdateStatus,
    mailRegex,
    stripRejectedSignatures,
    parseBoundedInt
}