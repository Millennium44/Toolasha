import { describe, test, expect, vi, afterEach } from 'vitest';

const gates = vi.hoisted(() => ({ marketplace: true, september: false }));

vi.mock('./server-gate.js', () => ({
    isMarketplacePatchLive: () => gates.marketplace,
    isSeptember2026MarketPatchLive: () => gates.september,
}));

/** MARKET_TAX is fixed at module load, so each case imports a fresh copy. */
async function loadTax() {
    vi.resetModules();
    const { MARKET_TAX, COWBELL_BAG_TAX } = await import('./profit-constants.js');
    return { MARKET_TAX, COWBELL_BAG_TAX };
}

afterEach(() => {
    gates.marketplace = true;
    gates.september = false;
});

describe('MARKET_TAX', () => {
    test('4% once the September 2026 market patch is live (test server)', async () => {
        gates.september = true;
        expect((await loadTax()).MARKET_TAX).toBe(0.04);
    });

    test('5% on the live server until it takes the patch', async () => {
        expect((await loadTax()).MARKET_TAX).toBe(0.05);
    });

    test('the cowbell bag tax is 18% either way', async () => {
        expect((await loadTax()).COWBELL_BAG_TAX).toBe(0.18);
        gates.september = true;
        expect((await loadTax()).COWBELL_BAG_TAX).toBe(0.18);
    });
});

describe('MARKET_TAX follows the hostname through the real gate', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.doUnmock('./server-gate.js');
    });

    test.each([
        ['test.milkywayidle.com', 0.04],
        ['www.milkywayidle.com', 0.05],
    ])('%s → %s', async (hostname, rate) => {
        vi.stubGlobal('location', { hostname });
        vi.resetModules();
        vi.doMock('./server-gate.js', async () => vi.importActual('./server-gate.js'));
        const { MARKET_TAX } = await import('./profit-constants.js');
        expect(MARKET_TAX).toBe(rate);
    });
});
