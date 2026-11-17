import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  canConnect: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn(),
}));
vi.mock('../../src/db/pool.js', () => ({ canConnect: mocks.canConnect }));
vi.mock('pg', () => ({
  default: { Client: class {
    connect = mocks.connect;
    query = mocks.query;
    end = mocks.end;
  } },
}));

import { ensureTestDatabase, testDatabaseTarget } from '../test-database.js';

describe('initialisation de la base de test', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
  });

  it('préserve les paramètres et utilise le nom configuré', () => {
    const target = testDatabaseTarget('postgres://user:pass@localhost:15432/custom_test?sslmode=require');
    expect(target.database).toBe('custom_test');
    expect(new URL(target.adminUrl).pathname).toBe('/postgres');
    expect(new URL(target.adminUrl).searchParams.get('sslmode')).toBe('require');
  });

  it('refuse une base de production avant toute connexion', async () => {
    await expect(ensureTestDatabase('postgres://user:pass@localhost/ragator')).rejects.toThrow('base dédiée');
    expect(mocks.canConnect).not.toHaveBeenCalled();
  });

  it('sans serveur, permet d’ignorer les suites sans tenter une création', async () => {
    mocks.canConnect.mockResolvedValue(false);
    expect(await ensureTestDatabase('postgres://user:pass@localhost/ragator_test')).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('crée une base absente avant de tester sa disponibilité', async () => {
    mocks.canConnect.mockResolvedValue(true);
    mocks.query.mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 });
    expect(await ensureTestDatabase('postgres://user:pass@localhost/custom_test')).toBe(true);
    expect(mocks.query).toHaveBeenNthCalledWith(1, 'SELECT 1 FROM pg_database WHERE datname = $1', ['custom_test']);
    expect(mocks.query).toHaveBeenNthCalledWith(2, 'CREATE DATABASE "custom_test"');
    expect(new URL(mocks.canConnect.mock.calls[0]![0] as string).pathname).toBe('/postgres');
    expect(new URL(mocks.canConnect.mock.calls[1]![0] as string).pathname).toBe('/custom_test');
    expect(mocks.end).toHaveBeenCalled();
  });

  it('accepte une création simultanée, mais remonte les autres erreurs', async () => {
    mocks.canConnect.mockResolvedValue(true);
    mocks.query.mockResolvedValueOnce({ rowCount: 0 }).mockRejectedValueOnce({ code: '42P04' });
    expect(await ensureTestDatabase('postgres://user:pass@localhost/custom_test')).toBe(true);
    mocks.query.mockResolvedValueOnce({ rowCount: 0 }).mockRejectedValueOnce(new Error('permission refusée'));
    await expect(ensureTestDatabase('postgres://user:pass@localhost/custom_test')).rejects.toThrow('permission refusée');
  });
});
