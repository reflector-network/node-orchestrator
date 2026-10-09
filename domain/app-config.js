const net = require('net')
const {StrKey} = require('@stellar/stellar-sdk')
const {normalizeAddress} = require('../utils/client-address')

class EmailSettings {
    constructor(rawSettings) {
        if (!rawSettings)
            throw new Error('rawSettings is undefined')
        if (!rawSettings.apiKey)
            throw new Error('apiKey is undefined')
        if (!rawSettings.appId)
            throw new Error('appId is undefined')
        this.apiKey = rawSettings.apiKey
        this.from = rawSettings.from
        this.appId = rawSettings.appId
    }
}

class AppConfig {
    constructor(rawConfig) {
        if (!rawConfig)
            throw new Error('rawConfig is undefined')
        if (!rawConfig.dbConnectionString)
            throw new Error('dbConnectionString is undefined')
        this.dbConnectionString = rawConfig.dbConnectionString

        if (!rawConfig.port || isNaN(rawConfig.port))
            throw new Error('port is undefined or not a number')
        this.port = rawConfig.port
        if (!rawConfig.networks)
            throw new Error('networks is undefined')
        if (rawConfig.whitelist)
            this.whitelist = rawConfig.whitelist
        this.__assignDefaultNodes(rawConfig.defaultNodes)
        this.__assignNetworks(rawConfig.networks)
        this.__assignEmailConfig(rawConfig.emailSettings)
        this.__assignMonitoringKey(rawConfig.monitoringKey)
        this.__assignLokiUrl(rawConfig.lokiUrl)
        this.__assignLokiPushAuth(rawConfig.lokiPushAuth)
        this.__assignTrustedProxies(rawConfig.trustedProxies)
    }

    /**
     * @type {string}
     */
    dbConnectionString = null

    /**
     * @type {number}
     */
    port = null

    /**
     * @type {string[]}
     */
    whitelist = []

    /**
     * @type {Map<string, {urls: string[], passphrase: string}>}
     */
    networks = new Map()

    /**
     * @type {string[]}
     */
    defaultNodes = []

    /**
     * @type {EmailSettings}
     */
    emailSettings = null

    /**
     * @param {string} monitoringKey
     */
    monitoringKey = null

    /**
     * @type {string}
     */
    lokiUrl = null

    /**
     * 'required' refuses pushes without a valid token; 'optional' accepts them and exists only as a rollout escape hatch for nodes that do not issue tokens yet
     * @type {'optional'|'required'}
     */
    lokiPushAuth = 'required'

    /**
     * Exact addresses of the reverse proxies allowed to name the client in `x-forwarded-for`, normalised. Empty means
     * the socket peer is always the client address and the header is ignored.
     * @type {string[]}
     */
    trustedProxies = []

    __assignDefaultNodes(defaultNodes) {
        if (!defaultNodes)
            throw new Error('defaultNodes is undefined')
        if (!Array.isArray(defaultNodes))
            throw new Error('defaultNodes is not an array')
        if (defaultNodes.length === 0)
            throw new Error('defaultNodes is empty')
        for (const node of defaultNodes) {
            if (!StrKey.isValidEd25519PublicKey(node))
                throw new Error('invalid node public key')
        }
        this.defaultNodes = defaultNodes
    }

    __assignNetworks(networks) {
        if (!networks)
            throw new Error('networks is undefined')
        const networkNames = Object.keys(networks)
        if (networkNames.length === 0)
            throw new Error('networks is empty')
        for (const networkName of networkNames) {
            const network = networks[networkName]
            if (!network)
                throw new Error(`${networkName} is undefined`)
            if (!network.urls || !Array.isArray(network.urls) || network.urls.length === 0)
                throw new Error(`${networkName}.url is undefined`)
            if (!network.passphrase)
                throw new Error(`${networkName}.passphrase is undefined`)
            if (!network.horizonUrls)
                throw new Error(`${networkName}.horizonUrls is undefined`)
            this.networks.set(networkName, {urls: network.urls, passphrase: network.passphrase, horizonUrls: network.horizonUrls})
        }
    }

    /**
     * @param {string} network
     * @returns {{urls: string[], passphrase: string, horizonUrls: string[]}}
     */
    getNetworkConfig(network) {
        if (!network)
            throw new Error('network is undefined')
        if (!this.networks.has(network))
            throw new Error(`Unsupported network: ${network}`)
        return this.networks.get(network)
    }

    __assignEmailConfig(rawEmailSettings) {
        this.emailSettings = new EmailSettings(rawEmailSettings)
    }

    __assignMonitoringKey(monitoringKey) {
        this.monitoringKey = monitoringKey
    }

    __assignLokiUrl(lokiUrl) {
        this.lokiUrl = lokiUrl
    }

    __assignLokiPushAuth(lokiPushAuth) {
        if (lokiPushAuth === undefined)
            return
        if (!['optional', 'required'].includes(lokiPushAuth))
            throw new Error('lokiPushAuth must be "optional" or "required"')
        this.lokiPushAuth = lokiPushAuth
    }

    __assignTrustedProxies(trustedProxies) {
        if (trustedProxies === undefined)
            return
        if (!Array.isArray(trustedProxies))
            throw new Error('trustedProxies must be an array of IP addresses')
        this.trustedProxies = trustedProxies.map(entry => {
            //exact addresses only: a range, a host name or a padded string is refused rather than guessed at
            if (typeof entry !== 'string' || net.isIP(entry) === 0)
                throw new Error(`trustedProxies entry ${JSON.stringify(entry)} is not an IP address`)
            return normalizeAddress(entry)
        })
    }
}

module.exports = AppConfig