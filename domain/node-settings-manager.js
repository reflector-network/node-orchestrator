const {ValidationError} = require('@reflector/reflector-shared')
const NodeSettings = require('../persistence-layer/models/node-settings')
const logger = require('../logger')
const {mailRegex} = require('./utils')
const container = require('./container')

//the addresses are node-supplied and unverified; a small cap keeps the orchestrator from being used as a bulk mailer
//through the cluster alert channel
const maxEmailsPerNode = 5
//the longest address SMTP can carry (RFC 5321 path limit less the angle brackets)
const maxEmailLength = 254

class NodeSettingsManager {
    async init() {
        this.settings = new Map()
        const settings = await NodeSettings.find({}).exec()
        for (const s of settings) {
            const plainObject = s.toPlainObject()
            this.settings.set(plainObject.pubkey, plainObject.settings)
        }
    }

    /**
     * Replace a node's notification addresses. Every check runs before anything is registered with OneSignal or stored
     * @param {string} pubkey - node public key
     * @param {{emails: string[]}} settings - node settings
     * @returns {Promise<void>}
     */
    async update(pubkey, settings) {
        const {emails} = settings || {}
        if (!Array.isArray(emails))
            throw new ValidationError('emails must be an array')
        if (emails.length > maxEmailsPerNode)
            throw new ValidationError(`emails must contain at most ${maxEmailsPerNode} addresses`)
        for (const email of emails) {
            //the type check comes first: the regex coerces its argument, so ['a@b.com'] would pass as a@b.com
            if (typeof email !== 'string' || email.length > maxEmailLength || !mailRegex.test(email)) {
                throw new ValidationError('Invalid email')
            }
        }
        //compared without case, since mail providers treat Ops@x.com and ops@x.com as one mailbox
        if ((new Set(emails.map(email => email.toLowerCase()))).size !== emails.length) {
            throw new ValidationError('Duplicate emails')
        }

        if (emails.length > 0) {
            try {
                await container.emailProvider.registerUsers(emails)
            } catch (err) {
                logger.error({err}, 'Error registering emails')
                throw new ValidationError('Unable to register emails.')
            }
        }

        //only the field that was validated is stored, whatever else the settings object carries
        const settingsModel = await NodeSettings.findByIdAndUpdate(
            pubkey,
            {$set: {settings: {emails}}},
            {upsert: true, new: true}
        ).exec()

        this.settings.set(pubkey, settingsModel.toPlainObject().settings)
    }

    get(pubkey) {
        return this.settings.get(pubkey) || {}
    }
}

module.exports = NodeSettingsManager