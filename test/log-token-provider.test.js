/*eslint-disable no-undef */
const {LogTokenProvider, supersededTokenTtl} = require('../domain/log-token-provider')

describe('LogTokenProvider', () => {
    afterEach(() => {
        jest.useRealTimers()
    })

    test('issues a 64-character hex token that verifies to its node', () => {
        const provider = new LogTokenProvider()
        const token = provider.issue('GA')
        expect(token).toMatch(/^[0-9a-f]{64}$/)
        expect(provider.verify(token)).toBe('GA')
    })

    test('rejects unknown, malformed and missing tokens', () => {
        const provider = new LogTokenProvider()
        provider.issue('GA')
        expect(provider.verify('0'.repeat(64))).toBeNull()
        expect(provider.verify('abc')).toBeNull()
        expect(provider.verify(undefined)).toBeNull()
    })

    test('tokens are unique per issue and bound to their node', () => {
        const provider = new LogTokenProvider()
        const a = provider.issue('GA')
        const b = provider.issue('GB')
        expect(a).not.toBe(b)
        expect(provider.verify(a)).toBe('GA')
        expect(provider.verify(b)).toBe('GB')
    })

    test('a superseded token stays valid for the grace period and then expires', () => {
        jest.useFakeTimers()
        const provider = new LogTokenProvider()
        const first = provider.issue('GA')
        const second = provider.issue('GA')
        expect(provider.verify(first)).toBe('GA')
        expect(provider.verify(second)).toBe('GA')
        jest.advanceTimersByTime(supersededTokenTtl + 1)
        expect(provider.verify(first)).toBeNull()
        expect(provider.verify(second)).toBe('GA')
    })

    test('revoke drops every token of a node', () => {
        const provider = new LogTokenProvider()
        const first = provider.issue('GA')
        const second = provider.issue('GA')
        provider.revoke('GA')
        expect(provider.verify(first)).toBeNull()
        expect(provider.verify(second)).toBeNull()
    })
})
