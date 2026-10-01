/*eslint-disable no-undef */
const {Keypair} = require('@stellar/stellar-sdk')
const HandshakeResponseHandler = require('../server/ws/handlers/handshake-response-handler')

describe('HandshakeResponseHandler', () => {
    const keypair = Keypair.random()
    let channel
    let handler

    beforeEach(() => {
        handler = new HandshakeResponseHandler()
        channel = {
            pubkey: keypair.publicKey(),
            authPayload: 'reflector-node-challenge',
            close: jest.fn(),
            validated: jest.fn()
        }
    })

    test('valid signature validates the channel', async () => {
        const signature = Buffer.from(keypair.sign(Buffer.from(channel.authPayload))).toString('hex')
        await handler.handle(channel, {data: {signature}})
        expect(channel.validated).toHaveBeenCalled()
        expect(channel.close).not.toHaveBeenCalled()
    })

    test('invalid signature closes the channel and throws', async () => {
        await expect(handler.handle(channel, {data: {signature: '00'}})).rejects.toThrow('Invalid signature')
        expect(channel.close).toHaveBeenCalledWith(1008, 'Invalid signature', true)
        expect(channel.validated).not.toHaveBeenCalled()
    })

    test('signature over a different payload is rejected', async () => {
        const signature = Buffer.from(keypair.sign(Buffer.from('some-other-payload'))).toString('hex')
        await expect(handler.handle(channel, {data: {signature}})).rejects.toThrow('Invalid signature')
        expect(channel.validated).not.toHaveBeenCalled()
    })

    test('missing data closes the channel and throws', async () => {
        await expect(handler.handle(channel, {})).rejects.toThrow('Signature is required')
        expect(channel.close).toHaveBeenCalledWith(1008, 'Invalid signature', true)
        expect(channel.validated).not.toHaveBeenCalled()
    })
})
