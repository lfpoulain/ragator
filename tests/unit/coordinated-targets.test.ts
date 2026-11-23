import { describe, expect, it } from 'vitest';
import { actionTargetForms, coordinatedTargets, mentionsActionTargets } from '../../src/core/requirements.js';

const groups = (...clauses: string[][]) => clauses.map((clause) => clause.map((term) => ({ term, forms: [term] })));

describe('matière d’un geste dans un passage', () => {
  const target = (term: string) => [[{ term, forms: actionTargetForms(term) }]];
  it('reconnaît la famille du matériau nommé dans la citation', () => {
    expect(mentionsActionTargets(target('metaux'), ['Elle plie la tôle en aluminium.'])).toBe(true);
    expect(mentionsActionTargets(target('metal'), ['Il ajuste les pieds métalliques de la table.'])).toBe(true);
    expect(mentionsActionTargets(target('metal'), ['La pièce est en plastique. On aurait pu utiliser de l’acier.'])).toBe(false);
    expect(mentionsActionTargets(target('metal'), ['Le fer à souder fond le plastique.'])).toBe(false);
  });
  it('garde le matériau précis quand il est imposé par la question', () => {
    expect(mentionsActionTargets(target('acier'), ['Ils plient une plaque de métal.'])).toBe(false);
    expect(mentionsActionTargets(target('acier'), ['Ils plient une plaque en aluminium.'])).toBe(false);
  });
});

describe('objets coordonnés dans une demande d’usage', () => {
  it('retrouve le procédé même si les extraits ne reprennent pas le nom de la machine', () => {
    const question = 'Quand utilisent-ils une découpeuse ou une graveuse laser ?';
    for (const raw of [groups(['decoupeuse', 'graveuse'], ['laser']), groups(['decoupeuse', 'graveuse', 'laser']), groups(['laser']), []]) {
      const targets = coordinatedTargets(question, raw);
      expect(targets.map(g => g.map(t => t.term))).toEqual([['decoupeuse', 'graveuse'], ['laser']]);
      expect(mentionsActionTargets(targets, ['Le laser grave un motif sur la plaque.'])).toBe(true);
      expect(mentionsActionTargets(targets, ['La machine coupe le bois au laser.'])).toBe(true);
      expect(mentionsActionTargets(targets, ['La découpeuse vinyle découpe les lettres.'])).toBe(false);
      expect(mentionsActionTargets(targets, ['La grille du scanner laser apparaît sur sa main.'])).toBe(false);
    }
  });

  it('applique la technologie aux deux outils et conserve les autres conditions explicites', () => {
    const question = 'Quand se servent-ils d’une ponceuse ou d’une fraiseuse pneumatique sur du verre ?';
    const targets = coordinatedTargets(question, groups(['ponceuse', 'fraiseuse'], ['pneumatique'], ['verre']));
    expect(mentionsActionTargets(targets, ['Ils usinent le verre au moyen de la fraiseuse pneumatique.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Le ponçage du verre est réalisé par leur machine pneumatique.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Le ponçage électrique du verre commence.'])).toBe(false);
    expect(mentionsActionTargets(targets, ['Ils fraisent du bois avec la machine pneumatique.'])).toBe(false);
    const mixed = coordinatedTargets(question, groups(['ponceuse', 'fraiseuse'], ['pneumatique', 'verre']));
    expect(mentionsActionTargets(mixed, ['Ils fraisent du bois avec la machine pneumatique.'])).toBe(false);
  });

  it('ne propage pas une technologie au premier outil quand il en impose une autre', () => {
    const question = 'Quand utilisent-ils une découpeuse vinyle ou une graveuse laser ?';
    const targets = coordinatedTargets(question, groups(['decoupeuse', 'graveuse'], ['vinyle', 'laser']));
    expect(mentionsActionTargets(targets, ['Ils utilisent la découpeuse vinyle.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Ils utilisent la graveuse laser.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Ils utilisent la découpeuse laser.'])).toBe(false);
  });

  it('accepte le premier matériau seul sans confondre la famille générique avec le deuxième matériau', () => {
    const targets = coordinatedTargets('Quand travaillent-ils du cuivre ou de la tôle galvanisée ?',
      groups(['cuivre', 'galvanisee'], ['tole', 'galvanisee']));
    expect(targets).toEqual(groups(['cuivre', 'galvanisee']));
    expect(mentionsActionTargets(targets, ['Ils martèlent le cuivre.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Ils découpent la tôle en aluminium.'])).toBe(false);
  });

  it('préserve le qualificatif de la deuxième option et les contraintes extérieures à la coordination', () => {
    const targets = coordinatedTargets('Où découpent-ils du feutre ou du cuir épais au laser ?',
      groups(['feutre', 'cuir'], ['epais'], ['laser']));
    expect(mentionsActionTargets(targets, ['Le feutre est découpé au laser.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Le cuir épais est découpé au laser.'])).toBe(true);
    expect(mentionsActionTargets(targets, ['Le cuir fin est découpé au laser.'])).toBe(false);
    expect(mentionsActionTargets(targets, ['Ils découpent le feutre au cutter.'])).toBe(false);
  });

  it('conserve les groupes quand le choix ne relie pas deux objets identifiés', () => {
    const targets = groups(['cuir'], ['laser']);
    expect(coordinatedTargets('Où utilisent-ils le laser sur du cuir ?', targets)).toEqual(targets);
    expect(coordinatedTargets('Découpent-ils le cuir ou préfèrent-ils utiliser le laser ?', targets)).toEqual(targets);
  });
});
