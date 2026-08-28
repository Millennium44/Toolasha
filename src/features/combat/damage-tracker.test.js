/**
 * When one run stops being the same run.
 *
 * The tally is keyed by battle slot, which is a position in *this* fight rather
 * than an identity. That is fine while the fight keeps the same shape and wrong
 * the moment it does not: leave a party of five and slot 0 stops being whoever
 * it was, while slots 1 to 4 stop being anybody at all.
 *
 * Both symptoms came from the same cause and both are here — four people who
 * had left still listed, and your own name on two rows at once.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const listeners = vi.hoisted(() => ({}));

/** Enough of the ability map for a class to be read off a cast */
const ABILITIES = vi.hoisted(() => ({
    '/abilities/fireball': {
        abilityEffects: [
            {
                effectType: '/ability_effect_types/damage',
                combatStyleHrid: '/combat_styles/magic',
                damageType: '/damage_types/fire',
            },
        ],
    },
    '/abilities/heal': {
        abilityEffects: [{ effectType: '/ability_effect_types/heal', targetType: 'ally' }],
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ abilityDetailMap: ABILITIES }) },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => (listeners[type] = handler),
        off: (type) => delete listeners[type],
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => null },
}));

const tracker = await import('./damage-tracker.js');
const { sessionKeyFor, battleBreakdown, manaSamples, damageBreakdown, runClasses } = tracker;

const battle = (names, combatStartTime = '2026-08-03T01:00:00Z') => ({
    combatStartTime,
    players: names.map((name) => ({ name })),
});

describe('naming a run', () => {
    test('the same party in the same run is the same key', () => {
        expect(sessionKeyFor(battle(['Millennium44', 'Gold999']))).toBe(
            sessionKeyFor(battle(['Millennium44', 'Gold999']))
        );
    });

    test('somebody leaving is a different run', () => {
        // The screenshot case: a party of five, then alone, and the four who
        // left were still in the DPS table
        const party = sessionKeyFor(battle(['Millennium44', 'Gold999', 'Briggsy99', 'heymouse', 'Overdark']));
        const alone = sessionKeyFor(battle(['Millennium44']));

        expect(alone).not.toBe(party);
    });

    test('somebody joining is too', () => {
        expect(sessionKeyFor(battle(['Millennium44']))).not.toBe(sessionKeyFor(battle(['Millennium44', 'Gold999'])));
    });

    test('the same party starting a new run is a different run', () => {
        // Which is why the roster alone is not enough
        const first = sessionKeyFor(battle(['Millennium44'], '2026-08-03T01:00:00Z'));
        const second = sessionKeyFor(battle(['Millennium44'], '2026-08-03T04:00:00Z'));

        expect(second).not.toBe(first);
    });

    test('a message with nobody in it names nothing', () => {
        // Rather than a key that every other empty message would also match,
        // which would reset the run on every one of them
        expect(sessionKeyFor({ players: [] })).toBeNull();
        expect(sessionKeyFor(null)).toBeNull();
    });

    test('a party in a different order is a different key, and that is fine', () => {
        // Slots are what the tally is keyed by, so a reordered party genuinely
        // cannot keep its figures — resetting is the correct outcome, not a
        // limitation being worked around
        expect(sessionKeyFor(battle(['A', 'B']))).not.toBe(sessionKeyFor(battle(['B', 'A'])));
    });
});

/**
 * What the tracker carries about the fight on screen, driven tick by tick.
 *
 * The new figures — a monster's remaining health, its enrage clock, each
 * player's mana series — exist so the portrait meters can estimate honestly,
 * which means the cases worth testing are the ones where a stale or invented
 * value would be a lie: a health bar surviving a battle nothing announced, a
 * sheet with no enrage timer growing one.
 */
describe('the fight on screen', () => {
    /** A `new_battle` with one player and one fully described monster */
    const announce = (monster = {}) =>
        listeners.new_battle({
            combatStartTime: '2026-08-03T01:00:00Z',
            players: { 0: { name: 'You', isPreparingAutoAttack: true } },
            monsters: {
                0: {
                    name: 'Eye',
                    combatDetails: { maxHitpoints: 1000 },
                    currentHitpoints: 1000,
                    ...monster,
                },
            },
        });

    const tick = ({ battleId = 1, atk = 1, mana = 100, monsterHP, dmg = 0 } = {}) =>
        listeners.battle_updated({
            battleId,
            pMap: { 0: { atkCounter: atk, cMP: mana, isAutoAtk: true } },
            mMap: monsterHP === undefined ? {} : { 0: { cHP: monsterHP, dmgCounter: dmg, mHP: 1000 } },
        });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-03T01:00:00Z'));
        tracker.default.initialize();
    });

    afterEach(() => {
        tracker.default.cleanup();
        vi.useRealTimers();
    });

    test('health is seeded by the battle statement and kept current by ticks', () => {
        announce();

        // Known before anybody has touched it, from `new_battle` itself
        expect(battleBreakdown().enemies['0'].hp).toBe(1000);
        expect(battleBreakdown().enemies['0'].maxHP).toBe(1000);

        tick({ monsterHP: 1000 });
        vi.setSystemTime(Date.now() + 1000);
        tick({ atk: 2, monsterHP: 900, dmg: 1 });

        const enemy = battleBreakdown().enemies['0'];
        expect(enemy.hp).toBe(900);
        expect(enemy.damage).toBe(100);
        expect(enemy.dps).toBeCloseTo(100);
    });

    test('a monster stated without health has none, not a full bar', () => {
        // A weakened spawn is a real thing, and guessing "full" would
        // overstate every time-to-kill drawn from it
        listeners.new_battle({
            combatStartTime: '2026-08-03T01:00:00Z',
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye', combatDetails: { maxHitpoints: 1000 } } },
        });

        expect(battleBreakdown().enemies['0'].hp).toBeNull();
    });

    test('the enrage clock comes from the sheet, anchored at the spawn', () => {
        // Three minutes in nanoseconds, spawned at 01:00:00
        announce({ enrageTimerDuration: 180e9, spawnTime: '2026-08-03T01:00:00Z' });

        const enemy = battleBreakdown().enemies['0'];
        expect(enemy.enrageAt).toBe(Date.parse('2026-08-03T01:03:00Z'));
    });

    test('a sheet with no timer, or no spawn time, counts down to nothing', () => {
        announce({ enrageTimerDuration: 180e9 });
        expect(battleBreakdown().enemies['0'].enrageAt).toBeNull();
    });

    test('the seed survives the battle it announces and no other', () => {
        announce();
        tick({ battleId: 7 });
        // The first tick of the announced battle changes the id; wiping the
        // seed here would blank every bar until its monster reported
        expect(battleBreakdown().enemies['0'].hp).toBe(1000);

        // A second id change nothing announced is a battle this map knows
        // nothing about, and last battle's bars must not be worn by it
        tick({ battleId: 8 });
        expect(battleBreakdown().enemies['0'].hp).toBeNull();
    });

    test('a battleId change clears "this fight" too, not just its counters', () => {
        // Same reconnect trigger as the seed test above: the id changes without
        // a `new_battle` announcing the new fight. This-fight totals are reset
        // in every other per-battle counter in that branch (state.dmgCounter,
        // battleHP, ...) but `battle` itself — the players/enemies tally behind
        // battleBreakdown(), the portrait "cur" DPS line, and wave-clear/TTK —
        // was not, so the finished fight's numbers used to blend into the new
        // one's.
        announce();
        tick({ battleId: 7, atk: 1, monsterHP: 1000, dmg: 0 });
        tick({ battleId: 7, atk: 2, monsterHP: 900, dmg: 1 });
        expect(battleBreakdown().enemies['0'].damage).toBeGreaterThan(0);

        // A second id change, nothing announced: a brand-new battle whose only
        // tick this fight does no damage
        tick({ battleId: 8, atk: 1, monsterHP: 1000, dmg: 0 });
        expect(battleBreakdown().enemies['0'].damage).toBe(0);
        expect(battleBreakdown().players['0']).toBeUndefined();
    });

    test('each player’s mana readings accumulate for the runway', () => {
        announce();
        tick({ mana: 300 });
        vi.setSystemTime(Date.now() + 6000);
        tick({ mana: 240 });
        vi.setSystemTime(Date.now() + 6000);
        tick({ mana: 180 });

        const samples = manaSamples()['0'];
        expect(samples).toHaveLength(3);
        expect(samples[0].mana).toBe(300);
        expect(samples[2].mana).toBe(180);
    });

    test('a reload mid-fight keeps what it tallied once the battle is named', () => {
        // Ticks first — the page came up mid-fight and nothing has named the run
        tick({ battleId: 1, atk: 1, monsterHP: 1000, dmg: 0 });
        tick({ battleId: 1, atk: 2, monsterHP: 900, dmg: 1 });
        expect(tracker.damageBreakdown().players[0]?.name).toBe('Player 1');
        expect(tracker.damageBreakdown().players[0]?.damage).toBe(100);

        // The battle statement for the same fight: the name fills in, the tally stays
        announce();
        const row = tracker.damageBreakdown().players[0];
        expect(row?.name).toBe('You');
        expect(row?.damage).toBe(100);

        // A later statement with a different roster is still a new run
        listeners.new_battle({
            combatStartTime: '2026-08-03T02:00:00Z',
            players: { 0: { name: 'SomebodyElse' } },
            monsters: { 0: { name: 'Eye' } },
        });
        expect(tracker.damageBreakdown().players).toEqual([]);
    });

    test('a reload whose slots outnumber the roster it is then given starts over', () => {
        listeners.battle_updated({
            battleId: 1,
            pMap: { 0: { atkCounter: 1 }, 1: { atkCounter: 1 } },
            mMap: { 0: { cHP: 1000, dmgCounter: 0, mHP: 1000 } },
        });
        listeners.battle_updated({
            battleId: 1,
            pMap: { 0: { atkCounter: 2 }, 1: { atkCounter: 1 } },
            mMap: { 0: { cHP: 900, dmgCounter: 1, mHP: 1000 } },
        });
        expect(tracker.damageBreakdown().players.length).toBeGreaterThan(0);

        // Solo now — slot 1 is nobody, so the ticks before this were another party's
        announce();
        expect(tracker.damageBreakdown().players).toEqual([]);
    });

    test('a new session forgets the mana series with everything else', () => {
        announce();
        tick({ mana: 300 });

        // A different roster is a different run, and its mana is not this one's
        listeners.new_battle({
            combatStartTime: '2026-08-03T02:00:00Z',
            players: { 0: { name: 'SomebodyElse' } },
            monsters: { 0: { name: 'Eye' } },
        });

        expect(manaSamples()['0']).toBeUndefined();
    });
});

describe('the class read off a run', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-03T01:00:00Z'));
        tracker.default.initialize();
    });

    afterEach(() => {
        tracker.default.cleanup();
        vi.useRealTimers();
    });

    const announce = () =>
        listeners.new_battle({
            combatStartTime: '2026-08-03T01:00:00Z',
            players: { 0: { name: 'Alice' }, 1: { name: 'Bob' } },
            monsters: { 0: { name: 'Eye', combatDetails: { maxHitpoints: 1000 }, currentHitpoints: 1000 } },
        });

    const tick = (pMap) => listeners.battle_updated({ battleId: 1, pMap, mMap: {} });

    test('what each slot was seen preparing names its class', () => {
        announce();
        tick({ 0: { preparingAbilityHrid: '/abilities/fireball' }, 1: { preparingAbilityHrid: '/abilities/heal' } });
        tick({ 0: { preparingAbilityHrid: '/abilities/fireball' }, 1: { isAutoAtk: true } });

        const classes = runClasses();
        expect(classes['0']?.key).toBe('fireMage');
        expect(classes['1']?.key).toBe('healer');
    });

    test('the verdict rides the breakdown row, and is null before any cast', () => {
        listeners.new_battle({
            combatStartTime: '2026-08-03T01:00:00Z',
            players: { 0: { name: 'Alice' } },
            monsters: { 0: { name: 'Eye', combatDetails: { maxHitpoints: 1000 }, currentHitpoints: 1000 } },
        });
        const swing = (atk, hp, dmg, ability) =>
            listeners.battle_updated({
                battleId: 1,
                pMap: {
                    0: { atkCounter: atk, ...(ability ? { preparingAbilityHrid: ability } : { isAutoAtk: true }) },
                },
                mMap: { 0: { cHP: hp, dmgCounter: dmg, mHP: 1000 } },
            });

        // Auto-attacks land, and say nothing about the build
        swing(1, 1000, 0);
        swing(2, 950, 1);
        expect(damageBreakdown().players.find((row) => row.name === 'Alice')?.classTag).toBeNull();

        swing(3, 900, 2, '/abilities/fireball');
        swing(4, 850, 3, '/abilities/fireball');

        const alice = damageBreakdown().players.find((row) => row.name === 'Alice');
        expect(alice?.classTag?.key).toBe('fireMage');
        expect(alice?.classTag?.short).toBe('FIRE');
    });

    test('an auto-attacker is read off the weapon on their sheet, before any cast', () => {
        listeners.new_battle({
            combatStartTime: '2026-08-03T01:00:00Z',
            players: {
                0: {
                    name: 'Alice',
                    combatDetails: {
                        combatAbilities: [],
                        combatStats: {
                            combatStyleHrids: ['/combat_styles/ranged'],
                            damageType: '/damage_types/physical',
                        },
                    },
                },
                1: {
                    name: 'Bob',
                    combatDetails: {
                        combatAbilities: [{ abilityHrid: '/abilities/heal' }],
                        combatStats: { combatStyleHrids: ['/combat_styles/magic'], damageType: '/damage_types/nature' },
                    },
                },
            },
            monsters: { 0: { name: 'Eye' } },
        });
        tick({ 0: { isAutoAtk: true }, 1: { isAutoAtk: true } });

        const classes = runClasses();
        expect(classes['0']?.key).toBe('ranged');
        expect(classes['1']?.key).toBe('healer');
    });

    test('a new run starts with no evidence', () => {
        announce();
        tick({ 0: { preparingAbilityHrid: '/abilities/fireball' }, 1: {} });
        expect(runClasses()['0']?.key).toBe('fireMage');

        listeners.new_battle({
            combatStartTime: '2026-08-03T02:00:00Z',
            players: { 0: { name: 'SomebodyElse' } },
            monsters: { 0: { name: 'Eye' } },
        });
        expect(runClasses()).toEqual({});
    });
});
