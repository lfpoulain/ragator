import { describe, expect, it } from 'vitest';
import { mapConcurrent } from '../../src/core/concurrent.js';

describe('mapConcurrent', () => {
  it('respecte la limite et rend les résultats dans l’ordre d’entrée', async () => {
    let running = 0;
    let peak = 0;
    const delays = [30, 5, 20, 1, 10, 15, 2];
    const results = await mapConcurrent(delays, 3, async (ms) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return ms * 2;
    });
    expect(results).toEqual(delays.map((ms) => ms * 2));
    expect(peak).toBe(3);
  });

  it('limite 1 : strictement séquentiel ; liste vide : aucun appel', async () => {
    const order: number[] = [];
    await mapConcurrent([1, 2, 3], 1, async (n) => {
      order.push(n);
    });
    expect(order).toEqual([1, 2, 3]);
    expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  });

  it('propage la première erreur', async () => {
    await expect(mapConcurrent([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('lot en échec');
      return n;
    })).rejects.toThrow('lot en échec');
  });
});
