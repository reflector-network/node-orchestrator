const {Keypair} = require('@stellar/stellar-sdk')
const ChannelTypes = require('../channel-types')
const BaseHandler = require('./base-handler')

class HandshakeResponseHandler extends BaseHandler {

    allowAnonymous = true

    allowedChannelTypes = [ChannelTypes.INCOMING]

    /**
     * @param {ChannelBase} channel - channel
     * @param {any} message - message to handle
     */
    async handle(channel, message) {
        const {signature} = message.data
        const kp = Keypair.fromPublicKey(channel.pubkey)
        if (!kp.verify(Buffer.from(channel.authPayload), Buffer.from(signature, 'hex'))) {
            channel.close(1008, 'Invalid signature', true)
            return
        }
        channel.validated()
    }
}

module.exports = HandshakeResponseHandler