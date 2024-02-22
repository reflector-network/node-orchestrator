/*eslint-disable guard-for-in */
const {getMajority, hasMajority} = require('@reflector/reflector-shared')
const logger = require('../logger')
const MessageTypes = require('../server/ws/handlers/message-types')
const container = require('./container')

const issueTypes = {
    CONNECTION_ISSUES: 'CONNECTION_ISSUES',
    TIME_SHIFT: 'TIME_SHIFT',
    NODE_UNAVAILABLE: 'NODE_UNAVAILABLE',
    WRONG_CONFIG: 'WRONG_CONFIG',
    WRONG_PENDING_CONFIG: 'WRONG_PENDING_CONFIG',
    PRICE_UPDATE_ISSUE: 'PRICE_UPDATE_ISSUE',
    CLUSTER_UPDATE_ISSUE: 'CLUSTER_UPDATE_ISSUE',
    NO_MAJORITY: 'NO_MAJORITY'
}

class NodeIssueItem {
    constructor(type, message, timestamp) {
        this.type = type
        this.message = message
        this.timestamp = timestamp
        this.notificationTimestamp = 0
    }

    setNotificationSent() {
        this.notificationTimestamp = Date.now()
    }

    shouldSend() {
        const __hoursToMs = (hours) => 1000 * 60 * 60 * hours
        //check if notification was sent recently
        const __shouldSend = (repeatInterval) => Date.now() - this.notificationTimestamp > __hoursToMs(repeatInterval)
        switch (this.type) {
            case issueTypes.NODE_UNAVAILABLE:
                return Date.now() - this.timestamp > __hoursToMs(1) && __shouldSend(6) //if node is unavailable for more than 1 hour
            case issueTypes.NO_MAJORITY:
                return Date.now() - this.timestamp > __hoursToMs(.1) && __shouldSend(6) //if no majority for more than 6 minutes
            case issueTypes.PRICE_UPDATE_ISSUE:
            case issueTypes.CLUSTER_UPDATE_ISSUE:
                return __shouldSend(6)

            default:
                return __shouldSend(24)
        }
    }
}

const statistics = []

const issues = {nodeIssues: {}, clusterIssues: {}}

async function getStatistics() {
    try {
        const nodes = container.configManager.allNodePubkeys()
        const requests = []
        for (const pubkey of nodes) {
            const channel = container.connectionManager.getNodeConnection(pubkey)
            const request = async () => {
                const result = {pubkey, statistics: null}
                try {
                    if (channel) {
                        const statisticsData = await channel.send({type: MessageTypes.STATISTICS_REQUEST})
                        statisticsData.timeshift = Date.now() - statisticsData.currentTime
                        result.statistics = statisticsData
                    }
                } catch (e) {
                    logger.error(`Error requesting statistics from node ${pubkey}: ${e.message}`)
                }
                return result
            }
            requests.push(request())
        }
        const nodeStatistics = (await Promise.allSettled(requests))
            .reduce((statistics, response) => {
                statistics[response.value.pubkey] = response.value.statistics
                return statistics
            }, {})

        const configData = container.configManager.getCurrentConfigs()

        const issuesData = collectIssues(nodeStatistics, configData)

        addStatistics({
            nodeStatistics,
            currentTimestamp: Date.now(),
            currentConfigHash: configData.currentConfig?.hash,
            pendingConfigHash: configData.pendingConfig?.hash
        })
        addIssues(issuesData, container.configManager.allNodePubkeys().length)
    } catch (e) {
        logger.error(`Error requesting statistics: ${e.message}`)
        return null
    } finally {
        setTimeout(getStatistics, 10000)
    }
}

function collectIssues(nodeStatistics, configData) {
    const now = Date.now()
    const nodeIssues = {}
    const lastOracleTimestamps = {}
    for (const pubkey in nodeStatistics) {
        const statistics = nodeStatistics[pubkey]
        const issues = {}
        if (!statistics) {
            nodeIssues[pubkey] = {[issueTypes.NODE_UNAVAILABLE]: new NodeIssueItem(issueTypes.NODE_UNAVAILABLE, 'Node server is unavailable', now)}
            continue
        }
        if (statistics.connectionIssues && statistics.connectionIssues.length > 0) {
            issues[issueTypes.CONNECTION_ISSUES] = new NodeIssueItem(issueTypes.CONNECTION_ISSUES, `Connection issues detected. \n${statistics.connectionIssues.join('\n')}`, now)
        }
        if (Math.abs(statistics.timeshift) > 5000) {
            issues[issueTypes.TIME_SHIFT] = new NodeIssueItem(issueTypes.TIME_SHIFT, `${statistics.timeshift}ms timeshift detected. Please, check time on your machine, or the internet connection.`, now)
        }
        if (configData.currentConfig && configData.currentConfig.hash !== statistics.currentConfigHash) {
            issues[issueTypes.WRONG_CONFIG] = new NodeIssueItem(issueTypes.WRONG_CONFIG, 'Node has wrong config. Please, check that you\'ve signed the current config, or restart the node server', now)
        }
        if (configData.pendingConfig && configData.pendingConfig.hash !== statistics.pendingConfigHash) {
            issues[issueTypes.WRONG_PENDING_CONFIG] = new NodeIssueItem(issueTypes.WRONG_PENDING_CONFIG, 'Node has wrong pending config. Please, restart the node server for sync.', now)
        }
        //set last oracle timestamps
        for (const oracleStatistics of Object.values(statistics.oracleStatistics)) {
            if (!oracleStatistics)
                console.log(oracleStatistics)
            const {lastOracleTimestamp, oracleId} = oracleStatistics
            if (!lastOracleTimestamps[oracleId])
                lastOracleTimestamps[oracleId] = lastOracleTimestamp
            else if (lastOracleTimestamps[oracleId] < lastOracleTimestamp) {
                lastOracleTimestamps[oracleId] = lastOracleTimestamp
            }
        }
        nodeIssues[pubkey] = issues
    }

    const clusterIssues = {}

    for (const [oracleId, lastOracleTimestamp] of Object.entries(lastOracleTimestamps)) {
        const contractData = configData.currentConfig.config.config.contracts[oracleId]
        if (!contractData)
            continue
        if (now - lastOracleTimestamp > contractData.timeframe * 2) { //if last oracle timestamp is older than 2 timeframes
            clusterIssues[oracleId] = {[issueTypes.PRICE_UPDATE_ISSUE]: new NodeIssueItem(issueTypes.PRICE_UPDATE_ISSUE, `Price update issue for oracle ${oracleId}.`, now)}
        }
    }

    if (configData.pendingConfig && now - configData.pendingConfig.timestamp > 1000 * 60 * 10) { //if pending config update is delayed for more than 10 minutes
        clusterIssues[issueTypes.CLUSTER_UPDATE_ISSUE] = new NodeIssueItem(issueTypes.CLUSTER_UPDATE_ISSUE, 'Cluster update issue.', now)
    }
    return {nodeIssues, clusterIssues}
}

function addStatistics(statisticsData) {
    //add statistics to the beginning of the array
    statistics.unshift(statisticsData)
    if (statistics.length > 100) //keep only 100 last statistics
        statistics.pop()
}

function addIssues(newIssuesData, totalNodesCount) {
    //merge new issues with existing ones
    function getUpdatedIssues(currentIssues, newIssues) {
        const updated = Object.keys(currentIssues).reduce((acc, key) => {
            if (key in newIssues) {
                acc[key] = currentIssues[key]
                delete newIssues[key]
            }
            return acc
        }, {})

        return {...updated, ...newIssues}
    }

    for (const pubkey in newIssuesData.nodeIssues) {
        const currentNodeIssues = issues.nodeIssues[pubkey] || {}
        const newNodeIssues = newIssuesData.nodeIssues[pubkey] || {}
        issues.nodeIssues[pubkey] = getUpdatedIssues(currentNodeIssues, newNodeIssues)
    }

    //check if there is no majority of nodes available
    if (!hasMajority(totalNodesCount, Object.values(issues.nodeIssues).filter(issue => !issue[issueTypes.NODE_UNAVAILABLE]).length)) {
        newIssuesData.clusterIssues[issueTypes.NO_MAJORITY] = new NodeIssueItem(issueTypes.NO_MAJORITY, 'No majority of nodes available', Date.now())
    }

    issues.clusterIssues = getUpdatedIssues(issues.clusterIssues, newIssuesData.clusterIssues)

    processIssues()
}

function processIssues() {
    for (const pubkey in issues.nodeIssues) {
        const nodeIssues = issues.nodeIssues[pubkey]
        const notificationsToSend = []
        for (const issue of Object.values(nodeIssues)) {
            if (issue.shouldSend()) {
                notificationsToSend.push(issue)
            }
        }
        if (notificationsToSend.length > 0) {
            container.emailProvider.sendToPubkey(pubkey, `Node ${pubkey} issues`, `<html><body><h1>Node issues<h1><hr/>${issuesToHtml(notificationsToSend.map(i => i.message))}</body></html>`)
                .then(() => {
                    for (const issue of notificationsToSend) {
                        issue.setNotificationSent()
                    }
                })
                .catch(e => logger.error(`Error sending email to ${pubkey}: ${e.message}`))
        }
    }

    const notificationsToSend = []
    for (const issue of Object.values(issues.clusterIssues)) {
        if (issue.shouldSend())
            notificationsToSend.push(issue)
    }

    if (notificationsToSend.length > 0) {
        container.emailProvider.sendToAll('Cluster issues', `<html><body><h1>Cluster issues<h1><hr/>${issuesToHtml(notificationsToSend.map(i => i.message))}</body></html>`)
            .then(() => {
                for (const issue of notificationsToSend) {
                    issue.setNotificationSent()
                }
            })
            .catch(e => logger.error(`Error sending email to all: ${e.message}`))
    }
}

function issuesToHtml(issues) {
    let issuesHtml = ''
    for (const issue of issues) {
        issuesHtml += `<h3>${issue}</h3>`
    }
    return issuesHtml
}

class StatisticsManager {

    constructor() {
        setTimeout(getStatistics, 10000)
    }

    getStatistics() {
        return statistics
    }
}

module.exports = StatisticsManager