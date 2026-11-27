import { describe, expect, it } from 'vitest';
import { gatewayConfig, guestIdentity, isGatewayRequest } from '../../src/web/gateway.js';

const host = 'ragator.example.org';
const secret = 'test-gateway-secret-for-unit-tests';
const gateway = gatewayConfig({ RAGATOR_PUBLIC_URL: 'https://' + host, RAGATOR_GATEWAY_SECRET: secret });
function request(headers: Record<string, string[]> = {}, remoteAddress = '127.0.0.1') {
  const fields = { host: [host], ...headers };
  return { headersDistinct: fields, headers: Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, v.join(', ')])),
    socket: { remoteAddress } };
}

describe('passerelle de recherche', () => {
  const identity = { 'remote-user': ['ami'], 'remote-name': ['ZoÃ©'], 'remote-groups': ['x| ragator-collection-jeux,ragator-collection-jeux|Ragator-collection-secret'],
    'x-ragator-gateway': [secret] };
  it('accepte une seule identité de la passerelle, avec ses groupes exacts', () => {
    expect(guestIdentity(request(identity), gateway)).toEqual({ user: 'ami', label: 'Zoé', keys: new Set(['jeux']) });
    for (const values of [[], ['incorrect'], [secret, secret]]) {
      expect(guestIdentity(request({ ...identity, 'x-ragator-gateway': values }), gateway)).toBeNull();
    }
    expect(guestIdentity(request(identity), { ...gateway, trusted: false })).toBeNull();
    expect(guestIdentity(request(identity), { ...gateway, secret: '' })).toBeNull();
    expect(guestIdentity(request({ ...identity, host: ['localhost'] }), gateway)).toBeNull();
    expect(guestIdentity(request({ ...identity, 'remote-groups': ['ragator-invites'] }), gateway)).toBeNull();
    expect(guestIdentity(request({ ...identity, 'remote-user': [''] }), gateway)).toBeNull();
  });
  it('isole l’hôte public et les requêtes de proxy avant l’accès local', () => {
    for (const headers of [{ host: [host] }, { 'x-forwarded-host': [host] }, { 'cf-ray': ['x'] },
      { 'tailscale-user-login': ['ami'] }, { 'x-ragator-gateway': [''] }, { host: ['x.trycloudflare.com'] },
      { host: ['8.8.8.8'] }, { 'remote-groups': ['admin'] }]) {
      expect(isGatewayRequest(request({ host: ['localhost'], ...headers }), gateway, [])).toBe(true);
    }
    expect(isGatewayRequest(request({ host: ['localhost'] }, '8.8.8.8'), gateway, [])).toBe(true);
    for (const name of ['localhost:3210', '100.64.1.2:3210', 'nas.lan', '[::1]:3210']) {
      expect(isGatewayRequest(request({ host: [name] }, '::ffff:172.18.0.2'), gateway, ['nas.lan'])).toBe(false);
    }
  });
  it('RAGATOR_GATEWAY_PEERS : la machine de la passerelle n’atteint jamais l’administration, et elle seule porte le secret', () => {
    const pinned = gatewayConfig({ RAGATOR_PUBLIC_URL: 'https://' + host, RAGATOR_GATEWAY_SECRET: secret, RAGATOR_GATEWAY_PEERS: '100.64.0.7, fd7a:115c:a1e0::/48' });
    // Sans en-tête, avec un Host privé : c'est le chemin de l'administration pour toute autre machine.
    expect(isGatewayRequest(request({ host: ['100.64.1.2:3210'] }, '100.64.0.8'), pinned, [])).toBe(false);
    for (const peer of ['100.64.0.7', '::ffff:100.64.0.7', 'fd7a:115c:a1e0::12']) {
      expect(isGatewayRequest(request({ host: ['100.64.1.2:3210'] }, peer), pinned, [])).toBe(true);
      expect(guestIdentity(request(identity, peer), pinned)).toMatchObject({ user: 'ami' });
    }
    expect(guestIdentity(request(identity, '100.64.0.8'), pinned)).toBeNull();
    expect(() => gatewayConfig({ RAGATOR_GATEWAY_PEERS: 'vps.example.org' })).toThrow('RAGATOR_GATEWAY_PEERS');
    expect(() => gatewayConfig({ RAGATOR_GATEWAY_PEERS: '100.64.0.7/40' })).toThrow('RAGATOR_GATEWAY_PEERS');
  });
  it('nettoie le nom affiché et refuse un compte vide après nettoyage', () => {
    // Node lit les octets d'un en-tête en latin1 : c'est sous cette forme qu'un nom UTF-8 arrive.
    const wire = (text: string) => Buffer.from(text, 'utf8').toString('latin1');
    expect(guestIdentity(request({ ...identity, 'remote-name': [wire(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(7)}c`)] }), gateway)?.label).toBe('abc');
    expect(guestIdentity(request({ ...identity, 'remote-user': [wire(String.fromCharCode(0x200b))] }), gateway)).toBeNull();
  });
  it('préserve les installations utilisant déjà un proxy lorsque la passerelle est désactivée', () => {
    const disabled = gatewayConfig({});
    expect(isGatewayRequest(request({ 'cf-ray': ['x'], 'remote-user': ['ami'] }), disabled, [])).toBe(false);
    expect(isGatewayRequest(request({ 'x-ragator-gateway': ['invalid'] }), disabled, [])).toBe(true);
  });
});
