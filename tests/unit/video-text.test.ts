import { describe, expect, it } from 'vitest';
import { buildDescriptionBlocks } from '../../src/core/description.js';
import { templateThreshold, videoTexts, type VideoTextSource } from '../../src/core/video-text.js';

const TEMPLATE = [
  '*ABONNE TOI* , PARTAGE la PASSION et LIKE pour soutenir la créativité ! 💚',
  '❤️ Soutien *à fond* la chaine, via Tipeee : https://lfp.yt/tip',
  '🔨 *Équipement de Bricolage Favori* :',
  '✔️ RYOBI : https://amzn.to/2AfNoOv',
].join('\n');

function video(id: string, intro: string, plans: string[], extra = ''): VideoTextSource {
  const description = [intro, '', TEMPLATE, extra].join('\n');
  return { videoId: id, title: `Titre ${id}`, descriptionBlocks: buildDescriptionBlocks(id, description), planTitles: plans };
}

describe('texte encodé par vidéo', () => {
  it('écarte le gabarit de la chaîne (lignes reprises dans plusieurs vidéos), garde ce qui est propre à chacune', () => {
    const videos = ['a', 'b', 'c', 'd'].map((id) => video(id, `On fabrique un répéteur ${id} avec un ESP32.`, [`Plan propre ${id}`, 'Écran de fin de vidéo']));
    const text = videoTexts(videos).get('a')!;
    expect(text).toBe('Titre a\nOn fabrique un répéteur a avec un ESP32.\nPlans : Plan propre a');
  });

  it('retire les liens et ce qu’ils laissent en fin de ligne, garde les noms de produits', () => {
    const videos = [video('a', 'Intro', [], ['Liens affiliés :', '✔️ Panneau solaire : https://amzn.to/x ou https://s.click.aliexpress.com/e/y'].join('\n'))];
    const text = videoTexts(videos).get('a')!;
    expect(text).toContain('✔️ Panneau solaire');
    expect(text).not.toMatch(/https?:|: ou|Panneau solaire :/);
  });

  it('un chapitre donne son libellé, sans horodatage ; une ligne en double ne compte qu’une fois', () => {
    const description = 'Intro\n\nChapitres :\n00:00 Présentation du montage\n03:12 Test en extérieur\n\nIntro';
    const [text] = videoTexts([
      { videoId: 'a', title: 'T', descriptionBlocks: buildDescriptionBlocks('a', description), planTitles: ['Montage', 'Montage', 'Essai'] },
    ]).values();
    expect(text).toBe('T\nIntro\nPrésentation du montage\nTest en extérieur\nPlans : Montage ; Essai');
  });

  it('borne la description, puis les plans, sans couper une ligne', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Ligne de description numéro ${i} assez longue pour peser.`).join('\n');
    const plans = Array.from({ length: 400 }, (_, i) => `Plan numéro ${i}`);
    const [text] = videoTexts([{ videoId: 'a', title: 'T', descriptionBlocks: buildDescriptionBlocks('a', long), planTitles: plans }]).values();
    expect(text!.length).toBeLessThanOrEqual(6000);
    expect(text).toMatch(/Plans : Plan numéro 0 ; /);
    expect(text).toMatch(/Plan numéro \d+$/);
    const description = text!.slice(0, text!.indexOf('\nPlans : '));
    expect(description.length).toBeLessThanOrEqual(3000 + 2);
    expect(description.split('\n').at(-1)).toMatch(/assez longue pour peser\.$/);
  });

  it('seuil du gabarit : 1 % du corpus, au moins 3 vidéos', () => {
    expect(templateThreshold(2)).toBe(3);
    expect(templateThreshold(595)).toBe(6);
  });
});
