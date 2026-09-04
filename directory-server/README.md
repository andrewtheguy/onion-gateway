# directory-server

The reference directory server. A browser Tor client — the onion gateway in
this repository is one — bootstraps in seconds when it is handed a *seed*: the
current microdesc consensus, the authority certificates that check it and the
microdescriptor of every relay in it, in one JSON document. Downloading those
over a single Snowflake circuit takes minutes; this server fetches them from a
directory authority over plain HTTP, verifies them, and serves them over two
URLs, rebuilding as each hourly consensus is published.

```bash
cargo run -- serve                                 # 127.0.0.1:5180
cargo run -- serve --listen 0.0.0.0:8080 --web-root dist   # with a built site in front
cargo run -- snapshot seed.json                    # one seed to a file, no server
```

`--listen` (or `WEBTOR_DIRECTORY_LISTEN`) moves the server, `--web-root` (or
`WEBTOR_DIRECTORY_WEB_ROOT`) serves a built single-page site from `/` with
`index.html` for any path that is not a file, and `--authority <URL>`,
repeatable, replaces the built-in list of authorities to try in order.
`RUST_LOG` filters the log; the default is `info`.

## What it answers

This is the contract: a server that answers these two URLs the same way,
from any language, is a directory server the client can use.

```
GET /api/directory
200 {"url": "/api/directory/20260904T180000Z-3fa9c1d2e5b70a41.json",
     "validAfter": "2026-09-04T18:00:00Z", "freshUntil": "2026-09-04T19:00:00Z",
     "validUntil": "2026-09-04T21:00:00Z", "bytes": 40736969, "relays": 9453}
503 {"error": "..."} with Retry-After: 30, until the first seed has been built

GET /api/directory/<name>.json
200 the seed; ETag "<name>"; 304 on a matching If-None-Match

GET /api/health
200 {"ok": true, "directory": <the manifest, or null>}
```

- **The manifest** names the current seed and its lifetime, and is answered
  with `Cache-Control: no-cache`: it is the one thing that changes. `url` is
  relative to the manifest here; a client must also take an absolute one.
- **The seed** is `{"version":3,"consensus":…,"certificates":…,"microdescriptors":…}`,
  the fields in that order, the documents as the authority served them. Its
  name is `<valid-after as 20260904T180000Z>-<first 16 hex of the JSON's SHA-256>`,
  so a name is unique to its bytes and the response is
  `Cache-Control: public, max-age=<seconds to validUntil>, immutable`, gzip
  when the request accepts it, which roughly halves the forty megabytes.
- **CORS.** Every `/api` answer carries `Access-Control-Allow-Origin: *`. The
  client asking runs on an onion's origin, not this host's.
- **Freshness.** A consensus is published every hour and valid for three. A
  new seed is built three minutes after the current one's `freshUntil`, again
  five minutes later if the authorities still serve the old consensus, and
  after a failure with a backoff from one minute to fifteen. The seed the
  manifest named before stays served, unadvertised, until the next rebuild,
  for a client that read the manifest a moment before.

## How a seed is built

The consensus comes from the first authority in the list that answers, the
certificates as one document named by the signers' key fingerprints, and the
microdescriptors in batches of ninety with four requests in flight, in
consensus order so that two builds of one consensus are byte for byte the
same. Every document is asked for zlib-compressed and capped in size, on the
wire and inflated.

Before anything is served it is checked with Arti's `tor-netdoc` crates, the
ones the client itself is built on: the consensus must be valid now and
signed by a strict majority of the nine pinned directory authorities, each
signature checked against its certificate; and it must carry enough relays
usable as middles and as HSDirs for a client to build circuits and find
onion services. A build that fails any of this is not served, and a seed
that passes is one the client will install.

## Develop

`cargo test` covers the seed checks against fixtures and the endpoints in
process; `cargo clippy --all-targets` is expected to pass clean. Nothing here
touches the network but `serve` and `snapshot`.
