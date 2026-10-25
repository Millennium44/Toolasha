/**
 * Party Finder arithmetic: which parties are planned, how they are built, and how a finished sim is read and
 * ranked for you alone.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const pricing = vi.hoisted(() => ({ throwFor: null, unpriced: [], capped: null }));

vi.mock('./combat-sim-adapter.js', () => ({
    // Profit read from a test-only `__profit` map, keyed by the player asked for
    calculateSimRevenue: (simResult, _gameData, playerHrid, hours) => {
        if (pricing.throwFor && simResult === pricing.throwFor) throw new Error('no market');
        return {
            netPerHour: ((simResult.__profit || simResult.lootStates?.__profit)?.[playerHrid] ?? 0) / hours,
            dropEntries: [{ itemHrid: '/items/x', name: 'X', countPerHour: 1 }],
            unpricedDrops: pricing.unpriced,
            unpricedConsumables: [],
            unpricedKeys: [],
        };
    },
    // Highest combat level takes no penalty; everyone below takes 0.1 per member above them, enough to tell
    recomputeLevelGapDebuffs: (players) => {
        const top = Math.max(...players.map((p) => p.magicLevel));
        for (const p of players) p.debuffOnLevelGap = p.magicLevel < top ? 0.1 : 0;
    },
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitRateCached: ({ goldPerHour }) =>
        pricing.capped != null && goldPerHour > pricing.capped
            ? { goldPerHour: pricing.capped, capped: true, limit: { note: 'vol' } }
            : { goldPerHour, capped: false, limit: null },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));

const {
    planSweep,
    enumerateCompositions,
    narrowRoster,
    countCompositionsUpperBound,
    buildCompositionParty,
    readResult,
    repriceMetrics,
    soloDelta,
    sortRows,
    pickRerunRows,
    partyLabel,
    csvRow,
    stoppedSweepText,
    applyAura,
    sharedAuras,
    maxAbilityLevel,
    checkAuraOption,
    MAX_QUICK_RUNS,
} = await import('./party-finder.js');

const HOUR = 3600 * 1e9;

function dto(magicLevel = 90, weapon = '/items/rippling_trident') {
    return {
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel,
        equipment: { '/equipment_types/main_hand': { hrid: weapon, enhancementLevel: 5 } },
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null, null],
    };
}

const mate = (id, name, build = dto(80 + id.length)) => ({ id, name, dto: build });

const ZONE = { zoneHrid: '/actions/combat/swamp_planet', difficultyTier: 1, isDungeon: false, name: 'Swamp Planet' };
const DUNGEON = { zoneHrid: '/actions/combat/chimerical_den', difficultyTier: 0, isDungeon: true, name: 'Den' };

beforeEach(() => {
    pricing.throwFor = null;
    pricing.unpriced = [];
    pricing.capped = null;
});

describe('planSweep', () => {
    const four = [mate('a', 'Ann'), mate('bb', 'Bob'), mate('ccc', 'Cy'), mate('dddd', 'Di')];

    test('a 3-player zone tries solo, every single and every pair; a dungeon goes up to four teammates', () => {
        const zone = planSweep({ zones: [ZONE], roster: four });
        // 1 + 4 + 6
        expect(zone.total).toBe(11);
        expect(Math.max(...zone.tasks.map((t) => t.comp.members.length))).toBe(2);

        const dungeon = planSweep({ zones: [DUNGEON], roster: four });
        // 1 + 4 + 6 + 4 + 1
        expect(dungeon.total).toBe(16);
        expect(Math.max(...dungeon.tasks.map((t) => t.comp.members.length))).toBe(4);
    });

    test('solo baselines of every zone come first, so a stop still leaves them', () => {
        const plan = planSweep({ zones: [ZONE, DUNGEON], roster: four });
        expect(plan.tasks.slice(0, 2).every((t) => t.comp.isBaseline)).toBe(true);
        expect(plan.tasks.slice(2).some((t) => t.comp.isBaseline)).toBe(false);
    });

    test('the max party size narrows every zone, never past its own cap', () => {
        const plan = planSweep({ zones: [ZONE, DUNGEON], roster: four, maxPartySize: 2 });
        expect(plan.total).toBe(10);
        expect(Math.max(...plan.tasks.map((t) => t.comp.members.length))).toBe(1);
    });

    test('must-include and exclude', () => {
        const plan = planSweep({ zones: [ZONE], roster: four, choices: { a: 'always', dddd: 'never' } });
        const parties = plan.tasks.filter((t) => !t.comp.isBaseline).map((t) => partyLabel(t.comp));
        expect(parties).toEqual(['Ann', 'Ann + Bob', 'Ann + Cy']);
        expect(plan.tasks[0].comp.isBaseline).toBe(true);
    });

    test('more must-includes than a zone can hold: that zone runs nothing and says why', () => {
        const plan = planSweep({
            zones: [ZONE, DUNGEON],
            roster: four,
            choices: { a: 'always', bb: 'always', ccc: 'always' },
        });
        const zoneEntry = plan.perZone.find((z) => z.zone === ZONE);
        expect(zoneEntry.count).toBe(0);
        expect(zoneEntry.note).toMatch(/Ann, Bob, Cy cannot all fit in a 3-player party/);
        expect(plan.tasks.every((t) => t.zone === DUNGEON)).toBe(true);
    });

    test('an empty roster plans nothing and says so', () => {
        const plan = planSweep({ zones: [ZONE], roster: [] });
        expect(plan.total).toBe(0);
        expect(plan.perZone[0].note).toBe('no teammates to try');
    });

    test('zero zones plans nothing', () => {
        expect(planSweep({ zones: [], roster: four }).total).toBe(0);
    });

    test('the same zone/tier picked twice is planned once', () => {
        expect(planSweep({ zones: [ZONE, { ...ZONE }], roster: four }).total).toBe(11);
    });

    test('a sweep over the limit is refused, before enumerating a huge one', () => {
        const forty = Array.from({ length: 40 }, (_, i) => mate(`m${i}`, `M${i}`, dto(60 + i)));
        const plan = planSweep({ zones: [DUNGEON], roster: forty });
        expect(plan.refused).toMatch(/over the 1,500 limit/);
        expect(plan.tasks).toEqual([]);

        // 1 + 40 + 780 per zone, two zones: over the limit after enumerating
        const two = planSweep({ zones: [ZONE, { ...ZONE, difficultyTier: 2 }], roster: forty });
        expect(two.total).toBe(1642);
        expect(two.total).toBeGreaterThan(MAX_QUICK_RUNS);
        expect(two.refused).toMatch(/1,642/);
    });
});

describe('enumerateCompositions', () => {
    test('the same build saved twice, under the same name or not, is one party with an alias', () => {
        const same = dto(99);
        const { pool, mustInclude } = narrowRoster([
            mate('a', 'Bob', same),
            mate('b', 'Bob', structuredClone(same)),
            mate('c', 'Cy', dto(70)),
        ]);
        const comps = enumerateCompositions(pool, mustInclude, 2);
        const labels = comps.map(partyLabel);
        // Solo, Bob, Cy, Bob+Bob (two copies is a real party), Bob+Cy
        expect(labels).toEqual(['Solo', 'Bob', 'Cy', 'Bob + Bob', 'Bob + Cy']);
        expect(comps.find((c) => partyLabel(c) === 'Bob').aliases).toEqual([['Bob']]);
    });

    test('the cheap upper bound matches the count with distinct builds', () => {
        const roster = Array.from({ length: 6 }, (_, i) => mate(`m${i}`, `M${i}`, dto(60 + i)));
        const { pool, mustInclude } = narrowRoster(roster);
        const ones = pool.map(() => 1);
        expect(enumerateCompositions(pool, mustInclude, 4)).toHaveLength(
            countCompositionsUpperBound(
                ones,
                ones.map(() => false),
                4
            )
        );
        const narrowed = narrowRoster(roster, { m0: 'always' });
        expect(enumerateCompositions(narrowed.pool, narrowed.mustInclude, 2)).toHaveLength(
            countCompositionsUpperBound(
                ones,
                narrowed.pool.map((t) => t.id === 'm0'),
                2
            )
        );
    });
});

describe('buildCompositionParty', () => {
    test('you are player1, teammates follow, each a copy with this party’s level gaps', () => {
        const self = { ...dto(90), hrid: 'player3', debuffOnLevelGap: 0.3 };
        const high = mate('a', 'High', dto(120));
        const party = buildCompositionParty(self, [high, mate('b', 'Low', dto(70))]);
        expect(party.map((p) => p.hrid)).toEqual(['player1', 'player2', 'player3']);
        expect(party.map((p) => p.debuffOnLevelGap)).toEqual([0.1, 0, 0.1]);
        // Copies: the roster's own build is untouched
        party[1].magicLevel = 1;
        expect(high.dto.magicLevel).toBe(120);
        expect(self.hrid).toBe('player3');
    });

    test('alone there is no level-gap penalty', () => {
        const [solo] = buildCompositionParty({ ...dto(), debuffOnLevelGap: 0.4 }, []);
        expect(solo.debuffOnLevelGap).toBe(0);
    });
});

describe('readResult', () => {
    const sim = (xp, profit, deaths = 0, hours = 2) => ({
        simulatedTime: hours * HOUR,
        experienceGained: { player1: { magic: xp }, player2: { magic: 99999 } },
        deaths: { player1: deaths, player2: 50 },
        // Read by the test adapter; a field the kept row keeps, so repricing can read it again
        lootStates: { __profit: { player1: profit, player2: 99999 } },
    });

    test('reads you, never the party', () => {
        const m = readResult(sim(2000, 400, 1), {}, 2);
        expect(m.xpPerHour).toBe(1000);
        expect(m.profitPerHour).toBe(200);
        expect(m.deathsPerHour).toBe(0.5);
    });

    test('a failed sim is a failed row', () => {
        expect(readResult(null, {}, 2)).toEqual({ failed: true });
    });

    test('pricing that throws leaves profit null, not 0', () => {
        const s = sim(100, 100);
        pricing.throwFor = s;
        expect(readResult(s, {}, 2).profitPerHour).toBeNull();
    });

    test('unpriced loot is named on the row', () => {
        pricing.unpriced = ['/items/mystery_box'];
        expect(readResult(sim(100, 100), {}, 2).unpriced).toEqual(['/items/mystery_box']);
    });

    test('a volume cap bounds the shown profit and keeps the raw one', () => {
        pricing.capped = 50;
        const m = readResult(sim(100, 400), {}, 2);
        expect(m.profitPerHour).toBe(50);
        expect(m.uncappedProfit).toBe(200);
    });

    test('repricing keeps the sim and re-reads the price', () => {
        const m = readResult(sim(100, 400), {}, 2);
        pricing.capped = 10;
        expect(repriceMetrics(m, {}).profitPerHour).toBe(10);
        expect(repriceMetrics(m, {}).xpPerHour).toBe(m.xpPerHour);
    });
});

describe('ranking against solo', () => {
    const metrics = (xpPerHour, profitPerHour, hours = 2) => ({
        failed: false,
        hours,
        xpPerHour,
        profitPerHour,
        deathsPerHour: 0,
        unpriced: [],
    });
    const row = (key, quick, full = null, isBaseline = false) => ({
        id: key,
        zoneKey: 'z',
        zone: ZONE,
        isBaseline,
        comp: isBaseline ? { isBaseline: true, members: [] } : { members: [{ name: key }] },
        quick,
        full,
    });

    test('a party worse than solo has a negative delta', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const worse = row('Bob', metrics(800, 50));
        expect(soloDelta(worse, base)).toEqual({ xpPct: -20, profitDelta: -50, stage: 'quick' });
    });

    test('like against like: full re-runs compare with the full baseline, else both quick', () => {
        const base = row('solo', metrics(1000, 100), metrics(900, 90, 10), true);
        const party = row('Bob', metrics(1100, 120), metrics(990, 99, 10));
        expect(soloDelta(party, base).stage).toBe('full');
        expect(soloDelta(party, base).xpPct).toBeCloseTo(10);

        const baseQuickOnly = row('solo', metrics(1000, 100), null, true);
        expect(soloDelta(party, baseQuickOnly)).toEqual({ xpPct: 10, profitDelta: 20, stage: 'quick' });
    });

    test('unpriced profit sinks to the bottom of a profit sort either way round', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const rows = [row('A', metrics(1, null)), row('B', metrics(1, 300)), base];
        const baselines = new Map([['z', base]]);
        expect(sortRows(rows, baselines, 'profit').map((r) => r.id)).toEqual(['B', 'solo', 'A']);
        expect(sortRows(rows, baselines, 'profit', true).map((r) => r.id)).toEqual(['solo', 'B', 'A']);
    });

    test('the re-run picks the top K parties and their baselines, baselines first', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const rows = [base, row('A', metrics(1500, 0)), row('B', metrics(1200, 0)), row('C', metrics(1100, 0))];
        const picked = pickRerunRows(rows, new Map([['z', base]]), 'xp', 2);
        expect(picked.map((r) => r.id)).toEqual(['solo', 'A', 'B']);
        expect(pickRerunRows(rows, new Map([['z', base]]), 'xp', 0)).toEqual([]);
    });

    test('a failed row is never re-run and has no figures in the CSV', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        const failed = row('F', { failed: true });
        expect(pickRerunRows([base, failed], new Map([['z', base]]), 'xp', 5)).toEqual([]);
        expect(csvRow(failed, base)).toMatchObject({ xpPerHour: '', note: 'sim failed' });
    });

    test('the CSV row', () => {
        const base = row('solo', metrics(1000, 100), null, true);
        expect(csvRow(row('Bob', metrics(1200, 150)), base)).toMatchObject({
            zone: 'Swamp Planet',
            tier: 1,
            party: 'Bob',
            size: 2,
            xpPerHour: 1200,
            profitPerHour: 150,
            xpVsSoloPct: 20,
            profitVsSolo: 50,
            comparedAt: 'quick pass',
        });
    });

    test('stopped text', () => {
        expect(stoppedSweepText(3, 12)).toBe('stopped early — 3 of 12 sims');
    });
});

describe('aura options', () => {
    // Auras as the game data shapes them: a special ability buffing all allies
    const aura = (name) => ({
        name,
        isSpecialAbility: true,
        abilityEffects: [
            { effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{ typeHrid: '/x' }] },
        ],
    });
    const gameData = {
        abilityDetailMap: {
            '/abilities/fierce_aura': aura('Fierce Aura'),
            '/abilities/mystic_aura': aura('Mystic Aura'),
            '/abilities/invincible': {
                name: 'Invincible',
                isSpecialAbility: true,
                abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'self', buffs: [{}] }],
            },
            '/abilities/water_strike': { name: 'Water Strike', isSpecialAbility: false, abilityEffects: [] },
        },
        levelExperienceTable: Array.from({ length: 201 }, (_, i) => i * 10),
    };
    const withSpecial = (special, level = 30) => {
        const d = dto(90);
        d.abilities[0] = special ? { hrid: special, level, triggers: [{ dependencyHrid: '/x' }] } : null;
        return d;
    };
    const entry = (id, name, build, auras, includeAsBuilt = true) => ({ id, name, dto: build, auras, includeAsBuilt });

    test('an aura takes the special slot, replacing the special worn; triggers kept only for the same aura', () => {
        const replaced = applyAura(withSpecial('/abilities/invincible'), { hrid: '/abilities/fierce_aura', level: 20 });
        expect(replaced.dto.abilities[0]).toEqual({ hrid: '/abilities/fierce_aura', level: 20, triggers: null });
        expect(replaced.replaced).toBe('/abilities/invincible');

        const same = applyAura(withSpecial('/abilities/fierce_aura', 10), {
            hrid: '/abilities/fierce_aura',
            level: 25,
        });
        expect(same.dto.abilities[0].level).toBe(25);
        expect(same.dto.abilities[0].triggers).toEqual([{ dependencyHrid: '/x' }]);
        expect(same.replaced).toBeNull();

        // No special worn, and a build whose ability list is short: the slot is there to fill
        const bare = { ...dto(90), abilities: [] };
        const filled = applyAura(bare, { hrid: '/abilities/mystic_aura', level: 5 });
        expect(filled.dto.abilities).toHaveLength(5);
        expect(filled.dto.abilities[0].hrid).toBe('/abilities/mystic_aura');
        expect(bare.abilities).toEqual([]);
    });

    test('a teammate with two auras is tried three ways, and never twice in one party', () => {
        const roster = [
            entry('a', 'Ann', withSpecial(null), [
                { hrid: '/abilities/fierce_aura', level: 20 },
                { hrid: '/abilities/mystic_aura', level: 15 },
            ]),
            entry('b', 'Bob', dto(100), []),
        ];
        const plan = planSweep({ zones: [ZONE], roster, gameData });
        // Solo; Ann x3; Bob; Ann x3 + Bob
        expect(plan.total).toBe(8);
        const labels = plan.tasks.map((t) => partyLabel(t.comp));
        expect(labels).toContain('Ann [Fierce Aura 20] + Bob');
        expect(labels).toContain('Ann [Mystic Aura 15]');
        const distinct = plan.tasks.every(
            (t) => new Set(t.comp.members.map((m) => m.id)).size === t.comp.members.length
        );
        expect(distinct).toBe(true);
        const { pool } = narrowRoster(roster, {}, gameData);
        expect(
            countCompositionsUpperBound(
                pool.map((t) => t.variants.length),
                [false, false],
                2
            )
        ).toBe(8);
    });

    test('as built off: only the aura variants', () => {
        const roster = [entry('a', 'Ann', withSpecial(null), [{ hrid: '/abilities/fierce_aura', level: 20 }], false)];
        const labels = planSweep({ zones: [ZONE], roster, gameData }).tasks.map((t) => partyLabel(t.comp));
        expect(labels).toEqual(['Solo', 'Ann [Fierce Aura 20]']);
    });

    test('no aura offered: tried as built, whatever the checkbox says', () => {
        const roster = [entry('a', 'Ann', dto(90), [], false)];
        expect(planSweep({ zones: [ZONE], roster, gameData }).total).toBe(2);
    });

    test('options the game data cannot run are skipped with a note: gone, not an aura, level too high', () => {
        const roster = [
            entry('a', 'Ann', dto(90), [
                { hrid: '/abilities/retired_aura', level: 10 },
                { hrid: '/abilities/invincible', level: 10 },
                { hrid: '/abilities/fierce_aura', level: 999 },
            ]),
        ];
        const plan = planSweep({ zones: [ZONE], roster, gameData });
        expect(plan.total).toBe(2);
        const notes = plan.notes.join(' | ');
        expect(notes).toMatch(/retired_aura is not in the game data/);
        expect(notes).toMatch(/Invincible is not an aura/);
        expect(notes).toMatch(/Fierce Aura level 999 is outside 1-200/);
    });

    test('every option unusable and as built off: the teammate is left out and says so', () => {
        const roster = [entry('a', 'Ann', dto(90), [{ hrid: '/abilities/gone', level: 1 }], false)];
        const plan = planSweep({ zones: [ZONE], roster, gameData });
        expect(plan.total).toBe(0);
        expect(plan.notes.join(' ')).toMatch(/Ann: no usable aura option/);
    });

    test('two teammates offering the same aura are both tried, and the party says the aura is doubled', () => {
        const roster = [
            entry('a', 'Ann', dto(80), [{ hrid: '/abilities/fierce_aura', level: 20 }], false),
            entry('b', 'Bob', dto(100), [{ hrid: '/abilities/fierce_aura', level: 20 }], false),
        ];
        const plan = planSweep({ zones: [ZONE], roster, gameData });
        const pair = plan.tasks.find((t) => t.comp.members.length === 2);
        expect(partyLabel(pair.comp)).toBe('Ann [Fierce Aura 20] + Bob [Fierce Aura 20]');
        const party = buildCompositionParty(withSpecial('/abilities/fierce_aura'), pair.comp.members);
        expect(sharedAuras(party, gameData)).toEqual([{ name: 'Fierce Aura', count: 3 }]);
    });

    test('an aura option a teammate already wears at that level is the same build: folded, named as an alias', () => {
        const build = withSpecial('/abilities/fierce_aura', 20);
        build.abilities[0].triggers = null;
        const roster = [entry('a', 'Ann', build, [{ hrid: '/abilities/fierce_aura', level: 20 }])];
        const { pool, mustInclude } = narrowRoster(roster, {}, gameData);
        const comps = enumerateCompositions(pool, mustInclude, 2);
        expect(comps).toHaveLength(2);
        expect(comps[1].aliases).toEqual([['Ann [Fierce Aura 20]']]);
    });

    test('the level ceiling comes from the game data', () => {
        expect(maxAbilityLevel(gameData)).toBe(200);
        expect(maxAbilityLevel({ levelExperienceTable: [0, 1, 2] })).toBe(2);
        expect(maxAbilityLevel(null)).toBe(200);
        expect(checkAuraOption({ hrid: '/abilities/fierce_aura', level: 0 }, gameData).ok).toBe(false);
    });
});

describe('a kept row holds only what repricing reads', () => {
    test('no wipe log or per-tick data survives, and repricing gives the same profit', () => {
        const full = {
            simulatedTime: 2 * HOUR,
            experienceGained: { player1: { magic: 2000 } },
            deaths: { player1: 1, '/monsters/x': 40 },
            // Where the test adapter prices from: a field repricing keeps
            lootStates: { __profit: { player1: 400 } },
            consumablesUsed: { player1: {} },
            wipeEvents: [{ log: Array.from({ length: 200 }, () => ({ playersHp: [1, 2, 3] })) }],
            timeSpentAlive: [{ name: 'w', count: 3 }],
            attacks: { player1: { a: 1 } },
        };
        const m = readResult(full, {}, 2);
        expect(m.simResult.wipeEvents).toBeUndefined();
        expect(m.simResult.timeSpentAlive).toBeUndefined();
        expect(m.simResult.attacks).toBeUndefined();
        expect(m.simResult.deaths).toEqual(full.deaths);
        expect(Object.keys(m.simResult).sort()).toEqual(
            ['consumablesUsed', 'deaths', 'experienceGained', 'lootStates', 'simulatedTime'].sort()
        );
        expect(m.profitPerHour).toBe(200);
        expect(repriceMetrics(m, {}).profitPerHour).toBe(200);
    });
});
