# onion-gateway

Three projects that together let a browser reach plain-HTTP onion sites with
no Tor daemon or proxy, each usable on its own:

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
- [`directory-server-ts`](directory-server-ts) — a sample, in TypeScript on
  Bun, showing the same contract answered from another language and nothing
  more: no refresh loop and no native Tor document verification, which the
  reference server has and the gateway does not need of a backend. The seed
  is built by a script you run yourself.

Each directory is self-contained: its own manifest, lock file and tests, and
nothing in one is imported by another. The gateway installs the Tor client
from a release tarball its `package.json` pins, and the servers build seeds
from the directory authorities directly. The READMEs link across only to
name which project plays which part.

```bash
cd directory-server && cargo run -- serve   # a backend on 127.0.0.1:5180
cd gateway && bun install && bun run dev    # the front end on http://intor.localhost:5173/
```
