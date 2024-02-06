const {ValidationError} = require('@reflector/reflector-shared')
const NodeSettings = require('../persistence-layer/models/node-settings')
const {mailRegex} = require('./utils')

class NodeSettingsManager {
    async init() {
        this.settings = new Map()
        const settings = await NodeSettings.find({}).exec()
        for (const s of settings) {
            const plainObject = s.toPlainObject()
            this.settings.set(plainObject.pubkey, plainObject.settings)
        }
    }

    async update(pubkey, settings) {
        const emails = {settings}
        for (const email of emails) {
            if (!mailRegex.test(email)) {
                throw new ValidationError('Invalid email')
            }
        }
        const settingsModel = await NodeSettings.findByIdAndUpdate(
            pubkey,
            {$set: {settings}},
            {upsert: true, new: true}
        ).exec()

        this.settings.set(pubkey, settingsModel.toPlainObject().settings)
    }

    get(pubkey) {
        return this.settings.get(pubkey) || {}
    }
}

module.exports = NodeSettingsManager