import { describe, expect, it } from 'vitest';
import { extractCitations, extractParsedCitations, resolveCitation, renderClaims, validateClaims } from '../../src/core/citations.js';
import { groupSources, type AnswerSource } from '../../src/core/sources.js';
import { sortByDate } from '../../src/core/video-rank.js';

function source(sourceId: string, startS: number | null, endS: number | null = startS): AnswerSource {
  return {
    sourceId,
    sourceIds: [sourceId],
    videoId: sourceId.slice(0, 11),
    title: 't',
    publishedAt: null,
    kind: 'parole',
    startS,
    endS,
    link: '',
    excerpt: '',
    urls: [],
  };
}

describe('preuve recopiée (mode local)', () => {
  const withText = (id: string, startS: number, excerpt: string) => ({ ...source(id, startS), excerpt });
  const sources = new Map([
    ['Gu8bnHQaG5s:t00001', withText('Gu8bnHQaG5s:t00001', 10, 'On commence par démonter le capot.')],
    ['Gu8bnHQaG5s:t00002', withText('Gu8bnHQaG5s:t00002', 225, 'Le module Peltier transfère la chaleur d’une face vers l’autre.')],
  ]);
  const answer = (preuve: string, cited: string) =>
    validateClaims(JSON.stringify({ refus: false, claims: [{ preuve, text: 'Il transfère la chaleur.', sourceIds: [cited] }] }), sources, 'court');

  it('la ligne qui contient la preuve remplace une citation voisine', () => {
    expect(answer('le module Peltier transfère la chaleur', 'Gu8bnHQaG5s:t00001').claims[0]!.sourceIds).toEqual(['Gu8bnHQaG5s:t00002']);
  });

  it('accepte une citation exacte, même brève, et écarte une preuve absente de la ligne', () => {
    expect(answer('le module Peltier transfère la chaleur', 'Gu8bnHQaG5s:t00002').claims[0]!.sourceIds).toEqual(['Gu8bnHQaG5s:t00002']);
    expect(answer('LE CAPÔT', 'Gu8bnHQaG5s:t00001').claims[0]!.preuve).toBe('LE CAPÔT');
    expect(answer('il refroidit la glacière en déplaçant la chaleur', 'Gu8bnHQaG5s:t00001').claims).toEqual([]);
    expect(answer('le capot', 'Gu8bnHQaG5s:t00002').claims).toEqual([]);
    expect(answer('', 'Gu8bnHQaG5s:t00002').claims).toEqual([]);
  });

  it('ne change pas de vidéo pour rattacher une citation et ne transforme pas les nombres', () => {
    const other = 'cKRqOdTi5yE:t00001';
    const more = new Map(sources).set(other, withText(other, 40, 'Nous avons mesuré -54 °C et 154 € sur le devis.'));
    const check = (preuve: string, id: string) =>
      validateClaims(JSON.stringify({ claims: [{ text: 'Mesure.', preuve, sourceIds: [id] }] }), more, 'court').claims;
    expect(check('sur le devis', other)).toHaveLength(1);
    expect(check('nous avons mesuré -54', 'Gu8bnHQaG5s:t00002')).toEqual([]);
    expect(check('54 °C', other)).toEqual([]);
    expect(check('54 €', other)).toEqual([]);
    expect(check('-54 °C', other)).toHaveLength(1);
    const mixed = { text: 'Les deux projets utilisent ce module.', preuve: 'Le module Peltier', sourceIds: ['Gu8bnHQaG5s:t00002', other] };
    expect(validateClaims(JSON.stringify({ claims: [mixed] }), more, 'court').claims).toEqual([]);
  });
});

describe('citations de la couche de réponse', () => {
  it('extrait les identifiants entre crochets', () => {
    const text = 'La réponse [_R2GNWk1k34:t00020 @ 01:51–01:57] et aussi [Gu8bnHQaG5s:v00083 @ 09:21].';
    expect(extractCitations(text)).toEqual(['_R2GNWk1k34:t00020', 'Gu8bnHQaG5s:v00083']);
  });

  it('accepte les timecodes à heures et les sources sans instant', () => {
    expect(extractCitations('Voir [abc12345678:t00999 @ 1:02:05].')).toEqual(['abc12345678:t00999']);
    const parsed = extractParsedCitations('Lien [Gu8bnHQaG5s:d00003].');
    expect(parsed).toEqual([{ raw: '[Gu8bnHQaG5s:d00003]', ref: 'Gu8bnHQaG5s:d00003', startS: null }]);
  });

  it('parse le timecode de la citation', () => {
    const parsed = extractParsedCitations('[_R2GNWk1k34:v00010 @ 01:40–01:51]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.startS).toBe(100);
  });

  it('ignore les doublons, le texte sans citation et les crochets ordinaires', () => {
    expect(extractCitations('Rien ici [voir plus bas] [1].')).toEqual([]);
    expect(extractCitations('[Gu8bnHQaG5s:t00001 @ 00:01] puis [Gu8bnHQaG5s:t00001 @ 00:01].')).toEqual([
      'Gu8bnHQaG5s:t00001',
    ]);
  });

  it('rattache une citation réduite à l’entrée qui couvre l’instant, à 15 s près au plus', () => {
    const sources = new Map([
      ['Gu8bnHQaG5s:t00010', source('Gu8bnHQaG5s:t00010', 100, 110)],
      ['Gu8bnHQaG5s:t00011', source('Gu8bnHQaG5s:t00011', 200, 205)],
    ]);
    const at = (text: string) => resolveCitation(extractParsedCitations(text)[0]!, sources);
    expect(at('[Gu8bnHQaG5s @ 01:45]')).toBe('Gu8bnHQaG5s:t00010');
    expect(at('[Gu8bnHQaG5s @ 03:10]')).toBe('Gu8bnHQaG5s:t00011');
    expect(at('[Gu8bnHQaG5s @ 10:00]')).toBeNull();
    expect(at('[Gu8bnHQaG5s:t77777 @ 01:45]')).toBeNull();
    expect(at('[Gu8bnHQaG5s]')).toBeNull();
  });

  it('accepte l’identifiant local quand il désigne une seule source fournie', () => {
    const sources = new Map([
      ['_R2GNWk1k34:t00020', source('_R2GNWk1k34:t00020', 100, 111)],
      ['Gu8bnHQaG5s:t00020', source('Gu8bnHQaG5s:t00020', 500, 505)],
      ['Gu8bnHQaG5s:t00061', source('Gu8bnHQaG5s:t00061', 221, 230)],
    ]);
    const at = (text: string) => resolveCitation(extractParsedCitations(text)[0]!, sources);
    expect(at('[t00061 @ 03:41]')).toBe('Gu8bnHQaG5s:t00061');
    expect(at('[t00020 @ 01:40–01:51]')).toBe('_R2GNWk1k34:t00020');
    expect(at('[t00020 @ 08:20]')).toBe('Gu8bnHQaG5s:t00020');
    expect(at('[t00020]')).toBeNull();
    expect(at('[t00061 @ 30:00]')).toBeNull();
    expect(at('[t00999 @ 01:00]')).toBeNull();
  });

  it('tolère la perte du « _ » initial d’un identifiant de vidéo, jamais un crochet ordinaire', () => {
    const sources = new Map([['_R2GNWk1k34:t00020', source('_R2GNWk1k34:t00020', 100, 111)]]);
    const at = (text: string) => resolveCitation(extractParsedCitations(text)[0]!, sources);
    expect(at('[R2GNWk1k34 @ 01:40–01:51]')).toBe('_R2GNWk1k34:t00020');
    expect(at('[R2GNWk1k34:t00020 @ 01:41]')).toBe('_R2GNWk1k34:t00020');
    expect(extractCitations('Une note [importante] ici.')).toEqual([]);
  });

  describe('sortie structurée (prompt v3)', () => {
    const sources = new Map([
      ['_R2GNWk1k34:t00020', source('_R2GNWk1k34:t00020', 100, 111)],
      ['Gu8bnHQaG5s:d00003', source('Gu8bnHQaG5s:d00003', null)],
    ]);
    const json = (value: unknown) => JSON.stringify(value);

    it('garde les affirmations appuyées, rattache les identifiants déformés et ajoute les références', () => {
      const out = validateClaims(
        json({
          refus: false,
          claims: [
            { text: 'On surélève pour garder des rangements.', sourceIds: ['R2GNWk1k34:t00020'] },
            { text: 'Le firmware est en description.', sourceIds: ['Gu8bnHQaG5s:d00003'] },
            { text: 'Fait inventé.', sourceIds: ['Gu8bnHQaG5s:t99999'] },
          ],
        }),
        sources,
        'court',
      );
      expect(out.claims.map((c) => c.sourceIds)).toEqual([['_R2GNWk1k34:t00020'], ['Gu8bnHQaG5s:d00003']]);
      expect(out.invalid).toEqual(['Gu8bnHQaG5s:t99999']);
      expect(out.answer).toBe(
        'On surélève pour garder des rangements. [_R2GNWk1k34:t00020 @ 01:40] Le firmware est en description. [Gu8bnHQaG5s:d00003]',
      );
      expect(out.answer).not.toContain('inventé');
    });

    it('retire toute référence écrite par le modèle dans le texte', () => {
      const out = validateClaims(
        json({ refus: false, claims: [{ text: 'Rangements [t00020 @ 01:40] dessous.', sourceIds: ['t00020'] }] }),
        sources,
        'détaillé',
      );
      expect(out.answer).toBe('- Rangements dessous. [_R2GNWk1k34:t00020 @ 01:40]');
    });

    it('une affirmation n’affiche qu’une référence par séquence', () => {
      const scene = new Map([
        ['tr9Jq7W0P9M:t00132', source('tr9Jq7W0P9M:t00132', 461, 464)],
        ['tr9Jq7W0P9M:t00133', source('tr9Jq7W0P9M:t00133', 464, 468)],
      ]);
      const out = validateClaims(
        json({ refus: false, claims: [{ text: 'Des pieds en sisal.', sourceIds: ['tr9Jq7W0P9M:t00132', 'tr9Jq7W0P9M:t00133'] }] }),
        scene,
        'court',
      );
      expect(out.answer).toBe('Des pieds en sisal. [tr9Jq7W0P9M:t00132 @ 07:41]');
      expect(out.claims[0]!.sourceIds).toHaveLength(2);
    });

    it('accepte un identifiant recopié avec ses crochets et son horodatage', () => {
      const out = validateClaims(
        json({ refus: false, claims: [{ text: 'Rangements.', sourceIds: ['[_R2GNWk1k34:t00020 @ 01:40–01:51]'] }] }),
        sources,
        'court',
      );
      expect(out.claims.map((c) => c.sourceIds)).toEqual([['_R2GNWk1k34:t00020']]);
      expect(out.invalid).toEqual([]);
    });

    it('un refus sans affirmation est un refus', () => {
      expect(validateClaims(json({ refus: true, claims: [] }), sources, 'court').refused).toBe(true);
    });
  });

  it('réunit les sources d’une même séquence (moins de 30 s d’écart), pas celles d’une autre vidéo', () => {
    const grouped = groupSources([
      source('Gu8bnHQaG5s:t00062', 225, 229),
      source('Gu8bnHQaG5s:t00063', 229, 233),
      source('_R2GNWk1k34:t00020', 100, 111),
      source('Gu8bnHQaG5s:t00064', 233, 237),
      source('Gu8bnHQaG5s:t00090', 400, 405),
    ]);
    expect(grouped.map((g) => g.sourceIds)).toEqual([
      ['Gu8bnHQaG5s:t00062', 'Gu8bnHQaG5s:t00063', 'Gu8bnHQaG5s:t00064'],
      ['_R2GNWk1k34:t00020'],
      ['Gu8bnHQaG5s:t00090'],
    ]);
    expect(grouped[0]).toMatchObject({ startS: 225, endS: 237 });
  });
});

describe('renderClaims : ordre du juge du tri', () => {
  const source = (id: string, startS: number) => ({
    sourceId: id,
    sourceIds: [id],
    videoId: id.split(':')[0]!,
    title: 't',
    publishedAt: null,
    kind: 'parole' as const,
    startS,
    endS: startS + 5,
    link: '',
    excerpt: '',
    urls: [],
  });
  const sources = new Map([
    ['aaaaaaaaaaa:t00001', source('aaaaaaaaaaa:t00001', 10)],
    ['bbbbbbbbbbb:t00001', source('bbbbbbbbbbb:t00001', 20)],
  ]);

  it('les vidéos retenues de justesse passent sous « à vérifier »', () => {
    const answer = renderClaims(
      [
        { text: 'Sûre.', sourceIds: ['aaaaaaaaaaa:t00001'], relevance: 0.9 },
        { text: 'Douteuse.', sourceIds: ['bbbbbbbbbbb:t00001'], relevance: 0.35 },
      ],
      sources,
      'détaillé',
    );
    expect(answer.split('\n')[0]).toContain('Sûre.');
    expect(answer).toMatch(/à vérifier :\n- Douteuse\./);
  });

  it('une vidéo qui ne cite pas la marque demandée passe sous « éventuellement », après les vidéos prouvées', () => {
    const answer = renderClaims(
      [
        { text: 'Plus ancienne, sans la marque.', sourceIds: ['aaaaaaaaaaa:t00001'], relevance: 0.9, missing: '« Ryobi » n’apparaît pas dans leurs extraits' },
        { text: 'Prouvée.', sourceIds: ['bbbbbbbbbbb:t00001'], relevance: 0.9 },
      ],
      sources,
      'détaillé',
      true,
    );
    expect(answer.split('\n')[0]).toContain('Prouvée.');
    expect(answer).toMatch(/Éventuellement \(« Ryobi » n’apparaît pas dans leurs extraits, à vérifier\) :\n- Plus ancienne, sans la marque\./);
  });

  it('affiche la raison propre à chaque piste même en mode court', () => {
    const answer = renderClaims(
      [
        { text: 'Ils déballent une scie.', sourceIds: ['aaaaaaaaaaa:t00001'], missing: 'geste non confirmé' },
        { text: 'Ils scient une planche.', sourceIds: ['bbbbbbbbbbb:t00001'], missing: 'marque incertaine' },
      ],
      sources,
      'court',
      true,
    );
    expect(answer).toMatch(/geste non confirmé, à vérifier\) :\n- Ils déballent/);
    expect(answer).toMatch(/marque incertaine, à vérifier\) :\n- Ils scient/);
  });

  it('les mentions en passant et les passages promotionnels suivent les vidéos qui traitent le sujet', () => {
    const answer = renderClaims(
      [
        { text: 'Sponsor.', sourceIds: ['aaaaaaaaaaa:t00001'], relevance: 0.9, nature: 'promotion' },
        { text: 'Traité.', sourceIds: ['bbbbbbbbbbb:t00001'], relevance: 0.8 },
        { text: 'Au détour.', sourceIds: ['bbbbbbbbbbb:t00001'], relevance: 0.7, nature: 'en_passant' },
      ],
      sources,
      'détaillé',
    );
    expect(answer.split('\n')[0]).toContain('Traité.');
    expect(answer).toMatch(/Évoqué en passant :\n- Au détour\.[^\n]*\n\nSeulement dans un passage sponsorisé ou promotionnel :\n- Sponsor\./);
    // Ordre imposé par la date : pas de regroupement, la nature se lit sur la ligne.
    const dated = renderClaims([{ text: 'Sponsor.', sourceIds: ['aaaaaaaaaaa:t00001'], relevance: 0.9, nature: 'promotion' }], sources, 'détaillé', true);
    expect(dated).toContain('Sponsor. (passage sponsorisé ou promotionnel)');
  });

  it('sans note du juge : liste simple', () => {
    const answer = renderClaims([{ text: 'Seule.', sourceIds: ['aaaaaaaaaaa:t00001'] }], sources, 'détaillé');
    expect(answer).toBe('- Seule. [aaaaaaaaaaa:t00001 @ 00:10]');
  });
});

describe('première / dernière mention : tri par date', () => {
  const videos = [{ id: 'b', publishedAt: '2020-01-01' }, { id: 'x', publishedAt: null }, { id: 'a', publishedAt: '2018-02-07' }];
  it('croissant pour « première », décroissant pour « dernière », date inconnue en dernier', () => {
    expect(sortByDate(videos, 'premiere').map((v) => v.id)).toEqual(['a', 'b', 'x']);
    expect(sortByDate(videos, 'derniere').map((v) => v.id)).toEqual(['b', 'a', 'x']);
  });
});
