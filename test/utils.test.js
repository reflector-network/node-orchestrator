/*eslint-disable no-undef */
const {stripRejectedSignatures} = require('../domain/utils')

describe('stripRejectedSignatures', () => {
    test('removes rejected signatures and keeps the rest in order', () => {
        const envelope = {
            config: {a: 1},
            signatures: [
                {pubkey: 'GA', signature: 'aa', nonce: 1},
                {pubkey: 'GB', signature: 'bb', nonce: 2, rejected: true},
                {pubkey: 'GC', signature: 'cc', nonce: 3}
            ],
            timestamp: 0
        }
        const result = stripRejectedSignatures(envelope)
        expect(result.signatures.map(s => s.pubkey)).toEqual(['GA', 'GC'])
        expect(result.config).toBe(envelope.config)
        expect(envelope.signatures).toHaveLength(3) //input untouched
    })

    test('passes through undefined and null', () => {
        expect(stripRejectedSignatures(undefined)).toBeUndefined()
        expect(stripRejectedSignatures(null)).toBeNull()
    })
})

describe('parseBoundedInt', () => {
    const {parseBoundedInt} = require('../domain/utils')

    test('returns the fallback for an absent value', () => {
        expect(parseBoundedInt(undefined, 10, 1, 100)).toBe(10)
        expect(parseBoundedInt(null, 10, 1, 100)).toBe(10)
        expect(parseBoundedInt('', 10, 1, 100)).toBe(10)
    })

    test('parses a numeric string and clamps it', () => {
        expect(parseBoundedInt('5', 10, 1, 100)).toBe(5)
        expect(parseBoundedInt('1000000', 10, 1, 100)).toBe(100)
        expect(parseBoundedInt(-3, 10, 1, 100)).toBe(1)
    })

    test('refuses a value that is not a safe integer', () => {
        expect(() => parseBoundedInt('abc', 10, 1, 100)).toThrow('Invalid pagination parameter')
        expect(() => parseBoundedInt({$gt: 1}, 10, 1, 100)).toThrow('Invalid pagination parameter')
    })
})