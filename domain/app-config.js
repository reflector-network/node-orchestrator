class AppConfig {
    init(rawConfig) {
        if (!rawConfig)
            throw new Error('rawConfig is undefined')
        if (!rawConfig.dbConnectionString)
            throw new Error('dbConnectionString is undefined')
        this.dbConnectionString = rawConfig.dbConnectionString

        if (!rawConfig.port || isNaN(rawConfig.port))
            throw new Error('port is undefined or not a number')
        this.port = rawConfig.port
        if (!rawConfig.horizonUrl)
            throw new Error('horizonUrl is undefined')
        this.horizonUrl = rawConfig.horizonUrl
        if (rawConfig.whitelist)
            this.whitelist = rawConfig.whitelist
        this.__assignDefaultNodes(rawConfig.defaultNodes)
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
     * @type {string}
     */
    horizonUrl = null

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
}

module.exports = new AppConfig()