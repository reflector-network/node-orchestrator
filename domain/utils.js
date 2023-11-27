import { getMajority } from '@reflector/reflector-shared'
import ConfigStatus from './config-status.js'

export function computeUpdateStatus(signatures, totalNodesCount) {
    const majority = getMajority(totalNodesCount)
    const availableVotes = totalNodesCount - signatures.length
    const rejectedCount = signatures.filter(sig => sig.rejected).length
    const acceptedCount = signatures.filter(sig => !sig.rejected).length

    if (acceptedCount >= majority) {
        return ConfigStatus.PENDING
    } else if (rejectedCount >= majority //rejected by majority
        || availableVotes + acceptedCount < majority) { //not enough votes left to reach majority
        return ConfigStatus.REJECTED
    }
    return ConfigStatus.VOTING
}