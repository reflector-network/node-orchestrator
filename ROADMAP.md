# Roadmap

## Stale beam alerts

The price update alert (`PRICE_UPDATE_ISSUE` in `domain/statistics/statistics-manager.js`) covers price oracles only.
A beam updates only the feeds someone has paid for with `track`: a feed it adds starts unpaid, and a beam with no paid
feed correctly sends no update at all. So a beam cannot be judged by its last update alone, and today a beam that stops
updating while consumers are paying for it raises nothing.

- Nodes report, per beam, how many feeds are paid and unexpired (the oracle runner already counts them as
  `activeAssets`) next to the last processed timestamp.
- The orchestrator raises the price update alert for a beam when a majority of the reporting nodes count at least one
  paid feed and see no update within two timeframes plus the same 20% margin as price oracles.
- A beam with no paid feed raises nothing.
