import { describe, test, expect, vi, afterEach } from 'vitest';

// The global setup mocks this module patch-live for the rest of the suite; here
// we test the real hostname logic, so use the actual implementation.
vi.unmock('./server-gate.js');
const { isMarketplacePatchLive } = await vi.importActual('./server-gate.js');

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isMarketplacePatchLive', () => {
    // The patch is live on both servers now, so the gate is open regardless of
    // hostname — and still never throws where there is no location.
    test('true on the live server', () => {
        vi.stubGlobal('location', { hostname: 'www.milkywayidle.com' });
        expect(isMarketplacePatchLive()).toBe(true);
    });

    test('true on the test server', () => {
        vi.stubGlobal('location', { hostname: 'test.milkywayidle.com' });
        expect(isMarketplacePatchLive()).toBe(true);
    });

    test('true even with no location at all (e.g. a worker blob), never throws', () => {
        vi.stubGlobal('location', undefined);
        expect(() => isMarketplacePatchLive()).not.toThrow();
        expect(isMarketplacePatchLive()).toBe(true);

        vi.stubGlobal('location', {});
        expect(isMarketplacePatchLive()).toBe(true);
    });
});
