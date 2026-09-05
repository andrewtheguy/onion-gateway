# directory-server-ts

The directory contract in TypeScript on Bun, in two shapes. [`directory-server`](../directory-server)
is the reference implementation and its README documents the two URLs; the
server here answers them the same way and stops there. What the reference
server does beyond the contract — rebuilding on its own as each consensus is
published, and checking every signature with the same Tor document library
the client is built on — is deliberately not here: a script builds the seed
when you run it, checks only that the documents have the right shape, and the
server reads whatever the script last wrote. The second shape is a publisher:
the same build, laid out as a static site and uploaded to Cloudflare Workers,
where serving it is free without billing enabled, so the hourly build is the
only thing that runs on a machine of yours; see
[Publish it as a static site](#publish-it-as-a-static-site). Start from the
reference server for a server of your own; start from here to see the
minimum a backend must answer, or to host the directory without one.

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

## Publish it as a static site

`bun run tor:publish` builds a seed the same way and, instead of a store for
`serve`, lays out a static site and uploads it to Cloudflare Workers with
`wrangler deploy`. Serving static assets from a Worker is free without billing
enabled and the requests are not counted, so the only thing that has to run
somewhere is the hourly build, on any machine with Bun and a way to sign in:

```bash
bunx wrangler login                   # once, on a machine of yours: a browser sign-in, kept under ~/.wrangler
bun run tor:publish                   # about a minute; then https://webtor-directory.<account>.workers.dev
bun run tor:publish --no-deploy       # lay out ./site and stop
```

On a server with no browser, sign in with a token instead: copy
`.env.example` to `.env`, which git ignores, and fill in the account ID and a
token with the Workers Scripts:Edit permission. Bun loads `.env` from the
directory it is started in, and the wrangler it spawns inherits it, so the
token is in neither the command line nor the shell history; the cron line is
just `cd .../directory-server-ts && bun run tor:publish`, once an hour a few
minutes past the hour, as with `tor:directory`. `wrangler.toml` names the
Worker; `--site` (or `WEBTOR_DIRECTORY_SITE`) moves the directory it lays
out. Only files whose bytes changed are uploaded, so an hourly deploy moves
one seed.

The site differs from what the servers answer in two ways a static host
forces, both of which the client's manifest handling already allows for:

```
GET /api/directory.json               the manifest; Cache-Control: no-cache
GET /api/directory/<name>.json.gz     the seed, gzipped; public, max-age=31536000, immutable
```

- **The manifest is at `/api/directory.json`**, not `/api/directory`, since a
  static host cannot have a file and a directory of one name. The client is
  pointed at it with `VITE_DIRECTORY_URL`; the manifest's `url` is an absolute
  path, as before.
- **Only the gzipped seed is published**, as `<name>.json.gz` with
  `Content-Type: application/gzip`, because a static asset is capped at
  25 MiB and a seed is some forty megabytes; gzip roughly halves it, and
  `tor:publish` refuses to deploy one over the cap. A client inflates the
  bytes it fetches. Both URLs answer `Access-Control-Allow-Origin: *` from
  the site's `_headers` file, whose two rules match disjoint paths because
  the host joins the values of a header set by every matching rule.

The seed the previous manifest named stays in the site for one more publish,
as in the store.

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

`bun run test` covers the consensus reading, the store, the site layout and the endpoints
without touching the network; `bun run typecheck` runs `tsc`.
