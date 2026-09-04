// Putting the WebSocket shim (websocket-shim.js) into an HTML document the
// onion sent, before anything of the document's own runs.
//
// The document is handled as bytes: it is in whatever encoding the onion
// chose, and a `<script>` tag is ASCII, which every encoding a web page comes
// in agrees on, so nothing is decoded and re-encoded on the way through. The
// bytes are read as Latin-1 only to search them, since that maps each byte
// to one character and keeps every offset.

/** Where the worker serves the shim on every onion origin; no site may use the path. */
export const WEBSOCKET_SHIM_PATH = '/.webtor-onion-gateway/websocket.js';

const latin1 = new TextDecoder('latin1');
const ascii = new TextEncoder();

/**
 * Where the shim goes: just inside `<head>`, or `<html>` when there is no
 * head, or after the doctype, or at the very start. A classic script there
 * runs before the parser reaches anything else, so the page's own scripts
 * find the replacement in place.
 */
const OPENERS = [/<head(?=[\s/>])/i, /<html(?=[\s/>])/i, /<!doctype(?=\s)/i];

export function insertionOffset(html: string): number {
  for (const opener of OPENERS) {
    const match = opener.exec(html);
    if (match === null) continue;
    const end = html.indexOf('>', match.index);
    return end === -1 ? 0 : end + 1;
  }
  return 0;
}

/**
 * The nonce a page's `Content-Security-Policy` requires of scripts, or `null`
 * when it requires none. A policy of `script-src 'self'` allows the shim as
 * it is served, from the page's own origin; one of `'nonce-…'` only, as
 * strict policies say, needs the nonce on the tag.
 */
export function scriptNonce(policy: string | null): string | null {
  if (policy === null) return null;
  const directives = new Map<string, string>();
  for (const directive of policy.split(/[;,]/)) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources.join(' '));
  }
  const sources =
    directives.get('script-src-elem') ?? directives.get('script-src') ?? directives.get('default-src');
  const match = sources === undefined ? null : /'nonce-([A-Za-z0-9+/_=-]+)'/.exec(sources);
  return match ? match[1] : null;
}

/** The tag that loads the shim, with the nonce the page's policy wants on it. */
export function shimTag(nonce: string | null): string {
  const attribute = nonce === null ? '' : ` nonce="${nonce}"`;
  return `<script src="${WEBSOCKET_SHIM_PATH}"${attribute}></script>`;
}

/** `html` with `tag` at `insertionOffset`. */
export function withShim(html: Uint8Array, tag: string): Uint8Array {
  const offset = insertionOffset(latin1.decode(html));
  const inserted = ascii.encode(tag);
  const out = new Uint8Array(html.byteLength + inserted.byteLength);
  out.set(html.subarray(0, offset), 0);
  out.set(inserted, offset);
  out.set(html.subarray(offset), offset + inserted.byteLength);
  return out;
}
