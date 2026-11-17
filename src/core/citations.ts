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

function parseTimestamp(value: string): number {
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
    // Preuve recopiée (`llm.proof`) : si elle n'est dans aucune ligne citée, la ligne qui la contient fait foi.
    if (claim.preuve) {
      const owner = proofOwner(claim.preuve, ids, sources);
      if (owner !== null) ids.splice(0, ids.length, owner);
    }
    // Le texte ne doit porter aucune référence : le code les ajoute.
    const text = claim.text.replace(CITATION_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
    if (ids.length > 0 && text.length > 0) {
      claims.push({
        text,
        sourceIds: ids,
        ...(claim.relevance === undefined ? {} : { relevance: claim.relevance }),
        ...(claim.missing === undefined ? {} : { missing: claim.missing }),
        ...(claim.nature === undefined ? {} : { nature: claim.nature }),
      });
    }
  }
  return { claims, invalid, refused: structured.refus || structured.claims.length === 0, answer: renderClaims(claims, sources, mode, preserveOrder) };
}

const proofText = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Ligne qui contient la preuve recopiée par le modèle, quand aucune des lignes qu'il cite ne la
 * contient ; `null` si une ligne citée la contient déjà, ou si aucune ligne ne la contient (preuve
 * reformulée : les identifiants écrits restent). Preuves de moins de 4 mots ignorées.
 */
function proofOwner(proof: string, cited: string[], sources: Map<string, AnswerSource>): string | null {
  const wanted = proofText(proof);
  if (wanted.split(' ').length < 4) return null;
  if (cited.some((id) => proofText(sources.get(id)?.excerpt ?? '').includes(wanted))) return null;
  for (const [id, source] of sources) if (proofText(source.excerpt).includes(wanted)) return id;
  return null;
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
  if (mode === 'court') return claims.map(line).join(' ');
  const list = (items: Claim[]) => items.map((c) => `- ${line(c)}`).join('\n');
  // Vidéos qui ne citent pas la marque ou le modèle demandé : à part, après les vidéos prouvées.
  const unproven = claims.filter((c) => c.missing !== undefined);
  if (unproven.length > 0) {
    const proven = claims.filter((c) => c.missing === undefined);
    const tail = `Éventuellement (${unproven[0]!.missing}, à vérifier) :\n${list(unproven)}`;
    return proven.length === 0 ? tail : `${renderClaims(proven, sources, mode, preserveOrder)}\n\n${tail}`;
  }
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
