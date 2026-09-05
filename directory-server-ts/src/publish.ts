#!/usr/bin/env bun
// Build a directory seed and publish it as a static site on Cloudflare
// Workers, where serving files costs nothing and needs no billing enabled.
//
//   bun run tor:publish                 # build into ./site, then `wrangler deploy`
//   bun run tor:publish --no-deploy     # build the site and stop
//   bun run tor:publish --site /srv/tor-site
//
// The deploy authenticates the way wrangler does: `wrangler login` on a
// machine of yours, or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN on a
// server. Bun loads those from a `.env` beside `package.json` when run from
// there, and the spawned wrangler inherits them, so the token is never on a
// command line. `wrangler.toml` names the Worker and the site directory. Run
// this hourly, a few minutes past the hour, from cron.

import path from 'node:path';
import { parseArgs } from 'node:util';
import { Authorities, DEFAULT_AUTHORITIES } from './authority.ts';
import { withSiteLock, writeSite } from './site.ts';

/** The host caps a static asset at 25 MiB. */
const ASSET_LIMIT = 25 * 1024 * 1024;
const PROJECT = path.join(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    site: { type: 'string', default: process.env.WEBTOR_DIRECTORY_SITE ?? path.join(PROJECT, 'site') },
    'no-deploy': { type: 'boolean', default: false },
    authority: { type: 'string', multiple: true },
  },
});

const authorities = new Authorities(values.authority?.length ? values.authority : DEFAULT_AUTHORITIES);
const started = performance.now();
const seed = await authorities.buildSeed(console.log);
const site = path.resolve(values.site);
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

// Laid out and deployed under one lock, so that a publish running long
// cannot deploy over one that started after it.
await withSiteLock(site, async () => {
  const { manifest, gzipBytes } = await writeSite(site, seed);
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  console.log(
    `Laid out ${seed.name} (${mib(manifest.bytes)} MiB, ${mib(gzipBytes)} MiB gzipped, ${manifest.relays} relays) in ${site} in ${seconds}s; rebuild before ${manifest.validUntil}`,
  );
  if (gzipBytes > ASSET_LIMIT) {
    throw new Error(`the gzipped seed is ${gzipBytes} bytes, over the ${ASSET_LIMIT}-byte asset limit`);
  }
  if (values['no-deploy']) return;

  const deploy = Bun.spawn(['bunx', 'wrangler', 'deploy', '--assets', site], {
    cwd: PROJECT,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  const status = await deploy.exited;
  if (status !== 0) throw new Error(`wrangler deploy exited with ${status}`);
});
