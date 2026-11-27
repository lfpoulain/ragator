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

/** Adresse nue : sans crochets, et en IPv4 quand le système la présente en IPv6 (`::ffff:100.64.0.7`). */
function bareAddress(address: string): string {
  return address.replace(/^\[|\]$/g, '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
}

function inList(list: BlockList, address: string): boolean {
  const ip = bareAddress(address);
  return isIP(ip) !== 0 && list.check(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
}

const privateAddress = (address: string) => inList(privateNet, address);

/** `RAGATOR_GATEWAY_PEERS` : adresses ou plages CIDR d'où la passerelle se connecte (son adresse Tailscale). */
function peerList(value: string | undefined): BlockList | null {
  const entries = (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (!entries.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : isIP(address) === 4 ? 'ipv4' : null;
    const prefix = bits === undefined ? null : Number(bits);
    if (!family || (prefix !== null && (!/^\d{1,3}$/.test(bits!) || prefix > (family === 'ipv4' ? 32 : 128)))) {
      throw new Error('RAGATOR_GATEWAY_PEERS attend des adresses IP ou des plages CIDR séparées par des virgules.');
    }
    if (prefix === null) list.addAddress(address, family);
    else list.addSubnet(address, prefix, family);
  }
  return list;
}

export function gatewayConfig(env: NodeJS.ProcessEnv) {
  const url = env.RAGATOR_PUBLIC_URL ? new URL(env.RAGATOR_PUBLIC_URL) : null;
  if (url && (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password ||
    !url.hostname.includes('.') || /\.(localhost|local|lan|internal|test)$/.test(url.hostname) || privateAddress(url.hostname))) {
    throw new Error('RAGATOR_PUBLIC_URL doit être une origine HTTPS publique.');
  }
  const secret = env.RAGATOR_GATEWAY_SECRET ?? '';
  if (secret && !/^[!-~]{24,}$/.test(secret)) throw new Error('RAGATOR_GATEWAY_SECRET doit contenir au moins 24 caractères ASCII imprimables sans espace.');
  return { origin: url?.origin, host: url?.host, secret, trusted: (env.RAGATOR_GATEWAY_TRUST ?? '1') === '1', peers: peerList(env.RAGATOR_GATEWAY_PEERS) };
}

type Gateway = ReturnType<typeof gatewayConfig>;
type Peer = { socket: Pick<IncomingMessage['socket'], 'remoteAddress'> };
const marker = 'x-ragator-gateway';
export const groupPrefix = 'ragator-collection-';

/**
 * La passerelle ne peut jamais emprunter le chemin HTTP Basic, même avec le bon mot de passe.
 * Avec `RAGATOR_GATEWAY_PEERS`, cela vaut pour toute requête venue de la machine de la passerelle,
 * en-tête ou non : un VPS compromis n'atteint ni l'administration ni son mot de passe.
 */
export function isGatewayRequest(req: Pick<IncomingMessage, 'headers'> & Peer, gateway: Gateway, internalHosts: readonly string[]) {
  const h = req.headers;
  if (h[marker] !== undefined) return true;
  if (gateway.peers && inList(gateway.peers, req.socket.remoteAddress ?? '')) return true;
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
function warn(message: string) {
  if (Date.now() - lastWarning < 60_000) return;
  console.warn(message);
  lastWarning = Date.now();
}

/** Texte d'en-tête affichable : UTF-8 relu (Node le lit en latin1), sans caractère de contrôle ni de format. */
function headerText(raw: string, max: number): string {
  const utf8 = Buffer.from(raw, 'latin1').toString('utf8');
  return [...(utf8.includes('�') ? raw : utf8).replace(/[\p{Cc}\p{Cf}]/gu, '').trim()].slice(0, max).join('');
}

export interface GuestIdentity {
  /** Compte authentik (`Remote-User`) : clé des quotas et du journal, jamais affichée. */
  user: string;
  /** Nom affiché (`Remote-Name`, sinon le compte). */
  label: string;
  /** Clés des collections autorisées (groupes `ragator-collection-<clé>`). */
  keys: Set<string>;
}

export function guestIdentity(req: Pick<IncomingMessage, 'headers' | 'headersDistinct'> & Partial<Peer>, gateway: Gateway): GuestIdentity | null {
  const headers = req.headersDistinct;
  const values = headers[marker] ?? [];
  if (!values.length) return null;
  if (values.length !== 1 || !gateway.secret || !timingSafeEqual(digest(values[0]!), digest(gateway.secret))) {
    warn('Ragator : secret de passerelle invalide.');
    return null;
  }
  // Un secret volé ne sert à rien depuis une autre machine que la passerelle.
  if (gateway.peers && !inList(gateway.peers, req.socket?.remoteAddress ?? '')) {
    warn('Ragator : secret de passerelle présenté depuis une adresse hors de RAGATOR_GATEWAY_PEERS.');
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
  const account = headerText(user[0], 200);
  if (!account) return null;
  const label = headerText(headers['remote-name']?.[0]?.trim() || user[0], 60) || account.slice(0, 60);
  return { user: account, label, keys };
}

/** Adresse du pair telle que Ragator la voit, pour régler `RAGATOR_GATEWAY_PEERS` (affichée dans Réglages). */
export function peerAddress(req: Peer): string {
  return bareAddress(req.socket.remoteAddress ?? '');
}
