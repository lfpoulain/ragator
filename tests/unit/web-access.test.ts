import { describe, expect, it } from 'vitest';
import { hostAllowed, passwordOk } from '../../src/web/server.js';

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('accès à l’interface web', () => {
  it('hôte local ou adresse IP acceptés ; un nom seulement s’il est déclaré ou protégé par mot de passe', () => {
    expect(hostAllowed('localhost:3210', [])).toBe(true);
    expect(hostAllowed('127.0.0.1:3210', [])).toBe(true);
    expect(hostAllowed('192.168.1.20:3210', [])).toBe(true);
    expect(hostAllowed('[fd00::12]:3210', [])).toBe(true);
    expect(hostAllowed('nas:3210', [])).toBe(false);
    expect(hostAllowed('ragator.example.org', [], true)).toBe(true);
    expect(hostAllowed('1.2.3.4.evil.example', [])).toBe(false);
    expect(hostAllowed('NAS:3210', ['nas'])).toBe(true);
    expect(hostAllowed('evil.example:3210', ['nas'])).toBe(false);
    expect(hostAllowed(undefined, ['nas'])).toBe(false);
  });

  it('mot de passe HTTP Basic : nom libre, mot de passe exact', () => {
    expect(passwordOk(basic('alice', 'secret'), 'secret')).toBe(true);
    expect(passwordOk(basic('', 'secret'), 'secret')).toBe(true);
    expect(passwordOk(basic('alice', 'faux'), 'secret')).toBe(false);
    expect(passwordOk(undefined, 'secret')).toBe(false);
    expect(passwordOk('Bearer secret', 'secret')).toBe(false);
    // Un deux-points dans le mot de passe reste dans le mot de passe.
    expect(passwordOk(basic('a', 'x:y'), 'x:y')).toBe(true);
  });
});
