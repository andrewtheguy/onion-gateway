# onion-gateway

Three projects that together let a browser reach plain-HTTP onion sites with
no Tor daemon or proxy. Each is a self-contained codebase; at run time the
gateway is paired with one of the directory servers, or any backend that
answers the same URLs, for the Tor directory it bootstraps from:

- [`gateway`](gateway) — the front end: a Vite/React app whose service worker,
  one per onion origin, runs the [`webtor-rs`](https://github.com/andrewtheguy/webtor-rs)
  Tor client compiled to WASM. It needs a fresh Tor directory from a backend,
  and asks for it over two plain-HTTP URLs its README documents under *The
  directory endpoints*; any backend that answers them plugs in.
- [`directory-server`](directory-server) — the reference implementation of
  that backend, in Rust: builds a seed from a directory authority, verifies
  it with Arti's document crates, refreshes it as each hourly consensus is
  published, and serves it. Its README is where the server side of the
  contract is written down.
- [`directory-server-ts`](directory-server-ts) — the same contract in
  TypeScript on Bun, in two shapes. A server that answers the two URLs from
  a seed a script builds when you run it, with no refresh loop and no native
  Tor document verification, which the reference server has and the gateway
  does not need of a backend; and a publisher that lays the seed out as a
  static site and uploads it to Cloudflare Workers, where serving it is free
  without billing, so the hourly build is the only thing you run.
- [`e2e`](e2e) — the gateway end to end: headless Chrome opens a sample
  onion site, published as an onion service from a container in that
  directory, through the gateway, and checks static content, dynamic
  content, a WebSocket, cookie auth and a sign-in for a cookie-gated
  WebSocket, phase by phase. `e2e/run.sh` brings the whole rig up.

Each project directory is self-contained: its own manifest, lock file and
tests, and nothing in one is imported by another; `e2e` is the one directory
that spans them, since it runs the gateway against the reference server. The gateway installs the Tor client
from a release tarball its `package.json` pins, and the servers build seeds
from the directory authorities directly. The READMEs link across only to
name which project plays which part.

Both commands run from the repository root, each in a terminal of its own,
since `serve` keeps running:

```bash
# terminal 1: a backend on 127.0.0.1:5180
cd directory-server && cargo run -- serve
```

```bash
# terminal 2: the front end on http://intor.localhost:5173/
cd gateway && bun install && bun run dev
```
