const {default: axios} = require('axios')
const logger = require('../logger')
const container = require('./container')

class EmailProvider {
    constructor({apiKey, appId, from}) {
        if (!apiKey)
            throw new Error('apiKey is undefined')
        if (!from)
            throw new Error('from is undefined')
        if (!appId)
            throw new Error('appId is undefined')
        this.apiKey = apiKey
        this.from = from
        this.appId = appId
    }

    /**
     * Send an email
     * @param {string[]} to - Recipient email address
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async send(to, subject, text) {
        const message = {
            app_id: this.appId,
            "include_external_user_ids": [...new Set(to)],
            "channel_for_external_user_ids": "external_id",
            "email_subject": subject,
            "email_body": text
        }
        const options = {
            method: 'POST',
            url: 'https://api.onesignal.com/api/v1/notifications',
            headers: {accept: 'application/json', 'content-type': 'application/json; charset=utf-8', authorization: `Basic ${this.apiKey}`},
            data: message
        }

        const result = await axios
            .request(options)

        logger.debug(result.data)
    }

    /**
     * Send an email to public key
     * @param {string} publicKey - Recipient public key
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async sendToPubkey(publicKey, subject, text) {
        const {emails} = container.nodeSettingsManager.get(publicKey)

        if (!emails || emails.length === 0)
            return
        await this.send(emails, subject, text)
    }

    /**
     * Send an email to public key
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async sendToAll(subject, text) {
        const emails = [...container.nodeSettingsManager.settings.values()].filter(a => a.emails).map(a => a.emails).flat()
        if (!emails || emails.length === 0)
            return
        await this.send(emails, subject, text)
    }

    /**
     * Register users in OneSignal
     * @param {string[]} emails - User emails
     * @returns {Promise<void>}
     */
    async registerUsers(emails) {
        const getOptions = (email) => ({
            method: 'POST',
            url: `https://api.onesignal.com/apps/${this.appId}/users`,
            headers: {accept: 'application/json', 'content-type': 'application/json'},
            data: {
                identity: {external_id: email, onesignal_id: email},
                subscriptions: [{type: 'Email', token: email, enabled: true}]
            }
        })

        const requests = []
        for (const email of emails) {
            requests.push(axios.request(getOptions(email)))
        }
        await Promise.all(requests)
    }
}

module.exports = EmailProvider