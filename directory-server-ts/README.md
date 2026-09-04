# directory-server-ts

A sample directory server, in TypeScript on Bun, to show that the contract is
small enough to answer from any language. [`directory-server`](../directory-server)
is the reference implementation and its README documents the two URLs; this
one answers them the same way and stops there. What the reference server does
beyond the contract — rebuilding on its own as each consensus is published,
and checking every signature with the same Tor document library the client
is built on — is deliberately not here: a script builds the seed when you run
it, checks only that the documents have the right shape, and the server reads
whatever the script last wrote. Start from the reference server for a
deployment; start from this one to see the minimum a backend must answer.

```bash
cd directory-server-ts
bun install
bun run tor:directory    # builds ./directory/<name>.json and manifest.json, about a minute
bun run serve            # answers on 127.0.0.1:5180
```

A client that expects the directory endpoints on `127.0.0.1:5180` finds them
there, and nothing about it changes with the implementation behind the port.

## What the script writes

`bun run tor:directory` fetches the current microdesc consensus from a
directory authority over plain HTTP, the authority certificates that check its
signatures and the microdescriptor of every relay it names, and puts them in
the JSON `directorySeed` accepts. It checks that the result could be installed
— a strict majority of signatures from the authorities the client pins, a
certificate for each of them, enough relays in each role, most
microdescriptors present and matching their digests — but verifies no
signature itself, which would mean a Tor document library the way the
reference server has one. The client does that against its pinned authorities
before installing a single relay, so a seed needs no trust between here and
there; what the sample cannot catch is a seed the client will then reject.

The result goes into `./directory` (`--store` or `WEBTOR_DIRECTORY_STORE` for
another place):

```
directory/
  manifest.json                              what /api/directory answers
  20260904T180000Z-3f1c9a7b2e4d6c80.json     the seed, named by valid-after and its own SHA-256
  20260904T180000Z-3f1c9a7b2e4d6c80.json.gz  the same, gzipped ahead of time
```

The manifest is replaced in one step, so a running server picks up a rebuild
on its next request. The seed the previous manifest named is kept for one more
rebuild, for a worker that read that manifest a moment before; older ones are
removed.

A consensus is valid for three hours and the client refuses an expired one.
Run the script again before the `validUntil` it prints; from `cron`, once an
hour a few minutes past the hour suits the authorities' publication schedule.
Once the stored seed has expired the manifest answers `503` saying so, and the
worker downloads a directory over Tor instead.

`bun src/build.ts --seed <path>` writes the bare seed to one file instead,
for a project that ships one with its static files.

## What the server answers

```
GET /api/directory                the manifest; Cache-Control: no-cache; 503 with Retry-After when there is no valid seed
GET /api/directory/<name>.json    the seed; public, max-age=<seconds to validUntil>, immutable; ETag; gzip when accepted
GET /api/health
```

Every `/api` answer carries `Access-Control-Allow-Origin: *`, because the
worker asking lives on an onion's origin. `--listen host:port` (or
`WEBTOR_DIRECTORY_LISTEN`) moves it off `127.0.0.1:5180`, and
`--web-root <dir>` (or `WEBTOR_DIRECTORY_WEB_ROOT`) serves a built site beside
the endpoints, falling back to its `index.html` for the paths the site routes
itself:

```bash
bun run serve --listen 0.0.0.0:8080 --web-root dist
```

`bun run test` covers the consensus reading, the store and the endpoints
without touching the network; `bun run typecheck` runs `tsc`.
