import { aliasCanonical, isCanonicalBrand, variantsOf } from './brands.js';

const MAX_ALIAS_GRAM = 3;

export interface NormalizedText {
  norm: string;
  tokens: string[];
}

function foldAccents(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('\u0153', 'oe')
    .replaceAll('\u0152', 'oe')
    .replaceAll('\u00e6', 'ae')
    .replaceAll('\u00c6', 'ae')
    .normalize('NFC')
    .toLowerCase();
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isAlnum(c: string): boolean {
  return (c >= 'a' && c <= 'z') || isDigit(c);
}

function endsWithDigit(s: string): boolean {
  const last = s[s.length - 1];
  return last !== undefined && isDigit(last);
}

function tokenize(folded: string): string[] {
  const tokens: string[] = [];
  let current = '';
  const flush = () => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let i = 0; i < folded.length; i++) {
    const c = folded[i] as string;
    if (isAlnum(c)) {
      current += c;
      continue;
    }
    if (c === '.' && endsWithDigit(current)) {
      const next = folded[i + 1] ?? '';
      if (isDigit(next)) {
        current += '.';
        continue;
      }
    }
    if (c === '-' && current.length > 0 && isAlnum(folded[i + 1] ?? '')) {
      current += '-';
      continue;
    }
    flush();
  }
  flush();
  return tokens;
}

interface TokenParts {
  main: string;
  variants: string[];
}

function canonicalizeNumber(numberPart: string, unit: string): TokenParts {
  let canonical = numberPart;
  let decimal: { int: string; frac: string } | null = null;
  if (/^\d{1,3}(\.\d{3})+$/.test(canonical)) {
    canonical = canonical.replaceAll('.', '');
  } else {
    const decimalMatch = /^(\d+)\.(\d{1,2})$/.exec(canonical);
    if (decimalMatch) {
      decimal = { int: decimalMatch[1] as string, frac: decimalMatch[2] as string };
    }
  }
  const main = unit ? `${canonical} ${unit}` : canonical;
  const variants: string[] = [];
  if (decimal) {
    const split = `${decimal.int} ${decimal.frac}`;
    variants.push(unit ? `${main} ${split} ${unit}` : `${main} ${split}`);
  }
  return { main, variants };
}

function canonicalizeToken(token: string): TokenParts {
  if (/^\d/.test(token)) {
    const numericUnit = /^(\d[\d.]*)([a-z]+)$/.exec(token);
    if (numericUnit) {
      return canonicalizeNumber(numericUnit[1] as string, numericUnit[2] as string);
    }
    return canonicalizeNumber(token, '');
  }
  if (token.includes('-')) {
    const parts = token.split('-').filter((p) => p.length > 0);
    if (parts.length > 1) {
      const inner = parts.map((p) => canonicalizeToken(p));
      const joined = inner.map((p) => p.main).join(' ');
      const variants = [`${token} ${joined}`];
      for (const part of inner) {
        variants.push(...part.variants);
      }
      return { main: token, variants };
    }
  }
  const compound = /^([a-z]+)(\d+)([a-z]*)$/.exec(token);
  if (compound && (compound[1] as string).length > 0) {
    const letters = compound[1] as string;
    const digits = compound[2] as string;
    const tail = compound[3] as string;
    const split = `${letters} ${digits}${tail}`;
    return { main: token, variants: [`${token} ${split}`] };
  }
  return { main: token, variants: [] };
}

function applyBrands(tokens: string[], variants: string[]): void {
  const n = tokens.length;
  for (let i = 0; i < n; i++) {
    const maxLen = Math.min(MAX_ALIAS_GRAM, n - i);
    for (let len = maxLen; len >= 1; len--) {
      const gram = tokens.slice(i, i + len).join(' ');
      if (isCanonicalBrand(gram)) {
        for (const variante of variantsOf(gram)) {
          variants.push(`${gram} ${variante}`);
        }
        break;
      }
      const canonical = aliasCanonical(gram);
      if (canonical) {
        variants.push(`${gram} ${canonical}`);
        break;
      }
    }
  }
}

export function tokenizeText(input: string): NormalizedText {
  const folded = foldAccents(input).replace(/(\d),(\d)/g, '$1.$2');
  const rawTokens = tokenize(folded);
  const mains: string[] = [];
  const variants: string[] = [];
  const seenVariants = new Set<string>();
  for (const raw of rawTokens) {
    const { main, variants: tokenVariants } = canonicalizeToken(raw);
    mains.push(main);
    for (const v of tokenVariants) {
      if (!seenVariants.has(v)) {
        seenVariants.add(v);
        variants.push(v);
      }
    }
  }
  applyBrands(mains, variants);
  const norm = variants.length
    ? `${mains.join(' ')} | ${variants.join(' ')}`
    : mains.join(' ');
  return { norm, tokens: mains };
}

export function normalizeText(input: string): string {
  return tokenizeText(input).norm;
}
