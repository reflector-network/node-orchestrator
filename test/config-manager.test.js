/*eslint-disable no-undef */
const {createHash} = require('crypto')
const {sortObjectKeys} = require('@reflector/reflector-shared')
const {xdr, scValToNative, Address} = require('@stellar/stellar-sdk')
const ConfigManager = require('../domain/config-manager')
const AppConfig = require('../domain/app-config')
const {connect, dropDatabase} = require('../persistence-layer')
const HandlersManager = require('../server/ws/handlers/handlers-manager')
const ConnectionManager = require('../domain/connections-manager')
const NodeSettingsManager = require('../domain/node-settings-manager')
const constants = require('./constants')

const configManager = new ConfigManager()

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

test('test parsing', () => {
    const tx = {
        "id": "ecf5889e3edadd349930938821bc5ef07bb821200d1f7efb9a5e16da271cb636",
        "paging_token": "263623129829543936",
        "successful": true,
        "hash": "ecf5889e3edadd349930938821bc5ef07bb821200d1f7efb9a5e16da271cb636",
        "ledger": 61379543,
        "created_at": "2026-02-24T15:25:23Z",
        "source_account": "GCSJ7NZKNRP2NXUOOPHGNNPGOEMUKGUNPLQ4NOW2B2L4X7WEO6NQFXRF",
        "source_account_sequence": "243668527087701484",
        "fee_account": "GCSJ7NZKNRP2NXUOOPHGNNPGOEMUKGUNPLQ4NOW2B2L4X7WEO6NQFXRF",
        "fee_charged": "165145",
        "max_fee": "20000000",
        "operation_count": 1,
        "envelope_xdr": "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",
        "result_xdr": "AAAAAAAChRkAAAAAAAAAAQAAAAAAAAAYAAAAAMu8SHUN67hTUJOz3q+IrH9M/4dCVXaljeK6x1Ss20YWAAAAAA==",
        "fee_meta_xdr": "AAAAAgAAAAMDqJOjAAAAAAAAAACkn7cqbF+m3o5zzma15nEZRRqNeuHGutoOl8v+xHebAgAAAAISGSaEA2GvPAABTesAAAAHAAAAAAAAAAAAAAARcmVmbGVjdG9yLm5ldHdvcmsAAAAABAQEAAAABwAAAAAEFxuEWtNlC4IZGL4s5Co4jOWkZbUAwojyVFO2yJLOaQAAAAEAAAAALZYBJbF36iK4pmi8r6OjDz2Ilj3abmzMI2X8hLzWMc0AAAABAAAAAJeIpQK/DX/67h4Ek86gweX4C/72L1DS0biwLh/ZYLxJAAAAAQAAAADGPqLkFV3n16XEwNVCv4PDqeHoSCf2hAtmGt9S7P9OGQAAAAEAAAAAyAygw/LLj3HfePrEPHbGrANK2TkoSkiqVqe2BCHEGPkAAAABAAAAAMj5RmETzNy/80cNUpv1AW4oTTih9vr2NR8hmTR2OK/9AAAAAQAAAADuRRvNSgMU0cnepaJEj9yehzog3cjICisT/mcAygFuKAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAADqJOjAAAAAGmdwbUAAAAAAAAAAQOok9cAAAAAAAAAAKSftypsX6bejnPOZrXmcRlFGo164ca62g6Xy/7Ed5sCAAAAAhGAj6ADYa88AAFN6wAAAAcAAAAAAAAAAAAAABFyZWZsZWN0b3IubmV0d29yawAAAAAEBAQAAAAHAAAAAAQXG4Ra02ULghkYvizkKjiM5aRltQDCiPJUU7bIks5pAAAAAQAAAAAtlgElsXfqIrimaLyvo6MPPYiWPdpubMwjZfyEvNYxzQAAAAEAAAAAl4ilAr8Nf/ruHgSTzqDB5fgL/vYvUNLRuLAuH9lgvEkAAAABAAAAAMY+ouQVXefXpcTA1UK/g8Op4ehIJ/aEC2Ya31Ls/04ZAAAAAQAAAADIDKDD8suPcd94+sQ8dsasA0rZOShKSKpWp7YEIcQY+QAAAAEAAAAAyPlGYRPM3L/zRw1Sm/UBbihNOKH2+vY1HyGZNHY4r/0AAAABAAAAAO5FG81KAxTRyd6lokSP3J6HOiDdyMgKKxP+ZwDKAW4oAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAOok6MAAAAAaZ3BtQAAAAA=",
        "memo_type": "none",
        "signatures": [
            "yI1XyTywAMJ+SK74jLJUoogmrOGDo/s9GCvoaARFb2czmP9cttoj8mJTM8zg5SUw0DUqU8p9I3Y+InH/g9k+Cw==",
            "bKOEViWN5fy1FmAyqfXgKZAQYriwGFT0IN8aUoyY1v1ii6mEWQ2YCaS2Ez2FQonsKW3s01AzSSC6YrGVioGgDw==",
            "F58HEYNiEEhO4JQ8TNJoMe5DDbVe++Ii3pl91CPnccsuW+cPCkkoQQeefwCqawhMTbtOqdqDkcBZhrH/gVYgBw==",
            "wkJUYQHJ2nU0UGBqQrr/AeAA9LaTPRt+MKzIc/juz0LODv9GedUyTR2FKbhYWLZPZFyLgKX9S0i51ognOGkJDQ=="
        ],
        "preconditions": {
            "timebounds": {
                "min_time": "0",
                "max_time": "1771946735"
            }
        }
    }
    try {
        if (tx.inner_transaction) {
            return
        }
        const isHostFnTx = xdr.TransactionResult.fromXDR(tx.result_xdr, 'base64').result().value().some(r => r.value().switch().name === 'invokeHostFunction')
        if (isHostFnTx) {
            const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelope_xdr, 'base64')
            const operations = envelope.value().tx().operations()
            for (let i = 0; i < operations.length; i++) {
                const hostFunction = operations[i].body().value().hostFunction()
                if (hostFunction.switch().name !== 'hostFunctionTypeInvokeContract')
                    continue
                const fnName = hostFunction.value().functionName().toString()
                const args = [...hostFunction.value().args()].map(v => scValToNative(v))
                const contractId = Address.contract(hostFunction.value().contractAddress().contractId()).toString()
                const state = this.__contractsState.clusterStatistics.get(contractId)
                if (!state)
                    continue
                const parser = getParser(state.type)?.fns?.[fnName]
                if (!parser)
                    continue
                //normalize data
                parser({
                    source: {fn: fnName, args, txHash: tx.hash},
                    account: tx.source_account,
                    timestamp: BigInt(new Date(tx.created_at).getTime()),
                    ledger: tx.ledger_attr,
                    state
                })
            }
        }
    } catch (err) {
        logger.error({err, msg: `Error processing transaction ${tx.hash}`})
    }
})

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