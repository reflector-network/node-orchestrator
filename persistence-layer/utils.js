function normalizeValues(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj
    }

    //convert Long to BigInt
    if (obj._bsontype === 'Long' || (obj.hasOwnProperty('low') && obj.hasOwnProperty('high'))) {
        return BigInt(obj.toString())
    }

    //return Date as is
    if (obj instanceof Date)
        return obj

    //recursively normalize arrays and objects
    if (Array.isArray(obj))
        return obj.map(normalizeValues)

    //set normalized values
    const normalized = {}
    for (const [key, value] of Object.entries(obj)) {
        normalized[key] = normalizeValues(value)
    }
    return normalized
}

module.exports = {
    normalizeValues
}