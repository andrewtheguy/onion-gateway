# onion-gateway

Browse plain-HTTP onion sites from a browser, with no Tor daemon or proxy:
a service worker per onion origin runs the [`webtor-rs`](../webtor-rs) Tor
client compiled to WASM, and a small backend keeps it supplied with a fresh
Tor directory.

- [`gateway`](gateway) — the Vite/React app and its service worker. Its README
  explains how a request travels and what the gateway does and does not
  forward.
- [`directory-server`](directory-server) — the directory backend in Rust:
  builds a seed from a directory authority, refreshes it as each hourly
  consensus is published, and serves it, optionally with the built gateway
  in front. Its `snapshot` subcommand writes one seed to a file.
- [`directory-server-ts`](directory-server-ts) — the same two endpoints from
  TypeScript on Bun, with the seed built by a script you run yourself.

Both backends answer the contract the gateway's README documents under *The
directory endpoints*; any server that answers those two URLs serves the
gateway.

## Layout

The `webtor-rs` checkout is expected beside this repository: the gateway
installs `@andrewtheguy/webtor-wasm` from `../webtor-rs/crates/webtor-wasm/pkg`
(build it there with `bun run build` first), and `directory-server` depends on
`webtor-core` by path. The Cargo workspace here holds `directory-server`
alone, so `cargo clippy` and `cargo test` at the root cover the Rust half.

```bash
(cd ../webtor-rs && bun run build)   # the WASM package the gateway installs
cd gateway && bun install && bun run dev
bun run backend                      # in a second terminal: cargo run -p webtor-directory-server -- serve
```
