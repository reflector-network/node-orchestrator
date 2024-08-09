const mongoose = require('mongoose')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const signatureSchema = require('./signature')

const nodeSchema = new mongoose.Schema({
    pubkey: {
        type: String,
        required: true
    },
    url: {
        type: String,
        required: true
    },
    domain: {
        type: String,
        required: true
    }
}, {_id: false})

nodeSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        pubkey: this.pubkey,
        url: this.url,
        domain: this.domain
    })
}

const configEnvelopeSchemaModel = new mongoose.Schema({
    config: {type: mongoose.Schema.Types.Mixed, required: true},
    signatures: {
        type: [signatureSchema],
        required: true
    },
    timestamp: {
        type: Number,
        required: false
    },
    description: {
        type: String
    },
    expirationDate: {
        type: Number,
        required: true
    },
    status: {
        type: String,
        enum: ['voting', 'pending', 'rejected', 'applied', 'replaced'],
        required: true
    },
    txHash: {
        type: String,
        required: false,
        default: null
    },
    isBlockchainUpdate: {
        type: Boolean,
        required: false,
        default: false
    },
    allowEarlySubmission: {type: Boolean}
}, {timestamps: true})

configEnvelopeSchemaModel.methods.toPlainObject = function () {
    return sortObjectKeys({
        id: this._id.toString(),
        config: this.config,
        signatures: this.signatures.map(s => s.toPlainObject()),
        initiator: this.signatures[0].pubkey,
        description: this.description,
        expirationDate: this.expirationDate,
        status: this.status,
        timestamp: this.timestamp,
        txHash: this.txHash,
        isBlockchainUpdate: this.isBlockchainUpdate,
        allowEarlySubmission: this.allowEarlySubmission
    })
}

const ConfigEnvelopeModel = mongoose.model('Configs', configEnvelopeSchemaModel)

module.exports = ConfigEnvelopeModel