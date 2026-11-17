import { describe, expect, it } from 'vitest';
import { creditQuestion, namedPeople, parseCreditLine } from '../../src/core/credits.js';

describe('crédits des descriptions', () => {
  it('lit les lignes de crédit du corpus', () => {
    expect(parseCreditLine('Montage : Alice Martin')).toEqual({ roles: ['montage'], label: 'Montage', names: 'Alice Martin' });
    expect(parseCreditLine('*Montage et Cadre* : Alice Martin et Chloé Durand (Studio C)')).toMatchObject({ roles: ['montage', 'cadre'], names: 'Alice Martin et Chloé Durand (Studio C)' });
    expect(parseCreditLine('- Animations 3D et montage additionnel : Alice Martin')).toMatchObject({ roles: ['montage', 'animation'] });
    expect(parseCreditLine('Cadre : Manon Ghislain : https://www.instagram.com/manonforsteri/')).toMatchObject({ roles: ['cadre'], names: 'Manon Ghislain' });
    expect(parseCreditLine('- Post-production image, étalonnage et effets visuels : Baptiste Poulain')).toMatchObject({ roles: ['post-production'] });
    expect(parseCreditLine('Mixage son : Aurélien Belliard')).toMatchObject({ roles: ['son'] });
    expect(parseCreditLine('Sous-titres FR et EN : Jean Dupont')).toMatchObject({ roles: ['sous-titres'] });
  });

  it('écarte le matériel, les liens et les chapitres', () => {
    expect(parseCreditLine('Caméra GH5 : https://amzn.to/xyz')).toBeNull();
    expect(parseCreditLine('Lumière GoPro : https://amzn.to/xyz')).toBeNull();
    expect(parseCreditLine('🙏 Son Instagram : https://instagram.com/x')).toBeNull();
    expect(parseCreditLine('✔️ Ryobi : https://lfp.yt/r')).toBeNull();
    expect(parseCreditLine('12:16 Montage déco et réflexions')).toBeNull();
  });

  it('reconnaît une question sur la fabrication de la vidéo', () => {
    expect(creditQuestion('Quand Alice a monté la vidéo')).toEqual({ roles: ['montage'] });
    expect(creditQuestion('quand alice a monté la video')).toEqual({ roles: ['montage'] });
    expect(creditQuestion('Qui a fait le montage de la vidéo de la cuisine ?')).toEqual({ roles: ['montage'] });
    expect(creditQuestion('Quelles vidéos Calypso a-t-elle cadrées ?')).toEqual({ roles: ['cadre'] });
    expect(creditQuestion('Qui est le monteur ?')).toEqual({ roles: ['montage'] });
    expect(creditQuestion('Qui a fait les sous-titres ?')).toEqual({ roles: ['sous-titres'] });
  });

  it('laisse le bricolage à la recherche', () => {
    expect(creditQuestion('Quand ont-ils monté la cuisine ?')).toBeNull();
    expect(creditQuestion('Alice a monté le meuble comment ?')).toBeNull();
    expect(creditQuestion('Comment ont-ils monté les étagères ?')).toBeNull();
    expect(creditQuestion('Quand utilisent-ils une scie circulaire ?')).toBeNull();
  });

  it('repère les personnes créditées nommées dans la question', () => {
    const credited = ['Bruno Petit / Alice Martin', 'Jean Dupont', 'Chloé Durand (Studio C)'];
    expect(namedPeople('Quand Alice a monté la vidéo', credited)).toEqual(['alice']);
    expect(namedPeople('Quelles vidéos des Frères Poulain ont été montées ?', credited)).toEqual([]);
    expect(namedPeople('les vidéos montées par Jean', credited)).toEqual(['jean']);
  });
});
