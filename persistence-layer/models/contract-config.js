import { default as mongoose } from 'mongoose'
import signatureSchema from './signature.js'
import { sortObjectKeys } from '@reflector/reflector-shared'

const nodeSchema = new mongoose.Schema({
    pubkey: {
        type: String,
        required: true
    },
    url: {
        type: String,
        required: true
    }
}, { _id: false })

nodeSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        pubkey: this.pubkey,
        url: this.url,
        removed: this.removed
    })
}

const assetSchema = new mongoose.Schema({
    type: { type: Number, required: true },
    code: { type: String, required: true }
}, { _id: false })

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
    network: {
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
}, { _id: false })

contractConfigSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        oracleId: this.oracleId,
        admin: this.admin,
        network: this.network,
        baseAsset: this.baseAsset.toPlainObject(),
        decimals: this.decimals,
        assets: this.assets.map(a => a.toPlainObject()),
        timeframe: this.timeframe,
        period: this.period,
        fee: this.fee
    })
}

const configSchema = new mongoose.Schema({
    contracts: { type: [contractConfigSchema], required: true },
    nodes: { type: [nodeSchema], required: true },
    minDate: { type: Number, required: true },
    wasmHash: { type: String, length: 64 }
}, { _id: false })

configSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        contracts: this.contracts.map(c => c.toPlainObject()),
        nodes: this.nodes.map(n => n.toPlainObject()),
        minDate: this.minDate,
        wasmHash: this.wasmHash
    })
}

configSchema.pre('save', function (next) {
    const { nodes, contracts } = this
    for (let node of nodes) {
        if (nodes.filter(n => n.pubkey === node.pubkey).length > 1)
            return next(new Error('Duplicate pubkey found in nodes'))
    }

    for (let contract of contracts) {
        if (contracts.filter(c => c.oracleId === contract.oracleId).length > 1)
            return next(new Error('Duplicate oracleId found in contracts'))

        for (let asset of contract.assets) {
            if (contract.assets.filter(a => a.code === asset.code && a.type === asset.type).length > 1) {
                return next(new Error('Duplicate asset found in contracts'));
            }
        }
    }
    next()
})

const configEnvelopeSchemaModel = new mongoose.Schema({
    config: { type: configSchema, required: true },
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
        enum: ['voting', 'pending', 'rejected', 'applied'],
        required: true
    }
}, { timestamps: true })

configEnvelopeSchemaModel.methods.toPlainObject = function () {
    return sortObjectKeys({
        id: this._id.toString(),
        config: this.config.toPlainObject(),
        signatures: this.signatures.map(s => s.toPlainObject()),
        initiator: this.signatures[0].pubkey,
        description: this.description,
        expirationDate: this.expirationDate,
        status: this.status,
        timestamp: this.timestamp
    })
}

const ConfigEnvelopeModel = mongoose.model('Configs', configEnvelopeSchemaModel)

export default ConfigEnvelopeModel