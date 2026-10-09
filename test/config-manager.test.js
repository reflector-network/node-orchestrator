/*eslint-disable no-undef */
const {createHash} = require('crypto')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const ConfigManager = require('../domain/config-manager')
const AppConfig = require('../domain/app-config')
const {connect, dropDatabase, disconnect} = require('../persistence-layer')
const HandlersManager = require('../server/ws/handlers/handlers-manager')
const ConnectionManager = require('../domain/connections-manager')
const NodeSettingsManager = require('../domain/node-settings-manager')
const constants = require('./constants')

//this suite covers the stored lifecycle against a real database; a proposal's transaction would need the network, so
//its build check passes here (test/config-manager-build-check.test.js covers it)
jest.mock('../domain/blockchain-data-provider', () => ({
    ...jest.requireActual('../domain/blockchain-data-provider'),
    checkUpdateBuilds: jest.fn(() => Promise.resolve())
}))

const configManager = new ConfigManager()

//ConfigManager.init starts processPendingConfig, which re-arms itself with setTimeout for the life of the process and
//keeps no handle anyone could clear, so jest never exited after this file. The timers armed here are recorded,
//and teardown clears them and stops a round still in flight from arming another
const realSetTimeout = global.setTimeout
const armedTimers = new Set()
let tornDown = false
const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation((fn, delay, ...args) => {
    if (tornDown)
        return undefined
    const timer = realSetTimeout((...callbackArgs) => {
        armedTimers.delete(timer)
        fn(...callbackArgs)
    }, delay, ...args)
    armedTimers.add(timer)
    return timer
})

beforeAll(async () => {
    const container = require('../domain/container')

    container.configManager = new ConfigManager()
    container.handlersManager = new HandlersManager()
    container.connectionManager = new ConnectionManager()
    container.nodeSettingsManager = new NodeSettingsManager()

    const appConfig = new AppConfig(constants)
    await connect(appConfig.dbConnectionString)
    await container.configManager.init(appConfig.defaultNodes)
})

afterAll(async () => {
    tornDown = true
    for (const timer of armedTimers)
        clearTimeout(timer)
    setTimeoutSpy.mockRestore()
    await dropDatabase()
    await disconnect()
})

test('creating config', async () => {
    const {nodeKps, config} = constants

    let signedEnvelope = getSignedEnvelope(config, nodeKps[0])
    await configManager.create(signedEnvelope, signedEnvelope.signatures[0].pubkey)

    expect(configManager.getCurrentConfigs().pendingConfig.config.status).toBe('voting')

    signedEnvelope = getSignedEnvelope(config, nodeKps[1])

    await configManager.create(signedEnvelope, signedEnvelope.signatures[0].pubkey)

    const configs = configManager.getCurrentConfigs()

    expect(configs.currentConfig.config.status).toBe('applied') //init config will be applied immediately after majority of nodes signed it

    expect(configs.pendingConfig).toBe(null)

}, 3000000)

test('pending config (period update)', async () => {
    const {nodeKps, config} = constants

    const newConfig = {...config}
    newConfig.contracts.CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW.period = 9999999
    const signedEnvelope = getSignedEnvelope(newConfig, nodeKps[0])
    await configManager.create(signedEnvelope, signedEnvelope.signatures[0].pubkey)

    const pendingConfig = configManager.getCurrentConfigs().pendingConfig
    expect(pendingConfig.config.config.contracts.CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW.period).toBe(9999999)

}, 3000000)

let nonceCounter = Date.now()

function getSignedEnvelope(config, kp, rejected = false) {
    const pubkey = kp.publicKey()
    const nonce = ++nonceCounter
    const payload = {...config, nonce}
    if (rejected)
        payload.rejected = true
    const messageToSign = `${pubkey}:${JSON.stringify(sortObjectKeys(payload))}`

    const messageHash = createHash('sha256').update(messageToSign, 'utf8').digest()
    const signature = Buffer.from(kp.sign(messageHash)).toString('hex')

    return {
        config,
        signatures: [{signature, pubkey, nonce, rejected}],
        timestamp: 0,
        expirationDate: Date.now() + 1000 * 60 * 60 * 24 * 365
    }
}