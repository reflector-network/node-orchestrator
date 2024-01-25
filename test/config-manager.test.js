/*eslint-disable no-undef */
const {createHash} = require('crypto')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const ConfigManager = require('../domain/config-manager')
const AppConfig = require('../domain/app-config')
const {connect, dropDatabase} = require('../persistence-layer')
const HandlersManager = require('../server/ws/handlers/handlers-manager')
const StatisticsManager = require('../domain/statistics-manager')
const ConnectionManager = require('../domain/connections-manager')
const NodeSettingsManager = require('../domain/node-settings-manager')
const constants = require('./constants')

const configManager = new ConfigManager()

beforeAll(async () => {
    const container = require('../domain/container')

    container.configManager = new ConfigManager()
    container.handlersManager = new HandlersManager()
    container.statisticsManager = new StatisticsManager()
    container.connectionManager = new ConnectionManager()
    container.nodeSettingsManager = new NodeSettingsManager()

    const appConfig = new AppConfig(constants)
    await connect(appConfig.dbConnectionString)
    await container.configManager.init(appConfig.defaultNodes)
})

afterAll(async () => {
    await dropDatabase()
})

test('creating config', async () => {
    const {nodeKps, config} = constants

    let signedEnvelope = getSignedEnvelope(config, nodeKps[0])
    await configManager.create(signedEnvelope)

    expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('voting')

    signedEnvelope = getSignedEnvelope(config, nodeKps[1])

    await configManager.create(signedEnvelope)

    const configs = configManager.getCurrentConfigs()

    expect(configs.currentConfig.config.status).toBe('applied') //init config will be applied immediately after majority of nodes signed it

    expect(configs.pendingConfig).toBe(null)

}, 3000000)

test('pending config (period update)', async () => {
    const {nodeKps, config} = constants

    const newConfig = {...config}
    newConfig.contracts.CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW.period = 9999999
    const signedEnvelope = getSignedEnvelope(newConfig, nodeKps[0])
    await configManager.create(signedEnvelope)

    const pendingConfig = configManager.getCurrentConfigs().pendingConfig
    expect(pendingConfig.config.config.contracts.CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW.period).toBe(9999999)

}, 3000000)

function getSignedEnvelope(config, kp, rejected = false) {
    const pubkey = kp.publicKey()
    const nonce = Date.now()
    const payload = {...config, nonce}
    if (rejected)
        payload.rejected = true
    const messageToSign = `${pubkey}:${JSON.stringify(sortObjectKeys(payload))}`

    const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
    const signature = kp.sign(messageHash).toString('hex')

    return {
        config,
        signatures: [{signature, pubkey, nonce, rejected}],
        timestamp: 0,
        expirationDate: Date.now() + 1000 * 60 * 60 * 24 * 365
    }
}