const {getMajority} = require('@reflector/reflector-shared')
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

module.exports = {
    isDebugging,
    computeUpdateStatus,
    mailRegex,
    stripRejectedSignatures
}