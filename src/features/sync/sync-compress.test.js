/**
 * The gzip layer's one job: what goes in comes back out, much smaller.
 */
import { describe, test, expect } from 'vitest';
import { compressionAvailable, gzipText, gunzipToText } from './sync-compress.js';

describe('sync compression', () => {
    test('this environment has CompressionStream — the tests below mean something', () => {
        expect(compressionAvailable()).toBe(true);
    });

    test('round-trips a payload', async () => {
        const text = JSON.stringify({ stores: { settings: { a: 1 } }, exportedAt: '2026-08-05' });
        await expect(gunzipToText(await gzipText(text))).resolves.toBe(text);
    });

    test('round-trips non-ASCII', async () => {
        const text = JSON.stringify({ name: 'Mjölnir ⚒️', cow: '🐄' });
        await expect(gunzipToText(await gzipText(text))).resolves.toBe(text);
    });

    test('repetitive JSON actually shrinks — the reason this layer exists', async () => {
        const rows = Array.from({ length: 2000 }, (_, index) => ({
            itemHrid: '/items/cheese',
            enhancementLevel: 0,
            price: 100 + index,
            timestamp: 1_700_000_000_000 + index,
        }));
        const text = JSON.stringify({ stores: { marketListings: rows } });
        const compressed = await gzipText(text);
        expect(compressed.length).toBeLessThan(text.length / 5);
    });
});
