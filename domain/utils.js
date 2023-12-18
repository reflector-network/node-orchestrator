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

module.exports = {
    computeUpdateStatus
}