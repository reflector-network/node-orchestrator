/*eslint-disable no-undef */
const {createHash} = require('crypto')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const configProvider = require('../domain/config-provider')
const appConfig = require('../domain/app-config')
const {connect, dropDatabase} = require('../persistence-layer')
const constants = require('./constants')

beforeAll(async () => {
    appConfig.init(constants)
    await connect(appConfig.dbConnectionString)
    await configProvider.init(appConfig.defaultNodes)
})

afterAll(async () => {
    await dropDatabase()
})

test('creating config', async () => {
    const {nodeKps, config} = constants

    let signedEnvelope = getSignedEnvelope(config, nodeKps[0])
    await configProvider.create(signedEnvelope)

    expect(configProvider.getCurrentConfigs().pendingConfig.config.status).toBe('voting')

    signedEnvelope = getSignedEnvelope(config, nodeKps[1])

    await configProvider.create(signedEnvelope)

    const configs = configProvider.getCurrentConfigs()

    expect(configs.currentConfig.config.status).toBe('applied') //init config will be applied immediately after majority of nodes signed it

    expect(configs.pendingConfig).toBe(null)

}, 3000000)

test('pending config (period update)', async () => {
    const {nodeKps, config} = constants

    const newConfig = {...config}
    newConfig.contracts.CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW.period = 9999999
    const signedEnvelope = getSignedEnvelope(newConfig, nodeKps[0])
    await configProvider.create(signedEnvelope)

    const pendingConfig = configProvider.getCurrentConfigs().pendingConfig
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