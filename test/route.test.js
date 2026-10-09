/*eslint-disable no-undef */
const http = require('http')
const express = require('express')

jest.mock('../domain/container', () => ({appConfig: {whitelist: ['*']}, configManager: {hasNode: () => false}}))
jest.mock('../logger', () => ({error: jest.fn(), info: jest.fn(), debug: jest.fn(), warn: jest.fn()}))

const AuthMode = require('../server/auth-mode')
const {registerRoute} = require('../server/route')

function startApp() {
    return new Promise(resolve => {
        const app = express()
        registerRoute(app, 'probe', {authMode: AuthMode.noAuth}, () => ({alpha: 1, beta: 2}))
        const server = app.listen(0, '127.0.0.1', () => resolve(server))
    })
}

function request(server, path) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port: server.address().port, method: 'GET', path}, res => {
            let body = ''
            res.on('data', chunk => {
                body += chunk
            })
            res.on('end', () => resolve(body))
        })
        req.on('error', reject)
        req.end()
    })
}

describe('prettyPrint is per request', () => {
    let app

    beforeAll(async () => {
        app = await startApp()
    })

    afterAll(async () => {
        await new Promise(resolve => app.close(resolve))
    })

    test('one pretty-printed request does not change the next one', async () => {
        expect(await request(app, '/probe')).toBe('{"alpha":1,"beta":2}')
        expect(await request(app, '/probe?prettyPrint')).toContain('\n')
        expect(await request(app, '/probe')).toBe('{"alpha":1,"beta":2}')
    })
})
