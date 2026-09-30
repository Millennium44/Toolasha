import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const hadLocation = 'location' in globalThis;
const originalLocation = globalThis.location;

/** A fresh module each time: the manifest promise is cached for the page's lifetime */
async function manifestUrlFetchedFrom(origin) {
    vi.resetModules();
    globalThis.location = { origin, hostname: new URL(origin).hostname };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ files: {} }) }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await import('./asset-manifest.js');
    await mod.default.fetchManifest();
    return fetchMock.mock.calls[0]?.[0];
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (hadLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
});

describe('asset manifest origin', () => {
    test.each([
        'https://www.milkywayidle.com',
        'https://test.milkywayidle.com',
        'https://www.milkywayidlecn.com',
        'https://test.milkywayidlecn.com',
    ])('%s reads its own manifest', async (origin) => {
        expect(await manifestUrlFetchedFrom(origin)).toBe(`${origin}/asset-manifest.json`);
    });

    test('a sim site falls back to the international manifest', async () => {
        expect(await manifestUrlFetchedFrom('https://example.com')).toBe(
            'https://www.milkywayidle.com/asset-manifest.json'
        );
    });
});
