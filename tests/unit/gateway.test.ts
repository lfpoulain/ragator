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
    expect(guestIdentity(request(identity), gateway)).toEqual({ label: 'Zoé', keys: new Set(['jeux']) });
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
  it('préserve les installations utilisant déjà un proxy lorsque la passerelle est désactivée', () => {
    const disabled = gatewayConfig({});
    expect(isGatewayRequest(request({ 'cf-ray': ['x'], 'remote-user': ['ami'] }), disabled, [])).toBe(false);
    expect(isGatewayRequest(request({ 'x-ragator-gateway': ['invalid'] }), disabled, [])).toBe(true);
  });
});
