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
