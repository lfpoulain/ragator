import { describe, expect, it } from 'vitest';
import { createAuthThrottle, createGuestLimiter } from '../../src/web/limits.js';
import { buildPages } from '../../src/web/server.js';

describe('garde-fous de débit', () => {
  it('invité : une question à la fois, un quota par heure, des places bornées pour tous les invités', () => {
    let now = 0;
    const limiter = createGuestLimiter({ perHour: 2, concurrent: 2 }, () => now);
    const first = limiter.start('ami');
    expect(typeof first).toBe('function');
    expect(limiter.start('ami')).toMatchObject({ reason: 'busy' });
    const other = limiter.start('autre');
    expect(limiter.start('troisième')).toMatchObject({ reason: 'busy' });
    (first as () => void)();
    (first as () => void)();
    (other as () => void)();
    (limiter.start('ami') as () => void)();
    expect(limiter.remaining('ami')).toBe(0);
    expect(limiter.start('ami')).toEqual({ reason: 'quota', retryAfterS: 3600 });
    now = 3_600_001;
    expect(limiter.remaining('ami')).toBe(2);
    expect(typeof limiter.start('ami')).toBe('function');
  });

  it('mot de passe : les échecs répétés d’une adresse répondent de plus en plus tard, puis 429', () => {
    let now = 0;
    const throttle = createAuthThrottle(() => now);
    expect([1, 2, 3].map(() => throttle.failed('10.0.0.9'))).toEqual([0, 0, 0]);
    expect([4, 5, 6, 7].map(() => throttle.failed('10.0.0.9'))).toEqual([250, 500, 1000, 2000]);
    expect(throttle.failed('10.0.0.9')).toBeNull();
    expect(throttle.failed('10.0.0.8')).toBe(0);
    throttle.released('10.0.0.9');
    expect(throttle.failed('10.0.0.9')).toBe(4000);
    now = 11 * 60_000;
    expect(throttle.failed('10.0.0.9')).toBe(0);
  });
});

describe('pages servies', () => {
  const html = '<html lang="fr"><style>a{}/*admin*/b{}/*/admin*/</style><body><!--admin--><nav id="tab-admin"></nav><!--/admin--><main></main>' +
    '<script>const a = 1;/*admin*/fetch("/api/settings");/*/admin*/</script></body></html>';
  it('la page des invités est la page principale sans son administration', () => {
    const { main, guest } = buildPages(html);
    expect(main.html).toBe(html);
    expect(guest.html).toContain('<html lang="fr" data-guest>');
    expect(guest.html).not.toMatch(/tab-admin|api\/settings|b\{\}/);
    expect(guest.html).toContain('<main></main>');
  });
  it('chaque page n’autorise que son propre script', () => {
    const { main, guest } = buildPages(html);
    expect(main.csp).toMatch(/^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/]{43}='; style-src 'sha256-/);
    expect(main.csp).not.toContain("'unsafe-inline'; script");
    expect(guest.csp).not.toBe(main.csp);
  });
});
