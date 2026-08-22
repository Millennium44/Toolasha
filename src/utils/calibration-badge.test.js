/**
 * Calibration badge tests
 *
 * The text/colour mapping is the contract the forecast lines rely on, so it is
 * pinned on plain numbers. The cache is exercised against a mocked storage so
 * the read-once, serve-sync discipline is what is tested, not IndexedDB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({
    ledger: [],
    reads: 0,
    charId: 'char1',
    settings: {},
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in store.settings ? store.settings[key] : fallback),
    },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => store.charId,
    },
}));

vi.mock('../core/storage.js', () => ({
    default: {
        get: async (key) => {
            store.reads += 1;
            return key === `calibration_${store.charId}` ? store.ledger : [];
        },
    },
}));

const {
    classifyDeviation,
    describeBadge,
    badgeHtml,
    calibrationActionType,
    calibrationBadgeFor,
    loadCalibrationBadges,
    invalidateCalibrationBadges,
    BADGE_COLORS,
    BADGE_MIN_SAMPLES,
} = await import('./calibration-badge.js');

/**
 * A ledger of `n` runs for one action, each paying `ratio` x the forecast.
 * @param {string} actionHrid - The action
 * @param {number} n - Runs
 * @param {number} ratio - actual / predicted
 * @param {number} [start] - First timestamp
 * @returns {Array<Object>}
 */
function runs(actionHrid, n, ratio, start = 1_700_000_000_000) {
    const actionType = actionHrid.split('/')[2];
    return Array.from({ length: n }, (_, i) => ({
        id: `${actionHrid}#${i}`,
        actionHrid,
        actionType,
        t: start + i * 3_600_000,
        predicted: 100_000,
        actual: 100_000 * ratio,
    }));
}

beforeEach(() => {
    store.ledger = [];
    store.reads = 0;
    store.charId = 'char1';
    store.settings = {};
    invalidateCalibrationBadges();
});

describe('classifyDeviation', () => {
    it('is neutral inside 5%, amber to 15%, red beyond', () => {
        expect(classifyDeviation(0)).toBe('neutral');
        expect(classifyDeviation(4.9)).toBe('neutral');
        expect(classifyDeviation(-4.9)).toBe('neutral');
        expect(classifyDeviation(5)).toBe('amber');
        expect(classifyDeviation(-12)).toBe('amber');
        expect(classifyDeviation(15)).toBe('amber');
        expect(classifyDeviation(15.1)).toBe('red');
        expect(classifyDeviation(-40)).toBe('red');
    });
});

describe('describeBadge', () => {
    it('says nothing below the sample floor or without a deviation', () => {
        expect(describeBadge(null)).toBeNull();
        expect(describeBadge({ medianDeviation: -12, rated: BADGE_MIN_SAMPLES - 1 })).toBeNull();
        expect(describeBadge({ medianDeviation: null, rated: 50 })).toBeNull();
    });

    it('reads a hot forecast as a negative percentage over the runs, in amber', () => {
        const badge = describeBadge({ medianDeviation: -12.4, rated: 40, firstAt: 1, lastAt: 2 }, { label: 'milking' });
        expect(badge.text).toBe('−12% over 40 runs');
        expect(badge.tone).toBe('amber');
        expect(badge.color).toBe(BADGE_COLORS.amber);
        expect(badge.title).toContain('run hot');
        expect(badge.title).toContain('12% LESS than predicted');
        expect(badge.title).toContain('last 40 finished runs');
        expect(badge.title).toContain('milking');
    });

    it('reads a cold forecast as a positive percentage, red past 15%', () => {
        const badge = describeBadge({ medianDeviation: 22, rated: 9 });
        expect(badge.text).toBe('+22% over 9 runs');
        expect(badge.tone).toBe('red');
        expect(badge.title).toContain('run cold');
        expect(badge.title).toContain('22% MORE than predicted');
    });

    it('calls a small gap on target, in neutral', () => {
        const badge = describeBadge({ medianDeviation: 3.2, rated: 38 });
        expect(badge.text).toBe('on target (38 runs)');
        expect(badge.tone).toBe('neutral');
        expect(badge.color).toBe(BADGE_COLORS.neutral);
        expect(badge.title).toContain('on target');
    });

    it('renders as a titled inline span, with the tooltip escaped', () => {
        const html = badgeHtml(describeBadge({ medianDeviation: -12, rated: 40 }, { label: 'a "quoted" <one>' }));
        expect(html).toContain('class="mwi-calibration-badge"');
        expect(html).toContain('data-tone="amber"');
        expect(html).toContain('>−12% over 40 runs<');
        expect(html).toContain('&quot;quoted&quot; &lt;one&gt;');
        expect(badgeHtml(null)).toBe('');
    });
});

describe('calibrationActionType', () => {
    it('reads the skill from any spelling', () => {
        expect(calibrationActionType('/actions/milking/cow')).toBe('milking');
        expect(calibrationActionType('/action_types/cheesesmithing')).toBe('cheesesmithing');
        expect(calibrationActionType('combat')).toBe('combat');
        expect(calibrationActionType('')).toBeNull();
        expect(calibrationActionType(null)).toBeNull();
    });
});

describe('calibrationBadgeFor', () => {
    it('answers nothing before the ledger is read, then from the cache without re-reading', async () => {
        store.ledger = runs('/actions/milking/cow', 10, 0.88);

        // The first sync ask starts the read and honestly has nothing yet
        expect(calibrationBadgeFor('/action_types/milking')).toBeNull();
        await loadCalibrationBadges();

        const badge = calibrationBadgeFor('/action_types/milking', { actionHrid: '/actions/milking/cow' });
        expect(badge.text).toBe('−12% over 10 runs');

        const readsAfterLoad = store.reads;
        for (let i = 0; i < 20; i++) calibrationBadgeFor('/action_types/milking');
        expect(store.reads).toBe(readsAfterLoad);
    });

    it('prefers the action’s own runs and falls back to the skill series, saying so', async () => {
        store.ledger = [...runs('/actions/milking/cow', 8, 0.8), ...runs('/actions/milking/goat', 2, 1.3)];
        await loadCalibrationBadges();

        const own = calibrationBadgeFor('milking', { actionHrid: '/actions/milking/cow' });
        expect(own.text).toBe('−20% over 8 runs');
        expect(own.title).not.toContain('every milking action');

        // Goat has two runs of its own: the skill series (10 runs) speaks for it
        const fallback = calibrationBadgeFor('milking', { actionHrid: '/actions/milking/goat' });
        expect(fallback.samples).toBe(10);
        expect(fallback.title).toContain('every milking action is counted');

        expect(calibrationBadgeFor('milking', { actionHrid: '/actions/milking/goat', exact: true })).toBeNull();
    });

    it('narrows combat to one zone and tier', async () => {
        const zone = '/actions/combat/fly';
        store.ledger = [
            ...runs(zone, 6, 0.7).map((r) => ({ ...r, difficultyTier: 0 })),
            ...runs(zone, 6, 1.0, 1_800_000_000_000).map((r) => ({ ...r, difficultyTier: 1 })),
        ];
        await loadCalibrationBadges();

        expect(calibrationBadgeFor('combat', { actionHrid: zone, difficultyTier: 0, exact: true }).text).toBe(
            '−30% over 6 runs'
        );
        expect(calibrationBadgeFor('combat', { actionHrid: zone, difficultyTier: 1, exact: true }).text).toBe(
            'on target (6 runs)'
        );
        expect(calibrationBadgeFor('combat', { actionHrid: zone, difficultyTier: 2, exact: true })).toBeNull();
    });

    it('is silent when the setting is off', async () => {
        store.ledger = runs('/actions/milking/cow', 10, 0.5);
        await loadCalibrationBadges();
        store.settings.insights_calibrationBadges = false;
        expect(calibrationBadgeFor('milking')).toBeNull();
    });

    it('forgets one character’s ledger when another logs in', async () => {
        store.ledger = runs('/actions/milking/cow', 10, 0.5);
        await loadCalibrationBadges();
        expect(calibrationBadgeFor('milking')).not.toBeNull();

        store.charId = 'char2';
        store.ledger = [];
        expect(calibrationBadgeFor('milking')).toBeNull();
        await loadCalibrationBadges();
        expect(calibrationBadgeFor('milking')).toBeNull();
    });
});
