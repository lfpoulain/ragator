import { describe, expect, it } from 'vitest';
import { generateChunks, type ChunkEntry } from '../../src/windows/chunks.js';

const speech = (startS: number, text: string): ChunkEntry => ({ kind: 'parole', startS, text, planTitle: null });
const plan = (startS: number, planTitle: string): ChunkEntry => ({ kind: 'visuel', startS, text: 'longue description', planTitle });

describe('blocs sémantiques de 30 s', () => {
  it('range chaque entrée dans la tranche de son début, titre puis plans puis paroles', () => {
    const chunks = generateChunks('La glacière', [speech(35, 'deuxième'), speech(2, 'bonjour'), plan(10, 'Atelier'), speech(29, 'suite')], 70);
    expect(chunks).toEqual([
      { startS: 0, endS: 30, text: 'La glacière\n[Atelier]\nbonjour suite' },
      { startS: 30, endS: 60, text: 'La glacière\ndeuxième' },
    ]);
  });

  it('ignore les descriptions visuelles et saute les tranches vides', () => {
    const chunks = generateChunks('T', [plan(95, 'Chaton')], 100);
    expect(chunks).toEqual([{ startS: 90, endS: 100, text: 'T\n[Chaton]' }]);
  });

  it('borne la dernière tranche à la durée, jamais vide', () => {
    expect(generateChunks('T', [speech(60, 'fin')], 60)[0]).toMatchObject({ startS: 60, endS: 61 });
    expect(generateChunks('T', [], 100)).toEqual([]);
  });
});
