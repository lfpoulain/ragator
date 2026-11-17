import type { Page } from '../core/page.js';
import type { StatsData } from '../core/stats.js';

export function printStats(page: Page<StatsData>): void {
  const d = page.data;
  const e = d.embeddings;
  console.log(`corpus_version : ${page.corpusVersion}`);
  console.log(`index_version  : ${page.indexVersion}`);
  console.log(
    `vidéos         : ${d.videos} (durée totale ${d.totalDurationS} s, ${d.estimatedDurations} estimée(s), ${d.unknownPublicationDates} date(s) inconnue(s))`,
  );
  console.log(`entrées        : ${d.entries.parole + d.entries.visuel} (paroles ${d.entries.parole}, plans ${d.entries.visuel})`);
  console.log(`dates          : ${d.dateRange.from ?? '?'} → ${d.dateRange.to ?? '?'}`);
  console.log(`blocs de 30 s  : ${d.chunks.total} (${d.chunks.enriched} enrichis, ${d.chunks.pendingEnrichment} à enrichir)`);
  console.log(`taille indexée : ${(d.indexedBytes / (1024 * 1024)).toFixed(1)} Mo`);
  console.log(
    `embeddings     : ${e.done} faits, ${e.pending} en attente (entrées ${e.entries.done}/${e.entries.done + e.entries.pending}, ` +
      `blocs ${e.chunks.done}/${e.chunks.done + e.chunks.pending}, vidéos ${e.videos.done}/${e.videos.done + e.videos.pending}) — modèle ${e.model ?? 'aucun'}, index HNSW ${e.vectorIndex ? 'présent' : 'absent'}`,
  );
  for (const job of d.jobs) console.log(`jobs           : ${job.type} ${job.state} × ${job.count}`);
}
