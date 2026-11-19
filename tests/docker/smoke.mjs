import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Usage : node tests/docker/smoke.mjs ragator:smoke (image déjà construite).
const image = process.argv[2];
assert(image, 'Indiquer le tag local de l’image Ragator à vérifier.');
const project = 'ragator-smoke-' + randomBytes(6).toString('hex');
const local = project + '-local';
const remote = project + '-remote';
const password = randomBytes(32).toString('hex');
const workspace = mkdtempSync(join(tmpdir(), project));
const environmentFile = join(workspace, '.env');
const override = join(workspace, 'compose.json');
const composeFile = fileURLToPath(new URL('../../compose.yml', import.meta.url));
const fixture = readFileSync(new URL('../fixtures/video--Gu8bnHQaG5s.json', import.meta.url), 'utf8');
const env = {
  ...process.env, COMPOSE_PROFILES: '', RAGATOR_PORT: '0', RAGATOR_BIND_ADDRESS: '127.0.0.1',
  RAGATOR_PASSWORD: '', RAGATOR_HOSTS: '',
};
writeFileSync(environmentFile, '');
writeFileSync(override, JSON.stringify({ services: { ragator: { image, container_name: local, restart: 'no' } } }));

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 180_000, windowsHide: true, env, ...options }).trim();
}
function compose(...args) {
  return docker(['compose', '--project-name', project, '--env-file', environmentFile, '-f', composeFile, '-f', override, ...args]);
}
async function waitFor(description, probe) {
  let lastError;
  for (let i = 0; i < 90; i++) {
    try { if (await probe()) return; } catch (err) { lastError = err; }
    await delay(1000);
  }
  throw new Error('Délai dépassé : ' + description, { cause: lastError });
}
async function json(url, body, status = 200) {
  const response = await fetch(url, {
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, url);
  return response.json();
}
function remoteClient() {
  // Le client tourne sur le réseau dédié du projet. Le serveur distant ne publie aucun port sur l'hôte.
  const source = `
    import assert from 'node:assert/strict';
    const url = 'http://' + process.env.SMOKE_SERVER + ':3210/api/stats';
    const basic = 'Basic ' + Buffer.from('ragator:' + process.env.RAGATOR_PASSWORD).toString('base64');
    const anonymous = await fetch(url);
    assert.equal(anonymous.status, 401);
    const response = await fetch(url, { headers: { Authorization: basic } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).videos, 1);
  `;
  docker(['run', '--rm', '-i', '--network', project + '_default', '--entrypoint', 'node',
    '--env', 'SMOKE_SERVER', '--env', 'RAGATOR_PASSWORD', image, '--input-type=module', '-'], {
    input: source, env: { ...env, SMOKE_SERVER: remote, RAGATOR_PASSWORD: password },
  });
}

let remoteCreated = false;
try {
  const service = JSON.parse(compose('config', '--format', 'json')).services.ragator;
  assert.equal(service.ports.length, 1);
  assert.equal(service.ports[0].host_ip, '127.0.0.1');
  assert.equal(service.environment.RAGATOR_BIND_ADDRESS, '127.0.0.1');
  compose('up', '--no-build', '--pull', 'never', '--detach', '--wait', '--wait-timeout', '120', 'ragator');
  const localUrl = () => {
    const binding = compose('port', 'ragator', '3210');
    assert.match(binding, /^127\.0\.0\.1:\d+$/);
    return 'http://' + binding;
  };
  let url = localUrl();
  assert.equal((await fetch(url)).status, 200);
  const uploaded = await json(url + '/api/admin/upload', { name: 'exemple.json', content: fixture });
  assert.equal(uploaded.ok, true);
  await json(url + '/api/admin/update', { afterCurrent: true }, 202);
  const indexed = async () => {
    const { stats, job, corpus } = await json(url + '/api/admin/status');
    return stats.videos === 1 && corpus.files === 1 && job.state === 'done';
  };
  await waitFor('indexation de la vidéo', indexed);
  const answer = await json(url + '/api/ask', { question: 'À quoi sert le module Peltier ?', mode: 'extractif' });
  assert(answer.sources.some((s) => s.videoId === 'Gu8bnHQaG5s' && Number.isInteger(s.startS) && s.link.includes('&t=')));
  compose('restart', 'ragator');
  // Docker peut attribuer un nouveau port hôte éphémère après un redémarrage.
  url = localUrl();
  await waitFor('corpus et index après redémarrage', indexed);
  console.log('Compose local : dépôt, question citée et persistance vérifiés.');

  // Réutilise le même volume, avec un seul processus PostgreSQL à la fois.
  compose('stop', 'ragator');
  env.RAGATOR_BIND_ADDRESS = '0.0.0.0';
  env.RAGATOR_PASSWORD = password;
  compose('run', '--detach', '--no-deps', '--name', remote, 'ragator');
  remoteCreated = true;
  assert.equal(docker(['port', remote]), '');
  const healthy = () => docker(['inspect', '--format', '{{.State.Health.Status}}', remote]) === 'healthy';
  await waitFor('serveur réseau', healthy);
  remoteClient();
  docker(['restart', remote]);
  await waitFor('redémarrage du serveur réseau', healthy);
  remoteClient();
  console.log('Second conteneur : accès anonyme refusé, accès authentifié et données vérifiés avant et après redémarrage.');
} catch (err) {
  try { console.error(compose('logs', '--tail', '40', 'ragator')); } catch { /* lancement incomplet */ }
  throw err;
} finally {
  try {
    if (remoteCreated) docker(['rm', '--force', '--volumes', remote]);
  } finally {
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { unlinkSync(override); unlinkSync(environmentFile); rmdirSync(workspace); }
  }
}
