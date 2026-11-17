import type { Pool } from 'pg';
import { videoLink } from '../links.js';
import { readSnapshot } from '../db/pool.js';
import { tokenizeText } from '../norm/normalize.js';
import type { AnswerResult } from './answer.js';
import type { DescriptionBlock } from './description.js';
import { collectionSql, videoIdSql, videoIdsSql } from './filters.js';
import type { AnswerSource } from './sources.js';

/**
 * Crédits des descriptions YouTube (« Montage : Jean Dupont », « Animations 3D et montage additionnel :
 * Alice Martin ») : qui a monté, cadré, mixé, écrit une vidéo. Ni les paroles ni les plans ne le
 * disent ; la recherche classée ne lit pas les descriptions. La réponse est construite par le code,
 * exhaustive, comme un décompte : chaque vidéo citée avec sa ligne de crédit.
 */

export type CreditRole = 'montage' | 'cadre' | 'son' | 'musique' | 'ecriture' | 'animation' | 'post-production' | 'production' | 'sous-titres';

export const ROLE_LABELS: Record<CreditRole, string> = {
  montage: 'au montage',
  cadre: 'au cadre',
  son: 'au son et au mixage',
  musique: 'à la musique',
  ecriture: 'à l’écriture',
  animation: 'aux animations',
  'post-production': 'à la post-production (étalonnage, effets)',
  production: 'à la production',
  'sous-titres': 'aux sous-titres',
};

/** Rôles d'un intitulé de crédit (formes sans accents, en minuscules). */
const LABEL_ROLES: Array<[RegExp, CreditRole]> = [
  [/\bmont(age|eur|euse)\b/, 'montage'],
  [/\bcadr(e|eur|euse)\b|\btournage\b/, 'cadre'],
  [/\bmixage\b|^son\b|\bson$/, 'son'],
  [/\bmusiques?\b/, 'musique'],
  [/\becriture\b|\bscenario\b/, 'ecriture'],
  [/\banimations?\b/, 'animation'],
  [/\bpost-production\b|\betalonnage\b|\beffets visuels\b/, 'post-production'],
  // Pas « post-production » : `\b` coupe au trait d'union.
  [/(?<![-\w])production\b/, 'production'],
  [/\bsous-titres\b/, 'sous-titres'],
];
/** Premier mot d'un intitulé de crédit : le reste (« Caméra GH5 : », « Son Instagram : ») est du matériel ou un lien. */
const LABEL_HEADS = new Set([
  'montage', 'monteur', 'monteuse', 'cadre', 'cadreur', 'cadreuse', 'tournage', 'mixage', 'son', 'musique', 'musiques',
  'ecriture', 'recherche', 'preparation', 'scenario', 'animations', 'animation', 'assistanat', 'assistant', 'assistante',
  'post-production', 'etalonnage', 'production', 'sous-titres', 'creation',
]);
const LABEL_NOISE = /\b(instagram|site|carte|video|test|code|camera|twitter|facebook|tiktok|youtube)\b/;
const CREDIT_LINE = /^[\s*•\-–]*\**([^:]{2,70}?)\**\s*:\s*(\S.*)$/u;

export interface CreditLine {
  roles: CreditRole[];
  /** Intitulé tel qu'écrit (« Montage et Cadre »). */
  label: string;
  /** Noms crédités, sans liens. */
  names: string;
}

/** Ligne de crédit d'un bloc de description, ou `null` (lien, matériel, texte libre). */
export function parseCreditLine(text: string): CreditLine | null {
  const match = CREDIT_LINE.exec(text.trim());
  if (!match) return null;
  const label = match[1]!.replace(/\*/g, '').trim();
  const norm = tokenizeText(label).tokens.join(' ');
  const head = norm.split(' ')[0] ?? '';
  if (!LABEL_HEADS.has(head) || LABEL_NOISE.test(norm)) return null;
  const roles = LABEL_ROLES.filter(([re]) => re.test(norm)).map(([, role]) => role);
  // « Assistanat de production », « Assistant montage » : le rôle est celui qu'on assiste.
  if (roles.length === 0) return null;
  const names = match[2]!.replace(/https?:\/\/\S+/g, '').replace(/[\s:,;–-]+$/u, '').trim();
  if (names.length < 2) return null;
  return { roles: [...new Set(roles)], label, names };
}

/** Rôles demandés par une question (formes sans accents). */
const QUESTION_ROLES: Array<[RegExp, CreditRole]> = [
  [/\bmont(e|ee|es|ees|er|ait|aient|ent|age|eur|euse|euses|eurs)\b/, 'montage'],
  [/\bcadr(e|ee|es|ees|er|age|eur|euse)\b|\bfilm(e|ee|es|ees|er|ait)\b|\btourn(e|ee|es|ees|er|age)\b/, 'cadre'],
  [/\bmix(e|ee|es|ees|er|age)\b/, 'son'],
  [/\bmusiques?\b|\bcompos(e|ee|es|ees|er|ition)\b/, 'musique'],
  [/\becri(t|te|ts|tes|re|ture)\b|\bscenario\b/, 'ecriture'],
  [/\banim(e|ee|es|ees|er|ation|ations)\b/, 'animation'],
  [/\betalonn(e|ee|er|age)\b|\bpost-production\b|\beffets visuels\b/, 'post-production'],
  [/\bsous-titr(e|es|age|ee|ees)\b/, 'sous-titres'],
];
/** Noms de métier : la question parle forcément de la fabrication de la vidéo. */
const CRAFT_NOUNS = /\b(montage|monteur|monteuse|monteurs|monteuses|cadreur|cadreuse|cadreurs|generique|credits?|mixage|etalonnage|sous-titres|post-production)\b/;
/** Verbe de métier appliqué à une vidéo (« monté la vidéo », « quelles vidéos a-t-il cadrées »). */
const VIDEO_OBJECT =
  /\b(mont|cadr|film|tourn|realis|produi|anim|mix|ecri|compos|sous-titr)[\w-]*\s+(?:(?:la|les|cette|ces|leur|leurs|une|des|ses|sa|son|ce)\s+)?(?:videos?|episodes?)\b|\b(?:videos?|episodes?)\b.{0,40}\b(mont|cadr|film|tourn|mix|ecri|anim)\w*\b/;

export interface CreditQuestion {
  roles: CreditRole[];
}

/**
 * Question sur les crédits d'une vidéo, ou `null`. « Monter » est ambigu dans une chaîne de bricolage
 * (« ils ont monté le meuble ») : il faut un nom de métier ou une vidéo comme objet.
 */
export function creditQuestion(question: string): CreditQuestion | null {
  const norm = ` ${tokenizeText(question).tokens.join(' ')} `;
  const roles = QUESTION_ROLES.filter(([re]) => re.test(norm)).map(([, role]) => role);
  if (roles.length === 0) return null;
  if (!CRAFT_NOUNS.test(norm) && !VIDEO_OBJECT.test(norm)) return null;
  return { roles: [...new Set(roles)] };
}

/** Noms de famille de la chaîne : « les Frères Poulain » ne désigne pas une personne créditée. */
const NOT_A_PERSON = new Set(['poulain', 'freres', 'les', 'des', 'video', 'videos']);

/** Mots de la question qui désignent une personne créditée (prénom ou nom, 3 lettres au moins). */
export function namedPeople(question: string, creditedNames: Iterable<string>): string[] {
  const asked = new Set(tokenizeText(question).tokens.filter((t) => t.length >= 3 && !NOT_A_PERSON.has(t)));
  const found = new Set<string>();
  for (const names of creditedNames) {
    // Seuls les mots à majuscule (ou @pseudo) sont des noms : « son premier montage pour Scilabus » n'en
    // a qu'un, « Scilabus ».
    const proper = names.split(/[^\p{L}\p{N}@'’-]+/u).filter((word) => /^[\p{Lu}@]/u.test(word));
    for (const token of tokenizeText(proper.join(' ')).tokens) if (token.length >= 3 && asked.has(token)) found.add(token);
  }
  return [...found];
}

interface CreditedVideo {
  videoId: string;
  title: string;
  publishedAt: string | null;
  credits: Array<CreditLine & { sourceId: string; text: string }>;
}

type Base = Pick<AnswerResult, 'question' | 'resolvedQuestion' | 'route' | 'mode' | 'promptVersion' | 'analysis'>;

/**
 * Réponse construite par le code : une personne nommée → toutes les vidéos où elle est créditée pour
 * ce rôle, de la plus ancienne à la plus récente ; sans nom → les crédits des vidéos visées (vidéo
 * citée, série, chaîne), ou le bilan des personnes créditées sur tout le corpus.
 */
export async function answerCredits(
  pool: Pool,
  question: string,
  asked: CreditQuestion,
  scope: { videoId?: string | null; videoIds?: string[] | null; collection?: string | null },
  base: Base,
  startedAt: number,
): Promise<AnswerResult> {
  return readSnapshot(pool, async (db, versions) => {
    const params: unknown[] = [];
    const filters = `${videoIdSql(scope.videoId ?? undefined, params)} ${videoIdsSql(scope.videoIds ?? undefined, params)} ${collectionSql(scope.collection ?? undefined, params)}`;
    const { rows } = await db.query<{ video_id: string; title: string; published_at: string | null; description_blocks: DescriptionBlock[] }>(
      `SELECT v.video_id, v.title, v.published_at::text AS published_at, v.description_blocks
       FROM videos v WHERE true ${filters}
       ORDER BY v.published_at NULLS LAST, v.video_id`,
      params,
    );
    const videos: CreditedVideo[] = rows.map((row) => ({
      videoId: row.video_id,
      title: row.title,
      publishedAt: row.published_at,
      credits: row.description_blocks.flatMap((block) => {
        if (block.chapter) return [];
        const line = parseCreditLine(block.text);
        return line && line.roles.some((r) => asked.roles.includes(r)) ? [{ ...line, sourceId: block.id, text: block.text.trim() }] : [];
      }),
    }));
    const people = namedPeople(question, videos.flatMap((v) => v.credits.map((c) => c.names)));
    const roleLabel = asked.roles.map((r) => ROLE_LABELS[r]).join(' ou ');
    const single = Boolean(scope.videoId) || (scope.videoIds?.length ?? 0) > 0;

    const common = {
      ...base,
      route: 'infos' as const,
      claims: [] as AnswerResult['claims'],
      invalidCitations: [] as string[],
      exhaustive: null,
      expansion: null,
      retrieval: 'corpus' as const,
      degraded: false,
      degradedReason: null,
      model: null,
      corpusVersion: versions.corpusVersion,
      indexVersion: versions.indexVersion,
    };
    const done = (answer: string, listed: CreditedVideo[], refused = false): AnswerResult => {
      const sources: AnswerSource[] = listed.flatMap((v) =>
        v.credits.map((c) => ({
          sourceId: c.sourceId,
          sourceIds: [c.sourceId],
          videoId: v.videoId,
          title: v.title,
          publishedAt: v.publishedAt,
          kind: 'description' as const,
          startS: null,
          endS: null,
          link: videoLink(v.videoId),
          excerpt: c.text,
          urls: [],
        })),
      );
      return {
        ...common,
        answer,
        refused,
        sources,
        citedSourceIds: sources.map((s) => s.sourceId),
        consideredVideoIds: videos.map((v) => v.videoId),
        timings: { searchMs: Date.now() - startedAt, llmMs: 0, totalMs: Date.now() - startedAt },
      };
    };
    const line = (v: CreditedVideo, credits = v.credits) =>
      `- ${v.publishedAt ?? 'date inconnue'} « ${v.title} » — ${credits.map((c) => `${c.label} : ${c.names}`).join(' ; ')}\n  ${videoLink(v.videoId)}`;

    if (people.length > 0) {
      const matches = (c: CreditLine) => tokenizeText(c.names).tokens.some((t) => people.includes(t));
      const listed = videos.filter((v) => v.credits.some(matches)).map((v) => ({ ...v, credits: v.credits.filter(matches) }));
      const who = people.map((p) => p[0]!.toUpperCase() + p.slice(1)).join(' ou ');
      if (listed.length === 0) return done(`Aucune description de vidéo ne crédite ${who} ${roleLabel}.`, [], true);
      return done(
        [
          `Crédits ${roleLabel} ${/^[aeiouyhéèâîô]/i.test(who) ? 'd’' : 'de '}${who} dans les descriptions YouTube : ${listed.length} vidéo(s), de la plus ancienne à la plus récente.`,
          ...listed.map((v) => line(v)),
        ].join('\n'),
        listed,
      );
    }

    const credited = videos.filter((v) => v.credits.length > 0);
    if (single) {
      if (credited.length === 0) return done(`La description de cette vidéo ne donne aucun crédit ${roleLabel}.`, [], true);
      return done([`Crédits ${roleLabel}, d’après les descriptions YouTube :`, ...credited.map((v) => line(v))].join('\n'), credited);
    }
    // Tout le corpus (ou une chaîne) : bilan par personne, sans lister des centaines de vidéos.
    const byPerson = new Map<string, { count: number; from: string | null; to: string | null }>();
    for (const v of credited) {
      for (const name of new Set(v.credits.flatMap((c) => c.names.split(/\s*(?:,|\/|&|\bet\b|\(.*?\))\s*/u)).map((n) => n.trim()).filter((n) => n.length >= 3))) {
        const entry = byPerson.get(name) ?? { count: 0, from: v.publishedAt, to: v.publishedAt };
        entry.count += 1;
        entry.to = v.publishedAt ?? entry.to;
        byPerson.set(name, entry);
      }
    }
    if (byPerson.size === 0) return done(`Aucune description ne donne de crédit ${roleLabel}.`, [], true);
    const ranked = [...byPerson].sort((a, b) => b[1].count - a[1].count).slice(0, 15);
    return done(
      [
        `Personnes créditées ${roleLabel} dans les descriptions YouTube (${credited.length} vidéo(s) avec ce crédit) :`,
        ...ranked.map(([name, e]) => `- ${name} : ${e.count} vidéo(s)${e.from ? `, de ${e.from.slice(0, 4)} à ${(e.to ?? e.from).slice(0, 4)}` : ''}`),
        '',
        'Pour la liste de ses vidéos, nommez la personne (« quelles vidéos Jean Dupont a-t-il montées ? »).',
      ].join('\n'),
      [],
    );
  });
}
