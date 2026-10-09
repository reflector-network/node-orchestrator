/*eslint-disable no-undef */
const dns = require('dns')
//no jest.mock here: the real isPrivateIP is the subject of this suite
const {safeLookup} = require('../utils/safe-request')

function answering(addresses) {
    return (hostname, options, callback) => callback(null, addresses.map(address => ({address, family: 4})), 4)
}

describe('safeLookup', () => {
    afterEach(() => {
        jest.restoreAllMocks()
    })

    test('blocks the connection when an answer is private', done => {
        jest.spyOn(dns, 'lookup').mockImplementation(answering(['93.184.216.34', '10.0.0.5']))

        safeLookup('gateway.example.com', {all: true}, (err) => {
            expect(err).toBeInstanceOf(Error)
            expect(err.safeMessage).toBe('Host resolves to a private address')
            expect(err.message).toContain('10.0.0.5')
            done()
        })
    })

    test('passes a lookup whose answers are all public', done => {
        jest.spyOn(dns, 'lookup').mockImplementation(answering(['93.184.216.34', '93.184.216.35']))

        safeLookup('gateway.example.com', {all: true}, (err, address) => {
            expect(err).toBeNull()
            expect(address).toEqual([{address: '93.184.216.34', family: 4}, {address: '93.184.216.35', family: 4}])
            done()
        })
    })

    test('blocks a single-address answer that is private', done => {
        jest.spyOn(dns, 'lookup').mockImplementation((hostname, options, callback) => callback(null, '127.0.0.1', 4))

        safeLookup('gateway.example.com', {}, (err) => {
            expect(err.safeMessage).toBe('Host resolves to a private address')
            done()
        })
    })
})
