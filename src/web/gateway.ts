import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';

const privateNet = new BlockList();
for (const [network, bits] of [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['169.254.0.0', 16]] as const) {
  privateNet.addSubnet(network, bits);
}
privateNet.addAddress('::1', 'ipv6');
privateNet.addSubnet('fc00::', 7, 'ipv6');
privateNet.addSubnet('fe80::', 10, 'ipv6');

function privateAddress(address: string) {
  const ip = address.replace(/^\[|\]$/g, '');
  return isIP(ip) !== 0 && privateNet.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

export function gatewayConfig(env: NodeJS.ProcessEnv) {
  const url = env.RAGATOR_PUBLIC_URL ? new URL(env.RAGATOR_PUBLIC_URL) : null;
  if (url && (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
    !url.hostname.includes('.') || /\.(localhost|local|lan|internal|test)$/.test(url.hostname) || privateAddress(url.hostname))) {
    throw new Error('RAGATOR_PUBLIC_URL doit être une origine HTTPS publique.');
  }
  const secret = env.RAGATOR_GATEWAY_SECRET ?? '';
  if (secret && !/^[!-~]{24,}$/.test(secret)) throw new Error('RAGATOR_GATEWAY_SECRET doit contenir au moins 24 caractères ASCII imprimables sans espace.');
  return { origin: url?.origin, host: url?.host, secret, trusted: (env.RAGATOR_GATEWAY_TRUST ?? '1') === '1' };
}

type Gateway = ReturnType<typeof gatewayConfig>;
const marker = 'x-ragator-gateway';
export const groupPrefix = 'ragator-collection-';

/** La passerelle ne peut jamais emprunter le chemin HTTP Basic, même avec le bon mot de passe. */
export function isGatewayRequest(req: Pick<IncomingMessage, 'headers'> & { socket: Pick<IncomingMessage['socket'], 'remoteAddress'> }, gateway: Gateway, internalHosts: readonly string[]) {
  const h = req.headers;
  if (h[marker] !== undefined) return true;
  if (!gateway.host) return false;
  if (Object.keys(h).some(k => /^(remote-|x-authentik-|cf-|tailscale-)/.test(k))) return true;
  const privateHost = (authority: string) => {
    if (!/^(?:[\w.-]+|\[[\da-f:]+\])(?::\d+)?$/i.test(authority)) return false;
    const host = authority.toLowerCase().replace(/:\d+$/, '');
    if (host === gateway.host!.replace(/:\d+$/, '') || /\.(trycloudflare\.com|ngrok[^.]*\.(?:app|io)|loca\.lt)$/.test(host)) return false;
    if (isIP(host.replace(/^\[|\]$/g, ''))) return privateAddress(host);
    return host === 'localhost' || internalHosts.includes(host) || internalHosts.includes(authority.toLowerCase());
  };
  const forwardedHost = h['x-forwarded-host'];
  return !privateAddress(req.socket.remoteAddress ?? '') || !privateHost(h.host ?? '') ||
    h.forwarded !== undefined || (forwardedHost !== undefined && (typeof forwardedHost !== 'string' || !privateHost(forwardedHost)));
}

const digest = (value: string) => createHash('sha256').update(value).digest();
let lastWarning = -Infinity;
export function guestIdentity(req: Pick<IncomingMessage, 'headers' | 'headersDistinct'>, gateway: Gateway) {
  const headers = req.headersDistinct;
  const values = headers[marker] ?? [];
  if (!values.length) return null;
  if (values.length !== 1 || !gateway.secret || !timingSafeEqual(digest(values[0]!), digest(gateway.secret))) {
    if (Date.now() - lastWarning > 60_000) {
      console.warn('Ragator : secret de passerelle invalide.');
      lastWarning = Date.now();
    }
    return null;
  }
  if (!gateway.trusted || !gateway.host || req.headers.host?.toLowerCase() !== gateway.host) return null;
  const user = headers['remote-user'];
  const groups = headers['remote-groups'];
  if (user?.length !== 1 || !user[0]?.trim() || groups?.length !== 1) return null;
  const keys = new Set(groups[0]!.split(/[,|]/).slice(0, 200).map(s => s.trim())
    .filter(s => s.length <= 200 && s.startsWith(groupPrefix)).map(s => s.slice(groupPrefix.length))
    .filter(s => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)));
  if (!keys.size) return null;
  const raw = headers['remote-name']?.[0]?.trim() || user[0];
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  const label = (utf8.includes('\uFFFD') ? raw : utf8).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 60);
  return { label, keys };
}
