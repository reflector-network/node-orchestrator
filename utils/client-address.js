const net = require('net')
const {toIPv6Bytes} = require('./ssrf-validator')

/**
 * Spell an IP address one way, so the connection caps and the trusted proxy list compare like with like. An
 * IPv4-mapped IPv6 address (`::ffff:1.2.3.4`, as a dual-stack socket reports an IPv4 peer, or `::ffff:102:304`) becomes
 * the plain IPv4 address it carries; any other IPv6 address gets its compressed lowercase form. Only the mapped range is
 * unwrapped: an IPv4-compatible or NAT64 address names a different host. The byte expansion is the one the SSRF
 * validator uses, so both read an address the same way.
 * @param {*} address - candidate address, surrounding whitespace allowed
 * @returns {string|null} the normalised address, or null when the value is not an IP address
 */
function normalizeAddress(address) {
    if (typeof address !== 'string')
        return null
    const candidate = address.trim()
    if (net.isIPv4(candidate))
        return candidate
    if (!net.isIPv6(candidate))
        return null
    const bytes = toIPv6Bytes(candidate)
    if (bytes && bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
        return bytes.slice(12, 16).join('.')
    try {
        return new URL(`http://[${candidate}]`).hostname.slice(1, -1)
    } catch (e) {
        return candidate.toLowerCase() //a zone id (fe80::1%eth0) is valid for a socket but not in a URL
    }
}

/**
 * Resolve the address a connection is counted and logged under. It is the socket peer, which a client cannot forge,
 * unless that peer is one of the configured trusted proxies. Then `x-forwarded-for` is read from the right, skipping
 * trusted proxies, and the first other entry is the client: the proxy appends the address it saw, so entries to its
 * left are the client's own claims and are never reached. An entry that is not an IP address stops the walk at the last
 * trusted hop, so a malformed or missing header counts against the proxy itself, never against a chosen address.
 * With no trusted proxies the header is ignored entirely.
 * @param {string} socketAddress - socket peer address
 * @param {string|string[]} [forwardedFor] - raw `x-forwarded-for` header
 * @param {string[]} [trustedProxies] - normalised addresses of trusted proxies
 * @returns {string} client address, or 'unknown' when the socket has none
 */
function resolveClientAddress(socketAddress, forwardedFor, trustedProxies = []) {
    let client = normalizeAddress(socketAddress)
    if (!client)
        return 'unknown'
    if (!trustedProxies.includes(client))
        return client
    const hops = [].concat(forwardedFor || []).join(',').split(',')
    for (let i = hops.length - 1; i >= 0; i--) {
        const hop = normalizeAddress(hops[i])
        if (!hop)
            return client
        client = hop
        if (!trustedProxies.includes(hop))
            return client
    }
    return client
}

module.exports = {normalizeAddress, resolveClientAddress}
