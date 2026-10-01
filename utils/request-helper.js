const logger = require('../logger')

//The url that answered last, per configured url list (Soroban RPC and Horizon lists alike). Without it every request
//walked the list in configured order, so a first url that hangs cost its whole deadline on every request. The same
//helper lives in reflector-shared helpers/entries-helper.js, oracle-client src/rpc-helper.js, reflector-node
//src/utils/rpc-helper.js and reflector-stellar-connector src/utils.js
const lastGoodUrls = new Map()
//distinct url lists one process uses: an rpc and a horizon list per network
const maxRememberedUrlLists = 16
//a preference is dropped this long after it was set, so the configured order - the primary first - is tried again: a
//process that failed over once would otherwise stay on a secondary that lags the primary long after it recovered
const urlPreferenceTtl = 10 * 60 * 1000

/**
 * @param {string[]} urls - configured urls
 * @returns {string[]} the url that answered last first, then the others in configured order; the configured order
 * alone once the preference is older than urlPreferenceTtl
 */
function orderByLastGood(urls) {
    const key = urls.join('\n')
    const preferred = lastGoodUrls.get(key)
    const index = preferred ? urls.indexOf(preferred.url) : -1
    if (index < 0)
        return urls
    if (Date.now() - preferred.since >= urlPreferenceTtl) {
        lastGoodUrls.delete(key)
        return urls
    }
    //only the first occurrence moves: a url listed twice is still asked twice, so a failing request makes as many
    //attempts as it did without the preference
    return [urls[index], ...urls.slice(0, index), ...urls.slice(index + 1)]
}

/**
 * @param {string[]} urls - configured urls
 * @param {string} url - the url that answered
 */
function rememberGoodUrl(urls, url) {
    const key = urls.join('\n')
    const previous = lastGoodUrls.get(key)
    //the time is kept while the same url keeps answering, so a preference still expires ten minutes after it was set
    const since = previous && previous.url === url ? previous.since : Date.now()
    //deleted and set again, so the first entry is always the list used longest ago
    lastGoodUrls.delete(key)
    lastGoodUrls.set(key, {url, since})
    if (lastGoodUrls.size > maxRememberedUrlLists)
        lastGoodUrls.delete(lastGoodUrls.keys().next().value)
}

/**
 * Make a request to multiple server URLs, starting at the one that answered last, and return the result from the
 * first successful request.
 * @param {string[]} urls - list of server URLs
 * @param {(serverUrl: string) => any} serverCtor - function to create a server instance
 * @param {(server: any) => Promise<any>} requestFn - function to make a request using the server instance
 * @param {{quiet: boolean}} [options] - quiet: the caller expects a refusal and logs the errors itself once it knows
 * what the failure was; they are logged at debug here and always travel as the thrown error's cause
 * @returns {Promise<any>} - resolves with the result of the request
 */
async function makeServerRequest(urls, serverCtor, requestFn, {quiet = false} = {}) {
    const errors = []
    for (const url of orderByLastGood(urls)) {
        try {
            const server = serverCtor(url, {allowHttp: true})
            const result = await requestFn(server)
            rememberGoodUrl(urls, url)
            return result
        } catch (err) {
            logger.debug(`Request to ${url} failed. Error: ${err.message}`)
            errors.push(err)
        }
    }
    if (!quiet)
        for (const err of errors)
            logger.error(err)
    throw new Error('Failed to make request. See logs for details.', {cause: errors})
}

module.exports = {
    makeServerRequest
}