const ConfigStatus = {
    VOTING: 'voting', //config was created
    REJECTED: 'rejected', //config was rejected by the majority of nodes
    PENDING: 'pending', //config was accepted by the majority of nodes, but not yet executed
    APPLIED: 'applied', //config was applied
    REPLACED: 'replaced' //config was replaced by a newer one
}
module.exports = ConfigStatus