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
            },
            Statistics: {
                type: 'object',
                properties: {
                    nodeStatistics: {
                        type: 'object',
                        additionalProperties: {
                            type: 'array',
                            items: {
                                $ref: '#/components/schemas/NodeDetail'
                            }
                        }
                    },
                    currentTimestamp: {
                        type: 'integer',
                        format: 'int64'
                    },
                    currentConfigHash: {
                        type: 'string'
                    }
                }
            },
            NodeDetail: {
                type: 'object',
                properties: {
                    connectedNodes: {
                        type: 'array',
                        items: {
                            type: 'string'
                        }
                    },
                    connectionIssues: {
                        type: 'array',
                        items: {
                            type: 'string'
                        }
                    },
                    currentConfigHash: {
                        type: 'string'
                    },
                    isTraceEnabled: {
                        type: 'boolean'
                    },
                    lastProcessedTimestamp: {
                        type: 'integer',
                        format: 'int64'
                    },
                    oracleStatistics: {
                        type: 'object',
                        additionalProperties: {
                            $ref: '#/components/schemas/OracleStatistic'
                        }
                    },
                    pendingConfigHash: {
                        type: 'string'
                    },
                    startTime: {
                        type: 'integer',
                        format: 'int64'
                    },
                    submittedTransactions: {
                        type: 'integer'
                    },
                    totalProcessed: {
                        type: 'integer'
                    },
                    uptime: {
                        type: 'integer'
                    },
                    сurrentTime: {
                        type: 'integer',
                        format: 'int64'
                    },
                    version: {
                        type: 'string'
                    },
                    timeshift: {
                        type: 'integer'
                    }
                }
            },
            OracleStatistic: {
                type: 'object',
                properties: {
                    isInitialized: {
                        type: 'boolean'
                    },
                    lastOracleTimestamp: {
                        type: 'integer',
                        format: 'int64'
                    },
                    lastProcessedTimestamp: {
                        type: 'integer',
                        format: 'int64'
                    },
                    oracleId: {
                        type: 'string'
                    },
                    submittedTransactions: {
                        type: 'integer'
                    },
                    totalProcessed: {
                        type: 'integer'
                    }
                }
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