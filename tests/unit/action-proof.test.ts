import { describe, expect, it } from 'vitest';
import { assessAction, corroboratedAlternative, type ActionClue } from '../../src/core/action-proof.js';
import { validateClaims } from '../../src/core/citations.js';
import { sourceOf } from '../../src/core/sources.js';
import type { PromptWindow } from '../../src/prompts/answer.js';

const proof = 'On utilise la pince Knipex pour ce raccord.';
const source = sourceOf({ sourceId: 'v:t1', videoId: 'v', title: 'Raccord', publishedAt: null, kind: 'parole' }, 70, 71, proof);
const clue: ActionClue = { source, proof, alternative: 'Knipex', missing: 'Modalité visuelle à confirmer.' };
const question = 'Où les voit-on sertir ce raccord avec la pince Facom ?';

function scene(text: string, screenText: string[] = []): PromptWindow {
  return { videoId: 'v', title: 'Raccord', publishedAt: null, startS: 91, endS: 95, entries: [{
    sourceId: 'v:v3', kind: 'visuel', startS: 91, endS: 95, text, planTitle: 'Assemblage',
    speaker: null, isVoiceOver: false, speakerIsNamed: false, uncertainties: [], screenText,
  }] };
}

describe('rectification d’une prémisse sur un objet', () => {
  it('cite le plan identifiant la même valeur alternative pour l’objet précis', () => {
    const text = 'Ils sertissent le raccord avec leur pince Knipex.';
    expect(corroboratedAlternative(clue, question, scene(text), 'visuel')).toMatchObject({
      sourceIds: ['v:v3'], preuve: text, correction: 'Knipex',
    });
  });
  it.each([
    ['La pince est à côté de la perceuse Knipex.', []],
    ['La pince se referme.', ['Knipex']],
    ['Ils ne se servent pas de la pince Knipex.', []],
    ['Une pince Knipex pourrait être utilisée sur le raccord.', []],
  ] as const)('écarte une seconde ligne insuffisante : %s', (text, screen) => {
    expect(corroboratedAlternative(clue, question, scene(text, [...screen]), 'visuel')).toBeNull();
  });
});

it('lit la proposition principale qui suit un fragment subordonné dans une transcription', () => {
  const proof = 'elle utilise actuellement une cale en bois';
  const line = { ...source, excerpt: 'Et que la porte reste ouverte, et ben elle utilise actuellement une cale en bois.' };
  const sources = new Map([[line.sourceId, line]]);
  const raw = JSON.stringify({ refus: false, claims: [{ text: 'Elle pose une cale en bois.', preuve: proof, sourceIds: [line.sourceId] }] });
  const checked = assessAction(validateClaims(raw, sources, 'court', new Map()), sources, 'court', 'Avec quoi cale-t-elle la porte ?', [], 'tout');
  expect(checked.validated.claims[0]?.preuve).toBe(proof);
  expect(checked.clue).toBeNull();
});
