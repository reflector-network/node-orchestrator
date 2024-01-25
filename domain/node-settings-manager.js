const NodeSettings = require('../persistence-layer/models/node-settings')

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