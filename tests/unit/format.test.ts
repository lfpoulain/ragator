import { describe, expect, it } from 'vitest';
import { formatWindow, formatTimestamp, formatRange, type FormatEntry } from '../../src/windows/format.js';

function entry(overrides: Partial<FormatEntry>): FormatEntry {
  return {
    sourceId: 'Gu8bnHQaG5s:t00001',
    kind: 'parole',
    startS: 0,
    endS: 3,
    text: 'Ouais, c’est l’été.',
    speaker: null,
    isVoiceOver: false,
    speakerIsNamed: false,
    planTitle: null,
    screenText: null,
    uncertainties: [],
    ...overrides,
  };
}

const info = {
  videoId: 'Gu8bnHQaG5s',
  title: 'Les glacières sur batterie coûtent 1100 €. La nôtre : 54 €',
  publishedAt: '2026-08-13',
  startS: 0,
  endS: 120,
};

describe('format du texte fusionné', () => {
  it('écrit l’en-tête avec bornes, vidéo, date et titre', () => {
    const text = formatWindow(info, []);
    expect(text.split('\n')[0]).toBe(
      '=== Fenêtre 00:00–02:00 | vidéo Gu8bnHQaG5s | 2026-08-13 | « Les glacières sur batterie coûtent 1100 €. La nôtre : 54 € » ===',
    );
  });

  it('affiche la voix off comme rôle, jamais comme identité', () => {
    const text = formatWindow(info, [
      entry({ isVoiceOver: true }),
    ]);
    expect(text).toContain('PAROLE (voix off, identité inconnue) : Ouais');
    expect(text).not.toContain('Voff');
  });

  it('affiche les identités explicites uniquement', () => {
    const text = formatWindow(info, [
      entry({ speaker: 'Artus', speakerIsNamed: true }),
      entry({ sourceId: 'Gu8bnHQaG5s:t00002', speaker: 'Indéterminé' }),
    ]);
    expect(text).toContain('PAROLE (Artus) :');
    expect(text).toContain('PAROLE (identité inconnue) :');
    expect(text).not.toContain('Indéterminé');
  });

  it('affiche un instant pour une parole de durée nulle', () => {
    const text = formatWindow(info, [entry({ startS: 806, endS: 806 })]);
    expect(text).toContain('[Gu8bnHQaG5s:t00001 @ 13:26] PAROLE');
    expect(text).not.toContain('13:26–13:26');
  });

  it('écrit les plans avec titre, description, écran et incertitudes', () => {
    const text = formatWindow(info, [
      entry({
        sourceId: 'Gu8bnHQaG5s:v00001',
        kind: 'visuel',
        endS: 2,
        text: 'Plan sur les vagues de la mer',
        planTitle: 'Introduction estivale',
        screenText: ['C’est', 'PIC NIQUE'],
        uncertainties: ['texte partiellement illisible'],
      }),
    ]);
    expect(text).toContain(
      '[Gu8bnHQaG5s:v00001 @ 00:00–00:02] PLAN : Introduction estivale | Plan sur les vagues de la mer',
    );
    expect(text).toContain('ÉCRAN : « C’est » | « PIC NIQUE »');
    expect(text).toContain('INCERTAIN : texte partiellement illisible');
  });

  it('n’écrit pas de ligne ÉCRAN sans texte à l’image', () => {
    const text = formatWindow(info, [
      entry({ sourceId: 'Gu8bnHQaG5s:v00002', kind: 'visuel', endS: 2, text: 'd', planTitle: 't', screenText: [] }),
    ]);
    expect(text).not.toContain('ÉCRAN');
  });

  it('entremêle paroles et plans dans l’ordre chronologique', () => {
    const text = formatWindow(info, [
      entry({ sourceId: 'Gu8bnHQaG5s:v00001', kind: 'visuel', startS: 0, endS: 2, text: 'plan', planTitle: 't', speakerIsNamed: false }),
      entry({ sourceId: 'Gu8bnHQaG5s:t00001', startS: 1, endS: 4 }),
    ]);
    const lines = text.split('\n');
    expect(lines[1]).toContain('v00001');
    expect(lines[2]).toContain('t00001');
  });

  it('signale la date inconnue', () => {
    const text = formatWindow({ ...info, publishedAt: null }, []);
    expect(text).toContain('| date inconnue |');
  });

  it('formate les instants au-delà de l’heure', () => {
    expect(formatTimestamp(831)).toBe('13:51');
    expect(formatTimestamp(3725)).toBe('1:02:05');
    expect(formatRange(0, 120)).toBe('00:00–02:00');
  });
});
