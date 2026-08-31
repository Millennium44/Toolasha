/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    describeMeasuredRate,
    measuredComboFor,
    measuredRateFor,
    measuredRateElement,
    appendMeasuredRate,
    invalidateMeasuredRates,
    loadMeasuredRates,
    MIN_ATTEMPTS,
} from './alchemy-measured-rate.js';

const state = vi.hoisted(() => ({ charId: 'me', sessions: { transmute: [], decompose: [], coinify: [] } }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => state.charId },
}));

vi.mock('./alchemy-session-store.js', () => ({
    NO_CHARACTER: 'default',
    // Like the real chunked-history store, an instance serves its first read
    // from memory forever after — which is what makes holding one across reads
    // a staleness bug, and what the fresh-store-per-read tests below rely on
    createAlchemySessionStore: (baseKey) => {
        let loaded = false;
        let entries = [];
        return {
            load: async () => {
                if (!loaded) {
                    entries = [...(state.sessions[baseKey.replace('Sessions', '')] || [])];
                    loaded = true;
                }
                return [...entries];
            },
        };
    },
}));

/**
 * A stamped tracker session.
 * @param {Object} over - Fields to override
 * @returns {Object}
 */
function session(over = {}) {
    return {
        startTime: 1,
        inputItemHrid: '/items/sword',
        predictedCatalystHrid: null,
        enhancementLevel: 0,
        predictedRate: 0.63,
        totalAttempts: 100,
        totalSuccesses: 63,
        ...over,
    };
}

/**
 * A combo summary as `summarizeKind` builds one.
 * @param {Object} over - Fields to override
 * @returns {Object}
 */
function combo(over = {}) {
    return {
        key: '/items/sword|none|+0',
        attempts: 2140,
        observed: 0.58,
        predicted: 0.63,
        low: 0.56,
        high: 0.6,
        verdict: 'sim too high',
        ...over,
    };
}

describe('describeMeasuredRate', () => {
    test('draws the full line once the floor is cleared', () => {
        const line = describeMeasuredRate(combo(), { predicted: 0.63 });
        expect(line.text).toBe('predicted 63% · measured 58% (n=2,140, sim too high)');
        expect(line.enough).toBe(true);
        expect(line.tone).toBe('off');
    });

    test('a consistent verdict reads as consistent and is not painted as off', () => {
        const line = describeMeasuredRate(combo({ verdict: 'consistent', low: 0.6, high: 0.66 }), { predicted: 0.63 });
        expect(line.text).toContain('consistent');
        expect(line.tone).toBe('consistent');
    });

    test('quotes the predicted rate the surface is showing, not the stamped average', () => {
        const line = describeMeasuredRate(combo({ predicted: 0.5 }), { predicted: 0.71 });
        expect(line.text).toMatch(/^predicted 71%/);
    });

    test('falls back to the combination’s own weighted prediction when none is passed', () => {
        const line = describeMeasuredRate(combo({ predicted: 0.5 }));
        expect(line.text).toMatch(/^predicted 50%/);
    });

    test('under the floor there is a dim count marker and no rate', () => {
        const line = describeMeasuredRate(combo({ attempts: 12, verdict: 'too few attempts' }));
        expect(line.text).toBe(`measured n=12/${MIN_ATTEMPTS}`);
        expect(line.enough).toBe(false);
        expect(line.tone).toBe('pending');
        // The rate itself must not leak out below the floor
        expect(line.text).not.toContain('%');
    });

    test('no attempts at all draws nothing', () => {
        expect(describeMeasuredRate(combo({ attempts: 0 }))).toBeNull();
        expect(describeMeasuredRate(null)).toBeNull();
        expect(describeMeasuredRate(undefined)).toBeNull();
    });

    test('the floor is injectable, and the boundary attempt count counts as enough', () => {
        expect(describeMeasuredRate(combo({ attempts: 50 }), { minAttempts: 50 }).enough).toBe(true);
        expect(describeMeasuredRate(combo({ attempts: 49 }), { minAttempts: 50 }).enough).toBe(false);
    });

    test('the tooltip says the measurement is never fed back into the forecast', () => {
        expect(describeMeasuredRate(combo()).title).toContain('never used');
        expect(describeMeasuredRate(combo({ attempts: 3 })).title).toContain('never fed back');
    });
});

describe('measuredComboFor', () => {
    beforeEach(() => {
        state.charId = 'me';
        state.sessions = { transmute: [], decompose: [], coinify: [] };
        invalidateMeasuredRates();
    });

    test('says nothing at all before the first read lands', () => {
        expect(measuredComboFor('transmute', { inputItemHrid: '/items/sword' })).toBeNull();
    });

    test('finds the exact item, catalyst and enhancement combination', async () => {
        state.sessions.transmute = [session(), session({ startTime: 2 })];
        await loadMeasuredRates();

        const found = measuredComboFor('transmute', { inputItemHrid: '/items/sword' });
        expect(found.attempts).toBe(200);
        expect(found.observed).toBeCloseTo(0.63, 5);
    });

    test('a different catalyst is a different combination, never a fallback', async () => {
        state.sessions.transmute = [session({ predictedCatalystHrid: '/items/prime_catalyst' })];
        await loadMeasuredRates();

        expect(measuredComboFor('transmute', { inputItemHrid: '/items/sword' })).toBeNull();
        expect(
            measuredComboFor('transmute', {
                inputItemHrid: '/items/sword',
                catalystHrid: '/items/prime_catalyst',
            })
        ).not.toBeNull();
    });

    test('a different enhancement level is a different combination', async () => {
        state.sessions.decompose = [session({ enhancementLevel: 5 })];
        await loadMeasuredRates();

        expect(measuredComboFor('decompose', { inputItemHrid: '/items/sword' })).toBeNull();
        expect(measuredComboFor('decompose', { inputItemHrid: '/items/sword', enhancementLevel: 5 })).not.toBeNull();
    });

    test('one kind never answers for another', async () => {
        state.sessions.transmute = [session()];
        await loadMeasuredRates();

        expect(measuredComboFor('coinify', { inputItemHrid: '/items/sword' })).toBeNull();
    });

    test('a session recorded after the first read is in the next computation', async () => {
        state.sessions.transmute = [session()];
        await loadMeasuredRates();
        expect(measuredComboFor('transmute', { inputItemHrid: '/items/sword' }).attempts).toBe(100);

        // The tracker records another run mid-session; nothing invalidates the
        // cache, the TTL refresh just asks again — and must see the new session
        state.sessions.transmute = [...state.sessions.transmute, session({ startTime: 2 })];
        await loadMeasuredRates();
        expect(measuredComboFor('transmute', { inputItemHrid: '/items/sword' }).attempts).toBe(200);
    });

    test('unstamped sessions are excluded, so an unstamped item shows nothing', async () => {
        state.sessions.coinify = [session({ predictedRate: 0 })];
        await loadMeasuredRates();

        expect(measuredComboFor('coinify', { inputItemHrid: '/items/sword' })).toBeNull();
    });
});

describe('rendering', () => {
    beforeEach(() => {
        state.charId = 'me';
        state.sessions = { transmute: [], decompose: [], coinify: [] };
        invalidateMeasuredRates();
    });

    test('appends nothing when there is no history for the combination', async () => {
        await loadMeasuredRates();
        const line = document.createElement('div');
        line.textContent = 'Success Rate: 63.0%';

        expect(appendMeasuredRate(line, 'transmute', { inputItemHrid: '/items/sword' })).toBeNull();
        expect(line.childElementCount).toBe(0);
        expect(line.textContent).toBe('Success Rate: 63.0%');
    });

    test('appends the line once there is enough, without touching what was there', async () => {
        // 60 attempts clears the 50-attempt floor
        state.sessions.transmute = [session({ totalAttempts: 60, totalSuccesses: 20, predictedRate: 0.63 })];
        await loadMeasuredRates();

        const line = document.createElement('div');
        line.textContent = 'Success Rate: 63.0%';
        const span = appendMeasuredRate(line, 'transmute', { inputItemHrid: '/items/sword' }, { predicted: 0.63 });

        expect(span).not.toBeNull();
        expect(span.dataset.tone).toBe('off');
        expect(line.textContent).toContain('Success Rate: 63.0%');
        expect(line.textContent).toContain('predicted 63% · measured 33% (n=60, sim too high)');
    });

    test('appends only the dim marker below the floor', async () => {
        state.sessions.transmute = [session({ totalAttempts: 12, totalSuccesses: 4 })];
        await loadMeasuredRates();

        const line = document.createElement('div');
        const span = appendMeasuredRate(line, 'transmute', { inputItemHrid: '/items/sword' });
        expect(span.textContent).toBe(`measured n=12/${MIN_ATTEMPTS}`);
        expect(span.style.opacity).toBe('0.65');
    });

    test('measuredRateElement is null for nothing to say', () => {
        expect(measuredRateElement(null)).toBeNull();
        expect(appendMeasuredRate(null, 'transmute', { inputItemHrid: '/items/sword' })).toBeNull();
    });

    test('a lookup that throws is swallowed rather than blanking the panel', () => {
        expect(measuredRateFor('transmute', null)).toBeNull();
    });
});

describe('the ranking is never changed by what was measured', () => {
    test('describeMeasuredRate returns a string and nothing numeric a caller could rank on', () => {
        const line = describeMeasuredRate(combo(), { predicted: 0.63 });
        // Deliberately no `observed`, `rate` or `adjustedSuccessRate` field: the
        // only way to misuse this would be to parse the sentence back apart
        expect(Object.keys(line).sort()).toEqual(['attempts', 'color', 'enough', 'text', 'title', 'tone']);
    });

    test('the input combination object is not mutated', () => {
        const input = combo();
        const before = JSON.stringify(input);
        describeMeasuredRate(input, { predicted: 0.71 });
        expect(JSON.stringify(input)).toBe(before);
    });
});
