const UNNAMED_PATTERNS = [
  /^indetermine$/,
  /^invite(?: \d+)?$/,
  /^intervenant(?: \d+)?$/,
  /^voff$/,
  /^voix off$/,
];

export interface MappedSpeaker {
  speaker: string | null;
  speakerRaw: string;
  speakerIsNamed: boolean;
  isVoiceOver: boolean;
}

function foldLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function mapSpeaker(rawLabel: string): MappedSpeaker {
  const folded = foldLabel(rawLabel);
  const unnamed = UNNAMED_PATTERNS.some((pattern) => pattern.test(folded));
  const isVoiceOver = folded === 'voff' || folded === 'voix off';
  return {
    speaker: unnamed ? null : rawLabel.trim(),
    speakerRaw: rawLabel,
    speakerIsNamed: !unnamed,
    isVoiceOver,
  };
}
