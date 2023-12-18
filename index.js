const fs = require('fs')
const appConfig = require('./domain/app-config')
const init = require('./app')

try {
    if (!fs.existsSync('./home/app.config.json'))
        throw new Error('app.config.json not found')
    const rawConfig = JSON.parse(fs.readFileSync('./home/app.config.json'))

    appConfig.init(rawConfig)
    init()
} catch (e) {
    console.error(e)
}