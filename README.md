# @reflector/node-orchestrator

Admin and coordination service of a Reflector oracle cluster. It stores cluster configuration envelopes in MongoDB,
accepts proposals and votes from node operators over signed HTTP, pushes the resulting envelopes to nodes over
WebSocket, polls nodes for statistics, scans Horizon for the transactions the cluster landed, serves subscription data
read from Soroban RPC, and mails operators when something looks wrong.

It holds no signing key and never signs consensus material. Nodes verify every configuration signature themselves and
adopt an envelope only when a majority of the current node set signed it. The execution time of a pending update is
not covered by those signatures, so the orchestrator decides *when* an approved update executes, never *what* it
contains; nodes refuse an execution time earlier than the signed `minDate`.

## Running

Node >= 22.12. The service reads `./home/app.config.json`, relative to the working directory, and writes its logs to
`./home/logs/`.

| Field | Meaning |
| --- | --- |
| `port` | HTTP and WebSocket port (required) |
| `dbConnectionString` | MongoDB connection string (required); the client connects with `directConnection: true` |
| `defaultNodes` | non-empty list of node public keys trusted until the first configuration is applied (required) |
| `networks` | per-network `urls` (Soroban RPC), `horizonUrls` and `passphrase`, keyed by the network name the cluster config uses (required) |
| `whitelist` | CORS origins; `*` allows any origin, and a request without an `Origin` header is always allowed |
| `emailSettings` | OneSignal `apiKey`, `appId` and `from`, all three required |
| `monitoringKey` | public key that receives monitoring email and, while it is also a node key, may read logs from any node. Nodes verify the signature on every log request and trace toggle, and accept a trace toggle only from their own key, so this key toggles tracing on its own node only |
| `lokiUrl` | Loki base URL; the `/loki-proxy` mount is skipped when it is unset |
| `lokiPushAuth` | `required` (default) or `optional`, a rollout escape hatch that accepts log pushes without a valid token |
| `trustedProxies` | exact IP addresses of the reverse proxies in front of the service, default empty; see [WebSocket](#websocket). Boot refuses an entry that is not a single IPv4 or IPv6 address, so ranges and host names are rejected |

`npm start` runs the service with `NODE_ENV=production`; `npm run dev` runs it under nodemon with
`NODE_ENV=development`, which logs at trace level and also to stdout. `npm test` runs the jest suite, which can also be
run directly: `node --experimental-vm-modules node_modules/jest/bin/jest.js -i`. Every suite is offline except
`test/config-manager.test.js`, `test/statistics-metrics-store.test.js` and `test/nonce-index-boot.test.js`, which need a
MongoDB on `127.0.0.1:27017`. They drop their databases and close their connections and timers when they finish,
so the run exits by itself.

Boot stops with exit code 13, after logging the reason, when the config file is missing or invalid, the database is
unreachable, the `nonces` collection lacks its unique index `pubkey_1` on `pubkey` or it cannot be built (replay
protection depends on it), or the stored current or pending configuration is invalid. Boot builds that index itself
before checking it, so an empty database starts. This needs the `createIndex` privilege on the database, which the
built-in `readWrite` role includes; it changes nothing on a database that already has `pubkey_1` with the same
options. Boot stops, and changes nothing, in two cases where the index cannot be built:

- the collection holds more than one document for the same `pubkey`: boot asks for the duplicates to be removed and
  never deletes them itself;
- another index on `pubkey` conflicts with `pubkey_1` (unique, non-sparse), for example a unique index under another
  name or a sparse `pubkey_1`: boot names the index it found and asks for it to be dropped, and never drops it
  itself.

The Soroban RPC endpoints must include `headerXdr` and `metadataXdr` in their `getLatestLedger` response:
`@stellar/stellar-sdk` 17.0.1 refuses a response without them, and subscription loading and event polling call it.

## HTTP API

Signed requests carry `authorization: <pubkey>.<hex signature>.<nonce>`. The key must be in the current node list
(`defaultNodes` before the first configuration), and the nonce must be a positive integer higher than the last one
accepted for that key. The signature is an ed25519 signature over `sha256("<pubkey>:" + JSON.stringify(payload))`,
where the payload is the route binding for `GET` and `sortObjectKeys({...body, nonce, path})` for `POST`, with `path`
set to that same route binding. The route binding is the route path with its parameters filled in and without the
leading slash, then `?`, then the query string with `nonce` added and the keys sorted, for example
`logs?node=<pubkey>&nonce=42`.

| Route | Auth | Notes |
| --- | --- | --- |
| `GET /config` | optional | anonymous: the current config without `clusterSecret` and node URLs; signed: current and pending envelopes in full, with hashes |
| `POST /config` | signed | propose a configuration, or vote on the pending one |
| `GET /config/history` | signed | full envelopes, newest first; `status` must be one of `voting`, `pending`, `applied`, `rejected`, `replaced`, `initiator` a valid public key; `page` is at least 1, `pageSize` is clamped to 1-100 (default 10) |
| `GET /nodes` | none | public keys of the current nodes (`defaultNodes` before the first configuration) |
| `GET /monitoring-key` | none | the configured `monitoringKey` |
| `GET /statistics` | none | node statistics, node domains and per-contract timelines |
| `GET /metrics` | signed | stored gateway metrics; `page`, `limit` (1-100, default 10), `sortOrder` (`asc` or `desc`, default `desc`) |
| `GET /logs` | signed | log file names and trace flag of the caller's node |
| `GET /logs/:logname` | signed | one log file, answered as JSON `{logFile}`. The node sends the whole file in one WebSocket frame, capped at 4 MiB, which covers the node's 2 MiB rotated logs with room for JSON escaping. A larger answer closes the node's connection (1009) and the request answers 502; the node reconnects |
| `POST /logs/trace` | signed | body `{isTraceEnabled}` and nothing else |
| `GET /settings/node`, `POST /settings/node` | signed | the caller's notification addresses; the body is `{emails}` and nothing else |
| `GET /gateways`, `POST /gateways` | signed | relayed to the caller's own node; the `POST` body holds `urls` and an optional `challenge`, nothing else |
| `POST /validate-gateways` | signed | body `{urls, validationKey}`, at most 20 URLs |
| `GET /subscriptions/:contractId/:id`, `GET /subscriptions/:contractId/owner/:owner` | none | cached subscriptions of a subscriptions contract in the current config |
| `/loki-proxy/...` | token or signed | see below |
| `/api-docs` | none | Swagger UI; mounted only when `NODE_ENV=development` (`npm run dev`) or `ENABLE_SWAGGER=true`, so any other launch leaves it out |

The `monitoringKey`, when it is also a node key, can add `?node=<pubkey>` to the `/logs` routes to target another node.
The routes relayed to a node (`/logs`, `/logs/:logname`, `/logs/trace` and `/gateways`) answer 404 when the target is
not a node, 503 when it is a node without a connection, 502 when the node refuses the request (with the node's reason,
cut to 512 characters) or its connection closes before it answers, and 504 when it does not answer within 5 s.
Every route in the table except `/loki-proxy` and `/api-docs` goes through the CORS whitelist, the unauthenticated
ones included, and accepts `?prettyPrint` to indent the JSON response of that request.

## WebSocket

The WebSocket server shares the HTTP port. A client that sends a `pubkey` header must name a key in the current node
list and answer a signed challenge within 10 s. Nodes also send `app: node`; a newer node connection for the same key
replaces the older one. Connections without a `pubkey` header are anonymous and receive configuration broadcasts only,
stripped of `clusterSecret`, node URLs and signatures. Frames from anonymous clients are capped at 1 MiB. An upgrade
that names a registered node key gets 4 MiB, because a node answers a log file request with the whole file in one
frame. A request
waiting on a connection that closes fails at once rather than at its deadline.

Connections are capped as follows:

- **Node connections** (a `pubkey` header) are capped per public key, whatever address they come from. The key must
  already be in the node list, so the caps bound node connections without looking at addresses. Validated and pending
  connections are counted separately:
  - at most 2 validated connections per key, which lets a reconnecting node register while its old connection
    closes. A further one is refused, before its challenge when both slots are taken, or when it would register if
    two handshakes for the key completed at once;
  - at most 2 pending handshakes per key. A new handshake past that closes the oldest pending one for the key (close
    code 1008, `Handshake superseded`) instead of being refused. A pending handshake never takes a validated slot, and
    the pending handshakes the server tracks stay bounded at 2 × node count. An evicted socket leaves that count at
    once and gets its close frame; like every socket the server refuses before it registers, it is destroyed 1 s
    later if it has not closed, instead of after the WebSocket close timeout of 30 s.

  The real node's next connection evicts a parked handshake and answers its challenge within a round trip.
- **Anonymous connections**: at most 5 per client address and at most 100 in total.

The client address is the TCP peer address. When the service runs behind a TLS-terminating reverse proxy, list the
proxy's address in `trustedProxies`. A connection whose TCP peer is on that list is counted under the right-most
`x-forwarded-for` entry that is not itself a trusted proxy, which is the entry the proxy appended. This is only safe
when the proxy appends the address it saw, as nginx does with `$proxy_add_x_forwarded_for`; a proxy that passes the
client's header through unchanged lets any client choose the address it is counted under. When
`trustedProxies` is empty, `x-forwarded-for` is ignored and every client behind a proxy shares the proxy's address, so
anonymous clients share 5 slots. Node connections are unaffected either way. IPv4-mapped IPv6 addresses
(`::ffff:1.2.3.4`) are treated as the plain IPv4 address, both on the socket and in `trustedProxies`.

## Trust model

- **There is no administrator role.** Every key in the current configuration's node list has equal authority over
  configuration voting. The `monitoringKey` gets its extra rights only while it is also in that list, because every
  signed request must come from a node key.
- **Envelope submissions are bound to the caller.** `POST /config` requires `signatures[0].pubkey` to equal the
  authenticated caller and the signature nonce to be higher than the last one stored for that key, so a signature
  cannot be replayed onto another proposal.
- **Signatures are verified with the shared verifier** against the *current* cluster's node set: a node a proposal
  adds cannot vote on its own admission, a node it removes still can.
- **Signed requests bind their route.** The route binding is part of every signed payload, so a signature captured on
  one route or aimed at one node does not verify on another. The HTTP method is not signed, but a `GET` payload is a
  string and a `POST` payload an object, so one cannot pass for the other. Nonces are consumed atomically, and only
  after the signature has verified.
- **Control messages carry the operator's signature.** `SET_TRACE`, `LOGS_REQUEST` and `LOG_FILE_REQUEST` relay the
  caller's signed payload, signature and public key to the node unchanged, as `GATEWAYS_GET` and `GATEWAYS_POST` relay
  theirs, and the node verifies all five. For the three log and trace messages it checks the signature over exactly the
  payload this service verified, that the signer is a cluster node key, that the nonce moves forward per message type
  and signer, and the target: a request without a `node` parameter must be signed by the node's own key, and one with
  it must name that node. A log file name must equal the one inside the signed route, and `SET_TRACE` is accepted only
  from the node's own key.
- `STATISTICS_REQUEST` is not signed: it has no operator behind it. The response feeds the unauthenticated
  `GET /statistics`, apart from the gateway metrics, which are stored and served by the signed `GET /metrics`. The
  node trusts whatever answers on its configured `orchestratorUrl`; with an `https` or `wss` URL, TLS is what
  authenticates the orchestrator.
- **Anonymous connection caps key on the client address.** That is the TCP peer address, or, only when
  that peer is listed in `trustedProxies`, the address the proxy forwards. A proxy listed there is trusted to report
  client addresses honestly. Node connections are capped per public key instead, so a cluster of any size connects
  through a single proxy.

## Background work

- **Configuration updates.** A voting proposal is rejected once its expiration date passes; a new proposal must expire
  at least 7 days ahead. An update that reached a majority becomes pending and executes at its timestamp, which always
  lies on a 2-minute boundary: an explicit timestamp is rounded up to the next one, and without one the update executes
  4 minutes after the later of `minDate` and the time it became pending, rounded down to a 2-minute boundary. The
  timestamp must leave the update 61 s (its two submit attempts and a last poll) before the expiration date: a
  proposal whose timestamp does not is refused, and so is the vote that would make an update pending too close to its
  expiry. The pending update is sent to nodes with its expiration date, outside the signed envelope, and a node skips
  any round that would not end 61 s before it. An update that allows early submission executes before its timestamp
  once every node has signed it, but never before its signed `minDate`, the same check nodes make. The first configuration is applied as
  soon as it reaches a majority. For an update that needs a transaction, the orchestrator derives the hash the cluster
  submits and polls Soroban RPC for it.
- **A proposal is built before it is accepted.** A new proposal that calls a contract is built once, from the system
  account's current sequence, as the first attempt at its switch time would be. Building simulates the call, so a
  proposal the contracts refuse is refused with the simulation error, and so is one that cannot be checked because
  Soroban RPC does not answer. A node set change calls no contract and is not built. A change on chain between the
  proposal and its switch time can still make its rounds fail.
- **Votes change while an update is open.** A signer can change their vote, and the initiator withdraw the proposal,
  while it is voting or pending. A pending update's rounds start at every 2-minute tick from its switch time on (every
  tick when it allows early submission), and from 15 s before such a tick until its round is over, 61 s after it, a
  changed vote is refused: the nodes may already hold a signed transaction that would land after the update was
  dropped. A new vote is accepted at any time.
- **Statistics.** Nodes are polled 10 s after start, then 60 s after each round ends. Gateway metrics are stored per
  round and deleted after 7 days.
- **Landed transactions.** Horizon is scanned ledger by ledger, 10 s after each scan ends; only transactions Horizon
  marks successful count as landed rounds. A price round that moves an asset by 20% or more is reported to the
  monitoring key. The scan state is persisted in the `statistics` collection. A stored snapshot that cannot be
  interpreted is moved aside by renaming the collection to `statistics_quarantined_<timestamp>`, and statistics start
  fresh; this needs a database user that may rename collections. While the rename fails, statistics are not
  persisted, and the rename is retried on every scan.
- **Subscriptions.** For each subscriptions contract in the current config, the subscriptions are loaded from chain
  state and events are then read every 60 s. A failed load is retried after 5 s, doubling up to 5 min, for as long as
  the contract stays in the config. A suspended subscription keeps its entry with `status` 1, so the public routes
  return it; a cancelled one is removed. When the event cursor falls outside the RPC's event retention, the
  subscriptions are reloaded from chain state and events are read again from the latest ledger read before that
  reload.
- **Notifications.** Node issues go to the addresses of that node, while it is in the cluster. Cluster and oracle
  issues go to the addresses of the `monitoringKey` and of every current node, whether or not the monitoring key is a
  node; the monitoring key's addresses are listed first, so the 200-recipient cap never cuts them. Price spikes and
  DAO ballots and votes go to the monitoring key only. `POST /settings/node` accepts at most 5 distinct addresses per
  node, each at most 254 characters, and registers them with OneSignal before storing them. Each OneSignal send has a
  15 s deadline. An item is dropped 7 days after its last send, or 7 days after it was raised if it was never sent.
  An issue that clears and comes back within the throttle window of its last mail (1 h for a stale oracle, 6 or 24 h
  for the others) is not mailed again until that window has passed, however often it flaps.

## Upgrade and rollback

- **Prices are stored as strings, and rolling back past that change is not safe.** Transaction statistics persist
  every bigint, prices included, as a decimal string. An older build loads those strings unchanged. For each asset
  priced in a new round, its `__detectPriceSpike` walks back to the newest earlier round with a non-zero price for
  that asset, or to the oldest stored round when there is none. When the price it lands on is a stored string, it
  subtracts that string from a bigint and throws a `TypeError`. The throw ends the spike check of the whole round, so
  that asset and every asset after it in the round go unchecked, and `Error processing transaction` is logged at error
  level. The round's statistics are still recorded. This happens in the first new round of every oracle that has
  stored rounds, and then in every round in which an asset is priced but has had no non-zero price since the
  rollback, until the pre-rollback rounds age out of the 256 kept per contract. Before running an older build, delete
  the document in the `statistics` collection; the older build then starts its statistics from scratch.
- **The dashboard must sign the route.** `POST` signatures now cover `path`. `admin-dashboard` needs the matching change
  before it can make signed `POST` requests to this release. That change is tracked separately and is not part of this
  repository.

## Operational notes

- `home/app.config.json` holds the OneSignal REST key, and any provider key embedded in an RPC or Horizon URL. `/home`
  is gitignored. Rotate those credentials if the directory was ever copied or shared.
- Requests refused with 401 or 403 are logged at warn with the method, the route, the reason and the public key the
  `authorization` header claims, when that is a well-formed key; the signature, the nonce and the query are left out.
  One line per minute is written for each claimed node key, or for each route when the claimed key is not a node, and
  the next line says how many were held back. Relays that fail on the node side (502, 503, 504) are logged at warn,
  other 4xx at debug.
- Log messages and logged errors are redacted before they reach the log files: Stellar secret seeds, RSA private key
  blocks, `Bearer`/`Basic` credentials, key and token query parameters, every URL cut to its scheme, host and port (no
  path, query or user info: providers put API keys in the path too), and the middle of IPv4 and IPv6 addresses;
  absolute paths under the parent of the working directory are shortened to `./`. Fields named `clusterSecret`,
  `apiKey` or `secret` are replaced up to four levels deep. An axios error is reduced to its name, message, stack,
  code, status and a URL cut to scheme, host and port.
- Gateway URLs submitted to `POST /validate-gateways` are probed under egress guards: only `http` and `https`, no
  private, loopback, link-local or other reserved addresses (checked again at connect time), no redirects, no proxy, a
  1 MiB response cap and a 5 s deadline per request, and 30 s for the whole request.
- Soroban RPC and Horizon clients use a 15 s request timeout; a request that fails moves on to the next configured
  URL. Each URL list starts at the URL that answered last; that preference expires ten minutes after it was set, so the
  configured order, primary first, is tried again.
- Log pushes to `/loki-proxy/loki/api/v1/push` carry a bearer token the orchestrator issues to each node over its
  verified WebSocket connection; a superseded token stays valid for 1 hour, and a node's tokens are revoked when it
  leaves the cluster. Every other `/loki-proxy` request must be signed and is limited to read-only `GET` query
  endpoints.
