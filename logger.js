const fs = require('fs')
const pino = require('pino')
const rfs = require('rotating-file-stream')
const {errorSerializer, msgSerializer} = require('./logger-cleanup')

const isDev = process.env.NODE_ENV === 'development'
const traceLevel = 'trace'
const infoLevel = 'info'
const defaultLevel = isDev ? traceLevel : infoLevel
const folder = './home/logs/'

const MAX_LOG_FILE_SIZE = '2M'
const LOG_RETENTION_DAYS = '7d'

//fast-redact has no recursive wildcard and its leading * matches exactly one path segment, so each secret key is listed
//at every depth a log call reaches: a config item logged under a key holds the cluster secret four segments down
const secretKeys = ['clusterSecret', 'apiKey', 'secret']
const secretPaths = secretKeys.flatMap(key => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`])

const originalConsoleError = console.error
const originalConsoleWarn = console.warn
const originalConsoleInfo = console.info
const originalConsoleLog = console.log
const originalConsoleDebug = console.debug

//Override console.error
console.error = (...args) => {
    //Log the error using Pino
    logger.error(...args)

    //Call the original console.error
    originalConsoleError(...args)
}

//Override console.warn
console.warn = (...args) => {
    //Log the warn using Pino
    logger.warn(...args)

    //Call the original console.warn
    if (originalConsoleWarn)
        originalConsoleWarn(...args)
}

//Override console.info
console.info = (...args) => {
    //Log the info using Pino
    logger.info(...args)

    //Call the original console.info
    if (originalConsoleInfo)
        originalConsoleInfo(...args)
}

//Override console.log
console.log = (...args) => {
    //Log the log using Pino
    logger.info(...args)

    //Call the original console.log
    if (originalConsoleLog)
        originalConsoleLog(...args)
}

//Override console.debug
console.debug = (...args) => {
    //Log the debug using Pino
    logger.debug(...args)

    //Call the original console.debug
    if (originalConsoleDebug)
        originalConsoleDebug(...args)
}

const baseLogOptions = {
    level: defaultLevel,
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    serializers: {err: errorSerializer, msg: msgSerializer},
    redact: {
        paths: [
            'err.config.headers.authorization',
            'err.config.headers.Authorization',
            'err.config.data',
            ...secretPaths
        ],
        censor: '[redacted]'
    },
    formatters: {
        level(label) {
            return {level: label}
        },
        bindings() {
            return {}
        }
    }
}

if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, {recursive: true})
}

//configure rotating-file-stream
const rfsOptions = {
    size: MAX_LOG_FILE_SIZE,
    interval: LOG_RETENTION_DAYS,
    path: folder,
    maxFiles: 20
}

const errorLogStream = rfs.createStream('error.log', rfsOptions)
const combinedLogStream = rfs.createStream('combined.log', rfsOptions)


const streams = [
    {stream: errorLogStream, level: 'error'},
    {stream: combinedLogStream, level: defaultLevel}
]

if (isDev) {
    streams.push({
        stream: process.stdout,
        level: defaultLevel
    })
}

const logger = pino(baseLogOptions, pino.multistream(streams))

logger.setTrace = (isTraceEnabled) => {
    if (isTraceEnabled) {
        logger.level = traceLevel
    } else {
        logger.level = infoLevel
    }
}

logger.isTraceEnabled = () => logger.level === traceLevel

module.exports = logger