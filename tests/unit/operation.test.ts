import { describe, expect, it } from 'vitest';
import { questionOperation } from '../../src/core/operation.js';

describe('geste décrit par une ligne de preuve', () => {
  it('distingue la préparation, le geste et le produit fini', () => {
    const matches = questionOperation('Quand soudent-ils du métal ?')!;
    for (const line of [
      'Découpe et soudure du bras métallique', 'La technicienne soude la patte en acier.',
      'Nous avons ensuite soudé la tôle.', 'Elle est en train de souder le cadre.', 'Baptiste la soude sur la plaque.',
    ]) expect(matches.shown(line), line).toBe(true);
    for (const line of [
      'Test de gravure sur aluminium', 'Ils inspectent le cadre soudé.', 'Ils vont souder la tôle.',
      'Il pose le poste à souder.', 'Ils ne soudent pas le tube.', 'Ils évoquent la soudure du cadre.',
      'Soudure du cadre | Ils essaient de fixer la traverse mais la soudure ne prend pas.',
    ]) expect(matches.shown(line), line).toBe(false);
    expect(matches.mentioned('Ils inspectent le cadre déjà soudé.')).toBe(true);
    expect(matches.mentioned('La tige en acier est serrée puis découpée.')).toBe(false);
    expect(matches.mentioned('Le fer à souder est posé sur la table.')).toBe(false);
  });

  it('reconnaît le même type d’indice avec un autre procédé ou la forme non inversée', () => {
    const matches = questionOperation('Quand est-ce qu’elles percent du bois ?')!;
    expect(matches.shown('Perçage du panneau en contreplaqué')).toBe(true);
    expect(matches.shown('Elle perce trois trous dans le panneau.')).toBe(true);
    expect(matches.shown('Panneau déjà percé posé sur la table.')).toBe(false);
    expect(matches.shown('Le panneau est simplement poncé.')).toBe(false);
  });

  it('laisse les demandes ouvertes et les choix entre actions au modèle', () => {
    expect(questionOperation('Quand utilisent-ils du métal ?')).toBeNull();
    expect(questionOperation('Quand soudent-ils ou assemblent-ils les pieds ?')).toBeNull();
    expect(questionOperation('Quels objets voit-on dans cet épisode ?')).toBeNull();
  });

  it('vérifie le procédé et la technologie lorsque la question nomme deux machines', () => {
    const usage = questionOperation('Quand utilisent-ils une découpeuse ou une graveuse laser ?')!;
    for (const text of [
      'Découpe au laser du fond du boîtier.',
      'Le faisceau laser grave le motif sur le plateau.',
      'La graveuse laser tourne. Elle grave les repères sur la plaque.',
      'Séquence en accéléré de découpe au laser du gabarit.',
      'Le laser coupe les faces du boîtier.',
    ]) expect(usage.shown(text), text).toBe(true);
    for (const text of [
      'Le scanner laser relève le relief du pied.',
      'Le plotter découpe le vinyle à la lame.',
      'Le scanner laser relève le relief. Ils découpent la plaque avec la scie.',
      'La graveuse laser est rangée. La scie sauteuse découpe les pieds.',
      'Un niveau laser guide la scie qui découpe le panneau.',
      'Ils déballent la découpeuse laser et branchent son alimentation.',
      'Ils préparent le fichier pour la prochaine gravure au laser.',
    ]) expect(usage.shown(text), text).toBe(false);
    expect(questionOperation('Dans quel placard rangent-ils la découpeuse ou la graveuse laser ?')).toBeNull();
  });

  it('demande une action dans la description du plan, y compris lorsque le titre donne la technologie', () => {
    const usage = questionOperation('Quand utilisent-ils une découpeuse ou une graveuse laser ?')!;
    for (const text of [
      'Découpe laser des fentes | Réglage sur l’écran tactile, puis découpe manuelle de fentes dans la plaque.',
      'Gravure au laser | Positionnement du socle, calibration et gravure du nom sur la tranche du bois.',
      'Test de découpe laser | Chargement du panneau, lancement de la découpe et extraction des premières lettres.',
      'Gravure du logo au laser | Le faisceau laser blanc décape le revêtement de la carte.',
      'La graveuse laser | Elle grave le bois.',
      'Le laser découpe le contour du cadre, puis la pièce est ébavurée au cutter.',
      'Découpe au laser | Perçage du mur, découpe d’une bride carrée et collage du conduit.',
    ]) expect(usage.shown(text), text).toBe(true);
    for (const text of [
      'Découpe laser de la fenêtre | Ils chargent la plaque dans la machine de découpe laser, puis retirent le film.',
      'Gravure laser | Il peint la plaque pour que le laser grave le texte en creux.',
      'Planification | Les auteurs discutent de la poignée et des futures découpes laser des panneaux.',
      'Découpes laser prévues pour les côtés du boîtier.',
      'Un laser bleu qui découpe le bois et un CO2 qui fait de même, on va pouvoir comparer les différences.',
      'Gravure laser | Réglage de la machine et lancement du logiciel de gravure.',
      'Découpe laser | Ils découpent le panneau à la scie.',
      'La graveuse laser | Le scanner projette des repères sur la surface à graver.',
      'Découpe laser | La plaque repose sur le plateau. | ÉCRAN : Découpe au laser de la pièce',
    ]) expect(usage.shown(text), text).toBe(false);
  });
});
