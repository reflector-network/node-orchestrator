/*eslint-disable no-undef */
const AppConfig = require('../domain/app-config')
const constants = require('./constants')

describe('AppConfig.lokiPushAuth', () => {
    test('defaults to required', () => {
        expect(new AppConfig(constants).lokiPushAuth).toBe('required')
    })

    test('accepts optional', () => {
        expect(new AppConfig({...constants, lokiPushAuth: 'optional'}).lokiPushAuth).toBe('optional')
    })

    test('rejects any other value', () => {
        expect(() => new AppConfig({...constants, lokiPushAuth: 'yes'})).toThrow('lokiPushAuth must be "optional" or "required"')
    })
})

describe('AppConfig.trustedProxies', () => {
    test('defaults to empty, so the socket peer is always the client address', () => {
        expect(new AppConfig(constants).trustedProxies).toEqual([])
    })

    test('accepts exact IPv4 and IPv6 addresses and normalises them', () => {
        const config = new AppConfig({...constants, trustedProxies: ['10.0.0.100', '::ffff:10.0.0.101', '2001:0DB8::7']})
        expect(config.trustedProxies).toEqual(['10.0.0.100', '10.0.0.101', '2001:db8::7'])
    })

    test('accepts a link-local address with a zone id, lowercased', () => {
        expect(new AppConfig({...constants, trustedProxies: ['FE80::1%eth0']}).trustedProxies).toEqual(['fe80::1%eth0'])
    })

    test('rejects a value that is not an array', () => {
        expect(() => new AppConfig({...constants, trustedProxies: '10.0.0.100'}))
            .toThrow('trustedProxies must be an array of IP addresses')
    })

    test('rejects every entry that is not an exact IP address, naming it', () => {
        for (const entry of ['10.0.0.0/8', 'proxy.local', ' 10.0.0.100', '10.0.0.100:443', '', 7, null])
            expect(() => new AppConfig({...constants, trustedProxies: ['10.0.0.100', entry]}))
                .toThrow(`trustedProxies entry ${JSON.stringify(entry)} is not an IP address`)
    })
})
