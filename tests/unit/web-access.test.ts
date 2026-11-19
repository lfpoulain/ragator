import { describe, expect, it, vi } from 'vitest';
import { getStoredSettings, setStoredSettings } from '../../src/config.js';
import { applyStoredSettings } from '../../src/settings.js';
import { hostAllowed, passwordOk } from '../../src/web/server.js';

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('accès à l’interface web', () => {
  it('accès anonyme par localhost ; accès réseau protégé, avec liste de noms facultative', () => {
    expect(hostAllowed('localhost:3210', [])).toBe(true);
    expect(hostAllowed('127.0.0.1:3210', [])).toBe(true);
    expect(hostAllowed('192.168.1.20:3210', [])).toBe(false);
    expect(hostAllowed('[fd00::12]:3210', [])).toBe(false);
    expect(hostAllowed('192.168.1.20:3210', [], true)).toBe(true);
    expect(hostAllowed('[fd00::12]:3210', [], true)).toBe(true);
    expect(hostAllowed('nas:3210', [])).toBe(false);
    expect(hostAllowed('ragator.example.org', [], true)).toBe(true);
    expect(hostAllowed('1.2.3.4.evil.example', [])).toBe(false);
    expect(hostAllowed('NAS:3210', ['nas'])).toBe(false);
    expect(hostAllowed('NAS:3210', ['nas'], true)).toBe(true);
    expect(hostAllowed('evil.example:3210', ['nas'], true)).toBe(false);
    expect(hostAllowed(undefined, ['nas'])).toBe(false);
  });

  it('garde le dernier mot de passe connu si les réglages deviennent illisibles', async () => {
    const previous = getStoredSettings();
    try {
      setStoredSettings({ password: 'installé' });
      const query = vi.fn().mockRejectedValueOnce(new Error('base indisponible'))
        .mockResolvedValueOnce({ rows: [{ value: { password: 42 } }] });
      await expect(applyStoredSettings({ query })).rejects.toThrow('base indisponible');
      await expect(applyStoredSettings({ query })).rejects.toThrow('password');
      expect(getStoredSettings().password).toBe('installé');
    } finally {
      setStoredSettings(previous);
    }
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
