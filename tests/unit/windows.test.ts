import { describe, expect, it } from 'vitest';
import { generateWindows, windowsForEntry } from '../../src/windows/generate.js';

describe('génération des fenêtres', () => {
  it('produit 9 fenêtres sur 831 s, la dernière couvrant 720 → 831 s', () => {
    const windows = generateWindows(831);
    expect(windows).toHaveLength(9);
    expect(windows[0]).toEqual({ startS: 0, endS: 120 });
    expect(windows.map((w) => w.startS)).toEqual([0, 90, 180, 270, 360, 450, 540, 630, 720]);
    expect(windows[8]).toEqual({ startS: 720, endS: 831 });
  });

  it('produit 11 fenêtres sur 1013 s, dernière de 900 à 1013 s', () => {
    const windows = generateWindows(1013);
    expect(windows).toHaveLength(11);
    expect(windows[10]).toEqual({ startS: 900, endS: 1013 });
  });

  it('applique la règle de fermeture aux fenêtres en lambeau', () => {
    const windows = generateWindows(770);
    expect(windows).toHaveLength(8);
    expect(windows[7]).toEqual({ startS: 630, endS: 770 });
    for (const w of windows) {
      expect(w.endS - w.startS).toBeGreaterThanOrEqual(60);
    }
  });

  it('les bornes ne dépendent que de la durée', () => {
    expect(generateWindows(831)).toEqual(generateWindows(831));
  });

  it('couvre [0, durée] sans trou, recouvrement de 30 s', () => {
    for (const duration of [831, 1013, 120, 300, 45, 770]) {
      const windows = generateWindows(duration);
      expect(windows[0]?.startS).toBe(0);
      expect(windows[windows.length - 1]?.endS).toBe(duration);
      for (let i = 1; i < windows.length; i++) {
        const prev = windows[i - 1];
        const current = windows[i];
        expect(current).toBeDefined();
        expect(prev).toBeDefined();
        expect(prev!.endS - current!.startS).toBe(30);
      }
    }
  });

  it('aucune fenêtre de moins de 60 s sauf vidéo entière plus courte', () => {
    expect(generateWindows(30)).toEqual([{ startS: 0, endS: 30 }]);
    expect(generateWindows(0)).toEqual([]);
  });

  it('affecte les entrées par chevauchement [start, end)', () => {
    const windows = generateWindows(831);
    expect(windowsForEntry(windows, 0, 90)).toEqual([0]);
    expect(windowsForEntry(windows, 100, 120)).toEqual([0, 1]);
    expect(windowsForEntry(windows, 720, 800)).toEqual([7, 8]);
  });

  it('traite une durée nulle comme un point et la fin inconnue comme un point', () => {
    const windows = generateWindows(831);
    expect(windowsForEntry(windows, 806, 806)).toEqual([8]);
    expect(windowsForEntry(windows, 730, null)).toEqual([7, 8]);
  });

  it('un point exactement à la durée finale appartient à la dernière fenêtre', () => {
    const windows = generateWindows(831);
    expect(windowsForEntry(windows, 831, null)).toEqual([8]);
  });

  it('une longue entrée peut traverser plusieurs fenêtres', () => {
    const windows = generateWindows(300);
    const crossing = windowsForEntry(windows, 100, 250);
    expect(crossing.length).toBeGreaterThan(2);
  });
});
