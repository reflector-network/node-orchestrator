/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const schedule = require('@reflector/reflector-shared')
const provider = require('../domain/blockchain-data-provider')

describe('the update schedule comes from reflector-shared', () => {
    const domain = path.resolve(__dirname, '..', 'domain')

    test('the orchestrator keeps no copy of its own', () => {
        expect(fs.existsSync(path.join(domain, 'update-schedule.js'))).toBe(false)
    })

    test('config-manager judges the switch and the expiry with the shared rules', () => {
        const source = fs.readFileSync(path.join(domain, 'config-manager.js'), 'utf8')
        expect(source).not.toMatch(/function (endsBeforeExpiration|isUpdateTimeReached)/)
        expect(source).toContain("const {isUpdateTimeReached, syncTimeframe, endsBeforeExpiration} = require('@reflector/reflector-shared')")
    })

    test('the blockchain data provider derives hashes with the same schedule', () => {
        expect(provider.FEE_MULTIPLIER).toBe(schedule.FEE_MULTIPLIER)
        expect(provider.maxSubmitAttempts).toBe(schedule.maxSubmitAttempts)
        const source = fs.readFileSync(path.join(domain, 'blockchain-data-provider.js'), 'utf8')
        expect(source).toContain('getMaxTime(syncTimestamp, iteration, clusterRoundLength)')
    })
})
