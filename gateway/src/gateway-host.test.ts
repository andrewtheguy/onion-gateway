import { describe, expect, it } from 'bun:test';
import { gatewayHosts, parseOnionInput, subdomainForm } from './gateway-host';

const ADDRESS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ONION = `${ADDRESS}.onion`;

describe('the subdomain form', () => {
  it('keeps the .onion label unless VITE_BARE_ONION_SUBDOMAIN is true', () => {
    expect(subdomainForm(undefined)).toBe('address.onion');
    expect(subdomainForm('')).toBe('address.onion');
    expect(subdomainForm('false')).toBe('address.onion');
    expect(subdomainForm('true')).toBe('address');
  });

  it('refuses any other value', () => {
    expect(() => subdomainForm('yes')).toThrow('VITE_BARE_ONION_SUBDOMAIN');
    expect(() => subdomainForm('1')).toThrow('VITE_BARE_ONION_SUBDOMAIN');
  });
});

describe('hostnames with the .onion label', () => {
  const hosts = gatewayHosts('address.onion');

  it('take <address>.onion.<root> apart', () => {
    expect(hosts.parse(`${ONION}.intor.localhost`)).toEqual({ onion: ONION, root: 'intor.localhost' });
    expect(hosts.parse(`${ONION.toUpperCase()}.Intor.Localhost`)).toEqual({
      onion: ONION,
      root: 'intor.localhost',
    });
  });

  it('answer nothing else', () => {
    expect(hosts.parse('intor.localhost')).toBeNull();
    expect(hosts.parse(`${ADDRESS}.intor.localhost`)).toBeNull();
    expect(hosts.parse(ONION)).toBeNull();
    expect(hosts.parse(`${ADDRESS.slice(1)}.onion.intor.localhost`)).toBeNull();
  });

  it('build <address>.onion.<root> URLs', () => {
    expect(hosts.url(ONION, 'intor.localhost:5173')).toBe(`http://${ONION}.intor.localhost:5173/`);
    expect(hosts.url(ONION, 'intor.localhost:5173', '/a/b?c=d#e')).toBe(
      `http://${ONION}.intor.localhost:5173/a/b?c=d#e`,
    );
  });
});

describe('hostnames without the .onion label', () => {
  const hosts = gatewayHosts('address');

  it('take <address>.<root> apart, naming the onion in full', () => {
    expect(hosts.parse(`${ADDRESS}.intor.localhost`)).toEqual({ onion: ONION, root: 'intor.localhost' });
    expect(hosts.parse(`${ADDRESS.toUpperCase()}.gateway.example`)).toEqual({
      onion: ONION,
      root: 'gateway.example',
    });
  });

  it('answer nothing else', () => {
    expect(hosts.parse('intor.localhost')).toBeNull();
    expect(hosts.parse(ADDRESS)).toBeNull();
    expect(hosts.parse(`${ADDRESS.slice(1)}.intor.localhost`)).toBeNull();
  });

  it('build <address>.<root> URLs', () => {
    expect(hosts.url(ONION, 'intor.localhost:5173')).toBe(`http://${ADDRESS}.intor.localhost:5173/`);
    expect(hosts.url(ONION, 'gateway.example', '/a?b')).toBe(`http://${ADDRESS}.gateway.example/a?b`);
    expect(hosts.url('<address>.onion', 'gateway.example')).toBe('http://<address>.gateway.example/');
  });

  it('round-trip', () => {
    const url = new URL(hosts.url(ONION, 'gateway.example', '/path'));
    expect(hosts.parse(url.hostname)).toEqual({ onion: ONION, root: 'gateway.example' });
  });
});

describe('a pasted onion address', () => {
  it('is taken bare, with .onion, or as a URL', () => {
    expect(parseOnionInput(ADDRESS)).toEqual({ onion: ONION, pathAndQuery: '/' });
    expect(parseOnionInput(` ${ONION}/x?y#z `)).toEqual({ onion: ONION, pathAndQuery: '/x?y#z' });
    expect(parseOnionInput(`http://${ONION}:80/x`)).toEqual({ onion: ONION, pathAndQuery: '/x' });
  });

  it('is refused when it is not a plain-HTTP onion on port 80', () => {
    expect(parseOnionInput('')).toBeNull();
    expect(parseOnionInput('example.com')).toBeNull();
    expect(parseOnionInput(`https://${ONION}/`)).toBeNull();
    expect(parseOnionInput(`http://${ONION}:8080/`)).toBeNull();
    expect(parseOnionInput(`http://u:p@${ONION}/`)).toBeNull();
  });
});
