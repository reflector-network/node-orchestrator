const fs = require('fs')
const AppConfig = require('./domain/app-config')
const logger = require('./logger')
const container = require('./domain/container')
const ConfigManager = require('./domain/config-manager')
const HandlersManager = require('./server/ws/handlers/handlers-manager')
const StatisticsManager = require('./domain/statistics-manager')
const Server = require('./server')
const ConnectionManager = require('./domain/connections-manager')
const NodeSettingsManager = require('./domain/node-settings-manager')
const MailProvider = require('./domain/mail-provider')

try {
    if (!fs.existsSync('./home/app.config.json'))
        throw new Error('app.config.json not found')
    const rawConfig = JSON.parse(fs.readFileSync('./home/app.config.json'))

    logger.info('Starting reflector orchestrator')

    container.appConfig = new AppConfig(rawConfig)
    container.configManager = new ConfigManager()
    container.handlersManager = new HandlersManager()
    container.statisticsManager = new StatisticsManager()
    container.connectionManager = new ConnectionManager()
    container.nodeSettingsManager = new NodeSettingsManager()
    container.mailProvider = new MailProvider(container.appConfig.mailApiKey, container.appConfig.mailFrom)
    container.server = new Server()

    require('./app')(container)
} catch (e) {
    if (logger)
        logger.error(e)
    else
        console.error(e)
    setTimeout(() => process.exit(13), 1000)
}