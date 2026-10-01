/*eslint-disable no-undef */
jest.mock('../domain/container', () => ({}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const {getServer: getRpcServer} = require('../utils/rpc-helper')
const {getServer: getHorizonServer} = require('../utils/horizon-helper')

describe('upstream deadlines', () => {
    test('soroban rpc servers carry a 15 s http deadline', () => {
        const server = getRpcServer('http://rpc.example.com')
        expect(server.httpClient.defaults.timeout).toBe(15000)
    })

    test('horizon servers carry a 15 s http deadline', () => {
        const server = getHorizonServer('http://horizon.example.com')
        expect(server.httpClient.defaults.timeout).toBe(15000)
    })
})
