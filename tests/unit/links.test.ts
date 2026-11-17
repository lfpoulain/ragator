import { describe, expect, it } from 'vitest';
import { timestampedLink, videoLink } from '../../src/links.js';

describe('liens horodatés', () => {
  it('recule de 3 s', () => {
    expect(timestampedLink('Gu8bnHQaG5s', 198)).toBe(
      'https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=195s',
    );
    expect(timestampedLink('Gu8bnHQaG5s', 77)).toBe(
      'https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=74s',
    );
  });

  it('ne descend jamais sous 0 s', () => {
    expect(timestampedLink('Gu8bnHQaG5s', 2)).toBe(
      'https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=0s',
    );
    expect(timestampedLink('Gu8bnHQaG5s', 0)).toBe(
      'https://www.youtube.com/watch?v=Gu8bnHQaG5s&t=0s',
    );
  });

  it('le lien de titre ne comporte aucun instant', () => {
    expect(videoLink('Gu8bnHQaG5s')).toBe('https://www.youtube.com/watch?v=Gu8bnHQaG5s');
  });
});
