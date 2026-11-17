import { describe, expect, it } from 'vitest';
import { normalizeText } from '../../src/norm/normalize.js';

describe('normalisation', () => {
  it('conserve le composé X20V et ajoute la forme scindée adjacente', () => {
    const norm = normalizeText('X20V TEAM');
    expect(norm).toContain('x20v x 20v');
  });

  it('sépare le nombre de 20,5V de son unité et ajoute la compatibilité OCR', () => {
    const norm = normalizeText('20,5V -> 12V');
    expect(norm).toContain('20.5 v');
    expect(norm).toContain('20 5 v');
    expect(norm).toContain('12 v');
  });

  it('partage la clé 20.5 v entre les deux écritures décimales', () => {
    expect(normalizeText('20,5V')).toContain('20.5 v');
    expect(normalizeText('20.5 V')).toContain('20.5 v');
  });

  it('ne confond pas 20,5 V avec 205 V', () => {
    const norm = normalizeText('205 V');
    expect(norm).not.toContain('20.5');
    expect(norm).toContain('205 v');
  });

  it('ne confond pas 20,5 V avec 20 V / 5 V', () => {
    const norm = normalizeText('20 V / 5 V');
    expect(norm).toContain('20 v 5 v');
    expect(norm).not.toContain('20.5 v');
  });

  it('préserve ESP32-H2 et INA219 sous leurs deux formes', () => {
    expect(normalizeText('ESP32-H2')).toContain('esp32-h2');
    expect(normalizeText('ESP32-H2')).toContain('esp32 h2');
    expect(normalizeText('INA219')).toContain('ina219');
    expect(normalizeText('INA219')).toContain('ina 219');
  });

  it('conserve bambulab et ajoute sa forme scindée', () => {
    expect(normalizeText('BambuLab')).toContain('bambulab');
    expect(normalizeText('BambuLab')).toContain('bambu lab');
    expect(normalizeText('bamboo lab')).toContain('bambulab');
  });

  it('n’assimile pas la forme scindée « Bambu Lab » à la forme canonique', () => {
    const norm = normalizeText('Bambu Lab');
    expect(norm).toContain('bambu lab');
    expect(norm).not.toMatch(/\bbambulab\b/);
  });

  it('ne transforme pas un dérivé non validé en marque', () => {
    const norm = normalizeText('on va Meshysez-la');
    expect(norm).toContain('meshysez');
    expect(norm).not.toMatch(/\bmeshy\b/);
  });

  it('replie casse et accents', () => {
    expect(normalizeText('Rénovation à Châteauroux')).toBe('renovation a chateauroux');
    expect(normalizeText('cœur œuf')).toBe('coeur oeuf');
  });

  it('sépare les nombres des unités attachées', () => {
    expect(normalizeText('1100 €')).toContain('1100');
    expect(normalizeText('54€')).toContain('54');
  });

  it('produit une chaîne vide sans jeton lexical', () => {
    expect(normalizeText('!!! ...')).toBe('');
  });

  it('est déterministe', () => {
    const input = 'Le module Peltier de la Parkside 20V, à 20,5V';
    expect(normalizeText(input)).toBe(normalizeText(input));
  });

  it('traite identiquement question et document', () => {
    expect(normalizeText('oN PaRlE dE nOrDvPn ?')).toContain('nordvpn');
  });
});
