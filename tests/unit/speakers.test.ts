import { describe, expect, it } from 'vitest';
import { mapSpeaker } from '../../src/norm/speakers.js';

describe('mapping des locuteurs', () => {
  it('les noms explicites sont filtrables', () => {
    expect(mapSpeaker('Artus')).toEqual({
      speaker: 'Artus',
      speakerRaw: 'Artus',
      speakerIsNamed: true,
      isVoiceOver: false,
    });
    expect(mapSpeaker('Baptiste').speakerIsNamed).toBe(true);
  });

  it('Voff est un rôle, pas une identité', () => {
    const mapped = mapSpeaker('Voff');
    expect(mapped.speaker).toBeNull();
    expect(mapped.speakerRaw).toBe('Voff');
    expect(mapped.speakerIsNamed).toBe(false);
    expect(mapped.isVoiceOver).toBe(true);
  });

  it('Invité N, Intervenant N et Indéterminé ne sont pas des identités', () => {
    for (const label of ['Invité', 'Invité 1', 'Invité 2', 'Invité 3', 'Intervenant 2', 'Indéterminé']) {
      const mapped = mapSpeaker(label);
      expect(mapped.speaker).toBeNull();
      expect(mapped.speakerIsNamed).toBe(false);
      expect(mapped.speakerRaw).toBe(label);
    }
  });

  it('un prénom inattendu reste un nom explicite fourni', () => {
    expect(mapSpeaker('Emma').speakerIsNamed).toBe(true);
  });
});
