/*eslint-disable no-undef */
const {isPrivateIP, validateRequestUrl, resolveAndValidate} = require('../utils/ssrf-validator')

describe('isPrivateIP', () => {
    test('rejects loopback, link-local, private and unspecified addresses', () => {
        for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0'])
            expect(isPrivateIP(ip)).toBe(true)
    })

    test('rejects private IPv6 and IPv4-mapped IPv6', () => {
        for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1'])
            expect(isPrivateIP(ip)).toBe(true)
    })

    test('accepts public addresses', () => {
        expect(isPrivateIP('8.8.8.8')).toBe(false)
        expect(isPrivateIP('2001:4860:4860::8888')).toBe(false)
    })
})

describe('validateRequestUrl', () => {
    test('accepts http and https', () => {
        expect(validateRequestUrl('https://gateway.example.com').protocol).toBe('https:')
        expect(validateRequestUrl('http://gateway.example.com:8080').protocol).toBe('http:')
    })

    test('refuses other schemes with a message that is safe to echo', () => {
        expect(() => validateRequestUrl('file:///etc/passwd')).toThrow('Blocked URL scheme')
        try {
            validateRequestUrl('ftp://example.com')
        } catch (e) {
            expect(e.safeMessage).toBe('Blocked URL scheme')
        }
    })

    test('refuses a string that is not a url', () => {
        expect(() => validateRequestUrl('not a url')).toThrow()
    })

    test('sets a safe message on every rejection, including a bare parse failure', () => {
        //the route echoes safeMessage and nothing else, so a throw without one leaves it guessing
        for (const bad of ['not a url', '', 'http://', '///nope', 'file:///etc/passwd', 'ftp://example.com']) {
            try {
                validateRequestUrl(bad)
                throw new Error(`expected ${JSON.stringify(bad)} to be refused`)
            } catch (e) {
                expect(typeof e.safeMessage).toBe('string')
                expect(e.safeMessage.length).toBeGreaterThan(0)
            }
        }
    })
})

describe('resolveAndValidate', () => {
    test('refuses a loopback literal without touching dns', async () => {
        await expect(resolveAndValidate('http://127.0.0.1:7100/loki')).rejects.toThrow('SSRF blocked')
    })

    test('refuses the cloud metadata address', async () => {
        await expect(resolveAndValidate('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('SSRF blocked')
    })

    test('refuses an IPv6 loopback literal', async () => {
        await expect(resolveAndValidate('http://[::1]:7100/')).rejects.toThrow('SSRF blocked')
    })

    test('returns the resolved address for a public literal', async () => {
        const {resolvedIp} = await resolveAndValidate('http://8.8.8.8/health')
        expect(resolvedIp).toBe('8.8.8.8')
    })

    test('refuses an IPv4-mapped IPv6 literal in every spelling', async () => {
        for (const url of [
            'http://[::ffff:127.0.0.1]:6379/',
            'http://[::ffff:7f00:1]/',
            'http://[0:0:0:0:0:ffff:7f00:1]/',
            'http://[::ffff:169.254.169.254]/latest/meta-data/',
            'http://[::ffff:10.0.0.1]/'
        ])
            await expect(resolveAndValidate(url)).rejects.toThrow('SSRF blocked')
    })

    test('refuses the address families that carry an IPv4 address inside them', async () => {
        for (const url of ['http://[2002:7f00:1::]/', 'http://[64:ff9b::7f00:1]/', 'http://[::127.0.0.1]/'])
            await expect(resolveAndValidate(url)).rejects.toThrow('SSRF blocked')
    })

    test('refuses carrier-grade NAT, benchmarking and multicast ranges', async () => {
        //100.64.0.0/10 routes to an operator's own infrastructure and was allowed through
        for (const url of ['http://100.64.0.1/', 'http://100.127.255.254/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/'])
            await expect(resolveAndValidate(url)).rejects.toThrow('SSRF blocked')
    })

    test('still allows ordinary public addresses, including the ranges that only look private', async () => {
        for (const [url, expected] of [['http://172.15.0.1/', '172.15.0.1'], ['http://172.32.0.1/', '172.32.0.1'], ['http://99.63.255.255/', '99.63.255.255']]) {
            const {resolvedIp} = await resolveAndValidate(url)
            expect(resolvedIp).toBe(expected)
        }
        const {resolvedIp} = await resolveAndValidate('http://[2001:4860:4860::8888]/')
        expect(resolvedIp).toBe('2001:4860:4860::8888')
    })
})
