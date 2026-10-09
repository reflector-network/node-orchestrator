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

//how long an item is kept after its last send, or while it has never been sent
const retentionMs = hoursToMs(24 * 7)

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
        //set when the issue went away after a mail went out: the item stays, unsent, until its throttle window passes, so
        //an issue that flaps does not mail on every return
        this.cleared = false
        //when this process took the item in. firstSeenAt cannot stand in for it: a DAO event or a price round read on
        //catch-up carries its ledger or round time, which can already be more than a week old
        this.receivedAt = Date.now()
    }

    /**
     * @returns {number} how long after a send the item may not be sent again, in ms
     */
    get throttleMs() {
        return hoursToMs(this.throttleHoursOverride ?? throttleHoursByType[this.type] ?? 24)
    }

    shouldSend() {
        if (this.cleared)
            return false
        const now = Date.now()
        const minAge = minAgeMsByType[this.type] || 0
        if (now - this.firstSeenAt < minAge)
            return false
        return now - this.notificationTimestamp > this.throttleMs
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

    /**
     * @type {Promise<void>|null} the flush currently in flight, shared by both timer loops
     */
    __flushing = null

    report(event) {
        const existing = this.__items.get(event.dedupKey)
        if (existing) {
            if (existing.cleared) { //back inside the window of its last mail: that mail still throttles it
                existing.cleared = false
                existing.firstSeenAt = event.firstSeenAt //a new occurrence, which must age again where a type asks for it
            }
            existing.message = event.message
            existing.recipient = event.recipient
            return
        }
        this.__items.set(event.dedupKey, new NotificationItem(event))
    }

    /**
     * The issue went away. An item that was never sent is dropped. One that was sent, or may be by a flush in flight,
     * is kept as a tombstone that is not sent: deleting it would forget when it last mailed, so an issue that clears
     * and returns every other round would mail on every return. A report revives it and the sweep drops it once
     * its throttle window has passed
     * @param {string} dedupKey - key of the issue that went away
     */
    clear(dedupKey) {
        const item = this.__items.get(dedupKey)
        if (!item)
            return
        if (item.notificationTimestamp > 0 || this.__flushing)
            item.cleared = true
        else
            this.__items.delete(dedupKey)
    }

    /**
     * Send every item that is due, grouped by recipient. A call made while a flush is in flight gets that flush's
     * promise instead of starting a second pass: items are marked sent only once their send settles, so an overlapping
     * pass would select and send them again. An item reported meanwhile goes out with the next flush
     * @returns {Promise<void>}
     */
    flush() {
        if (this.__flushing)
            return this.__flushing
        this.__flushing = this.__flush().finally(() => {
            this.__flushing = null
        })
        return this.__flushing
    }

    async __flush() {
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
                if (!recipient.pubkey)
                    return null
                //an item raised while the node was a member is not sent once it has left the cluster
                if (!container.configManager.hasNode(recipient.pubkey)) {
                    logger.debug('NotificationsManager: ' + recipient.pubkey + ' is not in the cluster, skipping delivery')
                    return null
                }
                return 'pubkey:' + recipient.pubkey
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
        const now = Date.now()
        const cutoff = now - retentionMs
        for (const [key, item] of this.__items.entries()) {
            //a tombstone only remembers a send that throttles a return; with none, or once its window passed, it goes
            if (item.cleared && (item.notificationTimestamp === 0 || now - item.notificationTimestamp > item.throttleMs)) {
                this.__items.delete(key)
                continue
            }
            //an item that was never sent - its recipient never resolves, or every send failed - is dropped once it has
            //been held for the same window, rather than kept for the life of the process
            const expired = item.notificationTimestamp > 0
                ? item.notificationTimestamp < cutoff
                : item.receivedAt < cutoff
            if (expired)
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
