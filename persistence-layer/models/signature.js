import { sortObjectKeys } from '@reflector/reflector-shared'
import {default as mongoose} from 'mongoose'

const Schema = mongoose.Schema

const signatureSchema = new Schema({
    nonce: {
        type: Number,
        required: true
    },
    pubkey: {
        type: String,
        required: true
    },
    signature: {
        type: String,
        required: true
    },
    rejected: {
        type: Boolean,
        required: true,
        default: false
    }
}, { _id: false })

signatureSchema.methods.toPlainObject = function() {
    return sortObjectKeys({
        nonce: this.nonce,
        pubkey: this.pubkey,
        signature: this.signature,
        rejected: this.rejected
    })
}

export default signatureSchema