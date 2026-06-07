/*eslint-disable class-methods-use-this */
const logger = require('../../logger')
const container = require('../container')

function hoursToMs(hours) {
    return 1000 * 60 * 60 * hours
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]))
}

const throttleHoursByType = {
    NODE_UNAVAILABLE: 6,
    NO_MAJORITY: 6,
    WRONG_CONFIG: 6,
    WRONG_PENDING_CONFIG: 6,
    CONNECTION_ISSUES: 24,
    TIME_SHIFT: 24,
    PRICE_UPDATE_ISSUE: 1,
    CLUSTER_UPDATE_ISSUE: 6,
    PRICE_SPIKE: 24 * 365,
    DAO_BALLOT_CREATED: 24 * 365,
    DAO_VOTE: 24 * 365
}

const minAgeMsByType = {
    NODE_UNAVAILABLE: hoursToMs(1),
    NO_MAJORITY: hoursToMs(0.1),
    WRONG_CONFIG: hoursToMs(0.1),
    WRONG_PENDING_CONFIG: hoursToMs(0.1)
}

class NotificationItem {
    constructor({category, scope, type, message, recipient, firstSeenAt, dedupKey, throttleHoursOverride}) {
        this.category = category
        this.scope = scope
        this.type = type
        this.message = message
        this.recipient = recipient
        this.firstSeenAt = firstSeenAt
        this.dedupKey = dedupKey
        this.throttleHoursOverride = throttleHoursOverride
        this.notificationTimestamp = 0
    }

    shouldSend() {
        const now = Date.now()
        const minAge = minAgeMsByType[this.type] || 0
        if (now - this.firstSeenAt < minAge)
            return false
        const throttleHours = this.throttleHoursOverride ?? throttleHoursByType[this.type] ?? 24
        return now - this.notificationTimestamp > hoursToMs(throttleHours)
    }

    setNotificationSent() {
        this.notificationTimestamp = Date.now()
    }
}

class NotificationsManager {
    /**
     * @type {Map<string, NotificationItem>}
     */
    __items = new Map()

    report(event) {
        const existing = this.__items.get(event.dedupKey)
        if (existing) {
            existing.message = event.message
            existing.recipient = event.recipient
            return
        }
        this.__items.set(event.dedupKey, new NotificationItem(event))
    }

    clear(dedupKey) {
        this.__items.delete(dedupKey)
    }

    async flush() {
        const byRecipient = new Map()
        for (const item of this.__items.values()) {
            if (!item.shouldSend())
                continue
            const key = this.__recipientKey(item.recipient)
            if (!key)
                continue
            if (!byRecipient.has(key))
                byRecipient.set(key, {recipient: item.recipient, items: []})
            byRecipient.get(key).items.push(item)
        }

        const sends = []
        for (const {recipient, items} of byRecipient.values()) {
            sends.push(this.__deliver(recipient, items))
        }
        await Promise.allSettled(sends)
        this.__sweepExpired()
    }

    __recipientKey(recipient) {
        if (!recipient)
            return null
        switch (recipient.kind) {
            case 'pubkey':
                return recipient.pubkey ? 'pubkey:' + recipient.pubkey : null
            case 'all':
                return 'all'
            case 'monitoring': {
                const monitoringKey = container.appConfig && container.appConfig.monitoringKey
                if (!monitoringKey) {
                    logger.debug('NotificationsManager: monitoringKey unset, dropping monitoring delivery')
                    return null
                }
                return 'monitoring:' + monitoringKey
            }
            default:
                return null
        }
    }

    async __deliver(recipient, items) {
        const html = this.__renderHtml(items)
        try {
            switch (recipient.kind) {
                case 'pubkey':
                    await container.emailProvider.sendToPubkey(recipient.pubkey, this.__subject(recipient, items), html)
                    break
                case 'all':
                    await container.emailProvider.sendToAll(this.__subject(recipient, items), html)
                    break
                case 'monitoring':
                    await container.emailProvider.sendToPubkey(container.appConfig.monitoringKey, this.__subject(recipient, items), html)
                    break
                default:
                    return
            }
            for (const item of items)
                item.setNotificationSent()
        } catch (e) {
            logger.error('NotificationsManager: delivery failed for ' + this.__recipientKey(recipient) + ': ' + e.message)
        }
    }

    __subject(recipient) {
        switch (recipient.kind) {
            case 'pubkey':
                return 'Node ' + recipient.pubkey + ' issues'
            case 'all':
                return 'Cluster issues'
            case 'monitoring':
                return 'Reflector monitoring events'
            default:
                return 'Reflector notification'
        }
    }

    __renderHtml(items) {
        const headerByRecipientKind = items[0].recipient.kind === 'all'
            ? 'Cluster issues'
            : (items[0].recipient.kind === 'monitoring' ? 'Monitoring events' : 'Node issues')
        const body = items.map(i => '<h3>' + escapeHtml(i.message) + '</h3>').join('')
        return '<html><body><h1>' + headerByRecipientKind + '</h1><hr/>' + body + '</body></html>'
    }

    __sweepExpired() {
        const cutoff = Date.now() - hoursToMs(24 * 7)
        for (const [key, item] of this.__items.entries()) {
            if (item.notificationTimestamp > 0 && item.notificationTimestamp < cutoff)
                this.__items.delete(key)
        }
    }

    //test helpers - keep public-but-prefixed so tests can introspect without
    //exposing internals to production callers.
    _size() {
        return this.__items.size
    }

    _peek(dedupKey) {
        return this.__items.get(dedupKey)
    }
}

module.exports = NotificationsManager
