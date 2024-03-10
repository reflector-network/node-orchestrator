const {Keypair} = require('@stellar/stellar-sdk')
const nodeKps = [
    Keypair.fromSecret('SAPXRLLSLC5WLVW5YPDCGQYBDTZV6TJEXXXQCGFLHUFKG5AXGEN7KEKY'),
    Keypair.fromSecret('SA6TCIOKCFUDGOMFWKNRUZXUDO3WPKSZDDAJ4ZGWD6MAWXKCWNXZWNTT')
]

const constatns = {
    networks: {
        testnet: {
            urls: ["https://horizon-testnet.stellar.org"],
            passphrase: "Test SDF Network ; September 2015"
        },
        public: {
            urls: ["https://horizon.stellar.org"],
            passphrase: "Public Global Stellar Network ; September 2015"
        }
    },
    dbConnectionString: "mongodb://127.0.0.1:27017/reflector-orchestrator-test",
    port: 3000,
    defaultNodes: nodeKps.map(kp => kp.publicKey()),
    /**
     * @type {Keypair[]}
     */
    nodeKps,
    config: {
        "systemAccount": "GCEBYD3K3IYSYLK5EQEK72RVAH2AHZUYSFFG4IOXUS5AOINLMXJRMDRA",
        "contracts": {
            "CBMZO5MRIBFL457FBK5FEWZ4QJTYL3XWID7QW7SWDSDOQI5H4JN7XPZU": {
                "admin": "GD6CN3XGN3ZGND3RSPMAOB3YCO4HXF2TD6W4OMOUL4YOPC7XGBHXPF5K",
                "oracleId": "CBMZO5MRIBFL457FBK5FEWZ4QJTYL3XWID7QW7SWDSDOQI5H4JN7XPZU",
                "baseAsset": {
                    "type": 1,
                    "code": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
                },
                "decimals": 14,
                "assets": [
                    {
                        "type": 1,
                        "code": "BTCLN:GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT"
                    },
                    {
                        "type": 1,
                        "code": "AQUA:GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA"
                    },
                    {
                        "type": 1,
                        "code": "yUSDC:GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF"
                    },
                    {
                        "type": 1,
                        "code": "FIDR:GBZQNUAGO4DZFWOHJ3PVXZKZ2LTSOVAMCTVM46OEMWNWTED4DFS3NAYH"
                    },
                    {
                        "type": 1,
                        "code": "SSLX:GBHFGY3ZNEJWLNO4LBUKLYOCEK4V7ENEBJGPRHHX7JU47GWHBREH37UR"
                    },
                    {
                        "type": 1,
                        "code": "ARST:GCSAZVWXZKWS4XS223M5F54H2B6XPIIXZZGP7KEAIU6YSL5HDRGCI3DG"
                    }
                ],
                "timeframe": 300000,
                "period": 86400000,
                "fee": 10000000,
                "dataSource": "pubnet"
            },
            "CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW": {
                "admin": "GDCOZYKHZXOJANHK3ASICJYEFGYUBSEP3YQKEXXLAGV3BBPLOFLGBAZX",
                "oracleId": "CAA2NN3TSWQFI6TZVLYM7B46RXBINZFRXZFP44BM2H6OHOPRXD5OASUW",
                "baseAsset": {
                    "type": 2,
                    "code": "USD"
                },
                "decimals": 14,
                "assets": [
                    {
                        "type": 2,
                        "code": "BTC"
                    },
                    {
                        "type": 2,
                        "code": "ETH"
                    },
                    {
                        "type": 2,
                        "code": "USDT"
                    },
                    {
                        "type": 2,
                        "code": "XRP"
                    },
                    {
                        "type": 2,
                        "code": "SOL"
                    },
                    {
                        "type": 2,
                        "code": "USDC"
                    },
                    {
                        "type": 2,
                        "code": "ADA"
                    },
                    {
                        "type": 2,
                        "code": "AVAX"
                    },
                    {
                        "type": 2,
                        "code": "DOT"
                    },
                    {
                        "type": 2,
                        "code": "MATIC"
                    },
                    {
                        "type": 2,
                        "code": "LINK"
                    },
                    {
                        "type": 2,
                        "code": "DAI"
                    },
                    {
                        "type": 2,
                        "code": "ATOM"
                    },
                    {
                        "type": 2,
                        "code": "XLM"
                    },
                    {
                        "type": 2,
                        "code": "UNI"
                    }
                ],
                "timeframe": 300000,
                "period": 86400000,
                "fee": 10000000,
                "dataSource": "coinmarketcap"
            }
        },
        "wasmHash": "551723e0178208dd25c950bf78ab5618d47257a594654bbcaaf6cec8dc8c240c",
        "network": "testnet",
        "minDate": 0,
        "nodes": nodeKps.reduce((nodes, node, i) => {
            const pubkey = node.publicKey()
            nodes[pubkey] = {
                pubkey,
                url: `ws://127.0.0.1:300${i}`,
                domain: `trusted-node-${i}.com`
            }
            return nodes
        }, {})
    },
    "emailSettings": {
        "apiKey": "apiKey",
        "from":"orchestrator@refelector.world",
        "appId": "orchestrator"
    }
}

module.exports = constatns