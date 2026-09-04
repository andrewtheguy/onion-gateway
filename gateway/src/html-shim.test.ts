import { describe, expect, it } from 'bun:test';
import { insertionOffset, scriptNonce, shimTag, WEBSOCKET_SHIM_PATH, withShim } from './html-shim';

const TAG = shimTag(null);

function inject(html: string): string {
  return new TextDecoder().decode(withShim(new TextEncoder().encode(html), TAG));
}

describe('insertionOffset', () => {
  it('goes just inside <head>, whatever its case and attributes', () => {
    const html = '<!DOCTYPE html>\n<html lang="en">\n<HEAD lang="en"><meta charset="utf-8">';
    const offset = insertionOffset(html);
    expect(html.slice(offset)).toBe('<meta charset="utf-8">');
  });

  it('does not mistake <header> for <head>', () => {
    const html = '<html><body><header>x</header></body></html>';
    expect(html.slice(insertionOffset(html))).toBe('<body><header>x</header></body></html>');
  });

  it('goes inside <html> when there is no head', () => {
    const html = '<!doctype html><html><body>hi</body></html>';
    expect(html.slice(insertionOffset(html))).toBe('<body>hi</body></html>');
  });

  it('goes after the doctype when there is neither', () => {
    const html = '<!doctype html>\n<p>hi</p>';
    expect(html.slice(insertionOffset(html))).toBe('\n<p>hi</p>');
  });

  it('goes first when the document has none of them', () => {
    expect(insertionOffset('<p>hi</p>')).toBe(0);
    expect(insertionOffset('')).toBe(0);
  });
});

describe('withShim', () => {
  it('splices the tag in without touching the rest of the bytes', () => {
    expect(inject('<html><head></head><body>é</body></html>')).toBe(
      `<html><head>${TAG}</head><body>é</body></html>`,
    );
  });

  it('keeps offsets right through non-ASCII bytes before the head', () => {
    const html = '<!-- ünïcödé -->\n<html><head><title>t</title></head></html>';
    expect(inject(html)).toBe(html.replace('<head>', `<head>${TAG}`));
  });

  it('names the reserved path', () => {
    expect(TAG).toBe(`<script src="${WEBSOCKET_SHIM_PATH}"></script>`);
  });
});

describe('scriptNonce', () => {
  it('is null without a policy or without a nonce in it', () => {
    expect(scriptNonce(null)).toBeNull();
    expect(scriptNonce("default-src 'self'; script-src 'self' https://cdn.example")).toBeNull();
  });

  it('reads the nonce the script sources require', () => {
    expect(scriptNonce("default-src 'none'; script-src 'nonce-abc123+/=' 'strict-dynamic'")).toBe('abc123+/=');
  });

  it('prefers script-src-elem, then script-src, then default-src', () => {
    expect(scriptNonce("script-src 'nonce-a'; script-src-elem 'nonce-b'")).toBe('b');
    expect(scriptNonce("default-src 'nonce-d'; script-src 'nonce-s'")).toBe('s');
    expect(scriptNonce("default-src 'nonce-d'")).toBe('d');
  });

  it('puts the nonce on the tag', () => {
    expect(shimTag('xyz')).toBe(`<script src="${WEBSOCKET_SHIM_PATH}" nonce="xyz"></script>`);
  });
});
