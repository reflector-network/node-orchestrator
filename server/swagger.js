const swaggerJsdoc = require('swagger-jsdoc')
const swaggerUi = require('swagger-ui-express')

const globalSwaggerConfig = {
    openapi: '3.0.0',
    info: {
        title: 'Reflector Node Orchestrator API',
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
                description: "Header must be `<pubkey>.<hexSignature>.<nonce>`, signed with the node key."
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
                    url: {type: 'string'},
                    domain: {type: 'string'}
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
                    currentTime: {
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
            },
            NodeSettings: {
                type: 'object',
                properties: {
                    emails: {
                        type: 'array',
                        items: {
                            type: 'string'
                        }
                    }
                }
            },
            Subscription: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string'
                    },
                    balance: {
                        type: 'string'
                    },
                    threshold: {
                        type: 'number'
                    },
                    updated: {
                        type: 'string',
                        description: 'Last charge, or creation while there has been none, in milliseconds'
                    },
                    lastCharge: {
                        type: 'integer',
                        format: 'int64',
                        description: '`updated` as a number'
                    },
                    base: {
                        type: 'object'
                    },
                    quote: {
                        type: 'object'
                    },
                    heartbeat: {
                        type: 'number'
                    },
                    status: {
                        type: 'number'
                    },
                    owner: {
                        type: 'string'
                    },
                    webhook: {
                        type: 'string'
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

/**
 * Build the specification from the route annotations
 * @returns {object}
 */
function getSwaggerSpec() {
    return swaggerJsdoc(options)
}

/**
 * Mount the swagger ui. The specification describes every authenticated route and the ui itself is unauthenticated,
 * so it stays out of production deployments. It is opt-in: only `npm run dev` (NODE_ENV=development) or an
 * explicit ENABLE_SWAGGER=true mounts it, so a launch that sets neither - node index.js, pm2, a bare Dockerfile CMD -
 * does not publish it.
 * @param {object} app - Express app instance
 * @returns {boolean} true when the ui was mounted
 */
const registerSwaggerRoute = (app) => {
    if (process.env.NODE_ENV !== 'development' && process.env.ENABLE_SWAGGER !== 'true')
        return false
    app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(getSwaggerSpec()))
    return true
}

module.exports = registerSwaggerRoute
module.exports.getSwaggerSpec = getSwaggerSpec