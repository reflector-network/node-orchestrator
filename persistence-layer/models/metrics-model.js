const mongoose = require('mongoose')

const Schema = mongoose.Schema

const metricsSchema = new Schema({
    data: mongoose.Schema.Types.Mixed
}, {versionKey: false, timestamps: true})

metricsSchema.index({'createdAt': 1})

metricsSchema.methods.toPlainObject = function() {
    return {
        ...this.data,
        id: this._id
    }
}

const MetricsModel = mongoose.model('Metrics', metricsSchema)

module.exports = MetricsModel