const {ValidationError} = require('@reflector/reflector-shared')
const NodeSettings = require('../persistence-layer/models/node-settings')
const logger = require('../logger')
const {mailRegex} = require('./utils')
const container = require('./container')

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
        const {emails} = settings
        if ((new Set(emails)).size !== emails.length) {
            throw new ValidationError('Duplicate emails')
        }
        for (const email of emails) {
            if (!mailRegex.test(email)) {
                throw new ValidationError('Invalid email')
            }
        }

        try {
            await container.emailProvider.registerUsers(emails)
        } catch (err) {
            logger.error({err}, 'Error registering emails')
            throw new ValidationError('Unable to register emails.')
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