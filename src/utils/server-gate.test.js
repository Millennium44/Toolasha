import { describe, test, expect, vi, afterEach } from 'vitest';

// The global setup mocks this module patch-live for the rest of the suite; here
// we test the real hostname logic, so use the actual implementation.
vi.unmock('./server-gate.js');
const { isMarketplacePatchLive } = await vi.importActual('./server-gate.js');

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('isMarketplacePatchLive', () => {
    test('true on the test server', () => {
        vi.stubGlobal('location', { hostname: 'test.milkywayidle.com' });
        expect(isMarketplacePatchLive()).toBe(true);
    });

    test('false on the live server, until the patch reaches it', () => {
        vi.stubGlobal('location', { hostname: 'www.milkywayidle.com' });
        expect(isMarketplacePatchLive()).toBe(false);
    });

    test('false when there is no location at all (e.g. a worker blob), never throws', () => {
        vi.stubGlobal('location', undefined);
        expect(isMarketplacePatchLive()).toBe(false);

        vi.stubGlobal('location', {});
        expect(isMarketplacePatchLive()).toBe(false);
    });
});
