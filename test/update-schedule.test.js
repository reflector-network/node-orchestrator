/*eslint-disable no-undef */
const fs = require('fs')
const path = require('path')
const schedule = require('../domain/update-schedule')
const provider = require('../domain/blockchain-data-provider')

describe('the update schedule', () => {
    const switchTime = 1_800_000_000_000

    test('the switch is inclusive: the tick equal to the switch time is due', () => {
        expect(schedule.isUpdateTimeReached(switchTime, switchTime)).toBe(true)
        expect(schedule.isUpdateTimeReached(switchTime, switchTime + 1)).toBe(true)
        expect(schedule.isUpdateTimeReached(switchTime, switchTime - 1)).toBe(false)
    })

    test('the submit schedule is the one the nodes build with', () => {
        expect(schedule.maxSubmitAttempts).toBe(3)
        expect(schedule.FEE_MULTIPLIER).toBe(8)
        expect([1, 2, 3].map(iteration => schedule.__getMaxTime(switchTime, iteration) - switchTime / 1000)).toEqual([30, 45, 60])
    })

    test('a round ends before expiry only when its last attempt and the poll a second past it are over by then', () => {
        //the last attempt's maxTime is the tick + 60 s, and the orchestrator polls one second past it
        expect(schedule.endsBeforeExpiration(switchTime, switchTime + 61_000)).toBe(true)
        expect(schedule.endsBeforeExpiration(switchTime, switchTime + 61_001)).toBe(true)
        expect(schedule.endsBeforeExpiration(switchTime, switchTime + 60_999)).toBe(false)
        expect(schedule.endsBeforeExpiration(switchTime, switchTime)).toBe(false)
        expect(schedule.endsBeforeExpiration(switchTime + 120_000, switchTime + 181_000)).toBe(true)
        expect(schedule.endsBeforeExpiration(switchTime + 120_000, switchTime + 180_999)).toBe(false)
    })

    test('config-manager judges expiry with the shared rule and keeps no copy of its own', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '..', 'domain', 'config-manager.js'), 'utf8')
        expect(source).not.toMatch(/function endsBeforeExpiration/)
        expect(source).toMatch(/\{[^}]*\bendsBeforeExpiration\b[^}]*\} = require\('\.\/update-schedule'\)/)
    })

    test('the blockchain data provider uses the same functions', () => {
        expect(provider.__getMaxTime).toBe(schedule.__getMaxTime)
        expect(provider.FEE_MULTIPLIER).toBe(schedule.FEE_MULTIPLIER)
        expect(provider.maxSubmitAttempts).toBe(schedule.maxSubmitAttempts)
    })
})
