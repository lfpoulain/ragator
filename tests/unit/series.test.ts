import { describe, expect, it } from 'vitest';
import { titleHas, withoutSeries } from '../../src/core/series.js';
import { parseAnalysis } from '../../src/prompts/analyze.js';

describe('séries nommées par la question', () => {
  it('un titre contient le nom de la série, accents et majuscules repliés, mots dans l’ordre', () => {
    expect(titleHas('La RÉGIE GAMING ROOM est DINGUE et les SETUPS sont FOUS !!', 'régie')).toBe(true);
    expect(titleHas('De Zéro à GAMING ROOM/RÉGIE MONTAGE et LIVES !', 'gaming room')).toBe(true);
    expect(titleHas('La GAMING Room RÉGIE est incroyable', 'Gaming Room')).toBe(true);
    // Un mot seul ne suffit pas pour un nom de deux mots ; un mot plus long n'est pas le nom.
    expect(titleHas('On MOULE une manette XBOX pour un support GAMING en BÉTON CIRÉ', 'gaming room')).toBe(false);
    expect(titleHas('Une "GameBoy Like" portable 8 BITS DIY Retrogaming', 'gaming')).toBe(false);
    expect(titleHas('Un titre', '')).toBe(false);
  });

  it('la question sans le nom de la série garde le sujet cherché', () => {
    expect(withoutSeries('Quand est-ce qu’une femme apparaît dans les vidéos de la régie/gaming room ?', ['régie', 'gaming room'])).toBe(
      'Quand est-ce qu’une femme apparaît dans les vidéos de la ?',
    );
    expect(withoutSeries('Comment passent-ils les câbles dans la REGIE ?', ['régie'])).toBe('Comment passent-ils les câbles dans la ?');
    // Nom absent de la question (écrit autrement par l'analyse) : question inchangée.
    expect(withoutSeries('Quand voit-on un chien au chalet ?', ['cabane'])).toBe('Quand voit-on un chien au chalet ?');
  });

  it('l’analyse lit la série, absente : aucune', () => {
    const base = { route: 'chercher', generale: false, terme: '', ordre: 'aucun', alternatives: [], motsCles: [], passage: '', exigences: [], sujet: '' };
    expect(parseAnalysis(JSON.stringify({ ...base, serie: [' régie ', 'gaming room', ''] }))?.serie).toEqual(['régie', 'gaming room']);
    expect(parseAnalysis(JSON.stringify(base))?.serie).toEqual([]);
  });
});
