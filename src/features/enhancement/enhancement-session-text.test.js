/**
 * enhancementSessionText — the flattened, plain-text form of a session used by
 * the enhancement panel's Copy button. Tested on its own because the panel
 * that calls it (enhancement-ui.js) is DOM-heavy legacy code with no test
 * harness of its own; this is the one piece of that file worth asserting on
 * without a browser.
 */
import { describe, test, expect } from 'vitest';
import { enhancementSessionText } from './enhancement-ui.js';
import { SessionState } from './enhancement-session.js';

/** A tracking session with 20 attempts costing 100 each, no protection. */
function session(overrides = {}) {
    return {
        itemHrid: '/items/advanced_intelligence_charm',
        itemName: 'Advanced Intelligence Charm',
        state: SessionState.TRACKING,
        startLevel: 0,
        targetLevel: 5,
        startTime: 0,
        lastUpdateTime: 100_000, // 100s
        totalAttempts: 20,
        totalSuccesses: 15,
        totalFailures: 5,
        totalBlessed: 0,
        totalCost: 2000,
        totalXP: 0,
        protectionCount: 0,
        materialCosts: { '/items/prime_catalyst': { count: 20, totalCost: 2000 } },
        coinCost: 0,
        protectionCost: 0,
        predictions: null,
        ...overrides,
    };
}

describe('enhancementSessionText', () => {
    test('with nothing to read, says so rather than printing blanks', () => {
        expect(enhancementSessionText(null)).toBe('Enhancement Tracker\nNo session.');
    });

    test('states the item, the level span, and whether it is still running', () => {
        const text = enhancementSessionText(session());
        expect(text).toContain('Advanced Intelligence Charm +0 → +5 (in progress)');
    });

    test('a completed session says so, not "in progress"', () => {
        const text = enhancementSessionText(session({ state: SessionState.COMPLETED }));
        expect(text).toContain('(completed)');
    });

    test('falls back to the session’s own name, then the hrid, when no item name is passed', () => {
        expect(enhancementSessionText(session({ itemName: null }), {})).toContain(
            '/items/advanced_intelligence_charm +0'
        );
    });

    test('an explicit item name overrides the session’s own', () => {
        expect(enhancementSessionText(session(), { itemName: 'Renamed Charm' })).toContain('Renamed Charm +0');
    });

    test('reports attempts broken down by outcome, and protections separately', () => {
        const text = enhancementSessionText(session({ totalBlessed: 2, protectionCount: 3 }));
        expect(text).toContain('Attempts: 20 (15 success, 2 blessed, 5 fail)');
        expect(text).toContain('Protections used: 3');
    });

    test('runs the cost and duration through the caller’s own formatters', () => {
        const text = enhancementSessionText(session(), {
            formatNum: (num) => `£${num}`,
            formatDuration: (seconds) => `${seconds}sec`,
        });
        expect(text).toContain('Duration: 100sec');
        expect(text).toContain('Total cost: £2000');
    });

    test('XP is left out below five seconds or with nothing earned, so it never prints 0/h', () => {
        expect(enhancementSessionText(session({ totalXP: 500, lastUpdateTime: 1000 }))).not.toContain('XP:');
        expect(enhancementSessionText(session({ totalXP: 0 }))).not.toContain('XP:');
    });

    test('XP/hour is derived from the total against the session duration', () => {
        // 3600 XP over 100 seconds → 129,600/hour
        const text = enhancementSessionText(session({ totalXP: 3600 }));
        expect(text).toContain('XP: 3600 (129600/h)');
    });

    test('without a stored prediction, the cost-vs-expected line is left out', () => {
        expect(enhancementSessionText(session())).not.toContain('Cost vs expected');
    });

    test('with a prediction, states the expected cost, the factor, and which way it ran', () => {
        const text = enhancementSessionText(session({ predictions: { expectedAttempts: 14, expectedProtections: 0 } }));
        // 20 attempts cost 2000 → 100/attempt; expected 14 attempts → 1400 expected.
        // Actual 2000 is 600 above expected.
        expect(text).toContain('Cost vs expected: 1400 expected, 1.43x, 600 above');
    });
});
