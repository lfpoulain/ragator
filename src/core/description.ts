const URL_PATTERN = /https?:\/\/[^\s<>()\[\]«»"']+/g;
const AFFILIATED_PATTERN = /affili(?:é|e|es|s)|sponsor/i;
const CHAPTER_PATTERN = /^(\d{1,2}:\d{2}(?::\d{2})?)\s+(.+)$/;

export interface DescriptionBlock {
  id: string;
  section: string | null;
  text: string;
  fromChar: number;
  toChar: number;
  urls: string[];
  affiliated: boolean;
  chapter: { label: string; seconds: number } | null;
}

function isSectionHeader(trimmed: string): boolean {
  if (/https?:\/\//.test(trimmed)) return false;
  if (trimmed.length > 100) return false;
  return /:\s*$/.test(trimmed.replace(/\*/g, '').trimEnd());
}

function sectionLabel(trimmed: string): string {
  return trimmed
    .replace(/\*/g, '')
    .replace(/\s*:\s*$/, '')
    .trim();
}

function parseChapterSeconds(value: string): number {
  const parts = value.split(':').map((p) => Number.parseInt(p, 10));
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function buildDescriptionBlocks(
  videoId: string,
  description: string,
): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let section: string | null = null;
  let counter = 0;
  let offset = 0;

  const pushBlock = (
    text: string,
    fromChar: number,
    toChar: number,
    inChapterSection: boolean,
  ): void => {
    const urls = [...text.matchAll(URL_PATTERN)].map((m) => m[0]).filter((u): u is string => u !== undefined);
    const chapterMatch = CHAPTER_PATTERN.exec(text);
    const chapter =
      inChapterSection && chapterMatch
        ? {
            label: chapterMatch[2]?.trim() ?? '',
            seconds: parseChapterSeconds(chapterMatch[1] as string),
          }
        : null;
    counter += 1;
    blocks.push({
      id: `${videoId}:d${String(counter).padStart(5, '0')}`,
      section,
      text,
      fromChar,
      toChar,
      urls,
      affiliated: AFFILIATED_PATTERN.test(text) || AFFILIATED_PATTERN.test(section ?? ''),
      chapter,
    });
  };

  const lines = description.split(/\r?\n/);
  for (const line of lines) {
    const fromChar = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (isSectionHeader(trimmed)) {
      section = sectionLabel(trimmed) || trimmed;
      continue;
    }
    const inChapterSection = (section ?? '').toLowerCase().includes('chapitre');
    pushBlock(trimmed, fromChar, fromChar + line.length, inChapterSection);
  }
  return blocks;
}
