/*eslint-disable no-undef */
//the real resolveAndValidate has to run here: the point of this suite is that its dns lookup shares the request
//deadline instead of running before any budget starts. The lookup is stubbed, so nothing leaves the machine.
let mockDnsDelay = 0
jest.mock('dns', () => {
    const actual = jest.requireActual('dns')
    return {
        ...actual,
        promises: {
            ...actual.promises,
            lookup: () => new Promise(resolve => {
                //unref so a lookup the deadline abandoned cannot hold the test runner open
                setTimeout(() => resolve({address: '93.184.216.34', family: 4}), mockDnsDelay).unref()
            })
        }
    }
})
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const {safeGetJson} = require('../utils/safe-request')
const {resolveAndValidate} = require('../utils/ssrf-validator')

describe('the request deadline covers name resolution', () => {
    test('a slow lookup is abandoned at the deadline instead of running outside it', async () => {
        mockDnsDelay = 4000
        const started = Date.now()
        //a slow authoritative server must not add its delay on top of the setting
        await expect(safeGetJson('http://slow-dns.example.com/', {timeout: 400})).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(2500)
    })

    test('resolveAndValidate gives up as soon as the shared deadline fires', async () => {
        mockDnsDelay = 4000
        const controller = new AbortController()
        const reason = new Error('Gateway request deadline exceeded')
        reason.safeMessage = 'Gateway request timed out'
        setTimeout(() => controller.abort(reason), 200).unref()
        const started = Date.now()
        await expect(resolveAndValidate('http://slow-dns.example.com/', {signal: controller.signal}))
            .rejects.toThrow('Gateway request deadline exceeded')
        expect(Date.now() - started).toBeLessThan(2500)
    })

    test('an already expired deadline stops the lookup before it starts', async () => {
        mockDnsDelay = 4000
        const controller = new AbortController()
        const reason = new Error('Gateway validation budget exceeded')
        reason.safeMessage = 'Gateway validation timed out'
        controller.abort(reason)
        const started = Date.now()
        await expect(resolveAndValidate('http://slow-dns.example.com/', {signal: controller.signal}))
            .rejects.toThrow('Gateway validation budget exceeded')
        expect(Date.now() - started).toBeLessThan(1000)
    })
})
