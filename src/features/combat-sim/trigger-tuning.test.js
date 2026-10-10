/**
 * Trigger optimizer, the parts that are arithmetic: which rows are tunable, the
 * candidate grids, how a halving round is kept and when a change is believed,
 * the whole search against deterministic fake measurements, and the plain-text
 * and sim-editor write-backs. No simulation runs here.
 */

import { describe, test, expect } from 'vitest';
import {
    TRIGGER_OPTIMIZER_SETTING,
    MAX_TRIGGERS,
    PRECISIONS,
    KIND_ENEMY_HP,
    KIND_ENEMY_PCT,
    KIND_HP_POOL,
    KIND_MP_POOL,
    tunableKind,
    activeRows,
    triggersForStorage,
    collectTunables,
    applyTriggerValues,
    clampValue,
    coarseGrid,
    fineGrid,
    balancedScore,
    scopeMetrics,
    pairedDiff,
    accepts,
    successiveHalving,
    runTriggerSearch,
    estimateTriggerSims,
    buildEditorChanges,
    describeRow,
    formatChangeLine,
    formatChangesText,
} from './trigger-tuning.js';

const SELF = '/combat_trigger_dependencies/self';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const ENEMIES = '/combat_trigger_dependencies/all_enemies';
const ALLIES = '/combat_trigger_dependencies/all_allies';
const C_HP = '/combat_trigger_conditions/current_hp';
const C_MISSING_HP = '/combat_trigger_conditions/missing_hp';
const C_MP = '/combat_trigger_conditions/current_mp';
const C_LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
const C_BUFF = '/combat_trigger_conditions/berserk';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';
const INACTIVE = '/combat_trigger_comparators/is_inactive';

const row = (dependencyHrid, conditionHrid, comparatorHrid, value = 0) => ({
    dependencyHrid,
    conditionHrid,
    comparatorHrid,
    value,
});

const FIREBALL = '/abilities/fireball';
const BERSERK = '/abilities/berserk';
const DONUT = '/items/donut';
const COFFEE = '/items/attack_coffee';

function gameData() {
    return {
        abilityDetailMap: {
            [FIREBALL]: { name: 'Fireball', defaultCombatTriggers: [row(TARGET, C_HP, GTE, 1)] },
            [BERSERK]: { name: 'Berserk', defaultCombatTriggers: [row(SELF, C_BUFF, INACTIVE, 0)] },
        },
        itemDetailMap: {
            [DONUT]: {
                name: 'Donut',
                consumableDetail: { defaultCombatTriggers: [row(SELF, C_MISSING_HP, GTE, 100)] },
            },
            [COFFEE]: {
                name: 'Attack Coffee',
                consumableDetail: { defaultCombatTriggers: [row(SELF, C_BUFF, INACTIVE)] },
            },
        },
        combatTriggerDependencyDetailMap: { [TARGET]: { name: 'Targeted enemy' }, [SELF]: { name: 'Self' } },
        combatTriggerConditionDetailMap: {
            [C_HP]: { name: 'Current HP' },
            [C_MISSING_HP]: { name: 'Missing HP' },
            [C_LOWEST]: { name: 'Lowest HP %' },
        },
    };
}

function playerDTO(hrid = 'player1', { abilityTriggers = null, foodTriggers = null } = {}) {
    return {
        hrid,
        abilities: [
            null,
            { hrid: FIREBALL, level: 10, triggers: abilityTriggers },
            { hrid: BERSERK, level: 5, triggers: null },
        ],
        food: [{ hrid: DONUT, triggers: foodTriggers }, null, null],
        drinks: [{ hrid: COFFEE, triggers: null }, null, null],
    };
}

describe('tunableKind', () => {
    test('enemy HP rows on abilities qualify with either enemy dependency', () => {
        expect(tunableKind('abilities', row(TARGET, C_HP, GTE))).toBe(KIND_ENEMY_HP);
        expect(tunableKind('abilities', row(ENEMIES, C_MISSING_HP, LTE))).toBe(KIND_ENEMY_HP);
    });

    test('lowest HP percentage qualifies only against all enemies', () => {
        expect(tunableKind('abilities', row(ENEMIES, C_LOWEST, LTE))).toBe(KIND_ENEMY_PCT);
        expect(tunableKind('abilities', row(ALLIES, C_LOWEST, LTE))).toBeNull();
        expect(tunableKind('abilities', row(TARGET, C_LOWEST, LTE))).toBeNull();
    });

    test('self HP and MP rows on food and drinks qualify; the same row on an ability does not', () => {
        expect(tunableKind('food', row(SELF, C_MISSING_HP, GTE))).toBe(KIND_HP_POOL);
        expect(tunableKind('food', row(SELF, C_MP, LTE))).toBe(KIND_MP_POOL);
        expect(tunableKind('drinks', row(SELF, '/combat_trigger_conditions/missing_mp', GTE))).toBe(KIND_MP_POOL);
        expect(tunableKind('abilities', row(SELF, C_HP, GTE))).toBeNull();
        expect(tunableKind('food', row(TARGET, C_HP, GTE))).toBeNull();
    });

    test('rows whose comparator does not read the value never qualify', () => {
        expect(tunableKind('abilities', row(SELF, C_BUFF, INACTIVE))).toBeNull();
        expect(tunableKind('abilities', row(TARGET, C_HP, INACTIVE))).toBeNull();
        expect(tunableKind('abilities', null)).toBeNull();
    });
});

describe('activeRows and collectTunables', () => {
    test('a slot with null triggers starts from the game defaults', () => {
        const { rows, fromDefault } = activeRows({ hrid: FIREBALL, triggers: null }, 'abilities', gameData());
        expect(fromDefault).toBe(true);
        expect(rows).toEqual([row(TARGET, C_HP, GTE, 1)]);
    });

    test('custom triggers win over the defaults, even an empty list', () => {
        expect(activeRows({ hrid: FIREBALL, triggers: [] }, 'abilities', gameData()).rows).toEqual([]);
        const custom = [row(TARGET, C_HP, GTE, 600)];
        expect(activeRows({ hrid: FIREBALL, triggers: custom }, 'abilities', gameData()).fromDefault).toBe(false);
    });

    test('untouched abilities and food yield their default rows; buff-only items yield nothing', () => {
        const tunables = collectTunables({
            playerDTOs: [playerDTO()],
            playerIndices: [0],
            gameData: gameData(),
            playerNames: { player1: 'Milkman' },
        });
        expect(tunables.map((t) => [t.itemName, t.kind, t.original, t.fromDefault])).toEqual([
            ['Fireball', KIND_ENEMY_HP, 1, true],
            ['Donut', KIND_HP_POOL, 100, true],
        ]);
        expect(tunables[0].playerName).toBe('Milkman');
        expect(tunables[0].key).toBe(`player1|abilities|${FIREBALL}|0`);
    });

    test('custom values are the starting point, and only the chosen players are read', () => {
        const dtos = [playerDTO('player1', { abilityTriggers: [row(TARGET, C_HP, GTE, 600)] }), playerDTO('player2')];
        const solo = collectTunables({ playerDTOs: dtos, playerIndices: [0], gameData: gameData() });
        expect(solo.find((t) => t.itemHrid === FIREBALL).original).toBe(600);
        expect(new Set(solo.map((t) => t.playerHrid))).toEqual(new Set(['player1']));
        const party = collectTunables({ playerDTOs: dtos, playerIndices: [0, 1], gameData: gameData() });
        expect(new Set(party.map((t) => t.playerHrid))).toEqual(new Set(['player1', 'player2']));
    });
});

describe('applyTriggerValues', () => {
    const tunablesFor = (dtos) => collectTunables({ playerDTOs: dtos, playerIndices: [0], gameData: gameData() });

    test('returns the input untouched when nothing differs from the original', () => {
        const dtos = [playerDTO()];
        const tunables = tunablesFor(dtos);
        expect(applyTriggerValues(dtos, tunables, {})).toBe(dtos);
        expect(applyTriggerValues(dtos, tunables, { [tunables[0].key]: tunables[0].original })).toBe(dtos);
    });

    test('writes the full row list into the slot and leaves the source alone', () => {
        const dtos = [playerDTO()];
        const tunables = tunablesFor(dtos);
        const out = applyTriggerValues(dtos, tunables, { [tunables[0].key]: 750 });
        expect(out[0].abilities[1].triggers).toEqual([row(TARGET, C_HP, GTE, 750)]);
        expect(dtos[0].abilities[1].triggers).toBeNull();
        expect(out[0].abilities[2]).toBe(dtos[0].abilities[2]);
        expect(out[0].food).toBe(dtos[0].food);
    });

    test('two tunables on different slots both land', () => {
        const dtos = [playerDTO()];
        const [fireball, donut] = tunablesFor(dtos);
        const out = applyTriggerValues(dtos, [fireball, donut], { [fireball.key]: 5, [donut.key]: 250 });
        expect(out[0].abilities[1].triggers[0].value).toBe(5);
        expect(out[0].food[0].triggers[0].value).toBe(250);
    });
});

describe('triggersForStorage (the sim editor convention)', () => {
    const defaults = [row(TARGET, C_HP, GTE, 1)];

    test('rows equal to the defaults store as null', () => {
        expect(triggersForStorage([row(TARGET, C_HP, GTE, 1)], defaults)).toBeNull();
        expect(triggersForStorage([{ ...row(TARGET, C_HP, GTE), value: '1' }], defaults)).toBeNull();
    });

    test('a different value, or a different row count, stores the rows', () => {
        expect(triggersForStorage([row(TARGET, C_HP, GTE, 600)], defaults)).toEqual([row(TARGET, C_HP, GTE, 600)]);
        expect(triggersForStorage([], defaults)).toEqual([]);
    });

    test('the editor limit is four rows', () => {
        expect(MAX_TRIGGERS).toBe(4);
    });
});

describe('grids', () => {
    const enemy = { kind: KIND_ENEMY_HP, original: 1, playerHrid: 'player1' };
    const ctx = { partyDps: 100, pools: { player1: { hp: 2000, mp: 1000 } } };

    test('enemy HP runs from 0 up to six seconds of party damage in twelve points, plus the current value', () => {
        const grid = coarseGrid(enemy, ctx);
        expect(grid[0]).toBe(0);
        expect(grid[grid.length - 1]).toBe(600);
        expect(grid).toContain(1);
        expect(grid.length).toBe(13);
        expect([...grid].sort((a, b) => a - b)).toEqual(grid);
        expect(grid.every(Number.isInteger)).toBe(true);
    });

    test('percentages run 0 to 100 in tens', () => {
        const grid = coarseGrid({ kind: KIND_ENEMY_PCT, original: 50 }, ctx);
        expect(grid).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    });

    test('food thresholds step through 10% of the matching pool', () => {
        const hp = coarseGrid({ kind: KIND_HP_POOL, original: 100, playerHrid: 'player1' }, ctx);
        expect(hp).toEqual([0, 100, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 2000]);
        const mp = coarseGrid({ kind: KIND_MP_POOL, original: 0, playerHrid: 'player1' }, ctx);
        expect(mp[mp.length - 1]).toBe(1000);
        expect(mp.length).toBe(11);
    });

    test('a missing baseline falls back to a range around the current value instead of an empty grid', () => {
        const grid = coarseGrid({ kind: KIND_ENEMY_HP, original: 800 }, { partyDps: 0, pools: {} });
        expect(grid[grid.length - 1]).toBe(1600);
    });

    test('values clamp to integers, never below zero, percent never above 100', () => {
        expect(clampValue(KIND_ENEMY_HP, -5)).toBe(0);
        expect(clampValue(KIND_ENEMY_HP, 12.6)).toBe(13);
        expect(clampValue(KIND_ENEMY_PCT, 140)).toBe(100);
        expect(clampValue(KIND_HP_POOL, 140)).toBe(140);
    });

    test('fine grids sit around the winner, skip tried values and the center, and stay in range', () => {
        const pct = { kind: KIND_ENEMY_PCT, original: 50 };
        expect(fineGrid(pct, ctx, 40)).toEqual([35, 38, 42, 45]);
        expect(fineGrid(pct, ctx, 98)).toEqual([93, 96, 100]);
        expect(fineGrid(pct, ctx, 3)).toEqual([0, 1, 5, 8]);
        expect(fineGrid(pct, ctx, 40, new Set([38, 45]))).toEqual([35, 42]);
        // the enemy-HP step is 600/11 ≈ 54.5, so offsets are about ±27 and ±14
        const hp = fineGrid(enemy, ctx, 300);
        expect(hp.length).toBe(4);
        expect(hp.every((v) => Math.abs(v - 300) <= 28 && v !== 300)).toBe(true);
        expect(fineGrid(enemy, ctx, 0).every((v) => v >= 0)).toBe(true);
    });
});

describe('balancedScore', () => {
    const base = { xp: 1000, profit: 2000, deaths: 1, dps: 100, encounters: 10 };

    test('the baseline scores zero', () => {
        expect(balancedScore(base, base)).toBe(0);
    });

    test('is the average of four percent changes and the death penalty', () => {
        const better = { xp: 1100, profit: 2200, deaths: 1, dps: 110, encounters: 11 };
        expect(balancedScore(better, base)).toBeCloseTo((10 + 10 + 10 + 10) / 5, 6);
        const worse = { ...base, deaths: 3 };
        expect(balancedScore(worse, base)).toBeCloseTo(-20 / 5, 6);
    });

    test('a zero baseline term reads as no signal rather than infinity', () => {
        expect(balancedScore({ ...base, profit: 999 }, { ...base, profit: 0 })).toBe(0);
    });

    test('scope metrics sum the judged players and carry encounters through', () => {
        const sample = {
            encounters: 7,
            perPlayer: { a: { xp: 1, profit: 2, deaths: 3, dps: 4 }, b: { xp: 10, profit: 20, deaths: 30, dps: 40 } },
        };
        expect(scopeMetrics(sample, ['a'])).toEqual({ xp: 1, profit: 2, deaths: 3, dps: 4, encounters: 7 });
        expect(scopeMetrics(sample, ['a', 'b'])).toEqual({ xp: 11, profit: 22, deaths: 33, dps: 44, encounters: 7 });
    });
});

describe('paired statistics and the acceptance rule', () => {
    test('paired differences use the same seeds', () => {
        const d = pairedDiff([5, 7, 6, 8], [4, 5, 5, 6]);
        expect(d.mean).toBeCloseTo(1.5, 6);
        expect(d.se).toBeGreaterThan(0);
        expect(d.n).toBe(4);
    });

    test('a single seed has no error bar and is never accepted', () => {
        const d = pairedDiff([5], [1]);
        expect(d.se).toBe(Infinity);
        expect(accepts(d)).toBe(false);
    });

    test('accepts only a positive gain beyond two standard errors', () => {
        expect(accepts({ mean: 5, se: 2 })).toBe(true);
        expect(accepts({ mean: 4, se: 2 })).toBe(false);
        expect(accepts({ mean: 3.9, se: 2 })).toBe(false);
        expect(accepts({ mean: -5, se: 0.1 })).toBe(false);
        expect(accepts({ mean: 0, se: 0 })).toBe(false);
        expect(accepts({ mean: 1, se: 0 })).toBe(true);
    });
});

describe('successiveHalving', () => {
    /** Four seeds; a sample's score is its value, plus a seed offset shared by every value */
    const makeMeasure =
        (calls, valueScore = (v) => v) =>
        async (value, hours) => {
            calls.push({ value, hours });
            return [0, 1, 2, 3].map((k) => ({ s: valueScore(value) + k }));
        };
    const score = (sample) => sample.s;

    test('twelve candidates narrow 12 -> 4 -> 2 -> 1 with each round 1.5x longer', async () => {
        const calls = [];
        const values = Array.from({ length: 12 }, (_, i) => i + 10);
        const result = await successiveHalving({
            values,
            reference: 0,
            hours: 10,
            measure: makeMeasure(calls),
            score,
        });
        const byHours = new Map();
        for (const c of calls) byHours.set(c.hours, (byHours.get(c.hours) || 0) + 1);
        expect([...byHours]).toEqual([
            [10, 13],
            [15, 5],
            [22.5, 3],
        ]);
        expect(result.rounds).toBe(3);
        expect(result.winner).toBe(21);
        expect(result.accepted).toBe(true);
        expect(result.means.get(10)).toBeCloseTo(11.5, 6);
    });

    test('the top third survives each cut, best first', async () => {
        const calls = [];
        await successiveHalving({
            values: [1, 2, 3, 4, 5, 6, 7, 8, 9],
            reference: 0,
            hours: 1,
            measure: makeMeasure(calls),
            score,
        });
        const secondRound = calls.filter((c) => c.hours === 1.5).map((c) => c.value);
        expect(secondRound.sort((a, b) => a - b)).toEqual([0, 7, 8, 9]);
    });

    test('a winner no better than the reference is not accepted', async () => {
        const result = await successiveHalving({
            values: [1, 2, 3],
            reference: 10,
            hours: 1,
            measure: makeMeasure([], (v) => (v === 10 ? 50 : 0)),
            score,
        });
        expect(result.accepted).toBe(false);
    });

    test('a noisy gain inside two standard errors is not accepted', async () => {
        const noise = { 5: [0, 0, 0, 0], 6: [3, -3, 3, -2] };
        const result = await successiveHalving({
            values: [6],
            reference: 5,
            hours: 1,
            measure: async (value) => noise[value].map((s) => ({ s })),
            score,
        });
        expect(result.winner).toBe(6);
        expect(result.diff.mean).toBeCloseTo(0.25, 6);
        expect(result.accepted).toBe(false);
    });

    test('stopping returns null before a first round, and the partial state after', async () => {
        let stop = true;
        expect(
            await successiveHalving({
                values: [1, 2],
                reference: 0,
                hours: 1,
                measure: makeMeasure([]),
                score,
                aborted: () => stop,
            })
        ).toBeNull();
        stop = false;
        const result = await successiveHalving({
            values: [1, 2, 3, 4, 5, 6],
            reference: 0,
            hours: 1,
            measure: async (value, hours) => {
                if (hours > 1) stop = true;
                return [0, 1, 2, 3].map((k) => ({ s: value + k }));
            },
            score,
            aborted: () => stop,
        });
        expect(result.winner).toBe(6);
    });
});

describe('runTriggerSearch with deterministic fakes', () => {
    const precision = { ...PRECISIONS.standard, seeds: 4, pointHours: 40 };

    /**
     * A world where Fireball's enemy-HP threshold has a sharp optimum at 300
     * and the Donut threshold does nothing at all. Every seed adds the same
     * offset to every setup, which is what makes the runs paired.
     */
    function world({ optimum = 300 } = {}) {
        const calls = [];
        const measure = async (overrides, hours, seedSet) => {
            calls.push({ overrides: { ...overrides }, hours, seedSet });
            const fireball = overrides[`player1|abilities|${FIREBALL}|0`] ?? 1;
            return [0, 1, 2, 3].map((k) => ({
                perPlayer: {
                    player1: { xp: 1000 - Math.abs(fireball - optimum) + k * 3, profit: 0, deaths: 0, dps: 100 },
                },
                encounters: 10,
                pools: { player1: { hp: 1000, mp: 500 } },
            }));
        };
        return { measure, calls };
    }

    const tunables = () => collectTunables({ playerDTOs: [playerDTO()], playerIndices: [0], gameData: gameData() });

    test('finds the optimum, leaves the inert trigger alone and confirms the combination', async () => {
        const { measure, calls } = world();
        const result = await runTriggerSearch({
            tunables: tunables(),
            scopeHrids: ['player1'],
            measure,
            precision,
        });
        expect(result.changes).toHaveLength(1);
        const [change] = result.changes;
        expect(change.itemName).toBe('Fireball');
        expect(change.from).toBe(1);
        expect(Math.abs(change.to - 300)).toBeLessThanOrEqual(15);
        expect(change.deltaScore).toBeGreaterThan(5);
        expect(change.deltaXp).toBeGreaterThan(200);
        expect(result.unchanged.map((t) => t.itemName)).toEqual(['Donut']);
        expect(result.combined.deltaScore).toBeGreaterThan(5);
        expect(result.combined.seeds).toBe(4);
        expect(result.stopped).toBe(false);
        // the combination ran on the fresh seed set; the search never did
        const final = calls.filter((c) => c.seedSet === 'final');
        expect(final).toHaveLength(2);
        expect(calls.filter((c) => c.seedSet === 'search').length).toBeGreaterThan(20);
        // the baseline's party DPS and pools came through to the grids
        expect(result.partyDps).toBe(100);
        expect(result.screened.find((s) => s.key.includes(FIREBALL)).promising).toBe(true);
        expect(result.screened.find((s) => s.key.includes(DONUT)).promising).toBe(false);
    });

    test('nothing to improve means no changes and no combined check', async () => {
        const { measure, calls } = world({ optimum: 1 });
        const result = await runTriggerSearch({ tunables: tunables(), scopeHrids: ['player1'], measure, precision });
        expect(result.changes).toEqual([]);
        expect(result.combined).toBeNull();
        expect(calls.some((c) => c.seedSet === 'final')).toBe(false);
    });

    test('stopping keeps what was accepted and skips the combined check', async () => {
        const { measure } = world();
        let finalCalls = 0;
        let stop = false;
        const result = await runTriggerSearch({
            tunables: tunables(),
            scopeHrids: ['player1'],
            measure: async (overrides, hours, seedSet) => {
                if (seedSet === 'final') finalCalls++;
                // stop as soon as Fireball has an accepted value
                if (overrides[`player1|abilities|${FIREBALL}|0`] > 1 && hours > (40 / 4) * 1.5 * 1.5 * 0.99)
                    stop = true;
                return measure(overrides, hours, seedSet);
            },
            precision,
            aborted: () => stop,
        });
        expect(result.stopped).toBe(true);
        expect(result.combined).toBeNull();
        expect(finalCalls).toBe(0);
    });

    test('a stop before the baseline returns null', async () => {
        const result = await runTriggerSearch({
            tunables: tunables(),
            scopeHrids: ['player1'],
            measure: async () => null,
            precision,
        });
        expect(result).toBeNull();
    });

    test('progress is reported by step', async () => {
        const { measure } = world();
        const seen = [];
        await runTriggerSearch({
            tunables: tunables(),
            scopeHrids: ['player1'],
            measure,
            precision,
            onProgress: ({ description }) => seen.push(description),
        });
        expect(seen[0]).toMatch(/baseline/);
        expect(seen.some((d) => /screening Fireball/.test(d))).toBe(true);
        expect(seen.some((d) => /confirming all changes/.test(d))).toBe(true);
    });

    test('the estimate grows with the number of triggers and the seed count', () => {
        expect(estimateTriggerSims(2, 'standard')).toBeGreaterThan(estimateTriggerSims(1, 'standard'));
        expect(estimateTriggerSims(1, 'precise')).toBeGreaterThan(estimateTriggerSims(1, 'quick'));
    });
});

describe('write-back and text', () => {
    const change = {
        playerHrid: 'player1',
        playerName: 'Milkman',
        slotType: 'abilities',
        itemHrid: FIREBALL,
        itemName: 'Fireball',
        rowIndex: 0,
        dependencyHrid: TARGET,
        conditionHrid: C_HP,
        comparatorHrid: GTE,
        from: 1,
        to: 600,
    };

    test('editor changes carry the row identity and the new value', () => {
        expect(buildEditorChanges({ changes: [change] })).toEqual([
            {
                playerHrid: 'player1',
                slotType: 'abilities',
                itemHrid: FIREBALL,
                rowIndex: 0,
                dependencyHrid: TARGET,
                conditionHrid: C_HP,
                comparatorHrid: GTE,
                from: 1,
                to: 600,
            },
        ]);
        expect(buildEditorChanges(null)).toEqual([]);
    });

    test('rows read the way the game words them, with a percent sign on percentages', () => {
        expect(describeRow(change, gameData(), 600)).toBe('Targeted enemy: Current HP ≥ 600');
        expect(describeRow(row(ENEMIES, C_LOWEST, LTE), gameData(), 40)).toBe('all enemies: Lowest HP % ≤ 40%');
    });

    test('one line per change, naming the player only in a party', () => {
        expect(formatChangeLine(change, gameData())).toBe(
            'Fireball (ability) — Targeted enemy: Current HP ≥ 600 (was 1)'
        );
        const food = {
            ...change,
            slotType: 'food',
            itemHrid: DONUT,
            itemName: 'Donut',
            conditionHrid: C_MISSING_HP,
            dependencyHrid: SELF,
            to: 250,
            from: 100,
        };
        const solo = formatChangesText({ changes: [change, food] }, gameData());
        expect(solo.split('\n')).toHaveLength(2);
        expect(solo).not.toContain('Milkman');
        const party = formatChangesText(
            { changes: [change, { ...food, playerHrid: 'player2', playerName: 'Cheesy' }] },
            gameData()
        );
        expect(party.split('\n')[0].startsWith('Milkman: ')).toBe(true);
        expect(party.split('\n')[1].startsWith('Cheesy: ')).toBe(true);
        expect(party.split('\n')[1]).toContain('Donut (food)');
    });

    test('the setting key is the one the schema declares', () => {
        expect(TRIGGER_OPTIMIZER_SETTING).toBe('combatSim_triggerOptimizer');
    });
});
