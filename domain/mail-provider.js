const sgMail = require('@sendgrid/mail')
const container = require('./container')


class MailProvider {
    constructor(apiKey, from) {
        if (!apiKey)
            throw new Error('apiKey is undefined')
        if (!from)
            throw new Error('from is undefined')
        sgMail.setApiKey(apiKey)
        this.from = from
        this.isReady = true
    }

    /**
     * Send an email
     * @param {string|string[]} to - Recipient email address
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async send(to, subject, text) {
        if (!this.isReady)
            throw new Error('Mail provider is not ready')
        const msg = {
            to,
            from: this.from,
            subject,
            text
        }
        return await sgMail.send(msg)
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
}

module.exports = MailProvider