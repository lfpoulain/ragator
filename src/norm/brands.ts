/**
 * Marques dont l'écriture varie dans le corpus (espaces, fautes de transcription) : alias → forme
 * canonique, à l'ingestion comme dans la question. Une marque toujours écrite pareil n'a pas besoin
 * d'y figurer. Relevé le 14 octobre 2026 sur les paroles, les plans et l'écran des 404 vidéos, à partir
 * des partenaires cités dans les descriptions. Changer la liste réingère le corpus (texte normalisé
 * seulement : vecteurs et enrichissement sont conservés).
 */
export const BRANDS_VERSION = '2';

export interface Brand {
  canonical: string;
  aliases: string[];
  variantes: string[];
}

export const BRANDS: Brand[] = [
  { canonical: 'nordvpn', aliases: [], variantes: ['nord vpn'] },
  { canonical: 'parkside', aliases: [], variantes: [] },
  { canonical: 'bambulab', aliases: ['bamboo lab'], variantes: ['bambu lab'] },
  { canonical: 'aeg', aliases: [], variantes: [] },
  { canonical: 'tacklife', aliases: ['tack life'], variantes: [] },
  { canonical: 'x20v team', aliases: ['x20v'], variantes: ['x 20v team'] },
  { canonical: 'meshy', aliases: [], variantes: [] },
  { canonical: 'crivit', aliases: [], variantes: [] },
  { canonical: 'ryobi', aliases: [], variantes: [] },
  { canonical: 'einhell', aliases: ['enhell'], variantes: [] },
  { canonical: 'home assistant', aliases: ['homeassistant'], variantes: [] },
  { canonical: 'raspberry pi', aliases: ['raspberrypi'], variantes: [] },
  { canonical: 'leroy merlin', aliases: ['leroymerlin'], variantes: [] },
  { canonical: 'brico depot', aliases: ['bricodepot'], variantes: [] },
  { canonical: 'opera gx', aliases: ['operagx'], variantes: [] },
  { canonical: 'esphome', aliases: ['esp home'], variantes: [] },
  { canonical: 'gotronic', aliases: ['go tronic'], variantes: [] },
  { canonical: 'manomano', aliases: ['mano mano'], variantes: [] },
  { canonical: 'minisforum', aliases: ['minis forum'], variantes: [] },
  { canonical: 'mammouth', aliases: ['mamouth', 'mammouh'], variantes: [] },
  { canonical: 'xtool', aliases: ['xtoul'], variantes: [] },
];

const aliasToCanonical = new Map<string, string>();
const canonicalSet = new Set<string>();
const canonicalToVariants = new Map<string, string[]>();

for (const brand of BRANDS) {
  canonicalSet.add(brand.canonical);
  canonicalToVariants.set(brand.canonical, brand.variantes);
  for (const alias of brand.aliases) {
    const existing = aliasToCanonical.get(alias);
    if (existing && existing !== brand.canonical) {
      throw new Error(`alias « ${alias} » déjà relié à « ${existing} »`);
    }
    aliasToCanonical.set(alias, brand.canonical);
  }
}

export function aliasCanonical(alias: string): string | undefined {
  return aliasToCanonical.get(alias);
}

export function isCanonicalBrand(token: string): boolean {
  return canonicalSet.has(token);
}

export function variantsOf(canonical: string): string[] {
  return canonicalToVariants.get(canonical) ?? [];
}
