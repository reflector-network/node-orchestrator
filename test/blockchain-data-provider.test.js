/*eslint-disable no-undef */
const {__getMaxTime, maxSubmitAttempts, baseUpdateFee, FEE_MULTIPLIER} = require('../domain/blockchain-data-provider')

describe('blockchain-data-provider submit schedule', () => {
    test('attempt 0 (iteration 1) gives 30s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 1) - syncTs / 1000).toBe(30)
    })

    test('attempt 1 (iteration 2) gives 45s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 2) - syncTs / 1000).toBe(45)
    })

    test('attempt 2 (iteration 3) gives 60s lookahead', () => {
        const syncTs = 1_700_000_000_000
        expect(__getMaxTime(syncTs, 3) - syncTs / 1000).toBe(60)
    })

    test('exports parity constants', () => {
        expect(maxSubmitAttempts).toBe(3)
        expect(baseUpdateFee).toBe(10_000_000)
        expect(FEE_MULTIPLIER).toBe(8)
    })
})
