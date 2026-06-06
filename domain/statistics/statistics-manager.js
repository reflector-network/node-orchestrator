/*eslint-disable guard-for-in */
const {hasMajority, ContractTypes} = require('@reflector/reflector-shared')
const logger = require('../../logger')
const MessageTypes = require('../../server/ws/handlers/message-types')
const MetricsModel = require('../../persistence-layer/models/metrics-model')
const container = require('../container')
const ConfigStatus = require('../config-status')

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

class IssueRecord {
    constructor(type, message, timestamp) {
        this.type = type
        this.message = message
        this.timestamp = timestamp
    }
}

function nodeIssueDedupKey(pubkey, type) {
    return 'node:' + pubkey + ':' + type
}
function clusterIssueDedupKey(type) {
    return 'cluster:' + type
}
function oracleIssueDedupKey(oracleId, type) {
    return 'oracle:' + oracleId + ':' + type
}

function collectIssues(nodeStatistics, configData) {
    const now = Date.now()
    const nodeIssues = {}
    const lastOracleTimestamps = {}
    for (const pubkey in nodeStatistics) {
        const stats = nodeStatistics[pubkey]
        const perNode = {}
        if (!stats) {
            nodeIssues[pubkey] = {[issueTypes.NODE_UNAVAILABLE]: new IssueRecord(issueTypes.NODE_UNAVAILABLE, 'Node server is unavailable', now)}
            continue
        }
        if (stats.connectionIssues && stats.connectionIssues.length > 0) {
            perNode[issueTypes.CONNECTION_ISSUES] = new IssueRecord(issueTypes.CONNECTION_ISSUES, `Connection issues detected. \n${stats.connectionIssues.join('\n')}`, now)
        }
        if (Math.abs(stats.timeshift) > 5000) {
            perNode[issueTypes.TIME_SHIFT] = new IssueRecord(issueTypes.TIME_SHIFT, `${stats.timeshift}ms timeshift detected. Please, check time on your machine, or the internet connection.`, now)
        }
        if (configData.currentConfig && configData.currentConfig.hash !== stats.currentConfigHash) {
            perNode[issueTypes.WRONG_CONFIG] = new IssueRecord(issueTypes.WRONG_CONFIG, 'Node has wrong config. Please, check that you\'ve signed the current config, or restart the node server', now)
        }
        if (configData.pendingConfig
            && configData.pendingConfig.status === ConfigStatus.PENDING
            && configData.pendingConfig.hash !== stats.pendingConfigHash) {
            perNode[issueTypes.WRONG_PENDING_CONFIG] = new IssueRecord(issueTypes.WRONG_PENDING_CONFIG, 'Node has wrong pending config. Please, restart the node server for sync.', now)
        }
        for (const oracleStatistics of Object.values(stats.oracleStatistics)) {
            const {lastOracleTimestamp, oracleId} = oracleStatistics
            if (!lastOracleTimestamps[oracleId])
                lastOracleTimestamps[oracleId] = lastOracleTimestamp
            else if (lastOracleTimestamps[oracleId] < lastOracleTimestamp)
                lastOracleTimestamps[oracleId] = lastOracleTimestamp
        }
        nodeIssues[pubkey] = perNode
    }

    const oracleIssues = Object.keys(configData.currentConfig?.config.config.contracts || {})
        .reduce((acc, oracleId) => ({...acc, [oracleId]: {}}), {})

    for (const [oracleId, lastOracleTimestamp] of Object.entries(lastOracleTimestamps)) {
        const contractData = configData.currentConfig?.config?.config.contracts[oracleId]
        if (!contractData || contractData.type === ContractTypes.ORACLE_BEAM)
            continue
        if (now - lastOracleTimestamp > (contractData.timeframe + contractData.timeframe * .2) * 2) {
            logger.debug(`Price update issue with oracle ${oracleId}, lastOracleTimestamp: ${lastOracleTimestamp}.`)
            oracleIssues[oracleId] = {[issueTypes.PRICE_UPDATE_ISSUE]: new IssueRecord(issueTypes.PRICE_UPDATE_ISSUE, `Price update issue with oracle ${oracleId}.`, now)}
        }
    }

    const clusterIssues = {}
    if (configData.pendingConfig && now - configData.pendingConfig.timestamp > 1000 * 60 * 10) {
        clusterIssues[issueTypes.CLUSTER_UPDATE_ISSUE] = new IssueRecord(issueTypes.CLUSTER_UPDATE_ISSUE, 'Cluster update issue.', now)
    }
    return {nodeIssues, clusterIssues, oracleIssues}
}

class StatisticsManager {
    constructor() {
        setTimeout(() => this.__requestStatistics(), 10000)
        this.__cleanMetrics()
    }

    __previousDedupKeys = new Set()
    __statistics = {}
    __gatewaysMetrics = {}
    __issues = {nodeIssues: {}, clusterIssues: {}, oracleIssues: {}}

    getStatistics() {
        const currentConfig = container.configManager.currentConfig
        const contracts = [...(currentConfig?.contracts.values() || [])]
        const oracles = contracts.filter(contract => ['oracle', 'oracle_beam', 'subscription'].includes(contract.type))
        return {
            ...this.__statistics,
            timelines: container.txStatisticsManager.getTimelines(
                oracles,
                {priceHeartbeat: currentConfig?.priceHeartbeat || 2 * 60 * 60 * 1000}
            )
        }
    }

    async getMetrics(options = {}) {
        const {page = 1, limit = 10, sortOrder = 'desc'} = options
        const skip = (page - 1) * limit
        const sort = {_id: sortOrder === 'asc' ? 1 : -1}
        return await MetricsModel.find().sort(sort).limit(limit).skip(skip)
    }

    __reportIssues() {
        const currentKeys = new Set()
        for (const pubkey in this.__issues.nodeIssues) {
            for (const type in this.__issues.nodeIssues[pubkey]) {
                const item = this.__issues.nodeIssues[pubkey][type]
                const key = nodeIssueDedupKey(pubkey, type)
                currentKeys.add(key)
                container.notificationsManager.report({
                    category: 'node',
                    scope: pubkey,
                    type,
                    message: item.message,
                    recipient: {kind: 'pubkey', pubkey},
                    firstSeenAt: item.timestamp,
                    dedupKey: key
                })
            }
        }
        for (const type in this.__issues.clusterIssues) {
            const item = this.__issues.clusterIssues[type]
            const key = clusterIssueDedupKey(type)
            currentKeys.add(key)
            container.notificationsManager.report({
                category: 'cluster',
                type,
                message: item.message,
                recipient: {kind: 'all'},
                firstSeenAt: item.timestamp,
                dedupKey: key
            })
        }
        for (const oracleId in this.__issues.oracleIssues) {
            for (const type in this.__issues.oracleIssues[oracleId]) {
                const item = this.__issues.oracleIssues[oracleId][type]
                const key = oracleIssueDedupKey(oracleId, type)
                currentKeys.add(key)
                container.notificationsManager.report({
                    category: 'oracle',
                    scope: oracleId,
                    type,
                    message: item.message,
                    recipient: {kind: 'all'},
                    firstSeenAt: item.timestamp,
                    dedupKey: key
                })
            }
        }
        for (const prev of this.__previousDedupKeys) {
            if (!currentKeys.has(prev))
                container.notificationsManager.clear(prev)
        }
        this.__previousDedupKeys = currentKeys
    }

    __recordSignersForAllNodes() {
        if (!container.txStatisticsManager)
            return
        for (const pubkey in this.__statistics.nodeStatistics) {
            const stats = this.__statistics.nodeStatistics[pubkey]
            if (!stats || !stats.processedHashes)
                continue
            for (const contractId in stats.processedHashes) {
                const hashes = stats.processedHashes[contractId]
                if (!hashes || hashes.length === 0)
                    continue
                container.txStatisticsManager.recordSigners(contractId, pubkey, hashes)
            }
        }
    }

    async __requestStatistics() {
        try {
            const nodes = container.configManager.allNodePubkeys()
            const requests = []
            for (const pubkey of nodes) {
                const channel = container.connectionManager.getNodeConnection(pubkey)
                const request = async () => {
                    const result = {pubkey, statistics: null}
                    try {
                        if (channel && channel.isReady) {
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
            const nodeStatistics = {}
            const statisticsData = await Promise.allSettled(requests)
            for (const response of statisticsData) {
                if (response.value.statistics) {
                    this.__gatewaysMetrics[response.value.pubkey] = response.value.statistics.gatewaysMetrics
                    response.value.statistics.gatewaysMetrics = undefined
                    for (const oracleId in response.value.statistics.oracleStatistics) {
                        response.value.statistics.oracleStatistics[oracleId].oracleId = oracleId
                    }
                }
                nodeStatistics[response.value.pubkey] = response.value.statistics
            }

            await this.__saveMetrics()

            const configData = container.configManager.getCurrentConfigs()
            const issuesData = collectIssues(nodeStatistics, configData)

            this.__statistics = {
                nodeStatistics,
                currentTimestamp: Date.now(),
                currentConfigHash: configData?.currentConfig?.hash,
                pendingConfigHash: configData?.pendingConfig?.hash,
                contractsInfo: Object.fromEntries(
                    Object.entries(configData?.currentConfig?.config.config.contracts || {})
                        .map(([contractId, contract]) => [contractId, {type: contract.type, timeframe: contract.timeframe}]))
            }
            this.__processIssues(issuesData, nodes.length)
            this.__reportIssues()
            this.__recordSignersForAllNodes()
            try {
                await container.notificationsManager.flush()
            } catch (e) {
                logger.error(`NotificationsManager flush failed: ${e.message}`)
            }
        } catch (e) {
            logger.error(`Error requesting statistics: ${e.message}`)
            return null
        } finally {
            setTimeout(() => this.__requestStatistics(), 60000)
        }
    }


    __processIssues(newIssuesData, totalNodesCount) {
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
            const currentNodeIssues = this.__issues.nodeIssues[pubkey] || {}
            const newNodeIssues = newIssuesData.nodeIssues[pubkey] || {}
            this.__issues.nodeIssues[pubkey] = getUpdatedIssues(currentNodeIssues, newNodeIssues)
        }
        const __hasMajority = hasMajority(
            totalNodesCount,
            Object.values(this.__issues.nodeIssues)
                .filter(issue => !issue[issueTypes.NODE_UNAVAILABLE]).length
        )
        if (!__hasMajority) {
            newIssuesData.clusterIssues[issueTypes.NO_MAJORITY] = new IssueRecord(issueTypes.NO_MAJORITY, 'No majority of nodes available', Date.now())
        }
        this.__issues.clusterIssues = getUpdatedIssues(this.__issues.clusterIssues, newIssuesData.clusterIssues)
        for (const oracleId in newIssuesData.oracleIssues) {
            const currentOracleIssues = this.__issues.oracleIssues[oracleId] || {}
            const newOracleIssues = newIssuesData.oracleIssues[oracleId] || {}
            this.__issues.oracleIssues[oracleId] = getUpdatedIssues(currentOracleIssues, newOracleIssues)
        }
    }


    async __cleanMetrics() {
        try {
            const now = new Date()
            await MetricsModel.deleteMany({createdAt: {$lt: now - 1000 * 60 * 60 * 24 * 7}})
        } catch (e) {
            logger.error(`Error cleaning metrics: ${e.message}`)
        } finally {
            setTimeout(() => this.__cleanMetrics(), 1000 * 60 * 60 * 6)
        }
    }

    async __saveMetrics() {
        try {
            if (Object.keys(this.__gatewaysMetrics).length === 0)
                return
            const metrics = new MetricsModel({data: this.__gatewaysMetrics})
            await metrics.save()
        } catch (e) {
            logger.error(`Error saving metrics: ${e.message}`)
        }
    }
}

module.exports = StatisticsManager
