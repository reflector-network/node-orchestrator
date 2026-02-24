const logger = require('../logger')

/**
 * Make a request to multiple server URLs and return the result from the first successful request.
 * @param {string[]} urls - list of server URLs
 * @param {(serverUrl: string) => any} serverCtor - function to create a server instance
 * @param {(server: any) => Promise<any>} requestFn - function to make a request using the server instance
 * @returns {Promise<any>} - resolves with the result of the request
 */
async function makeServerRequest(urls, serverCtor, requestFn) {
    const errors = []
    for (const url of urls) {
        try {
            const server = serverCtor(url, {allowHttp: true})
            return await requestFn(server)
        } catch (err) {
            logger.debug(`Request to ${url} failed. Error: ${err.message}`)
            errors.push(err)
        }
    }
    for (const err of errors)
        logger.error(err)
    throw new Error('Failed to make request. See logs for details.')
}

module.exports = {
    makeServerRequest
}