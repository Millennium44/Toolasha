/**
 * The worker scripts are built by string concatenation, which no amount of
 * linting checks. Two things can go wrong and did: the source can fail to
 * parse, and the chain inside it can drift from the one on the main thread.
 *
 * Since the matrix helper is serialised in alongside the chain — replacing an
 * `importScripts` of ~600 KB of math.js per worker — both risks now apply to
 * it too, so the generated source is parsed and run here and its answers
 * compared against the main-thread calculator's.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';

/**
 * Capture the worker source a manager hands to `new Blob([...])`.
 * @param {Function} load - Imports the manager and provokes the pool creation
 * @returns {Promise<string>} The worker script text
 */
async function captureWorkerScript(load) {
    let captured = null;
    vi.stubGlobal(
        'Blob',
        class {
            constructor(parts) {
                captured = parts[0];
            }
        }
    );
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

    // There is no real Worker here, so pool creation throws after the Blob is
    // built — which is all this needs.
    await load().catch(() => {});

    expect(captured).toBeTruthy();
    return captured;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('generated worker sources', () => {
    test('the enhancement worker parses, pulls in no CDN library, and matches the calculator', async () => {
        const { calculateEnhancementAsync } = await import('./enhancement-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateEnhancementAsync({ enhancingLevel: 100, toolBonus: 0, itemLevel: 50, targetLevel: 5 })
        );

        expect(source).not.toContain("importScripts('http");

        // Parsing and running it is the point: a template-literal mistake in
        // the serialised helper shows up here and nowhere else.
        const calculateEnhancement = new Function('self', `${source}\n; return calculateEnhancement;`)({
            postMessage: () => {},
            onmessage: null,
        });

        const params = { enhancingLevel: 100, toolBonus: 5, itemLevel: 60, targetLevel: 10, protectFrom: 5 };
        const fromWorker = calculateEnhancement(params);

        const { calculateEnhancement: mainThread } = await import('./enhancement-calculator.js');
        const fromMain = mainThread(params);

        expect(fromWorker.attempts).toBeCloseTo(fromMain.attempts, 9);
        expect(fromWorker.protectionCount).toBeCloseTo(fromMain.protectionCount, 9);
    });

    test('the networth worker parses and pulls in no CDN library', async () => {
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() => calculateItemValueBatch([], {}, {}, {}));

        expect(source).not.toContain("importScripts('http");

        // Parses, and the serialised matrix helper is intact inside it
        const math = new Function('self', `${source}\n; return math;`)({ postMessage: () => {}, onmessage: null });
        const identity = math.identity(3);
        expect(math.inv(identity).get([2, 2])).toBe(1);
    });
});
