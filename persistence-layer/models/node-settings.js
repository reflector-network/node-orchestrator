const {sortObjectKeys} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')

const settingsSchema = new mongoose.Schema({
    emails: {
        type: [String],
        required: true
    }
}, {_id: false, strict: true})

settingsSchema.methods.toPlainObject = function() {
    return sortObjectKeys({
        emails: this.emails
    })
}

const nodeSettingsSchema = new mongoose.Schema({
    _id: {type: String, required: true},
    settings: {
        type: settingsSchema,
        required: true
    }
}, {autoIndex: false, strict: true})

nodeSettingsSchema.virtual('pubkey').get(function() {
    return this._id
})

nodeSettingsSchema.pre('save', function(next) {
    if (!this.pubkey)
        return next(new Error('pubkey is required'))
    this._id = this.pubkey
    next()
})

nodeSettingsSchema.methods.toPlainObject = function() {
    return sortObjectKeys({
        pubkey: this.pubkey,
        settings: this.settings.toPlainObject()
    })
}

const NodeSettings = mongoose.model('NodeSettings', nodeSettingsSchema)

module.exports = NodeSettings