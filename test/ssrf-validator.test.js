/*eslint-disable no-undef */
const {isPrivateIP, validateRequestUrl, validateGatewayUrl, maxGatewayUrls, resolveAndValidate} = require('../utils/ssrf-validator')

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

//a mirror of reflector-node's tests of the same function: the two copies have to refuse exactly the same urls
describe('validateGatewayUrl', () => {
    test('an https gateway is returned with its trailing slashes removed', () => {
        expect(validateGatewayUrl('https://gw.example.com')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.example.com//')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.example.com:8443/base/')).toBe('https://gw.example.com:8443/base')
    })

    test('the parsed form is returned, so stray whitespace and host case never reach a request url', () => {
        expect(validateGatewayUrl(' https://GW.Example.com/ ')).toBe('https://gw.example.com')
        expect(validateGatewayUrl('https://gw.exa	mple.com/base')).toBe('https://gw.example.com/base')
    })

    test('a bare ? or # is refused although it leaves search and hash empty', () => {
        expect(() => validateGatewayUrl('https://gw.example.com/?')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('https://gw.example.com/#')).toThrow('Gateway URL must not contain a query string or a fragment')
    })

    test('http is accepted, https-only gateways not being required', () => {
        expect(validateGatewayUrl('http://gw.example.com')).toBe('http://gw.example.com')
        expect(validateGatewayUrl('http://93.184.216.34:8080/')).toBe('http://93.184.216.34:8080')
    })

    test('another scheme, credentials, a query or a fragment are refused', () => {
        for (const url of ['ftp://gw.example.com', 'ws://gw.example.com', 'file:///etc/passwd'])
            expect(() => validateGatewayUrl(url)).toThrow('Gateway URL must use http or https')
        expect(() => validateGatewayUrl('http://user@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('http://gw.example.com/?')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('http://10.0.0.5:8080')).toThrow('Gateway URL points at a private address')
        expect(() => validateGatewayUrl('https://user@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('https://:pass@gw.example.com')).toThrow('Gateway URL must not contain user information')
        expect(() => validateGatewayUrl('https://gw.example.com/?a=b')).toThrow('Gateway URL must not contain a query string or a fragment')
        expect(() => validateGatewayUrl('https://gw.example.com/#x')).toThrow('Gateway URL must not contain a query string or a fragment')
    })

    test('an explicit private address is refused in every spelling', () => {
        for (const url of ['https://10.0.0.5', 'https://127.0.0.1:8443', 'https://169.254.169.254', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[fd00::1]'])
            expect(() => validateGatewayUrl(url)).toThrow('Gateway URL points at a private address')
    })

    test('an empty, non-string, unparseable or oversized value is refused', () => {
        for (const value of ['', undefined, null, 42, ['https://gw.example.com']])
            expect(() => validateGatewayUrl(value)).toThrow('Gateway URL must be a non-empty string of at most 2048 characters')
        expect(() => validateGatewayUrl('not-a-url')).toThrow('Invalid URL')
        const long = 'https://gw.example.com/' + 'a'.repeat(2048 - 'https://gw.example.com/'.length)
        expect(validateGatewayUrl(long)).toBe(long)
        expect(() => validateGatewayUrl(long + 'a')).toThrow('Gateway URL must be a non-empty string of at most 2048 characters')
    })

    test('the gateway list is capped at ten', () => {
        expect(maxGatewayUrls).toBe(10)
    })
})

describe('IPv4-translated addresses', () => {
    test('are judged by the IPv4 address they carry', () => {
        expect(isPrivateIP('::ffff:0:7f00:1')).toBe(true) //127.0.0.1
        expect(isPrivateIP('::ffff:0:a9fe:a9fe')).toBe(true) //169.254.169.254
        expect(isPrivateIP('::ffff:0:a00:1')).toBe(true) //10.0.0.1
        expect(isPrivateIP('::ffff:0:808:808')).toBe(false) //8.8.8.8
    })

    test('a gateway url on a private one is refused', () => {
        expect(() => validateGatewayUrl('https://[::ffff:0:7f00:1]')).toThrow('Gateway URL points at a private address')
    })

    test('a request url on a private one is refused however the url parser respells it, without a dns lookup', async () => {
        const lookup = jest.spyOn(require('dns').promises, 'lookup')
        try {
            for (const url of ['http://[::ffff:0:7f00:1]/', 'http://[::ffff:0:127.0.0.1]/', 'http://[0:0:0:0:ffff:0:a9fe:a9fe]/'])
                await expect(resolveAndValidate(url)).rejects.toThrow('SSRF blocked')
            const {resolvedIp} = await resolveAndValidate('http://[::ffff:0:808:808]/')
            expect(resolvedIp).toBe('::ffff:0:808:808')
            expect(lookup).not.toHaveBeenCalled()
        } finally {
            lookup.mockRestore()
        }
    })
})
