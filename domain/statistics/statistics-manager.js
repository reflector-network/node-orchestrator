/*eslint-disable guard-for-in */
const {hasMajority, ContractTypes} = require('@reflector/reflector-shared')
const {BSON} = require('mongoose').mongo
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

const maxConnectionIssues = 50
const maxIssueLength = 512
const maxProcessedHashes = 1000
const txHashPattern = /^[0-9a-f]{64}$/
//a node's clock may drift this far from ours before TIME_SHIFT is raised
const maxClockDrift = 5000
//Nodes before v0.12.0-rc10 send gatewaysMetrics as {info, metrics: [<gateway /metrics body> | 'n/a']}, and later nodes
//send none. The deepest branch of a gateway body is dataStreams.<host>.urls.<url>.statusCodes, 8 levels of nesting in
//all. Twice that leaves room for a gateway that nests further and stays far below the 178 levels MongoDB stores under
//data.<pubkey> of the metrics document.
const maxGatewaysMetricsDepth = 16
//Every node's metrics are stored in one document, and MongoDB refuses a document over 16 MiB. Cluster nodes are
//signers of one Stellar account, which the protocol limits to 20 signers, so 512 KiB per node keeps even the largest
//cluster's document near 10 MiB. A gateway body spends about 124 bytes on each URL requested in the node's 60 s
//window, so this still holds some 4,000 of them.
const maxGatewaysMetricsSize = 512 * 1024

/**
 * Validate and sanitise one node's statistics response. Everything below comes from a peer, so a response that is not
 * shaped as expected drops that node from the round instead of throwing inside the shared loop.
 * @param {any} statistics - raw response from the node
 * @returns {object|null} sanitised statistics, or null when the response is unusable
 */
function normalizeNodeStatistics(statistics) {
    if (!statistics || typeof statistics !== 'object' || Array.isArray(statistics))
        return null
    if (typeof statistics.currentTime !== 'number' || !Number.isFinite(statistics.currentTime))
        return null
    const oracleEntries = []
    const rawOracleStatistics = statistics.oracleStatistics
    if (rawOracleStatistics !== undefined) {
        if (!rawOracleStatistics || typeof rawOracleStatistics !== 'object' || Array.isArray(rawOracleStatistics))
            return null
        for (const [oracleId, entry] of Object.entries(rawOracleStatistics)) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
                return null
            oracleEntries.push([oracleId, {...entry, oracleId}])
        }
    }
    const connectionIssues = Array.isArray(statistics.connectionIssues)
        ? statistics.connectionIssues
            .filter(issue => typeof issue === 'string')
            .slice(0, maxConnectionIssues)
            .map(issue => issue.slice(0, maxIssueLength))
        : []
    const processedEntries = []
    const rawProcessedHashes = statistics.processedHashes
    if (rawProcessedHashes && typeof rawProcessedHashes === 'object' && !Array.isArray(rawProcessedHashes)) {
        for (const [contractId, hashes] of Object.entries(rawProcessedHashes)) {
            if (!Array.isArray(hashes))
                continue
            const valid = hashes.filter(hash => typeof hash === 'string' && txHashPattern.test(hash)).slice(0, maxProcessedHashes)
            if (valid.length > 0)
                processedEntries.push([contractId, valid])
        }
    }
    //fromEntries defines each key as an own property, where assigning a peer's "__proto__" key would run the prototype
    //setter instead of storing the entry
    return {
        ...statistics,
        oracleStatistics: Object.fromEntries(oracleEntries),
        connectionIssues,
        processedHashes: Object.fromEntries(processedEntries),
        currentConfigHash: typeof statistics.currentConfigHash === 'string' ? statistics.currentConfigHash : null,
        pendingConfigHash: typeof statistics.pendingConfigHash === 'string' ? statistics.pendingConfigHash : null,
        version: typeof statistics.version === 'string' ? statistics.version : null,
        timeshift: 0
    }
}

/**
 * Check that a value nests no deeper than maxGatewaysMetricsDepth and has no key holding a NUL byte, the one character
 * BSON cannot encode in a field name. Dots and a leading `$` are kept: MongoDB stores both in a nested field and reads
 * them back intact, and an honest gateway body's host keys contain dots.
 * @param {any} value - value to check
 * @param {number} depth - how many objects or arrays enclose the value
 * @returns {boolean}
 */
function hasStorableShape(value, depth) {
    if (!value || typeof value !== 'object')
        return true
    if (depth >= maxGatewaysMetricsDepth)
        return false
    return Object.entries(value).every(([key, child]) => !key.includes('\u0000') && hasStorableShape(child, depth + 1))
}

/**
 * Screen one node's gatewaysMetrics before it joins the round's metrics document, which holds every node's metrics and
 * fails to save as a whole if any one of them cannot be stored.
 * @param {any} gatewaysMetrics - value as parsed from the node's statistics response
 * @returns {boolean}
 */
function isStorableGatewaysMetrics(gatewaysMetrics) {
    return hasStorableShape(gatewaysMetrics, 0)
        && BSON.calculateObjectSize({gatewaysMetrics}) <= maxGatewaysMetricsSize
}

/**
 * A lastOracleTimestamp is the oracle's on-chain round timestamp as a node last read it: whole milliseconds, 0 before the
 * first update. The cluster only writes a round that a majority of node clocks have reached, so a reading further ahead
 * of ours than a node's clock may drift, or one that is not a non-negative integer, is discarded rather than trusted.
 * @param {any} timestamp - reported lastOracleTimestamp
 * @param {number} now - the round's time
 * @returns {boolean}
 */
function isPlausibleOracleTimestamp(timestamp, now) {
    return Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now + maxClockDrift
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
    const oracleReports = new Map()
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
        if (Math.abs(stats.timeshift) > maxClockDrift) {
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
        for (const {lastOracleTimestamp, oracleId} of Object.values(stats.oracleStatistics)) {
            if (!isPlausibleOracleTimestamp(lastOracleTimestamp, now))
                continue
            if (!oracleReports.has(oracleId))
                oracleReports.set(oracleId, [])
            oracleReports.get(oracleId).push(lastOracleTimestamp)
        }
        nodeIssues[pubkey] = perNode
    }

    const contracts = configData.currentConfig?.config.config.contracts || {}
    const oracleIssues = Object.keys(contracts)
        .reduce((acc, oracleId) => ({...acc, [oracleId]: {}}), {})

    //Honest nodes read the same on-chain timestamp and can only lag behind it. Trusting the highest report let one node
    //clear the alert for everyone, so an oracle counts as updated only when a majority of the nodes that reported it saw
    //a fresh update, by the same majority the cluster needs to sign an update. Each node is one vote: it cannot clear the
    //alert when every other reporting node sees the oracle stale, nor raise it against two others that see it fresh.
    //A tie raises it, because the alert exists to surface a stale oracle.
    for (const [oracleId, contractData] of Object.entries(contracts)) {
        const reports = oracleReports.get(oracleId)
        //only price oracles carry a timeframe, and reflector-shared reads a contract without a type as a legacy one
        if ((contractData.type || ContractTypes.ORACLE) !== ContractTypes.ORACLE || !reports)
            continue
        const staleAfter = (contractData.timeframe + contractData.timeframe * .2) * 2
        const freshReports = reports.filter(timestamp => now - timestamp <= staleAfter).length
        if (hasMajority(reports.length, freshReports))
            continue
        logger.debug(`Price update issue with oracle ${oracleId}: ${freshReports} of ${reports.length} reporting nodes saw a fresh update.`)
        oracleIssues[oracleId] = {[issueTypes.PRICE_UPDATE_ISSUE]: new IssueRecord(issueTypes.PRICE_UPDATE_ISSUE, `Price update issue with oracle ${oracleId}.`, now)}
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
        const oracles = contracts.filter(contract =>
            [ContractTypes.ORACLE, ContractTypes.ORACLE_BEAM, ContractTypes.SUBSCRIPTIONS].includes(contract.type))
        return {
            ...this.__statistics,
            timelines: container.txStatisticsManager.getTimelines(
                oracles,
                {priceHeartbeat: currentConfig?.priceHeartbeat || 2 * 60 * 60 * 1000}
            ),
            nodes: [...(currentConfig?.nodes?.entries() || [])].map(([pubkey, node]) => ({pubkey, domain: node.domain}))
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
                            const statisticsData = normalizeNodeStatistics(await channel.send({type: MessageTypes.STATISTICS_REQUEST}))
                            if (!statisticsData) {
                                logger.warn(`Node ${pubkey} returned a malformed statistics response`)
                            } else {
                                statisticsData.timeshift = Date.now() - statisticsData.currentTime
                                result.statistics = statisticsData
                            }
                        }
                    } catch (e) {
                        logger.error(`Error requesting statistics from node ${pubkey}: ${e.message}`)
                    }
                    return result
                }
                requests.push(request())
            }
            const nodeStatistics = {}
            //rebuilt every round, so metrics a node sent never outlive the round they arrived in
            const gatewaysMetrics = {}
            const statisticsData = await Promise.allSettled(requests)
            for (const response of statisticsData) {
                const {pubkey, statistics} = response.value
                if (statistics) {
                    const storable = isStorableGatewaysMetrics(statistics.gatewaysMetrics)
                    if (!storable)
                        logger.warn(`Node ${pubkey} sent gateway metrics that cannot be stored`)
                    //every node that answered keeps its key, so a round still stores a document when no node sends metrics
                    gatewaysMetrics[pubkey] = storable ? statistics.gatewaysMetrics : undefined
                    statistics.gatewaysMetrics = undefined
                }
                nodeStatistics[pubkey] = statistics
            }
            this.__gatewaysMetrics = gatewaysMetrics

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
module.exports.normalizeNodeStatistics = normalizeNodeStatistics
module.exports.isStorableGatewaysMetrics = isStorableGatewaysMetrics
