/*eslint-disable no-undef */
jest.mock('../domain/container', () => ({}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

describe('dead code removal', () => {
    test('the uncallable cluster-transactions helper is gone', () => {
        const provider = require('../domain/blockchain-data-provider')
        expect(provider.getLastClusterTransactions).toBeUndefined()
        expect(typeof provider.getUpdateTxHash).toBe('function')
    })

    test('the broken contract-instance helpers are gone', () => {
        const rpcHelper = require('../utils/rpc-helper')
        expect(rpcHelper.getContractInstance).toBeUndefined()
        expect(rpcHelper.getContractEntries).toBeUndefined()
        expect(typeof rpcHelper.getUpdateTx).toBe('function')
    })

    test('the type module is plain commonjs', () => {
        //node 22.12+ and jest both load an ESM-syntax file through require() instead of throwing, so the stray
        //`export {}` shows up as an ES module namespace coming back rather than as an exception
        expect(() => require('../domain/types')).not.toThrow()
        expect(require('../domain/types')[Symbol.toStringTag]).toBeUndefined()
    })
})

describe('error helpers', () => {
    const {validationError, notFound} = require('../server/errors')

    test('validationError builds a 400 instead of throwing on `this`', () => {
        const error = validationError('urls', 'must be an array', {field: 'urls'})
        expect(error.code).toBe(400)
        expect(error.message).toBe('Bad request. Invalid parameter: urls. must be an array')
        expect(error.details).toEqual({field: 'urls'})
    })

    test('validationError without a message names the parameter alone', () => {
        const error = validationError('urls')
        expect(error.message).toBe('Bad request. Invalid parameter: urls.')
        expect(error.details).toBeNull()
    })

    test('notFound builds a 404', () => {
        const error = notFound('Node not found')
        expect(error.code).toBe(404)
        expect(error.message).toBe('Not found. Node not found')
    })
})

describe('swagger exposure', () => {
    const registerSwaggerRoute = require('../server/swagger')

    /**
     * @param {string|undefined} nodeEnv - NODE_ENV to mount under; undefined leaves it unset
     * @param {string|undefined} enableSwagger - ENABLE_SWAGGER to mount under; undefined leaves it unset
     * @returns {string|null} the path the ui was mounted on, or null when it was not mounted
     */
    function mountUnder(nodeEnv, enableSwagger) {
        const previous = {NODE_ENV: process.env.NODE_ENV, ENABLE_SWAGGER: process.env.ENABLE_SWAGGER}
        const app = {use: jest.fn()}
        try {
            for (const [name, value] of Object.entries({NODE_ENV: nodeEnv, ENABLE_SWAGGER: enableSwagger})) {
                if (value === undefined)
                    delete process.env[name]
                else
                    process.env[name] = value
            }
            const mounted = registerSwaggerRoute(app)
            expect(app.use).toHaveBeenCalledTimes(mounted ? 1 : 0)
            return mounted ? app.use.mock.calls[0][0] : null
        } finally {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined)
                    delete process.env[name]
                else
                    process.env[name] = value
            }
        }
    }

    //opt-in, so a launch that sets nothing - node index.js, pm2, a bare Dockerfile CMD - does not publish it
    test.each([
        ['NODE_ENV unset', undefined, undefined],
        ['NODE_ENV=production', 'production', undefined],
        ['NODE_ENV=test', 'test', undefined],
        ['NODE_ENV=staging', 'staging', undefined],
        ['ENABLE_SWAGGER=1', undefined, '1'],
        ['ENABLE_SWAGGER=TRUE', undefined, 'TRUE'],
        ['NODE_ENV=production and ENABLE_SWAGGER=false', 'production', 'false']
    ])('the swagger ui is not mounted with %s', (_, nodeEnv, enableSwagger) => {
        expect(mountUnder(nodeEnv, enableSwagger)).toBe(null)
    })

    test.each([
        ['NODE_ENV=development', 'development', undefined],
        ['ENABLE_SWAGGER=true', undefined, 'true'],
        ['ENABLE_SWAGGER=true in production', 'production', 'true']
    ])('the swagger ui is mounted on /api-docs with %s', (_, nodeEnv, enableSwagger) => {
        expect(mountUnder(nodeEnv, enableSwagger)).toBe('/api-docs')
    })
})

describe('swagger specification matches the code', () => {
    const {getSwaggerSpec} = require('../server/swagger')
    const spec = getSwaggerSpec()

    test('node statistics name currentTime in ascii, as the node sends it', () => {
        const properties = Object.keys(spec.components.schemas.NodeDetail.properties)
        expect(properties).toContain('currentTime')
        expect(properties.filter(name => /[^\x20-\x7e]/.test(name))).toEqual([])
    })

    test('names the service and the real authorization header', () => {
        expect(spec.info.title).toBe('Reflector Node Orchestrator API')
        expect(spec.components.securitySchemes.ed25519Auth.description).toBe('Header must be `<pubkey>.<hexSignature>.<nonce>`, signed with the node key.')
    })

    test('/config/history documents the parameters the code reads and returns envelopes', () => {
        const history = spec.paths['/config/history'].get
        const names = history.parameters.map(p => p.name).sort()
        expect(names).toEqual(['initiator', 'page', 'pageSize', 'status'])
        expect(history.responses[200].content['application/json'].schema.items.$ref).toBe('#/components/schemas/ConfigEnvelope')
    })

    test('the gateway validation route is documented under its own path', () => {
        expect(spec.paths['/validate-gateways'].post.summary).toBe('Validate gateways')
        expect(spec.paths['/gateways'].post.summary).toBe('Post current node gateways')
    })

    test('the log download route is documented under the path it is served on', () => {
        expect(spec.paths['/logs/{logname}']).toBeDefined()
        expect(spec.paths['/log/{logname}']).toBeUndefined()
    })

    test('subscription responses document lastCharge and the owner route returns a list of them', () => {
        expect(spec.components.schemas.Subscription.properties.lastCharge).toEqual(expect.objectContaining({type: 'integer'}))
        const owner = spec.paths['/subscriptions/{contractId}/owner/{owner}'].get
        expect(owner.responses[200].content['application/json'].schema).toEqual({
            type: 'array',
            items: {$ref: '#/components/schemas/Subscription'}
        })
    })

    test('/metrics documents the sortOrder parameter getMetrics reads', () => {
        const names = spec.paths['/metrics'].get.parameters.map(p => p.name).sort()
        expect(names).toEqual(['limit', 'page', 'sortOrder'])
    })
})

describe('pending update grace period', () => {
    const {getTimestamp} = require('../domain/config-manager')
    const now = 1_700_000_050_000 //normalises to 1_700_000_040_000 on the 2-minute grid

    afterEach(() => jest.restoreAllMocks())

    test('an explicit timestamp on the sync grid is returned unchanged', () => {
        expect(getTimestamp(1_700_000_040_000, 0)).toBe(1_700_000_040_000)
    })

    test('an explicit timestamp off the sync grid is rounded up onto it, so it never precedes the signed minDate', () => {
        //admin-dashboard schedules an update in the middle of a timeframe and signs that same time as minDate
        expect(getTimestamp(1_700_000_000_000, 1_700_000_000_000)).toBe(1_700_000_040_000)
        expect(getTimestamp(1_700_000_040_001, 0)).toBe(1_700_000_160_000)
        expect(getTimestamp(1_700_000_159_000, 0)).toBe(1_700_000_160_000)
    })

    test('a past minDate does not schedule the update in the past', () => {
        jest.spyOn(Date, 'now').mockReturnValue(now)
        expect(getTimestamp(0, 1000)).toBe(1_700_000_040_000 + 4 * 60 * 1000)
    })

    test('a missing minDate runs the grace period from now', () => {
        jest.spyOn(Date, 'now').mockReturnValue(now)
        expect(getTimestamp(0, undefined)).toBe(1_700_000_040_000 + 4 * 60 * 1000)
    })

    test('a future minDate wins over the current time', () => {
        jest.spyOn(Date, 'now').mockReturnValue(now)
        const future = now + 1000 * 60 * 60 //1_700_003_650_000, normalises to 1_700_003_640_000
        expect(getTimestamp(0, future)).toBe(1_700_003_640_000 + 4 * 60 * 1000)
    })

    test('the default switch time lies on the sync grid, two to four minutes ahead, whatever minute it is now', () => {
        const grid = 1_800_000_000_000
        for (const offset of [0, 1, 59_999, 60_000, 60_001, 119_999]) { //even and odd minutes
            jest.spyOn(Date, 'now').mockReturnValue(grid + offset)
            const switchTime = getTimestamp(0, 0)
            expect(switchTime).toBe(grid + 240_000)
            expect(switchTime % 120_000).toBe(0)
            expect(switchTime - (grid + offset)).toBeGreaterThan(120_000)
            expect(getTimestamp(0, grid + offset)).toBe(grid + 240_000) //a minDate of now lands on the same tick
        }
        const oddMinuteMinDate = grid + 3_600_000 + 60_000
        expect(getTimestamp(0, oddMinuteMinDate)).toBe(grid + 3_600_000 + 240_000)
    })

    test('the last attempt of a round started at the default switch time ends before the next tick', () => {
        const {getMaxTime, maxSubmitAttempts, clusterRoundLength} = require('@reflector/reflector-shared')
        jest.spyOn(Date, 'now').mockReturnValue(1_800_000_060_000) //an odd minute
        const switchTime = getTimestamp(0, 0)
        const pollEnd = getMaxTime(switchTime, maxSubmitAttempts - 1, clusterRoundLength) * 1000 + 1000 //pollForTransactionSuccess stops here
        expect(pollEnd).toBe(switchTime + 61_000)
        //a failed round is retried at the next grid tick (getNextSyncTimestamp: normalize(tick + 2 minutes)); from an
        //odd-minute switch time that tick came one second before the poll ended, from a grid switch time 59 s after it
        const nextTick = Math.floor((switchTime + 120_000) / 120_000) * 120_000
        expect(nextTick - pollEnd).toBe(59_000)
    })

    test('against the real clock the result lies ahead of now', () => {
        expect(getTimestamp(0, 1000)).toBeGreaterThan(Date.now())
    })
})
