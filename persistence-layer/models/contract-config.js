const mongoose = require('mongoose')
const {sortObjectKeys, mapToPlainObject} = require('@reflector/reflector-shared')
const signatureSchema = require('./signature')

const nodeSchema = new mongoose.Schema({
    pubkey: {
        type: String,
        required: true
    },
    url: {
        type: String,
        required: true
    }
}, {_id: false})

nodeSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        pubkey: this.pubkey,
        url: this.url
    })
}

const assetSchema = new mongoose.Schema({
    type: {type: Number, required: true},
    code: {type: String, required: true}
}, {_id: false})

assetSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        type: this.type,
        code: this.code
    })
}

const contractConfigSchema = new mongoose.Schema({
    oracleId: {
        type: String,
        required: true
    },
    admin: {
        type: String,
        required: true
    },
    dataSource: {
        type: String,
        required: true
    },
    baseAsset: {
        type: assetSchema,
        required: true
    },
    decimals: {
        type: Number,
        required: true
    },
    assets: {
        type: [assetSchema],
        required: true
    },
    timeframe: {
        type: Number,
        required: true
    },
    period: {
        type: Number,
        required: true
    },
    fee: {
        type: Number,
        required: true
    }
}, {_id: false})

contractConfigSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        oracleId: this.oracleId,
        admin: this.admin,
        dataSource: this.dataSource,
        baseAsset: this.baseAsset.toPlainObject(),
        decimals: this.decimals,
        assets: this.assets.map(a => a.toPlainObject()),
        timeframe: this.timeframe,
        period: this.period,
        fee: this.fee
    })
}

const configSchema = new mongoose.Schema({
    contracts: {type: mongoose.Schema.Types.Map, of: contractConfigSchema, required: true},
    nodes: {type: mongoose.Schema.Types.Map, of: nodeSchema, required: true},
    network: {type: String, required: true},
    minDate: {type: Number, required: true},
    wasmHash: {type: String, length: 64},
    systemAccount: {type: String, required: true}
}, {_id: false})

configSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        contracts: mapToPlainObject(this.contracts),
        nodes: mapToPlainObject(this.nodes),
        minDate: this.minDate,
        wasmHash: this.wasmHash,
        network: this.network,
        systemAccount: this.systemAccount
    })
}

const configEnvelopeSchemaModel = new mongoose.Schema({
    config: {type: configSchema, required: true},
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
    }
}, {timestamps: true})

configEnvelopeSchemaModel.methods.toPlainObject = function () {
    return sortObjectKeys({
        id: this._id.toString(),
        config: this.config.toPlainObject(),
        signatures: this.signatures.map(s => s.toPlainObject()),
        initiator: this.signatures[0].pubkey,
        description: this.description,
        expirationDate: this.expirationDate,
        status: this.status,
        timestamp: this.timestamp,
        txHash: this.txHash
    })
}

const ConfigEnvelopeModel = mongoose.model('Configs', configEnvelopeSchemaModel)

module.exports = ConfigEnvelopeModel