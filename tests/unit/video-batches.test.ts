import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { answerByVideo, judgeInWaves, packVideoBatches } from '../../src/core/general.js';
import type { CorpusDocument } from '../../src/core/validate.js';
import type { PromptWindow, WrittenVideo } from '../../src/prompts/answer.js';

const video = (id: string, ...lengths: number[]) => ({ id, texts: lengths.map((n) => 'x'.repeat(n)) });
const ids = (batches: Array<Array<{ id: string }>>) => batches.map((b) => b.map((v) => v.id));

describe('lots de rédaction', () => {
  it('au plus N vidéos par lot, dans l’ordre du classement', () => {
    const videos = ['a', 'b', 'c', 'd', 'e'].map((id) => video(id, 10));
    expect(ids(packVideoBatches(videos, 1000, 2))).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('ferme un lot avant de dépasser le budget', () => {
    const videos = [video('a', 400), video('b', 400), video('c', 300), video('d', 100)];
    expect(ids(packVideoBatches(videos, 800, 6))).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('une vidéo trop longue garde ses premiers passages, au moins un, sans modifier l’original', () => {
    const long = video('a', 500, 400, 300);
    const [[packed]] = packVideoBatches([long], 950, 6) as [[typeof long]];
    expect(packed.texts.map((t) => t.length)).toEqual([500, 400]);
    expect(long.texts).toHaveLength(3);
    expect(packVideoBatches([video('b', 2000)], 100, 6)[0]![0]!.texts).toHaveLength(1);
  });
});

describe('preuves dans un lot de vidéos des Frères Poulain', () => {
  function window(videoId: string, ...lines: string[]): PromptWindow {
    const doc: CorpusDocument = JSON.parse(readFileSync(new URL(`../fixtures/video--${videoId}.json`, import.meta.url), 'utf8'));
    const entries = lines.map((local) => {
      const line = doc.transcript.find((t) => t.id === `${videoId}:${local}`)!;
      return {
        sourceId: line.id, kind: 'parole' as const, text: line.text, startS: line.startSeconds, endS: line.endSeconds,
        speaker: null, isVoiceOver: false, speakerIsNamed: false, planTitle: null, screenText: null, uncertainties: [],
      };
    });
    return { videoId, title: doc.source.title, publishedAt: doc.source.publicationDate, entries, startS: entries[0]!.startS, endS: entries.at(-1)!.endS! };
  }
  const windows = [window('Gu8bnHQaG5s', 't00061', 't00062'), window('cKRqOdTi5yE', 't00003')];
  const aliases = new Map(windows.flatMap((w) => w.entries).map((line, i) => [line.sourceId, `s${i + 1}`]));
  const cooler = { videoId: 'v1', sourceIds: ['s1'], preuve: 'fonctionnent avec un module Peltier', affirmation: 'La glacière utilise un module Peltier.' };
  const manor = { videoId: 'v2', sourceIds: ['s3'], preuve: 'avec Victor, Emma, Éloi', affirmation: 'Ils retrouvent Victor, Emma et Éloi.' };
  const run = (videos: WrittenVideo[], onBatch = vi.fn(), required: string[] = [], question = 'Que montrent ces vidéos ?') => answerByVideo(
    { model: 'rédacteur simulé', available: async () => true, chat: async () => JSON.stringify({ videos }) },
    { model: 'juge simulé', judge: async () => [0.95, 0.85] },
    0.4, question, windows, (id) => aliases.get(id)!,
    { required: required.map((term) => ({ term, forms: [term.toLowerCase()] })) }, { onBatch },
  );

  it('ne diffuse jamais un lien du manoir pour la glacière, ni une preuve inventée ou une étiquette inconnue', async () => {
    for (const invalid of [
      { ...cooler, sourceIds: ['s3'] },
      { ...cooler, sourceIds: ['s1', 's3'] },
      { ...cooler, preuve: 'le module utilise un laser' },
      { ...cooler, videoId: 'v99' },
    ]) {
      const onBatch = vi.fn();
      const { raw } = await run([invalid, manor], onBatch);
      const claims = JSON.parse(raw).claims;
      expect(claims).toEqual([{ text: manor.affirmation, preuve: manor.preuve, sourceIds: ['s3'], relevance: 0.85 }]);
      expect(onBatch).toHaveBeenCalledExactlyOnceWith(claims);
    }
  });

  it('corrige une ligne voisine dans la vidéo et conserve la preuve en streaming comme dans la réponse', async () => {
    const onBatch = vi.fn();
    const { raw } = await run([{ ...cooler, sourceIds: ['s2'] }, manor], onBatch);
    const claims = JSON.parse(raw).claims;
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ preuve: cooler.preuve, sourceIds: ['s1'] });
    expect(onBatch).toHaveBeenCalledExactlyOnceWith(claims);
  });

  it('conserve les confirmations et limite les pistes au lot illisible, aux lignes classées et à la portée demandée', async () => {
    const passage = windows[0]!;
    const lot = Array.from({ length: 8 }, (_, i) => ({
      ...passage, videoId: `film${i}`, entries: passage.entries.map((e, j) => ({ ...e, sourceId: `s${i}-${j}` })),
    }));
    const rankedIds = lot.flatMap((w) => w.entries.map((e) => e.sourceId));
    const llm = { model: 'simulé', available: async () => true, chat: async (_system: string, prompt: string) => {
      if (prompt.includes('[s6-0 ')) return '{"videos":[';
      return JSON.stringify({ videos: [{ ...cooler, sourceIds: ['s0-0'] }] });
    } };
    const judge = { model: 'juge', judge: async () => lot.map((_, i) => i === 7 ? 0.05 : 0.9) };
    const onBatch = vi.fn();
    const run = (scope: 'paroles' | 'visuel') => answerByVideo(llm, judge, 0.4, 'Que disent-ils du module Peltier ?', lot, (id) => id,
      { rankedIds, scope }, { onBatch });
    const { raw, issue } = await run('paroles');
    const claims = JSON.parse(raw).claims;
    expect(issue).toContain('rédaction partielle');
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ sourceIds: ['s0-0'], text: cooler.affirmation });
    expect(claims[1]).toMatchObject({ sourceIds: ['s6-0'], preuve: passage.entries[0]!.text, missing: expect.any(String) });
    expect(onBatch.mock.calls.flatMap(([batch]) => batch)).toEqual(claims);
    const visual = await run('visuel');
    expect(JSON.parse(visual.raw).claims).toEqual([]);
  });

  it('récupère le plan choisi pour une question visuelle sans cible de matière, même si la preuve est mal recopiée', async () => {
    const original = windows[0]!;
    const doc: CorpusDocument = JSON.parse(readFileSync(new URL('../fixtures/video--Gu8bnHQaG5s.json', import.meta.url), 'utf8'));
    const plan = doc.visualSegments.find((s) => s.id.endsWith(':v00117'))!;
    const frame = { ...original.entries[0]!, sourceId: plan.id, kind: 'visuel' as const, startS: plan.startSeconds,
      endS: plan.endSeconds, planTitle: plan.title, text: plan.visualDescription, screenText: plan.screenText };
    const aliases = new Map([[frame.sourceId, 's1'], [windows[1]!.entries[0]!.sourceId, 's2']]);
    const llm = { model: 'rédacteur simulé', available: async () => true, chat: async () => JSON.stringify({
      videos: [{ videoId: 'v1', ligneGeste: 's1', preuve: 'Connexion au frigo réalisée, avec une faute de copie.', sourceIds: [],
        affirmation: 'Le narrateur invente un mot de passe.' }],
    }) };
    const { raw } = await answerByVideo(llm, { model: 'juge', judge: async () => [0.85, 0.1] }, 0.4,
      'Dans quelles vidéos voit-on connecter la glacière en Bluetooth ?', [{ ...original, entries: [frame] }, windows[1]!], (id) => aliases.get(id)!,
      { scope: 'visuel' });
    const claims = JSON.parse(raw).claims;
    expect(claims).toHaveLength(1);
    expect(claims[0].sourceIds).toEqual(['s1']);
    expect(claims[0].text).toContain(plan.visualDescription);
    expect(claims[0].text).not.toContain('mot de passe');
  });

  it('ne rattache pas au geste le détail d’une autre ligne de la vidéo', async () => {
    const onBatch = vi.fn();
    const row = { ...cooler, preuve: 'il transfère la chaleur', sourceIds: ['s2'] };
    const { raw } = await run([row], onBatch, ['Peltier']);
    const claim = JSON.parse(raw).claims[0];
    expect(claim).toMatchObject({ text: '« il transfère la chaleur »', preuve: row.preuve, sourceIds: ['s2'] });
    expect(claim.missing).toContain('Peltier');
    expect(onBatch).toHaveBeenCalledExactlyOnceWith([claim]);
  });

  it('relit une fois les seuls plans autonomes après un veto explicite sur une paire de machines', async () => {
    const template = windows[0]!.entries[0]!;
    const question = 'Quand utilisent-ils une découpeuse ou une graveuse laser ?';
    const text = 'La pièce est posée sur la grille. Le faisceau laser grave les lettres sur la plaque.';
    const plan = { ...template, sourceId: 's1', kind: 'visuel' as const, planTitle: 'Gravure laser', text };
    const neighbor = { ...template, sourceId: 's2', text: 'On prépare la machine.' };
    const veto = { videoId: 'v1', repond: false, affirmation: '', preuve: '', ligneGeste: 'aucune', sourceIds: [] };
    const accepted = { ...veto, repond: true, affirmation: 'Ils gravent les lettres.', ligneGeste: 's1', preuve: 'Le faisceau laser grave les lettres', sourceIds: ['s1'] };
    const tryAgain = async (response: unknown, uncertainties: string[] = [], first: unknown = veto) => {
      const chat = vi.fn().mockResolvedValueOnce(JSON.stringify({ videos: [first] }))
        .mockResolvedValueOnce(response === null ? 'invalide' : JSON.stringify({ videos: [response] }));
      const llm = { model: 'rédacteur simulé', available: async () => true, chat };
      const { raw } = await answerByVideo(llm, { model: 'juge', judge: async () => [0.9] }, 0.4, question,
        [{ ...windows[0]!, entries: [{ ...plan, uncertainties }, neighbor] }], (id) => id, { rankedIds: ['s1'] });
      return { chat, claims: JSON.parse(raw).claims };
    };
    const recovered = await tryAgain(accepted);
    expect(recovered.chat).toHaveBeenCalledTimes(2);
    expect(recovered.chat.mock.calls[0]![1]).toContain(neighbor.text);
    expect(recovered.chat.mock.calls[1]![1]).not.toContain(neighbor.text);
    expect(recovered.chat.mock.calls[1]![1]).toContain(text);
    expect(recovered.claims).toEqual([{ sourceIds: ['s1'], preuve: 'Gravure laser | ' + text, text: '« Gravure laser | ' + text + ' »', relevance: 0.9 }]);
    for (const second of [veto, null, { ...accepted, ligneGeste: 's2', sourceIds: ['s2'] }, { ...accepted, preuve: 'Mauvaise citation.' }]) {
      const refused = await tryAgain(second);
      expect(refused.chat).toHaveBeenCalledTimes(2);
      expect(refused.claims).toEqual([]);
    }
    for (const result of [await tryAgain(accepted, ['L’opérateur est incertain.']), await tryAgain(accepted, [], { ...veto, repond: undefined })]) {
      expect(result.chat).toHaveBeenCalledOnce();
      expect(result.claims).toEqual([]);
    }
  });

  it('vérifie le geste demandé sur la ligne affichée et retrouve un meilleur extrait dans la scène acceptée', async () => {
    const original = windows[0]!, template = original.entries[0]!;
    const wrong = 'Artus meule cette plaque de métal pour en lisser les bords.';
    const weld = 'Artus soude les deux plaques de métal en rapprochant les bords.';
    const archive = 'Dans l’épisode précédent, ils soudent les pieds de métal.';
    const thirdParty = 'Notre invité soude les deux plaques de métal.';
    async function check(lines: string[], response: 'ok' | 'non' | 'panne' | 'incertain' = 'ok') {
      const entries = lines.map((text, i) => ({ ...template, sourceId: `s${i + 1}`, text, startS: i * 4, endS: i * 4 + 3 }));
      const writer = { model: 'simulé', available: async () => true, chat: async () => response === 'panne' ? '{"videos":[' :
        JSON.stringify({ videos: [{ videoId: 'v1', repond: response !== 'non', lienIncertain: response === 'incertain', affirmation: 'Ils soudent le métal.',
          preuve: lines[0], sourceIds: ['s1'], ligneGeste: 's1' }] }) };
      const result = await answerByVideo(writer, { model: 'juge', judge: async () => [0.9] }, 0.4,
        'Quand soudent-ils du métal ?', [{ ...original, entries }], (id) => id,
        { rankedIds: ['s1'], actionTargets: [[{ term: 'métal', forms: ['metal'] }]] });
      return JSON.parse(result.raw).claims;
    }
    expect(await check([wrong])).toEqual([]);
    const repaired = await check([wrong, weld]);
    expect(repaired).toEqual([{ sourceIds: ['s2'], preuve: weld, text: `« ${weld} »`, relevance: 0.9 }]);
    expect(await check([wrong, weld], 'non')).toEqual([]);
    expect((await check([wrong, weld], 'panne'))[0]).toMatchObject({ sourceIds: ['s2'], preuve: weld, missing: expect.any(String) });
    expect(await check([wrong], 'panne')).toEqual([]);
    // Un passif sans rapport, un invité ou le doute du rédacteur ne prouvent même pas la mention du geste.
    const otherState = 'La tige en métal est serrée dans un étau, coupée à la scie puis pliée.';
    for (const unrelated of [otherState, 'Notre invité lime le métal.', otherState + ' | ÉCRAN : « SOUDURE »']) {
      expect(await check([unrelated])).toEqual([]);
      expect(await check([unrelated], 'incertain')).toEqual([]);
      expect((await check([unrelated, weld]))[0]).toMatchObject({ sourceIds: ['s2'], preuve: weld });
    }
    const weldedState = 'Voici le cadre de métal déjà soudé.';
    expect((await check([weldedState]))[0]).toMatchObject({ sourceIds: ['s1'], preuve: weldedState, missing: expect.any(String) });
    for (const indirect of [archive, thirdParty, 'Si nous soudons le métal, la fixation tiendra.']) {
      const result = await check([indirect]);
      expect(result.every((c: { missing?: string }) => !!c.missing)).toBe(true);
      expect(await check([wrong, indirect])).toEqual([]);
    }
  });

  it.each([
    ['Quand évoquent-ils Peltier et le compresseur ?', ['compresseur', 'Peltier'], 'compresseur'],
    ['Quand évoquent-ils Peltier ou le compresseur ?', ['compresseur', 'Peltier'], null],
    ['Quand évoquent-ils la sonde avec (Peltier ou le compresseur) ?', ['compresseur', 'sonde', 'Peltier'], 'sonde'],
  ] as const)('tient compte des contraintes explicites dans « %s »', async (question, required, absent) => {
    const { raw } = await run([{ ...cooler, lienIncertain: false }], vi.fn(), [...required], question);
    const claim = JSON.parse(raw).claims[0];
    if (absent) {
      expect(claim.missing).toContain(absent);
      expect(claim.missing).not.toContain('Peltier');
      expect(claim.text).toBe(`« ${cooler.preuve} »`);
    } else {
      expect(claim.missing).toBeUndefined();
      expect(claim.text).toBe(cooler.affirmation);
    }
  });

  it('écarte la mauvaise matière et une alternative seulement envisagée avant le streaming', async () => {
    const original = windows[0]!;
    const first = original.entries[0]!;
    const passage = {
      ...original,
      entries: [
        { ...first, sourceId: 's1', text: 'On découpe le feutre rouge pour le tapis.' },
        { ...first, sourceId: 's2', text: 'On découpe du coton ici. On aurait pu utiliser du cuir.' },
        { ...first, sourceId: 's3', text: 'Ces bandes de feutre sont déjà découpées en usine.' },
      ],
    };
    const judge = { model: 'juge simulé', judge: async () => [0.9] };
    const one = async (line: number, written: Partial<WrittenVideo> = {}, question = 'Quand découpent-ils du feutre ou du cuir ?') => {
      const entry = passage.entries[line]!;
      const llm = { model: 'rédacteur simulé', available: async () => true, chat: async () => JSON.stringify({
        videos: [{ videoId: 'v1', ligneGeste: entry.sourceId, sourceIds: [entry.sourceId], preuve: entry.text,
          affirmation: 'Le feutre est découpé pour le tapis.', ...written }],
      }) };
      const onBatch = vi.fn();
      const { raw } = await answerByVideo(llm, judge, 0.4, question, [passage], (s) => s, {
        actionTargets: [[{ term: 'feutre', forms: ['feutre'] }, { term: 'cuir', forms: ['cuir'] }]],
      }, { onBatch });
      return { claims: JSON.parse(raw).claims, onBatch };
    };
    const match = await one(0);
    expect(match.claims[0]).toMatchObject({ sourceIds: ['s1'], preuve: passage.entries[0]!.text });
    expect(match.onBatch).toHaveBeenCalledOnce();
    const other = await one(1);
    expect(other.claims).toEqual([]);
    expect(other.onBatch).not.toHaveBeenCalled();
    expect(match.claims[0].text).toBe(`« ${passage.entries[0]!.text} »`);
    const foreign = await one(0, { ligneGeste: 's999' });
    expect(foreign.claims).toEqual([]);
    const existing = await one(2);
    expect(existing.claims[0]).toMatchObject({ text: `« ${passage.entries[2]!.text} »`, missing: expect.stringContaining('qui a effectué le geste') });
    const explanation = await one(0, {}, 'Quand et pourquoi découpent-ils du feutre ?');
    expect(explanation.claims[0].text).toBe('Le feutre est découpé pour le tapis.');
  });
});

describe('jugement par vagues', () => {
  const videos = Array.from({ length: 400 }, (_, i) => ({ id: i }));
  const waves = { first: 150, next: 100, minYield: 0.1 };

  it('sujet étroit : une seule vague quand la suite n’apporte plus rien', async () => {
    const calls: number[] = [];
    // Pertinentes : les 20 premières seulement.
    const judged = await judgeInWaves(videos, async (wave) => {
      calls.push(wave.length);
      return wave.map((v) => (v.id < 20 ? 0.9 : 0.1));
    }, 0.3, waves);
    expect(calls).toEqual([150, 100]);
    expect(judged).toHaveLength(250);
    expect(judged.filter((v) => v.relevance >= 0.3)).toHaveLength(20);
  });

  it('sujet large : continue tant qu’une vague garde au moins 10 %', async () => {
    const calls: number[] = [];
    // Pertinentes : une sur quatre jusqu'à 300, plus rien ensuite.
    const judged = await judgeInWaves(videos, async (wave) => {
      calls.push(wave.length);
      return wave.map((v) => (v.id < 300 && v.id % 4 === 0 ? 0.8 : 0.05));
    }, 0.3, waves);
    expect(calls).toEqual([150, 100, 100, 50]);
    expect(judged.filter((v) => v.relevance >= 0.3)).toHaveLength(75);
  });
});
