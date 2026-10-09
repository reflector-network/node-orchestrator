const {sortObjectKeys} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')

const nonceSchema = new mongoose.Schema({
    pubkey: {type: String, required: true, index: true, unique: true},
    nonce: {type: Number, required: true},
    //envelope signatures travel to every node and to anonymous subscribers, so they get their own replay counter
    signatureNonce: {type: Number, required: false, default: 0}
})

nonceSchema.methods.toPlainObject = function() {
    return sortObjectKeys({
        pubkey: this.pubkey,
        nonce: this.nonce,
        signatureNonce: this.signatureNonce || 0
    })
}

const NonceModel = mongoose.model('Nonces', nonceSchema)

module.exports = NonceModel