/**
 * @typedef {import('./config-manager')} ConfigManager
 * @typedef {import('../server')} Server
 * @typedef {import('../server/ws/handlers/handlers-manager')} HandlersManager
 * @typedef {import('./connections-manager')} ConnectionManager
 * @typedef {import('./app-config')} AppConfig
 * @typedef {import('./email-provider')} EmailProvider
 * @typedef {import('./node-settings-manager')} NodeSettingsManager
 * @typedef {import('./notifications/notifications-manager')} NotificationsManager
 * @typedef {import('./statistics/statistics-manager')} StatisticsManager
 * @typedef {import('./statistics/tx-statistics-manager')} TxStatisticsManager
 */

const packageInfo = require('../package.json')

class Container {
    /**
     * @type {ConfigManager}
     */
    configManager

    /**
     * @type {Server}
     * */
    server

    /**
     * @type {HandlersManager}
     * */
    handlersManager

    /**
     * @type {ConnectionManager}
     */
    connectionManager


    /**
     * @type {NodeSettingsManager}
     */
    nodeSettingsManager

    /**
     * @type {EmailProvider}
     */
    emailProvider

    /**
     * @type {AppConfig}
     */
    appConfig

    /**
     * @type {{shutdown: function(): void}}
     */
    app

    /**
     * @type {NotificationsManager}
     */
    notificationsManager

    /**
     * @type {StatisticsManager}
     */
    statisticsManager

    /**
     * @type {TxStatisticsManager}
     */
    txStatisticsManager

    /**
     * @type {string}
     */
    version = packageInfo.version
}

module.exports = new Container()