
/**
 * @typedef {Object} Asset
 * @property {number} type - The asset type
 * @property {string} code - The asset code
 */

/**
 * @typedef {Object} Node
 * @property {string} pubkey - The public key
 * @property {string} url - The url
 */

/**
 * @typedef {Object} Signature
 * @property {string} pubkey - The public key
 * @property {string} signature - The signature
 * @property {number} nonce - The nonce
 * @property {boolean} rejected - The rejected flag
 */

/**
 * @typedef {Object} ConfigEnvelope
 * @property {Config} config - The config
 * @property {Signature[]} signatures - The signatures
 * @property {string} description - The description
 * @property {string} status - The status
 * @property {Number} expirationDate - The expiration date
 * @property {string} initiator - The initiator
 */

export {}