export interface FormatEntry {
  sourceId: string;
  kind: 'parole' | 'visuel';
  startS: number;
  endS: number | null;
  text: string;
  speaker: string | null;
  isVoiceOver: boolean;
  speakerIsNamed: boolean;
  planTitle: string | null;
  screenText: string[] | null;
  uncertainties: string[];
}

export interface FormatWindowInfo {
  videoId: string;
  title: string;
  publishedAt: string | null;
  startS: number;
  endS: number;
}

const SCREEN_INDENT = '              ';

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const seconds = s % 60;
  const minutes = Math.floor(s / 60) % 60;
  const hours = Math.floor(s / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRange(startS: number, endS: number): string {
  return `${formatTimestamp(startS)}–${formatTimestamp(endS)}`;
}

function speakerLabel(entry: FormatEntry): string {
  if (entry.speakerIsNamed && entry.speaker) return entry.speaker;
  if (entry.isVoiceOver) return 'voix off, identité inconnue';
  return 'identité inconnue';
}

function entryLine(entry: FormatEntry): string {
  if (entry.kind === 'parole') {
    const at =
      entry.endS !== null && entry.endS !== entry.startS
        ? `${formatTimestamp(entry.startS)}–${formatTimestamp(entry.endS)}`
        : formatTimestamp(entry.startS);
    return `[${entry.sourceId} @ ${at}] PAROLE (${speakerLabel(entry)}) : ${entry.text}`;
  }
  const title = entry.planTitle ?? '';
  const description = entry.text;
  const endS = entry.endS ?? entry.startS;
  const line = `[${entry.sourceId} @ ${formatTimestamp(entry.startS)}–${formatTimestamp(endS)}] PLAN : ${title} | ${description}`;
  const lines = [line];
  if (entry.screenText && entry.screenText.length > 0) {
    lines.push(`${SCREEN_INDENT}ÉCRAN : ${entry.screenText.map((t) => `« ${t} »`).join(' | ')}`);
  }
  for (const uncertainty of entry.uncertainties) {
    lines.push(`${SCREEN_INDENT}INCERTAIN : ${uncertainty}`);
  }
  return lines.join('\n');
}

export function formatWindow(info: FormatWindowInfo, entries: FormatEntry[]): string {
  const date = info.publishedAt ?? 'date inconnue';
  const header = `=== Fenêtre ${formatRange(info.startS, info.endS)} | vidéo ${info.videoId} | ${date} | « ${info.title} » ===`;
  const sorted = [...entries].sort(
    (a, b) =>
      a.startS - b.startS ||
      (a.endS ?? a.startS) - (b.endS ?? b.startS) ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
  );
  return [header, ...sorted.map(entryLine)].join('\n');
}
