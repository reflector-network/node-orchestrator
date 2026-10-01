const {default: axios} = require('axios')
const logger = require('../logger')
const container = require('./container')

//defence in depth next to the per-node cap in NodeSettingsManager: no single message goes to more addresses than this,
//whatever the stored lists hold
const maxRecipientsPerMessage = 200
//a OneSignal request that has not settled by then is abandoned as failed. The notifications flush waits on it and both
//monitoring loops wait on the flush, so a request left to hang would stall all three
const sendTimeout = 15000

/**
 * Drop repeated addresses, keeping the first spelling of each
 * @param {string[]} emails - addresses, possibly repeated
 * @returns {string[]}
 */
function distinctAddresses(emails) {
    const seen = new Set()
    const distinct = []
    for (const email of emails) {
        //compared without case, since mail providers treat Ops@x.com and ops@x.com as one mailbox
        const key = email.toLowerCase()
        if (seen.has(key))
            continue
        seen.add(key)
        distinct.push(email)
    }
    return distinct
}

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
     * Send an email to each distinct address once, to at most maxRecipientsPerMessage of them
     * @param {string[]} to - Recipient email addresses
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async send(to, subject, text) {
        const recipients = distinctAddresses(to)
        if (recipients.length > maxRecipientsPerMessage) {
            logger.warn(`Email sent to the first ${maxRecipientsPerMessage} of ${recipients.length} recipients`)
            recipients.length = maxRecipientsPerMessage
        }
        const message = {
            app_id: this.appId,
            "include_external_user_ids": recipients,
            "channel_for_external_user_ids": "external_id",
            "email_subject": subject,
            "email_body": text,
            "email_from_name": this.from
        }
        //axios' `timeout` only bounds socket inactivity; this deadline bounds the whole request
        const controller = new AbortController()
        const deadline = setTimeout(
            () => controller.abort(new Error(`Email request exceeded ${sendTimeout}ms`)),
            sendTimeout
        )
        const options = {
            method: 'POST',
            url: 'https://api.onesignal.com/api/v1/notifications',
            headers: {accept: 'application/json', 'content-type': 'application/json; charset=utf-8', authorization: `Basic ${this.apiKey}`},
            data: message,
            timeout: sendTimeout,
            signal: controller.signal
        }

        try {
            const result = await axios
                .request(options)

            logger.debug(result.data)
        } catch (err) {
            //axios reports an aborted request as a bare 'canceled', so the deadline's own reason is passed on instead
            if (controller.signal.aborted)
                throw controller.signal.reason
            throw err
        } finally {
            clearTimeout(deadline)
        }
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
     * Send an email to the monitoring key and to the operators of every node in the current cluster; send() removes
     * repeated addresses and caps the list
     * @param {string} subject - Email subject
     * @param {string} text - Email body in plain text
     * @returns {Promise<any>}
     */
    async sendToAll(subject, text) {
        const {settings} = container.nodeSettingsManager
        //cluster issues are addressed to this audience alone, so the operator's monitoring key is part of it whether or
        //not it is a node. It goes first, so the recipient cap never cuts the operator off
        const monitoringKey = container.appConfig?.monitoringKey
        const audience = new Set(monitoringKey ? [monitoringKey] : [])
        //a node that has left the cluster keeps its stored settings, but not its place in the audience
        for (const pubkey of container.configManager.allNodePubkeys())
            audience.add(pubkey)
        const emails = [...audience]
            .map(pubkey => settings.get(pubkey)?.emails || [])
            .flat()
        if (emails.length === 0)
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