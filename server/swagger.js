const swaggerJsdoc = require('swagger-jsdoc')
const swaggerUi = require('swagger-ui-express')

const globalSwaggerConfig = {
    openapi: '3.0.0',
    info: {
        title: 'Billing Server API',
        version: '1.0.0'
    },
    tags: [
        {
            name: 'Config',
            description: 'Config management'
        }
    ],
    components: {
        securitySchemes: {
            ed25519Auth: {
                type: "apiKey",
                in: "header",
                name: "authorization",
                description: "Header must include public key, signature, nonce and rejected flag."
            }
        },
        schemas: {
            Asset: {
                type: 'object',
                properties: {
                    code: {type: 'string'},
                    type: {type: 'integer'}
                },
                required: ['code', 'type']
            },
            Signature: {
                type: 'object',
                properties: {
                    pubkey: {type: 'string'},
                    signature: {type: 'string'},
                    nonce: {type: 'integer'},
                    rejected: {type: 'boolean'}
                },
                required: ['pubkey', 'signature', 'nonce']
            },
            Node: {
                type: 'object',
                properties: {
                    pubkey: {type: 'string'},
                    url: {type: 'string'}
                },
                required: ['pubkey', 'url']
            },
            ContractConfig: {
                type: 'object',
                properties: {
                    oracleId: {type: 'string'},
                    admin: {type: 'string'},
                    dataSource: {type: 'string'},
                    baseAsset: {type: 'object', $ref: '#/components/schemas/Asset'},
                    decimals: {type: 'integer'},
                    assets: {type: 'array', items: {type: 'object', $ref: '#/components/schemas/Asset'}},
                    timeframe: {type: 'integer'},
                    period: {type: 'integer'},
                    fee: {type: 'integer'}
                },
                required: ['oracleId', 'admin', 'dataSource', 'baseAsset', 'decimals', 'assets', 'timeframe', 'period', 'fee']
            },
            Config: {
                type: 'object',
                properties: {
                    contracts: {type: 'object', description: 'Key is oracle id', additionalProperties: {$ref: '#/components/schemas/ContractConfig'}},
                    nodes: {type: 'object', description: 'Key is public key of a node', additionalProperties: {$ref: '#/components/schemas/Node'}},
                    wasmHash: {type: 'string'},
                    minDate: {type: 'integer'},
                    network: {type: 'string'}
                },
                required: ['contracts', 'nodes', 'wasmHash', 'minDate', 'network']
            },
            ConfigEnvelope: {
                type: 'object',
                properties: {
                    config: {type: 'object', $ref: '#/components/schemas/Config'},
                    signatures: {type: 'array', items: {type: 'object', $ref: '#/components/schemas/Signature'}},
                    timestamp: {type: 'integer'},
                    description: {type: 'string'},
                    status: {type: 'string'},
                    initiator: {type: 'string'}
                }
            }
        },
        OkResult: {
            type: 'object',
            properties: {
                ok: {type: 'integer'}
            },
            example: {
                ok: 1
            }
        },
        ErrorResult: {
            type: 'object',
            properties: {
                error: {type: 'string'},
                status: {type: 'integer'}
            }
        }
    },
    security: [
        {
            ed25519Auth: []
        }
    ]
}

const options = {
    definition: globalSwaggerConfig,
    apis: ['./server/routes/*.js']
}

const specs = swaggerJsdoc(options)

const registerSwaggerRoute = (app) => {
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs))
}

module.exports = registerSwaggerRoute