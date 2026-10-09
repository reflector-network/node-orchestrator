const {Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channel-types')
const BaseHandler = require('./base-handler')

class HandshakeResponseHandler extends BaseHandler {

    allowAnonymous = true

    allowedChannelTypes = [ChannelTypes.INCOMING]

    /**
     * Verifies the peer's signature over the challenge. Throws so that the pending HANDSHAKE_REQUEST rejects
     * instead of resolving; the connection handler relies on that and on channel.isValidated.
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const signature = message.data?.signature
        if (!signature) {
            channel.close(1008, 'Invalid signature', true)
            throw new Error('Signature is required')
        }
        const kp = Keypair.fromPublicKey(channel.pubkey)
        let isValid = false
        try {
            isValid = kp.verify(Buffer.from(channel.authPayload), Buffer.from(signature, 'hex'))
        } catch (e) {
            isValid = false
        }
        if (!isValid) {
            channel.close(1008, 'Invalid signature', true)
            throw new Error('Invalid signature')
        }
        channel.validated()
    }
}

module.exports = HandshakeResponseHandler