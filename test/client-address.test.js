/*eslint-disable no-undef */
const {normalizeAddress, resolveClientAddress} = require('../utils/client-address')

describe('normalizeAddress', () => {
    test('keeps a plain IPv4 address', () => {
        expect(normalizeAddress('10.0.0.9')).toBe('10.0.0.9')
    })

    test('unwraps an IPv4-mapped IPv6 address in either spelling', () => {
        expect(normalizeAddress('::ffff:10.0.0.9')).toBe('10.0.0.9')
        expect(normalizeAddress('::FFFF:10.0.0.9')).toBe('10.0.0.9')
        expect(normalizeAddress('::ffff:a00:9')).toBe('10.0.0.9')
        expect(normalizeAddress('0:0:0:0:0:ffff:0a00:0009')).toBe('10.0.0.9')
    })

    test('spells an IPv6 address one way', () => {
        expect(normalizeAddress('2001:0DB8:0:0::1')).toBe('2001:db8::1')
        expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1')
        expect(normalizeAddress('::1')).toBe('::1')
    })

    test('does not unwrap an IPv4-compatible or NAT64 address, which are different hosts', () => {
        expect(normalizeAddress('::a00:9')).toBe('::a00:9')
        expect(normalizeAddress('64:ff9b::a00:9')).toBe('64:ff9b::a00:9')
    })

    test('keeps a zone id, lowercased, since a URL cannot carry one', () => {
        expect(normalizeAddress('fe80::1%eth0')).toBe('fe80::1%eth0')
        expect(normalizeAddress('FE80::1%ETH0')).toBe('fe80::1%eth0')
        expect(resolveClientAddress('FE80::1%eth0', '203.0.113.5', [])).toBe('fe80::1%eth0')
        expect(resolveClientAddress('FE80::1%eth0', '203.0.113.5', ['fe80::1%eth0'])).toBe('203.0.113.5')
    })

    test('trims the whitespace x-forwarded-for puts after its commas', () => {
        expect(normalizeAddress(' 203.0.113.5 ')).toBe('203.0.113.5')
    })

    test('returns null for anything that is not an address', () => {
        for (const value of [undefined, null, '', 'unknown', '10.0.0.0/8', '203.0.113.5:443', 'example.com', 42])
            expect(normalizeAddress(value)).toBeNull()
    })
})

describe('resolveClientAddress', () => {
    const proxies = ['10.0.0.100', '10.0.0.101']

    test('without trusted proxies the socket peer is the client and the header is ignored', () => {
        expect(resolveClientAddress('10.0.0.9', '203.0.113.5', [])).toBe('10.0.0.9')
        expect(resolveClientAddress('10.0.0.100', '203.0.113.5', [])).toBe('10.0.0.100')
    })

    test('a peer that is not a trusted proxy cannot forge its address', () => {
        expect(resolveClientAddress('10.0.0.9', '203.0.113.5', proxies)).toBe('10.0.0.9')
        expect(resolveClientAddress('10.0.0.9', '10.0.0.100', proxies)).toBe('10.0.0.9')
    })

    test('behind a trusted proxy the right-most entry that is not a trusted proxy is the client', () => {
        expect(resolveClientAddress('10.0.0.100', '203.0.113.5', proxies)).toBe('203.0.113.5')
        //the client forged the left entries; the proxy appended the real one last
        expect(resolveClientAddress('10.0.0.100', '1.1.1.1, 2.2.2.2, 203.0.113.5', proxies)).toBe('203.0.113.5')
        //a chain of trusted proxies is walked from the right
        expect(resolveClientAddress('10.0.0.100', '1.1.1.1, 203.0.113.5, 10.0.0.101', proxies)).toBe('203.0.113.5')
    })

    test('the forwarded address is normalised too', () => {
        expect(resolveClientAddress('10.0.0.100', '::ffff:203.0.113.5', proxies)).toBe('203.0.113.5')
    })

    test('a mapped socket peer still matches a trusted proxy written as IPv4', () => {
        expect(resolveClientAddress('::ffff:10.0.0.100', '203.0.113.5', proxies)).toBe('203.0.113.5')
    })

    test('a trusted proxy that forwards no usable address counts as the client itself', () => {
        expect(resolveClientAddress('10.0.0.100', undefined, proxies)).toBe('10.0.0.100')
        expect(resolveClientAddress('10.0.0.100', '', proxies)).toBe('10.0.0.100')
        expect(resolveClientAddress('10.0.0.100', 'garbage', proxies)).toBe('10.0.0.100')
        expect(resolveClientAddress('10.0.0.100', '203.0.113.5, garbage, 10.0.0.101', proxies)).toBe('10.0.0.101')
        expect(resolveClientAddress('10.0.0.100', '10.0.0.101', proxies)).toBe('10.0.0.101')
    })

    test('a socket without an address resolves to unknown', () => {
        expect(resolveClientAddress(undefined, '203.0.113.5', proxies)).toBe('unknown')
    })
})
