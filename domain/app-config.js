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
     * @type {Map<string, {url: string, passphrase: string}>}
     */
    networks = new Map()

    /**
     * @type {string[]}
     */
    defaultNodes = []

    __assignDefaultNodes(defaultNodes) {
        if (!defaultNodes)
            throw new Error('defaultNodes is undefined')
        if (!Array.isArray(defaultNodes))
            throw new Error('defaultNodes is not an array')
        if (defaultNodes.length === 0)
            throw new Error('defaultNodes is empty')
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
            if (!network.url)
                throw new Error(`${networkName}.url is undefined`)
            if (!network.passphrase)
                throw new Error(`${networkName}.passphrase is undefined`)
            this.networks.set(networkName, {url: network.url, passphrase: network.passphrase})
        }
    }

    /**
     * @param {string} network
     * @returns {{url: string, passphrase: string}}
     */
    getNetworkConfig(network) {
        if (!network)
            throw new Error('network is undefined')
        if (!this.networks.has(network))
            throw new Error(`Unsupported network: ${network}`)
        return this.networks.get(network)
    }
}

module.exports = AppConfig