import { describe, expect, it } from 'vitest';
import { buildDescriptionBlocks } from '../../src/core/description.js';

const description = `Une glacière autonome coûte 1100 €.
Si la vidéo t'a plu, partage la et ABONNE-TOI

*LE PROJET DU JOUR* :
✔️ Le firmware ESP32 sur notre GitHub : https://github.com/lfpoulain
✔️ Interface : https://glaciere.yt

*LES OUTILS & MATÉRIEL DE L'ÉPISODE* (Liens Affiliés*) :
✔️ ESP32-H2 : https://amzn.to/4hpK5cR

🎬 Chapitres :
00:00 Défis Glacière
01:18 NordVPN`;

describe('blocs de description', () => {
  const blocks = buildDescriptionBlocks('Gu8bnHQaG5s', description);

  it('produit des IDs stables et séquentiels', () => {
    expect(blocks.map((b) => b.id)).toEqual([
      'Gu8bnHQaG5s:d00001',
      'Gu8bnHQaG5s:d00002',
      'Gu8bnHQaG5s:d00003',
      'Gu8bnHQaG5s:d00004',
      'Gu8bnHQaG5s:d00005',
      'Gu8bnHQaG5s:d00006',
      'Gu8bnHQaG5s:d00007',
    ]);
  });

  it('extrait les URLs de chaque bloc', () => {
    expect(blocks[2]?.urls).toEqual(['https://github.com/lfpoulain']);
    expect(blocks[4]?.urls).toEqual(['https://amzn.to/4hpK5cR']);
    expect(blocks[0]?.urls).toHaveLength(0);
  });

  it('conserve le caractère affilié par bloc', () => {
    expect(blocks[4]?.affiliated).toBe(true);
    expect(blocks[2]?.affiliated).toBe(false);
    expect(blocks[3]?.affiliated).toBe(false);
  });

  it('rattache les blocs à leur section', () => {
    expect(blocks[2]?.section).toBe('LE PROJET DU JOUR');
    expect(blocks[4]?.section).toContain('LES OUTILS');
    expect(blocks[0]?.section).toBeNull();
  });

  it('parse les chapitres avec leurs secondes', () => {
    expect(blocks[5]?.chapter).toEqual({ label: 'Défis Glacière', seconds: 0 });
    expect(blocks[6]?.chapter).toEqual({ label: 'NordVPN', seconds: 78 });
    expect(blocks[5]?.section).toContain('Chapitres');
  });

  it('les offsets délimitent exactement le texte du bloc', () => {
    for (const block of blocks) {
      expect(description.slice(block.fromChar, block.toChar)).toContain(block.text);
    }
  });
});
