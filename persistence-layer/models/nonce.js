const {sortObjectKeys} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')

const nonceSchema = new mongoose.Schema({
    pubkey: {type: String, required: true, index: true, unique: true},
    nonce: {type: Number, required: true}
})

nonceSchema.methods.toPlainObject = function() {
    return sortObjectKeys({
        pubkey: this.pubkey,
        nonce: this.nonce
    })
}

const NonceModel = mongoose.model('Nonces', nonceSchema)

module.exports = NonceModel