/**
 * @typedef {import('./config-manager')} ConfigManager
 * @typedef {import('../server')} Server
 * @typedef {import('../server/ws/handlers/handlers-manager')} HandlersManager
 * @typedef {import('./statistics-manager')} StatisticsManager
 * @typedef {import('./connections-manager')} ConnectionManager
 * @typedef {import('./app-config')} AppConfig
 */

const packageInfo = require('../package.json')
const NodeSettingsManager = require('./node-settings-manager')

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
     * @type {StatisticsManager}
     */
    statisticsManager

    /**
     * @type {ConnectionManager}
     */
    connectionManager


    /**
     * @type {NodeSettingsManager}
     */
    nodeSettingsManager

    /**
     * @type {AppConfig}
     */
    appConfig

    /**
     * @type {{shutdown: function(): void}}
     */
    app

    /**
     * @type {string}
     */
    version = packageInfo.version
}

module.exports = new Container()