import { describe, test, expect, afterEach } from 'vitest';

import CombatUnit from './engine/combat-unit.js';
import { setGameData } from './engine/game-data.js';
import { TRIAL_GAME_DATA } from './engine/guild-trial-game-data.fixture.js';
import { getSimWarnings, resetSimWarnings } from './engine/sim-warnings.js';
import Trigger from './engine/trigger.js';
import {
    CONDITION_CAP,
    abilityBuffSides,
    SCREEN_SEEDS,
    applyTriggerRows,
    buildConditionCandidates,
    combineSurvivors,
    conditionForBuff,
    conditionSlots,
    describeTriggerRows,
    estimateConditionSimsPerFight,
    rowSignature,
    runConditionSearch,
} from './lab-condition-search.js';
import { PRECISIONS } from './trigger-tuning.js';

const SELF = '/combat_trigger_dependencies/self';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const ACTIVE = '/combat_trigger_comparators/is_active';
const INACTIVE = '/combat_trigger_comparators/is_inactive';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const COND = (name) => `/combat_trigger_conditions/${name}`;

/** A lab monster stand-in from the game's own data: casts Frenzy and Fierce Aura on itself, Puncture on me */
const MONSTER = '/monsters/trial_wasp';

/** Consumables as the game's itemDetailMap carries them (only the fields read here) */
const ITEMS = {
    '/items/attack_coffee': {
        hrid: '/items/attack_coffee',
        name: 'Attack Coffee',
        consumableDetail: {
            buffs: [{ uniqueHrid: '/buff_uniques/attack_coffee', typeHrid: '/buff_types/attack_level' }],
            defaultCombatTriggers: [
                { dependencyHrid: SELF, conditionHrid: COND('attack_coffee'), comparatorHrid: INACTIVE, value: 0 },
            ],
        },
    },
    '/items/spaceberry_cake': {
        hrid: '/items/spaceberry_cake',
        name: 'Spaceberry Cake',
        consumableDetail: {
            buffs: null,
            defaultCombatTriggers: [
                { dependencyHrid: SELF, conditionHrid: COND('missing_hp'), comparatorHrid: GTE, value: 500 },
            ],
        },
    },
};

const GAME_DATA = { ...TRIAL_GAME_DATA, itemDetailMap: ITEMS };

/**
 * A saved loadout as the game sends it (loadout_shared / the snapshot store): equipment keyed by full
 * equipment-type hrid, triggers in the two per-hrid maps, `null`-free slot lists.
 */
const LOADOUT = {
    wearableItemMap: {
        '/equipment_types/main_hand': { itemHrid: '/items/granite_bludgeon', enhancementLevel: 5 },
    },
    abilities: [
        { abilityHrid: '/abilities/toughness' },
        { abilityHrid: '/abilities/maim' },
        { abilityHrid: '/abilities/berserk' },
    ],
    food: [{ itemHrid: '/items/spaceberry_cake' }],
    drinks: [{ itemHrid: '/items/attack_coffee' }],
    abilityCombatTriggersMap: {
        '/abilities/toughness': [
            { dependencyHrid: SELF, conditionHrid: COND('toughness'), comparatorHrid: INACTIVE, value: 0 },
        ],
    },
    consumableCombatTriggersMap: {},
};

/** The player DTO built from it the way `applyLoadoutSnapshotToDTO` does: hrid-keyed rows onto slots */
function dtoFromLoadout(loadout) {
    const triggerMap = { ...loadout.abilityCombatTriggersMap, ...loadout.consumableCombatTriggersMap };
    const triggers = (hrid) => (Array.isArray(triggerMap[hrid]) ? triggerMap[hrid].map((t) => ({ ...t })) : null);
    return {
        hrid: 'player1',
        equipment: { '/equipment_types/main_hand': { hrid: '/items/granite_bludgeon', enhancementLevel: 5 } },
        abilities: [
            null,
            ...loadout.abilities.map((a) => ({ hrid: a.abilityHrid, level: 50, triggers: triggers(a.abilityHrid) })),
        ],
        food: loadout.food.map((f) => ({ hrid: f.itemHrid, triggers: triggers(f.itemHrid) })),
        drinks: loadout.drinks.map((d) => ({ hrid: d.itemHrid, triggers: triggers(d.itemHrid) })),
    };
}

const has = (rows, dep, cond, cmp) =>
    rows.some((r) => r.dependencyHrid === dep && r.conditionHrid === COND(cond) && r.comparatorHrid === cmp);

describe('conditionForBuff', () => {
    const conds = TRIAL_GAME_DATA.combatTriggerConditionDetailMap;

    test('matches a buff to the condition named after it, or after its prefix', () => {
        expect(conditionForBuff('/buff_uniques/frenzy', conds)).toBe(COND('frenzy'));
        expect(conditionForBuff('/buff_uniques/toughness_fire_resistance', conds)).toBe(COND('toughness'));
        expect(conditionForBuff('/buff_uniques/critical_aura_rate', conds)).toBe(COND('critical_aura'));
    });

    test('a buff no condition reads gives nothing', () => {
        expect(conditionForBuff('/buff_uniques/labyrinth_upgrade_combat_damage', conds)).toBeNull();
    });
});

describe('the grammar and the engine agree on buff identity', () => {
    afterEach(() => {
        setGameData(null);
        resetSimWarnings();
    });

    test('every buff the grammar maps to a condition is one the engine reads as active on its carrier', () => {
        setGameData(GAME_DATA);
        resetSimWarnings();
        const condMap = GAME_DATA.combatTriggerConditionDetailMap;
        const uniques = new Set();
        for (const detail of Object.values(GAME_DATA.abilityDetailMap)) {
            const sides = abilityBuffSides(detail);
            for (const u of [...sides.own, ...sides.foe]) uniques.add(u);
        }
        for (const item of Object.values(ITEMS)) {
            for (const b of item.consumableDetail.buffs || []) uniques.add(b.uniqueHrid);
        }
        let mapped = 0;
        for (const unique of uniques) {
            const cond = conditionForBuff(unique, condMap);
            if (!cond) continue;
            mapped++;
            const unit = new CombatUnit();
            unit.combatDetails.currentHitpoints = 1;
            const active = new Trigger(SELF, cond, ACTIVE);
            expect(active.isActive(unit, null, [unit], null, 0), `${unique} before`).toBe(false);
            unit.addBuff(
                { uniqueHrid: unique, typeHrid: '/buff_types/armor', ratioBoost: 0, flatBoost: 1, duration: 1e10 },
                0
            );
            expect(active.isActive(unit, null, [unit], null, 1), `${unique} → ${cond}`).toBe(true);
        }
        expect(mapped).toBeGreaterThan(20);
        expect(getSimWarnings()).toEqual([]);
    });
});

describe('the candidate grammar', () => {
    const dto = dtoFromLoadout(LOADOUT);
    const slots = conditionSlots(dto, GAME_DATA, 'both');
    const slot = (key) => slots.find((s) => s.key === key);

    test('lists every filled slot with the rows in force, custom or default', () => {
        expect(slots.map((s) => s.key)).toEqual(['abilities|1', 'abilities|2', 'abilities|3', 'food|0', 'drinks|0']);
        expect(slot('abilities|1').fromDefault).toBe(false);
        expect(slot('drinks|0').rows).toEqual([
            { dependencyHrid: SELF, conditionHrid: COND('attack_coffee'), comparatorHrid: INACTIVE, value: 0 },
        ]);
        expect(conditionSlots(dto, GAME_DATA, 'consumables').map((s) => s.key)).toEqual(['food|0', 'drinks|0']);
    });

    test("builds the monster's self-buffs on the target, my kit's buffs on me, and pool readings", () => {
        const rows = buildConditionCandidates({
            slot: slot('drinks|0'),
            dto,
            gameData: GAME_DATA,
            monsterHrids: [MONSTER],
            pools: { hp: 2000, mp: 1000 },
            enemyHp: 50000,
        });

        // What the wasp casts on itself
        expect(has(rows, TARGET, 'frenzy', ACTIVE)).toBe(true);
        expect(has(rows, TARGET, 'frenzy', INACTIVE)).toBe(true);
        expect(has(rows, TARGET, 'fierce_aura', ACTIVE)).toBe(true);
        // What it puts on me
        expect(has(rows, SELF, 'puncture', ACTIVE)).toBe(true);
        // My own kit: Toughness (four prefixed buffs, one condition), Berserk, and my Maim on the target
        expect(has(rows, SELF, 'toughness', INACTIVE)).toBe(true);
        expect(has(rows, SELF, 'berserk', ACTIVE)).toBe(true);
        expect(has(rows, TARGET, 'maim', INACTIVE)).toBe(true);
        // Pool readings at fractions of the pools; a consumable gets no enemy-HP row
        expect(rows).toContainEqual({
            dependencyHrid: SELF,
            conditionHrid: COND('missing_hp'),
            comparatorHrid: GTE,
            value: 500,
        });
        expect(rows).toContainEqual({
            dependencyHrid: SELF,
            conditionHrid: COND('missing_mp'),
            comparatorHrid: GTE,
            value: 500,
        });
        expect(rows.some((r) => r.conditionHrid === COND('current_hp'))).toBe(false);
        // Its own current row alone is not a candidate
        expect(has(rows, SELF, 'attack_coffee', INACTIVE)).toBe(false);
        // Ranked: the monster's self-buffs come first
        expect(rows[0].dependencyHrid).toBe(TARGET);
        expect(rows[0].conditionHrid).toBe(COND('fierce_aura'));
    });

    test('every row is one the game editor allows, with no duplicates, within the cap', () => {
        const condMap = GAME_DATA.combatTriggerConditionDetailMap;
        for (const s of slots) {
            const rows = buildConditionCandidates({
                slot: s,
                dto,
                gameData: GAME_DATA,
                monsterHrids: [MONSTER],
                pools: { hp: 2000, mp: 1000 },
                enemyHp: 50000,
            });
            expect(rows.length).toBeGreaterThan(0);
            expect(rows.length).toBeLessThanOrEqual(CONDITION_CAP);
            expect(new Set(rows.map(rowSignature)).size).toBe(rows.length);
            for (const r of rows) {
                expect(condMap[r.conditionHrid].isSingleTarget).toBe(true);
                expect(condMap[r.conditionHrid].allowedComparatorHrids).toContain(r.comparatorHrid);
            }
        }
        const capped = buildConditionCandidates({
            slot: slot('abilities|1'),
            dto,
            gameData: GAME_DATA,
            monsterHrids: [MONSTER],
            cap: 4,
        });
        expect(capped).toHaveLength(4);
    });

    test('an ability gets target-enemy HP rows at fractions of the monster HP', () => {
        const rows = buildConditionCandidates({
            slot: slot('abilities|2'),
            dto,
            gameData: GAME_DATA,
            monsterHrids: [MONSTER],
            enemyHp: 50000,
        });
        expect(rows).toContainEqual({
            dependencyHrid: TARGET,
            conditionHrid: COND('current_hp'),
            comparatorHrid: GTE,
            value: 25000,
        });
    });

    test('applyTriggerRows replaces one slot and leaves the source alone', () => {
        const rows = [{ dependencyHrid: TARGET, conditionHrid: COND('frenzy'), comparatorHrid: ACTIVE, value: 0 }];
        const out = applyTriggerRows(dto, { 'drinks|0': rows });
        expect(out.drinks[0].triggers).toEqual(rows);
        expect(out.drinks[0].triggers).not.toBe(rows);
        expect(dto.drinks[0].triggers).toBeNull();
        expect(out.abilities).toBe(dto.abilities);
        expect(applyTriggerRows(dto, {})).toBe(dto);
    });
});

describe('combineSurvivors', () => {
    const a = { dependencyHrid: TARGET, conditionHrid: COND('frenzy'), comparatorHrid: ACTIVE, value: 0 };
    const b = { dependencyHrid: SELF, conditionHrid: COND('toughness'), comparatorHrid: INACTIVE, value: 0 };
    const notA = { ...a, comparatorHrid: INACTIVE };

    test('pairs survivors on different readings and adds each to the current rows', () => {
        const current = [
            { dependencyHrid: SELF, conditionHrid: COND('attack_coffee'), comparatorHrid: INACTIVE, value: 0 },
        ];
        const out = combineSurvivors([[a], [b], [notA], []], current);
        expect(out.filter((c) => c.kind === 'pair').map((c) => c.rows)).toEqual([
            [a, b],
            [b, notA],
        ]);
        expect(out.filter((c) => c.kind === 'and-current')).toHaveLength(3);
    });
});

/**
 * A stub measure: each seed's expected attempts is a fixed base, less whatever saving the edits' rows
 * earn under `gainOf`, plus seeded noise shared by every setup on the same seed (as real paired seeds
 * are) and a small per-setup jitter.
 */
function stubMeasure(gainOf, { jitter = 0.01 } = {}) {
    const calls = [];
    const streams = new Map();
    const hash = (s) => {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
        return ((h >>> 0) % 10000) / 10000;
    };
    const measure = async (edits, { stream, count, offset = 0, stage }) => {
        calls.push({ edits, stream, count, stage });
        if (!streams.has(stream)) streams.set(stream, streams.size);
        const setup = JSON.stringify(
            Object.keys(edits)
                .sort()
                .map((k) => [k, edits[k].map(rowSignature).sort()])
        );
        let gain = 0;
        for (const rows of Object.values(edits)) gain += gainOf(rows);
        return Array.from({ length: count }, (_, k) => {
            const seed = `${stream}|${offset + k}`;
            const shared = hash(seed) * 2;
            return { attempts: 5 + shared - gain + (hash(seed + setup) - 0.5) * jitter, pools: {} };
        });
    };
    return { measure, calls };
}

describe('the staged search', () => {
    const frenzyOn = { dependencyHrid: TARGET, conditionHrid: COND('frenzy'), comparatorHrid: ACTIVE, value: 0 };
    const toughOff = { dependencyHrid: SELF, conditionHrid: COND('toughness'), comparatorHrid: INACTIVE, value: 0 };
    const berserkOn = { dependencyHrid: SELF, conditionHrid: COND('berserk'), comparatorHrid: ACTIVE, value: 0 };
    const current = [
        { dependencyHrid: SELF, conditionHrid: COND('attack_coffee'), comparatorHrid: INACTIVE, value: 0 },
    ];
    const slot = {
        key: 'drinks|0',
        slotType: 'drinks',
        slotIndex: 0,
        itemHrid: '/items/attack_coffee',
        itemName: 'Attack Coffee',
        rows: current,
    };
    const candidates = [frenzyOn, toughOff, berserkOn];
    const has2 = (rows, r) => rows.some((x) => rowSignature(x) === rowSignature(r));

    test('finds the AND-pair that wins, when each half alone only helps a little', async () => {
        // Each half alone saves 0.05 attempts; together they save 0.6
        const gainOf = (rows) => {
            const f = has2(rows, frenzyOn);
            const t = has2(rows, toughOff);
            if (f && t && rows.length === 2) return 0.6;
            return (f ? 0.05 : 0) + (t ? 0.05 : 0);
        };
        const { measure, calls } = stubMeasure(gainOf);
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });

        expect(result.reliable).toBe(true);
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change.kind).toBe('pair');
        expect(change.toRows.map(rowSignature).sort()).toEqual([frenzyOn, toughOff].map(rowSignature).sort());
        expect(change.fromRows).toEqual(current);
        expect(change.deltaScore).toBeGreaterThan(0.5);
        expect(result.combined.deltaScore).toBeGreaterThan(0.5);
        // The screen ran cheap, every candidate plus "always" against the current rows
        const screen = calls.filter((c) => c.stage === 'screen');
        // ... plus the current rows ANDed with each candidate
        expect(screen).toHaveLength(1 + candidates.length + 1 + candidates.length);
        expect(screen.every((c) => c.count === SCREEN_SEEDS)).toBe(true);
        // Selection and confirmation never share seeds
        const streamsOf = (stage) => new Set(calls.filter((c) => c.stage === stage).map((c) => c.stream));
        for (const s of streamsOf('confirm')) {
            expect(streamsOf('screen').has(s) || streamsOf('pair').has(s)).toBe(false);
        }
    });

    test('finds current AND X when X alone, replacing the current rows, is worse', async () => {
        // The Toughness-on-a-Mimic shape: "Frenzy active" alone is worse than the default, the default
        // plus it is clearly better
        const gainOf = (rows) => {
            const f = has2(rows, frenzyOn);
            const keepsCurrent = has2(rows, current[0]);
            if (f && keepsCurrent && rows.length === 2) return 0.5;
            return f ? -0.2 : 0;
        };
        const { measure } = stubMeasure(gainOf);
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].kind).toBe('and-current');
        expect(result.changes[0].toRows.map(rowSignature).sort()).toEqual(
            [...current, frenzyOn].map(rowSignature).sort()
        );
    });

    test('pairs the top few even when every one alone is worse than the current rows', async () => {
        // Each half alone loses 0.1; the two together save 0.6
        const gainOf = (rows) => {
            const f = has2(rows, frenzyOn);
            const t = has2(rows, toughOff);
            if (f && t && rows.length === 2) return 0.6;
            return (f ? -0.1 : 0) + (t ? -0.1 : 0) + (has2(rows, berserkOn) ? -0.1 : 0);
        };
        const { measure } = stubMeasure(gainOf);
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.reliable).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].kind).toBe('pair');
        expect(result.changes[0].toRows.map(rowSignature).sort()).toEqual(
            [frenzyOn, toughOff].map(rowSignature).sort()
        );
    });

    test('keeps the best measured candidate of a slot that changed nothing', async () => {
        const { measure } = stubMeasure((rows) => (has2(rows, berserkOn) && rows.length === 1 ? 0.01 : 0));
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.changes).toEqual([]);
        expect(result.bestMeasured).toHaveLength(1);
        const best = result.bestMeasured[0];
        expect(best.key).toBe('drinks|0');
        expect(best.fromRows).toEqual(current);
        expect(Number.isFinite(best.deltaScore)).toBe(true);
        expect(Number.isFinite(best.se)).toBe(true);
        expect(['screen', 'pair', 'confirm']).toContain(best.stage);
    });

    test('a slot that passed alone but failed the all-together check is still reported as the best measured', async () => {
        const base = stubMeasure((rows) => (has2(rows, berserkOn) && rows.length === 1 ? 0.5 : 0));
        // The fresh-seed check disagrees: the changed setup is much worse there
        const measure = async (edits, opts) => {
            const samples = await base.measure(edits, opts);
            if (opts.stage !== 'final' || Object.keys(edits).length === 0) return samples;
            return samples.map((x) => ({ ...x, attempts: x.attempts + 5 }));
        };
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.reliable).toBe(false);
        expect(result.changes).toEqual([]);
        expect(result.rejected).toHaveLength(1);
        expect(result.bestMeasured.map((b) => b.key)).toEqual(['drinks|0']);
    });

    test('"always" does not displace one of the three real singles from the pairing stage', async () => {
        const gains = new Map([
            [rowSignature(frenzyOn), 0.1],
            [rowSignature(toughOff), 0.09],
            [rowSignature(berserkOn), 0.08],
        ]);
        const gainOf = (rows) =>
            rows.length === 0 ? 0.3 : rows.length === 1 ? gains.get(rowSignature(rows[0])) || 0 : 0;
        const { measure, calls } = stubMeasure(gainOf);
        await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        const pairSizes = calls.filter((c) => c.stage === 'pair').map((c) => c.edits['drinks|0']);
        const pairsWithBerserk = pairSizes.filter(
            (rows) => rows.length === 2 && has2(rows, berserkOn) && !has2(rows, current[0])
        );
        expect(pairsWithBerserk.length).toBeGreaterThan(0);
        expect(pairSizes.some((rows) => rows.length === 0)).toBe(true);
    });

    test('a slot rejected by the all-together check reports its confirmation figure, not the pairing pick', async () => {
        const base = stubMeasure((rows) => (has2(rows, berserkOn) && rows.length === 1 ? 0.5 : 0));
        const measure = async (edits, opts) => {
            const samples = await base.measure(edits, opts);
            if (opts.stage !== 'final' || Object.keys(edits).length === 0) return samples;
            return samples.map((x) => ({ ...x, attempts: x.attempts + 5 }));
        };
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.reliable).toBe(false);
        expect(result.bestMeasured).toHaveLength(1);
        expect(result.bestMeasured[0].stage).toBe('confirm');
    });

    test('a slot whose every candidate is worse still reports its best, not above zero by much', async () => {
        const { measure } = stubMeasure((rows) =>
            rows.length === 1 && rowSignature(rows[0]) === rowSignature(current[0]) ? 0 : -0.3
        );
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.changes).toEqual([]);
        expect(result.bestMeasured).toHaveLength(1);
        expect(result.bestMeasured[0].deltaScore).toBeLessThanOrEqual(0.05);
    });

    test('rejects noise: nothing changes when no condition does anything', async () => {
        const { measure } = stubMeasure(() => 0, { jitter: 0.5 });
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.changes).toEqual([]);
    });

    test('a gain below the minimum is not offered', async () => {
        const { measure } = stubMeasure((rows) => (has2(rows, berserkOn) && rows.length === 1 ? 0.01 : 0));
        const result = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
        });
        expect(result.changes).toEqual([]);
    });

    test('Stop and the sim cap end the search where it stands', async () => {
        const { measure } = stubMeasure(() => 0);
        const stopped = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
            aborted: () => true,
        });
        expect(stopped.stopped).toBe(true);
        expect(stopped.screened).toBe(0);

        const capped = await runConditionSearch({
            slots: [slot],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
            overBudget: () => true,
        });
        expect(capped.capped).toBe(true);
        expect(capped.screened).toBe(0);
    });

    test('changes confirmed before the cap still get their all-together check and are kept', async () => {
        const gainOf = (rows) => {
            const f = has2(rows, frenzyOn);
            const t = has2(rows, toughOff);
            if (f && t && rows.length === 2) return 0.6;
            return (f ? 0.05 : 0) + (t ? 0.05 : 0);
        };
        const { measure, calls } = stubMeasure(gainOf);
        const second = { ...slot, key: 'drinks|1', slotIndex: 1 };
        const result = await runConditionSearch({
            slots: [slot, second],
            candidatesFor: () => candidates,
            measure,
            precision: PRECISIONS.standard,
            minGain: 0.02,
            // The budget runs out as soon as the second slot has screened its current rows
            overBudget: () => calls.some((c) => c.stream === 'cscreen:drinks|1'),
        });
        expect(result.capped).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].key).toBe('drinks|0');
        expect(result.reliable).toBe(true);
        expect(calls.some((c) => c.stage === 'final')).toBe(true);
    });

    test('the estimate covers the screen, the pairing, the confirmation and the final check', () => {
        const perFight = estimateConditionSimsPerFight([30, 10], PRECISIONS.standard);
        // Per slot: (reference + singles + always + current-AND-single) × 2 seeds, 14 pairing entries × 4 seeds,
        // 2 × 8 confirm; plus 2 × 8 for the final check
        expect(perFight).toBe(62 * 2 + 56 + 16 + (22 * 2 + 56 + 16) + 16);
        expect(estimateConditionSimsPerFight([], PRECISIONS.standard)).toBe(0);
    });
});

describe('describeTriggerRows', () => {
    test("reads like the game's trigger editor", () => {
        const rows = [
            { dependencyHrid: SELF, conditionHrid: COND('toughness'), comparatorHrid: INACTIVE, value: 0 },
            { dependencyHrid: TARGET, conditionHrid: COND('frenzy'), comparatorHrid: ACTIVE, value: 0 },
        ];
        expect(describeTriggerRows(rows, GAME_DATA)).toBe(
            "Activate when: My Toughness Is Inactive AND Target Enemy's Frenzy Is Active"
        );
        expect(
            describeTriggerRows(
                [{ dependencyHrid: SELF, conditionHrid: COND('missing_hp'), comparatorHrid: GTE, value: 300 }],
                GAME_DATA
            )
        ).toBe('Activate when: My Missing Hp >= 300');
        expect(describeTriggerRows([], GAME_DATA)).toBe('Activate when: always (no conditions)');
    });
});
