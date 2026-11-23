import { describe, expect, it } from 'vitest';
import { classify, extractTerm, extractVideoReference } from '../../src/core/classify.js';

describe('routage déterministe', () => {
  it('« toutes les vidéos où on parle de NordVPN » → lister + paroles', () => {
    const routed = classify('toutes les vidéos où on parle de NordVPN');
    expect(routed.route).toBe('lister');
    expect(routed.term).toBe('nordvpn');
    expect(routed.scope).toBe('paroles');
  });

  it('« dans quelle vidéo on parle du module Peltier ? » → chercher (singulier)', () => {
    const routed = classify('dans quelle vidéo on parle du module Peltier ?');
    expect(routed.route).toBe('chercher');
    expect(routed.term).toBe('module peltier');
  });

  it('« Liste les étapes du montage » reste factuel : le mot liste seul ne suffit pas', () => {
    expect(classify('liste les étapes du montage').route).toBe('chercher');
  });

  it('« à l’écran » déclenche la portée ecran, même avec « on voit »', () => {
    const routed = classify("dans quelle vidéo on voit Bambulab à l'écran");
    expect(routed.scope).toBe('ecran');
    expect(routed.route).toBe('plan');
    expect(routed.term).toBe('bambulab');
  });

  it('« on voit » sans intention exhaustive → plan', () => {
    const routed = classify('on voit un hérisson dans quelle vidéo ?');
    expect(routed.route).toBe('plan');
    expect(routed.scope).toBe('visuel');
    expect(routed.term).toBe('herisson');
  });

  it('intention exhaustive sans terme → clarification', () => {
    expect(classify('toutes les vidéos intéressantes').route).toBe('clarifier');
  });

  it('liens et références → infos', () => {
    for (const question of [
      'quel est le lien du firmware de la glacière ?',
      'on a mis un fichier 3D quelque part ?',
      'où acheter le module Peltier ?',
    ]) {
      expect(classify(question).route).toBe('infos');
    }
  });

  it('une question factuelle sur un firmware reste orale, pas infos', () => {
    expect(classify('quel firmware utilisent-ils pour le répéteur ?').route).toBe('chercher');
  });

  it('question factuelle → chercher', () => {
    expect(classify('comment on a mesuré la consommation de la glacière ?').route).toBe('chercher');
  });

  it.each([
    'Quand soudent-ils du métal ?',
    'Quand est-ce qu’ils cintrent du bois ?',
    'Quand brunissent-elles de l’acier ?',
    'Quand plient-ils de la tôle à la main ?',
    'Quand brunissent-elles du cuivre ou de la tôle ?',
    'Quand utilisent-ils de la résine ou de la colle époxy ?',
    'Quand ils tournent une poignée ?',
    'Quand parlent-ils de l’avenir de la chaîne ou de son financement ?',
  ])('cherche les occurrences du geste dans « %s »', (question) => {
    expect(classify(question)).toMatchObject({ route: 'chercher', general: true });
  });

  it.each([
    'Quand soudent-ils le cadre de leur remorque ?',
    'Quand cintrent-ils du bois pour le fauteuil ?',
    'Quand soudent-ils du métal dans cette vidéo ?',
    'Quand utilisent-ils du métal pour leur portail ?',
    'Quand ils soudent du métal, comment protègent-ils le sol ?',
    'Quand ont-ils terminé leur manoir ?',
  ])('conserve le cadrage précis dans « %s »', (question) => {
    expect(classify(question)).toMatchObject({ route: 'chercher', general: false });
  });

  it('« écran » seul et « épisode » sont reconnus malgré l’accent initial', () => {
    expect(classify('quel texte est affiché sur l’écran de la glacière ?').scope).toBe('ecran');
    expect(classify('dans quelle vidéo voit-on un écran LCD ?').scope).toBe('ecran');
    expect(extractVideoReference('dans l’épisode Gu8bnHQaG5s')).toBe('Gu8bnHQaG5s');
  });

  it('« dit » ne se déclenche pas à l’intérieur d’un mot', () => {
    expect(classify('quelles conditions pour la glacière ?').scope).toBe('tout');
  });

  it('extrait le terme entre guillemets', () => {
    expect(extractTerm('combien de fois « X20V TEAM » ?')).toBe('x20v team');
  });

  it('l’article est retiré entier : « une CNC », « les vis », « l’établi »', () => {
    expect(extractTerm('Partout où on voit une CNC')).toBe('cnc');
    expect(extractTerm('toutes les vidéos où on voit les vis')).toBe('vis');
    expect(extractTerm('toutes les vidéos où on parle de l’établi')).toBe('etabli');
  });

  it('« X ou Y » donne deux alternatives, et « mentionné » seul couvre tout', () => {
    const routed = classify('Quelles sont toutes les vidéos où BirdNET ou BirdNET-Pi est mentionné, même brièvement ?');
    expect(routed.route).toBe('lister');
    expect([routed.term, ...routed.alternatives]).toEqual(['birdnet', 'birdnet-pi']);
    expect(routed.scope).toBe('tout');
  });

  it('plusieurs expressions entre guillemets restent des phrases entières (normalisées comme le corpus)', () => {
    const routed = classify('Quelles vidéos mentionnent « 6DOF » ou « six degrés de liberté » ?');
    expect([routed.term, ...routed.alternatives]).toEqual(['6 dof', 'six degres de liberte']);
  });

  it('l’oral et l’écran ensemble couvrent tout ; l’adverbe est ignoré', () => {
    expect(classify('toutes les vidéos où Squeezelite est mentionné, à l’oral ou à l’écran').scope).toBe('tout');
    expect(classify('toutes les vidéos où ESPresense est explicitement mentionné ?').term).toBe('espresense');
    const herisson = classify('toutes les vidéos où un hérisson est mentionné ou décrit visuellement ?');
    expect(herisson.term).toBe('herisson');
    expect(herisson.scope).toBe('tout');
  });

  it('une longue description visuelle reste une recherche classée', () => {
    expect(classify('dans quelle vidéo voit-on un homme portant un bonnet de Père Noël ?').route).toBe('chercher');
  });

  it('extrait une référence de vidéo à 11 caractères et la reporte dans le routage', () => {
    expect(extractVideoReference('dans la vidéo Gu8bnHQaG5s à quel moment')).toBe('Gu8bnHQaG5s');
    expect(extractVideoReference('rien ici')).toBeNull();
    expect(classify('dans la vidéo Gu8bnHQaG5s à quel moment parle-t-on du Peltier ?').videoId).toBe(
      'Gu8bnHQaG5s',
    );
  });

  it('première / dernière mention → décompte trié par date, avec le terme', () => {
    const cases: Array<[string, 'premiere' | 'derniere', string]> = [
      ['Premier mention du PLA sur nos video', 'premiere', 'pla'],
      ['Quand ont-ils parlé de PLA pour la première fois ?', 'premiere', 'pla'],
      ['Première vidéo avec un ESP32', 'premiere', 'esp32'],
      ['Quelle est la vidéo la plus ancienne qui mentionne Home Assistant ?', 'premiere', 'home assistant'],
      ["La dernière fois qu'on voit une CNC", 'derniere', 'cnc'],
      ['Dernière vidéo où ils parlent de Bambu Lab', 'derniere', 'bambu lab'],
    ];
    for (const [question, order, term] of cases) {
      expect(classify(question)).toMatchObject({ route: 'lister', order, term });
    }
  });

  it('« première étape », « premier projet » : pas un décompte', () => {
    expect(classify('Quelle est la première étape pour fabriquer le claustra ?')).toMatchObject({ route: 'chercher', order: null });
    expect(classify('Leur premier projet domotique')).toMatchObject({ route: 'chercher', order: null });
  });

  it('première / dernière fois qu’ils FONT quelque chose : question générale, pas un décompte de mots', () => {
    expect(classify('La dernière fois où ils utilisent une visseuse')).toMatchObject({ route: 'chercher', general: true, order: 'derniere', term: null });
    expect(classify('Quand ont-ils testé une imprimante résine pour la première fois ?')).toMatchObject({ route: 'chercher', general: true, order: 'premiere' });
    expect(classify("La première fois qu'ils coulent de la résine dans un moule")).toMatchObject({ route: 'chercher', general: true, order: 'premiere' });
  });
});
