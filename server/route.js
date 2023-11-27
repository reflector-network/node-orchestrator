import { authenticate, corsMiddleware } from './middlewares.js';

/**
 * Register API route
 * @param {object} app - Express app instance
 * @param {string} route - Relative route path
 * @param {object} options - Additional options
 * @param {'get'|'post'|'put'|'delete'} [options.method] - Route prefix. Default: 'get'
 * @param {string} [options.prefix] - Route prefix. Default: '/explorer/:network/'
 * @param {('whitelist'|'open')} [options.cors] - CORS headers to set. Default: 'whitelist'
 * @param {object} [options.headers] - Additional response headers. Default: {}
 * @param {boolean} [options.prettyPrint] - Pretty-print JSON
 * @param {[function]} [options.middleware] - Request middleware to use
 * @param {routeHandler} handler - Request handler
 */
export function registerRoute(app, route, options, handler) {
    let {
        method = 'get',
        prefix = '/',
        cors = 'whitelist',
        prettyPrint = false,
        headers,
        middleware = [],
        allowAnonymous = false
    } = options

    if (!allowAnonymous)
        middleware.unshift(authenticate)
    middleware.unshift(corsMiddleware[cors])

    app[method](prefix + route, middleware, function (req, res, next) {
        if (req.query && req.query.prettyPrint !== undefined) {
            prettyPrint = true
        }
        processResponse(res, handler(req, res), headers, prettyPrint, next)
    })
    app.options(prefix + route, middleware, function (req, res) {
        res.send(method.toUpperCase())
    })
}

function processResponse(res, promise, headers, prettyPrint = false, next) {
    if (typeof promise.then !== 'function') {
        promise = Promise.resolve(promise)
    }
    promise
        .then(data => {
            if (!data) data = {}
            if (headers) {
                res.set(headers)
                //send raw data if content-type was specified
                if ((headers['content-type'] || '') !== 'application/json') {
                    res.send(data)
                    return
                }
            }
            if (prettyPrint) { //pretty-print result (tabs)
                res.set({'content-type': 'application/json'})
                res.send(JSON.stringify(data, null, '  '))
            } else {
                //send optimized json
                res.json(data)
            }
        })
        .catch(err => {
            next(err, res)
        })
}

/**
 * Route handler callback
 * @callback routeHandler
 * @param {{params: object, query: object, path: string}} req - Request object
 */