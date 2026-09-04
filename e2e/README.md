# e2e

The gateway end to end: headless Chrome opens an onion site through the
service worker, over Tor, and checks what arrives. The site is one of this
directory's own, published as an onion service by a container here, so the
run needs no site on the public Tor network and can be told what to expect.
This is the one directory in the repository that spans the others: it
starts the gateway's dev server from [`gateway`](../gateway) and, unless a
backend is named, the reference [`directory-server`](../directory-server).

```bash
e2e/run.sh                 # containers up, backend up, five phases, teardown
e2e/run.sh -t 'phase 1'    # arguments go to bun test
```

`run.sh` needs docker or podman, Bun, cargo (for the directory server) and a
Chrome. It builds the sample onion's image on first use, starts the
container, starts a directory server on `127.0.0.1:5180` unless one already
answers there or `DIRECTORY_BACKEND` names one, waits for its first seed,
installs the gateway's and this directory's dependencies, and runs the suite.
On the way out it stops the container it started, unless `KEEP_ONION=1`, and
the backend it started.

The pieces run separately too, which is how to iterate on one phase:

```bash
onion/onion.sh start && eval "$(onion/onion.sh env)"   # prints SAMPLE_ONION
(cd ../directory-server && cargo run --release -- serve)      # another terminal
bun install && bun run test:e2e
```

`bun run test` runs the site's handler in process, without a socket, and is
what to run while changing `onion/server.ts`; `bun run typecheck` covers
both files.

## The five phases

Each phase builds on the one before, in one browser page against one
gateway origin, `http://<address>.onion.intor.localhost:<port>`:

1. **Static content.** The install page registers the worker, the bootstrap
   page follows the Tor client up, and the site's page arrives. Its style
   sheet applies, its script runs, its image has a size, a text file and a
   gzip-encoded one read back as written, a megabyte of fixed bytes hashes
   right, and a `404` reaches the page as a `404`.
2. **Dynamic content.** A form `POST` is answered with a page and the URL
   moves with it. A script's `PUT` arrives with its headers and body, and
   with `Host`, `Origin` and `Referer` in the onion's terms; a `POST` with a
   binary body arrives intact, checked by hash; a `DELETE` arrives bodiless.
3. **WebSocket.** The page opens `ws://<its own host>/ws/echo`, the way a
   site's script would, and expects the greeting and its own text and bytes
   echoed back.
4. **Cookie auth.** A counter cookie the page sets comes back on the next
   load. A gated page and a JSON endpoint answer `401` to a visitor. The
   wrong password on the sign-in page is refused; the right username and
   password are answered with a `303` and an `HttpOnly` session cookie, and
   the gated page and endpoint open. The page's `document.cookie` stays
   empty, since the jar is the worker's, while `/echo` shows the session
   going out. Signing out shuts them again.
5. **Sign-in for a gated WebSocket.** `ws://<its own host>/ws/private` is
   refused while signed out. The username and password submitted on the
   sign-in page open it, and it greets by name and echoes with the name on
   the front. Signing out closes it again.

The two WebSocket phases exercise the shim the gateway puts in every page
it serves: `new WebSocket()` there is the replacement, and what the page
sees came over a `MessageChannel` from the worker's socket on the onion. The
gated one proves the upgrade carried the session cookie and that a `401` on
the handshake reaches the page as a close rather than a hang.

## Environment

| Variable | Meaning |
| --- | --- |
| `SAMPLE_ONION` | `http://<address>.onion`, what `onion/onion.sh env` prints. `run.sh` sets it. |
| `DIRECTORY_BACKEND` | The directory backend to proxy `/api` to, as a port or an origin. `127.0.0.1:5180` without one. It has to be serving a seed already. |
| `DIRECTORY_PORT` | Where `run.sh` starts a directory server when `DIRECTORY_BACKEND` is not set; `5180`. |
| `BRIDGE_URL`, `BRIDGE_FINGERPRINT` | A Snowflake bridge instead of the public one, both or neither; `scripts/local-bridge/bridge.sh env` in `webtor-rs` prints them. The bootstrap is seeded either way, so the bridge only has to carry the first hop. |
| `CHROME_PATH` | The Chrome-family binary. Without it the usual places on Linux and macOS are tried. |
| `CONTAINER_ENGINE` | `docker` or `podman`; otherwise the first that answers `info`. |
| `KEEP_ONION` | Set to leave the container `run.sh` started running for the next run. |

## The sample onion

`onion/` is the container: a tor client publishing one onion service, and
behind it the site in `server.ts`, on the container's loopback. Nothing is
published on the host; the site is reached over Tor or not at all. The
address is new on every start, since the container runs with `--rm` and no
volume, so read it from `onion.sh env` each time. An address is not yet a
reachable service: its tor has to bootstrap, which `onion.sh status`
reports, and then publish the descriptor, which takes a while longer; the
suite retries its first page for up to four minutes for that reason, and in
practice the site answers within a minute or two of `start`.

```bash
onion/onion.sh start      # builds the image if it is missing
onion/onion.sh status
onion/onion.sh logs       # follow, ctrl-c to detach
onion/onion.sh stop
```

To look at the site without Tor: `PORT=8000 bun onion/server.ts`.

| Request | Answer |
| --- | --- |
| `GET /` | The page: a style sheet, a script and an image under `/static/`, `#visits` counting this visitor's loads from a `visits` cookie, `#who` saying who the session names, a note form and a sign-out form. |
| `GET /static/…` | `site.css`, `app.js`, `pixel.png`, `hello.txt`, `compressed.txt` (gzip to a request that accepts it) and `blob.bin` (1 MiB of seeded bytes). Exported as `STATIC` so the suite knows the bytes. |
| `POST /notes` | `text` from a form body, shown on a page. Refused with `403` unless `Origin` is `http://<Host>`, the check a real site makes. |
| `/echo` | Any method. JSON with the method, path, query, every request header, the parsed cookies, the body as text and its length and SHA-256. |
| `GET /login` | The sign-in form, username and password; `?error` adds `#error`. |
| `POST /login` | The same `Origin` check. `alice` and `wonderland` are answered `303` to `/private` with `session=<token>; Path=/; HttpOnly`; anything else `303` to `/login?error`. |
| `POST /logout` | The same check; `303` to `/` with the session lapsed and the token forgotten. |
| `GET /private`, `GET /api/me` | `401` without a live session; a page and `{"user": …}` with one. |
| `GET /ws/echo` | A WebSocket for anyone: says `welcome`, then echoes every text and binary message. |
| `GET /ws/private` | `401` without a live session; with one, a WebSocket that says `welcome alice` and echoes text as `alice: …`, bytes as they came. |
| anything else | `404`. |

Neither a site anyone should visit nor a tor anyone should copy: it keeps
no key, has no SocksPort and runs for as long as a test takes.
