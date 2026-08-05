/**
 * The guild-shareable report.
 *
 * What matters here is what a guild reads in a chat window: no markup, no
 * padding that a proportional font will ruin, nothing mentioned that did not
 * happen, and the one figure the panel never showed — how close the party came
 * to the next tier.
 */

import { describe, test, expect } from 'vitest';

import { buildGuildReport, describeShortfall, MAX_REPORT_PLAYERS, playerLine } from './guild-trial-report.js';

/**
 * A breakdown as the damage module reports one.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The breakdown
 */
function breakdown(overrides = {}) {
    return {
        measured: true,
        reason: 'the monster says it is a trial',
        seconds: 480,
        totalDamage: 1_000_000,
        players: [
            { index: '0', name: 'Tib', damage: 600_000, dps: 1250, share: 60, deaths: 1 },
            { index: '1', name: 'Moo', damage: 400_000, dps: 833, share: 40, deaths: 0 },
        ],
        support: {
            players: [
                { index: '0', name: 'Tib', healingDone: 0, damageTaken: 200_000, manaOuts: 0, emptyManaMs: 0 },
                {
                    index: '1',
                    name: 'Moo',
                    healingDone: 150_000,
                    damageTaken: 0,
                    manaOuts: 3,
                    emptyManaMs: 240_000,
                },
            ],
            totals: { healingDone: 150_000 },
            unattributedHealing: 25_000,
        },
        ...overrides,
    };
}

describe('describeShortfall', () => {
    test('says how far into the tier the hour left them, both ways', () => {
        const line = describeShortfall({ tier: 4, remaining: 112_000, total: 669_500 });

        expect(line).toContain('83% into T4');
        expect(line).toContain('112,000 of 669,500 HP left');
    });

    test('a tier that finished on the buzzer says so', () => {
        expect(describeShortfall({ tier: 4, remaining: 0, total: 669_500 })).toContain('exactly as the hour ended');
    });

    test('the unit follows the trial kind', () => {
        expect(describeShortfall({ tier: 8, remaining: 5000, total: 69_360, unit: 'work' })).toContain('work left');
    });

    test('nothing to say is null rather than a sentence about nothing', () => {
        expect(describeShortfall({ tier: null, remaining: 1, total: 2 })).toBeNull();
        expect(describeShortfall({ tier: 4, remaining: null, total: 2 })).toBeNull();
        expect(describeShortfall({ tier: 4, remaining: 1, total: 0 })).toBeNull();
        expect(describeShortfall()).toBeNull();
    });
});

describe('playerLine', () => {
    test('mentions only what happened', () => {
        const line = playerLine(
            { name: 'Tib', damage: 600_000, dps: 1250, share: 60, deaths: 0 },
            { healingDone: 0, damageTaken: 0, manaOuts: 0 },
            1
        );

        expect(line).toBe('1. Tib · 600,000 dmg · 60% · 1,250/s');
        expect(line).not.toContain('died');
        expect(line).not.toContain('healed');
        expect(line).not.toContain('ran dry');
    });

    test('deaths are stated plainly', () => {
        const line = playerLine({ name: 'Ada', damage: 10, deaths: 2 }, null, 3);
        expect(line).toContain('died 2×');
    });

    test('running dry carries how long it lasted', () => {
        const line = playerLine(
            { name: 'Moo', damage: 400_000, deaths: 0 },
            { healingDone: 150_000, manaOuts: 3, emptyManaMs: 240_000 },
            2
        );

        expect(line).toContain('healed 150,000');
        expect(line).toContain('ran dry 3× (~4m)');
    });
});

describe('buildGuildReport', () => {
    test('reads as something a guild can paste', () => {
        const report = buildGuildReport({
            trialName: 'Trial Chameleon',
            tiersCleared: 3,
            tier: 4,
            breakdown: breakdown(),
            shortfall: { remaining: 112_000, total: 669_500, unit: 'HP' },
        });

        expect(report).toContain('Trial Chameleon — cleared 3 tiers');
        expect(report).toContain('Party · 1,000,000 dmg in 8m');
        expect(report).toContain('1. Tib');
        expect(report).toContain('died 1×');
        expect(report).toContain('2. Moo');
        expect(report).toContain('ran dry 3×');
        expect(report).toContain('Healing · 150,000 attributed');
        expect(report).toContain('83% into T4');
        expect(report).toContain('estimated from the battle feed');
    });

    test('carries no markup and no long lines', () => {
        const report = buildGuildReport({ trialName: 'Trial Chameleon', tiersCleared: 3, breakdown: breakdown() });

        expect(report).not.toMatch(/<[a-z]/i);
        // Nothing padded out to a width a proportional font would ruin
        expect(report).not.toMatch(/ {3}/);
        for (const line of report.split('\n')) expect(line.length).toBeLessThanOrEqual(120);
    });

    test('a trial nobody measured says so instead of printing an empty table', () => {
        const report = buildGuildReport({
            trialName: 'Trial Chameleon',
            breakdown: { players: [], reason: 'you were not in this fight' },
        });

        expect(report).toContain('Nothing was measured here');
        expect(report).toContain('you were not in this fight');
    });

    test('a large party is trimmed rather than pasted as a wall', () => {
        const many = Array.from({ length: MAX_REPORT_PLAYERS + 4 }, (_, index) => ({
            index: String(index),
            name: `P${index}`,
            damage: 1000 - index,
            deaths: 0,
        }));
        const report = buildGuildReport({ breakdown: breakdown({ players: many }) });

        expect(report).toContain(`…and 4 more`);
    });

    test('one tier cleared is singular', () => {
        expect(buildGuildReport({ tiersCleared: 1, breakdown: breakdown() })).toContain('cleared 1 tier\n');
    });
});
