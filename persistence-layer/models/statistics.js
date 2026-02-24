const {sortObjectKeys} = require('@reflector/reflector-shared')
const mongoose = require('mongoose')
const {normalizeValues} = require('../utils')

const Schema = mongoose.Schema

const statisticsSchema = new Schema({
    data: mongoose.Schema.Types.Mixed
}, {versionKey: false, timestamps: true})

statisticsSchema.methods.toPlainObject = function () {
    return sortObjectKeys({
        data: normalizeValues(this.data),
        id: this._id
    })
}

const StatisticsModel = mongoose.model('Statistics', statisticsSchema)

module.exports = StatisticsModel