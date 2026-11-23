import { parseClaims } from '../prompts/answer.js';
import { groupSources, reference, type AnswerSource } from './sources.js';

/**
 * Citations : lecture des références écrites par le modèle, rattachement aux
 * sources fournies, validation des affirmations et rendu de la réponse.
 */

export type AnswerMode = 'court' | 'détaillé' | 'extractif';

export interface Claim {
  text: string;
  sourceIds: string[];
  /** Extrait recopié par le rédacteur et retrouvé dans les sources attribuées. */
  preuve?: string;
  /** Valeur alternative effectivement présente dans une ligne citée, si la réponse rectifie la prémisse. */
  correction?: string;
  relevance?: number;
  /** Pourquoi la vidéo ne prouve pas la réponse : marque absente de ses extraits, ou pas sur le même plan que le sujet. */
  missing?: string;
  /** Questions générales : le sujet n'est que mentionné, ou n'apparaît que dans un passage promotionnel (absent : la vidéo le traite). */
  nature?: 'en_passant' | 'promotion';
}

/** Écart toléré pour rattacher une citation `[videoId @ mm:ss]` à une entrée. */
const CITATION_TOLERANCE_S = 15;

/**
 * `[Gu8bnHQaG5s:t00061 @ 03:41]`, `[Gu8bnHQaG5s:d00003]`, `[Gu8bnHQaG5s @ 03:41–03:45]`,
 * et deux déformations observées du modèle : l'identifiant local `[t00061 @ 03:41]`
 * et l'identifiant de vidéo privé de son `_`/`-` initial (`[R2GNWk1k34 @ 01:40]`).
 */
const CITATION_PATTERN =
  /\[([A-Za-z0-9_-]{11}(?::[A-Za-z0-9]+)?|[A-Za-z0-9_-]{10}(?=:|\s*@)(?::[A-Za-z0-9]+)?|[tvd]\d{5})(?:\s*@\s*([0-9:]+(?:\s*[–-]\s*[0-9:]+)?))?\s*\]/g;
const LOCAL_ID = /^[tvd]\d{5}$/;

export interface ParsedCitation {
  raw: string;
  ref: string;
  startS: number | null;
}

export function parseTimestamp(value: string): number {
  return value
    .trim()
    .split(':')
    .map((part) => Number.parseInt(part, 10) || 0)
    .reduce((total, part) => total * 60 + part, 0);
}

export function extractParsedCitations(text: string): ParsedCitation[] {
  const found: ParsedCitation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    const raw = match[0];
    if (seen.has(raw)) continue;
    seen.add(raw);
    const range = match[2];
    found.push({ raw, ref: match[1]!, startS: range ? parseTimestamp(range.split(/[–-]/)[0]!) : null });
  }
  return found;
}

export function extractCitations(text: string): string[] {
  return [...new Set(extractParsedCitations(text).map((c) => c.ref))];
}

/** Écart en secondes entre un instant cité et l'intervalle d'une source. */
function gapTo(source: AnswerSource, atS: number): number {
  if (source.startS === null) return Number.POSITIVE_INFINITY;
  const end = Math.max(source.endS ?? source.startS, source.startS);
  return atS < source.startS ? source.startS - atS : Math.max(0, atS - end);
}

function closest(candidates: Array<[string, AnswerSource]>, atS: number): string | null {
  let best: { id: string; gap: number } | null = null;
  for (const [id, source] of candidates) {
    const gap = gapTo(source, atS);
    if (gap <= CITATION_TOLERANCE_S && (best === null || gap < best.gap)) best = { id, gap };
  }
  return best?.id ?? null;
}

/** Compare deux identifiants de vidéo en tolérant la perte du `_`/`-` initial. */
function sameVideo(a: string, b: string): boolean {
  return a === b || a.replace(/^[_-]+/, '') === b.replace(/^[_-]+/, '');
}

/**
 * Rattache une citation à une source fournie pour cette requête :
 * - identifiant exact : il fait foi ;
 * - identifiant local (`t00020`) ou vidéo déformée : la seule source fournie
 *   qui correspond, l'instant départageant plusieurs candidates ;
 * - `[videoId @ mm:ss]` : l'entrée de cette vidéo qui couvre l'instant.
 * Un instant à plus de 15 s de la source rend la citation invalide.
 */
export function resolveCitation(citation: ParsedCitation, sources: Map<string, AnswerSource>): string | null {
  if (sources.has(citation.ref)) return citation.ref;
  const [first, second] = citation.ref.split(':');
  const video = LOCAL_ID.test(citation.ref) ? null : first!;
  const local = LOCAL_ID.test(citation.ref) ? citation.ref : (second ?? null);
  const candidates = [...sources.entries()].filter(
    ([id, source]) => (video === null || sameVideo(source.videoId, video)) && (local === null || id.endsWith(`:${local}`)),
  );
  if (local !== null && candidates.length === 1) {
    const [id, source] = candidates[0]!;
    return citation.startS === null || gapTo(source, citation.startS) <= CITATION_TOLERANCE_S ? id : null;
  }
  return citation.startS === null ? null : closest(candidates, citation.startS);
}

/** Rattache un identifiant écrit par le modèle (éventuellement déformé) à une source fournie. */
function resolveId(written: string, sources: Map<string, AnswerSource>, aliases?: Map<string, string>): string | null {
  // Le modèle recopie parfois la référence entière : « [id @ 00:39–00:44] » ou « [s12 03:41] ».
  const bare = written.trim().replace(/^\[+|\]+$/g, '').trim();
  const alias = aliases?.get(bare.split(/\s/)[0] ?? '');
  if (alias !== undefined) return sources.has(alias) ? alias : null;
  const parsed = extractParsedCitations(`[${bare}]`)[0] ?? { raw: written, ref: bare, startS: null };
  return resolveCitation(parsed, sources);
}

/**
 * Valide la sortie du modèle et reconstruit la réponse à partir des
 * seules affirmations appuyées sur une source fournie : une affirmation dont
 * aucun identifiant n'est valide est retirée. Sortie hors du schéma imposé :
 * aucune affirmation gardée (`offSchema`), la réponse devient extractive.
 */
export function validateClaims(
  raw: string,
  sources: Map<string, AnswerSource>,
  mode: AnswerMode,
  aliases?: Map<string, string>,
  preserveOrder = false,
): { claims: Claim[]; invalid: string[]; refused: boolean; answer: string; offSchema?: boolean } {
  const invalid: string[] = [];
  const structured = parseClaims(raw);
  // Sortie hors du schéma imposé : aucune affirmation n'est gardée (repli extractif signalé). Rattacher
  // tout le texte aux citations trouvées laisserait passer des phrases sans preuve.
  if (structured === null) return { claims: [], invalid, refused: false, answer: '', offSchema: true };

  const claims: Claim[] = [];
  for (const claim of structured.claims) {
    const ids: string[] = [];
    for (const written of claim.sourceIds) {
      const id = resolveId(written, sources, aliases);
      if (id === null) invalid.push(written);
      else if (!ids.includes(id)) ids.push(id);
    }
    if (claim.preuve !== undefined) {
      const checked = sourcesForProof(claim.preuve, ids, sources);
      if (!checked.length) {
        invalid.push(...ids);
        continue;
      }
      ids.splice(0, ids.length, ...checked);
    }
    // Le texte ne doit porter aucune référence : le code les ajoute.
    const text = claim.text.replace(CITATION_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    if (ids.length > 0 && text.length > 0) {
      claims.push({
        text,
        sourceIds: ids,
        ...(claim.preuve === undefined ? {} : { preuve: claim.preuve }),
        ...(claim.correction && ids.some((id) => sourceContainsProof(sources.get(id)!, claim.correction!)) ? { correction: claim.correction } : {}),
        ...(claim.relevance === undefined ? {} : { relevance: claim.relevance }),
        ...(claim.missing === undefined ? {} : { missing: claim.missing }),
        ...(claim.nature === undefined ? {} : { nature: claim.nature }),
      });
    }
  }
  return { claims, invalid, refused: structured.refus || structured.claims.length === 0, answer: renderClaims(claims, sources, mode, preserveOrder) };
}

// Les accents et la ponctuation d'une transcription varient. Les nombres signés, décimales et unités
// restent distincts : « 54 € » ne prouve ni « 154 € » ni « -54 € ».
function proofText(text: string): string {
  const normalized = text.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/−/g, '-').replace(/(\d),(?=\d)/g, '$1.');
  return (normalized.match(/-?\d+(?:\.\d+)?|\p{L}+|[%€$£°±+]/gu) ?? []).join(' ');
}

export function sourceContainsProof(source: Pick<AnswerSource, 'excerpt'>, proof: string): boolean {
  const wanted = proofText(proof);
  return /[\p{L}\d]/u.test(wanted) && ` ${proofText(source.excerpt)} `.includes(` ${wanted} `);
}

/**
 * Vérifie la citation exacte en priorité dans les lignes indiquées. Une preuve assez longue et unique
 * peut corriger une erreur de ligne dans la même vidéo. Une preuve ambiguë, absente ou provenant
 * d'une autre vidéo ne justifie aucune affirmation.
 */
export function sourcesForProof(proof: string, cited: string[], sources: ReadonlyMap<string, AnswerSource>): string[] {
  const wanted = proofText(proof);
  if (!/[\p{L}\d]/u.test(wanted) || cited.length === 0) return [];
  const matches = (source: AnswerSource) => sourceContainsProof(source, proof);
  const videoId = sources.get(cited[0]!)?.videoId;
  if (!videoId || cited.some((id) => sources.get(id)?.videoId !== videoId)) return [];
  if (cited.some((id) => matches(sources.get(id)!))) return cited;
  if (wanted.split(' ').length < 4) return [];
  let found: string | undefined;
  for (const [id, source] of sources) {
    if (source.videoId !== videoId || !matches(source)) continue;
    if (found !== undefined) return [];
    found = id;
  }
  return found === undefined ? [] : [found];
}

/** En dessous, une vidéo retenue par JEV est présentée à part, « à vérifier ». */
export const SURE_RELEVANCE = 0.5;

/**
 * Texte de la réponse à partir des affirmations validées. Les vidéos que
 * JEV n'a retenues que de justesse (seuil bas) passent en fin de
 * réponse, sous « à vérifier » : le rappel reste, le bruit est signalé.
 */
export function renderClaims(claims: Claim[], sources: Map<string, AnswerSource>, mode: AnswerMode, preserveOrder = false): string {
  // Une référence par séquence : des lignes voisines d'une même scène ne se répètent pas.
  const uncertain = (c: Claim) => c.relevance !== undefined && c.relevance < SURE_RELEVANCE;
  // Ordre imposé (par date) : la nature de la mention se lit sur la ligne, faute de pouvoir la regrouper.
  const aside = (c: Claim) => (!preserveOrder ? '' : c.nature === 'promotion' ? ' (passage sponsorisé ou promotionnel)' : c.nature === 'en_passant' ? ' (évoqué en passant)' : '');
  const line = (c: Claim) => `${c.text}${aside(c)}${preserveOrder && uncertain(c) ? ' (pertinence incertaine, à vérifier)' : ''} ${groupSources(c.sourceIds.map((id) => sources.get(id)!)).map(reference).join(' ')}`;
  const list = (items: Claim[]) => items.map((c) => `- ${line(c)}`).join('\n');
  // Vidéos qui ne citent pas la marque ou le modèle demandé : à part, après les vidéos prouvées.
  const unproven = new Map<string, Claim[]>();
  for (const claim of claims) {
    if (claim.missing === undefined) continue;
    const group = unproven.get(claim.missing) ?? [];
    group.push(claim);
    unproven.set(claim.missing, group);
  }
  if (unproven.size > 0) {
    const proven = claims.filter((c) => c.missing === undefined);
    const tail = [...unproven].map(([reason, group]) => `Éventuellement (${reason}, à vérifier) :\n${list(group)}`).join('\n\n');
    return proven.length === 0 ? tail : `${renderClaims(proven, sources, mode, preserveOrder)}\n\n${tail}`;
  }
  if (mode === 'court') return claims.map(line).join(' ');
  if (preserveOrder) return list(claims);
  // Les vidéos qui traitent le sujet d'abord ; les simples mentions et les passages promotionnels ensuite,
  // sous leur titre : rien n'est retiré, mais un sponsor ne passe plus pour une vidéo sur le sujet.
  const unsure = claims.filter(uncertain);
  const sure = claims.filter((c) => !uncertain(c));
  const sections = [
    list(sure.filter((c) => c.nature === undefined)),
    section('Évoqué en passant', sure.filter((c) => c.nature === 'en_passant')),
    section('Seulement dans un passage sponsorisé ou promotionnel', sure.filter((c) => c.nature === 'promotion')),
    section('Pertinence incertaine, à vérifier', unsure),
  ];
  return sections.filter(Boolean).join('\n\n');

  function section(title: string, items: Claim[]): string {
    return items.length === 0 ? '' : `${title} :\n${list(items)}`;
  }
}
