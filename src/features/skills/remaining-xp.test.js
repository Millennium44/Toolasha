/** @vitest-environment happy-dom */

/**
 * Tests for the Remaining XP calculation
 *
 * The feature is mostly observer plumbing, but one method does arithmetic worth
 * pinning: it reads the game's own progress-bar width and turns it back into
 * "XP left in this level" against the level experience table. That method is
 * what is tested here; the observers, the injected span and its styling are
 * left alone.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: null,
    initClientData: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => game.initClientData,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, onSelector: () => () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (_key, fallback) => fallback,
        COLOR_REMAINING_XP: '#fff',
    },
}));

const remainingXP = (await import('./remaining-xp.js')).default;

/** A progress bar filled to `percent` of the current level */
function progressBar(percent) {
    const bar = document.createElement('div');
    bar.style.width = `${percent}%`;
    return bar;
}

beforeEach(() => {
    game.characterData = {
        characterSkills: [
            { skillHrid: '/skills/milking', level: 30 },
            { skillHrid: '/skills/cooking', level: 99 },
        ],
    };
    // Level 30 starts at 20,000 XP and level 31 at 30,000 → 10,000 XP band.
    // Cooking is at the top of the table, so it has no next level.
    game.initClientData = {
        levelExperienceTable: { 29: 15000, 30: 20000, 31: 30000, 99: 5000000 },
    };
});

describe('calculateRemainingXPFromProgressBar', () => {
    test('turns the bar width into XP remaining in the level', () => {
        // band 30,000 − 20,000 = 10,000; 40% done → 6,000 left
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(40), 'Milking')).toBe(6000);
    });

    test('an empty bar owes the whole level and a full bar owes nothing', () => {
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(0), 'Milking')).toBe(10000);
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(100), 'Milking')).toBe(0);
    });

    test('rounds a partial XP point up so the display never reads zero early', () => {
        // 99.995% of 10,000 → 0.5 XP left → 1
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(99.995), 'Milking')).toBe(1);
    });

    test('never reports a negative remainder if the bar overshoots', () => {
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(120), 'Milking')).toBe(0);
    });

    test('matches skills case-insensitively via the hrid', () => {
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(50), 'milking')).toBe(5000);
    });

    test('returns null at max level, where there is no next level to reach', () => {
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(50), 'Cooking')).toBeNull();
    });

    test('returns null for an unknown skill', () => {
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(50), 'Alchemy')).toBeNull();
    });

    test('returns null when the bar has no width to read', () => {
        const bar = document.createElement('div');

        expect(remainingXP.calculateRemainingXPFromProgressBar(bar, 'Milking')).toBeNull();
    });

    test('returns null before the character or the game data has loaded', () => {
        game.characterData = null;
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(50), 'Milking')).toBeNull();

        game.characterData = { characterSkills: [{ skillHrid: '/skills/milking', level: 30 }] };
        game.initClientData = null;
        expect(remainingXP.calculateRemainingXPFromProgressBar(progressBar(50), 'Milking')).toBeNull();
    });
});
