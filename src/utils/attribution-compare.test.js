import { describe, it, expect } from 'vitest';
import { compareRecording, newPresenceState, presenceNewBattle, presenceTick } from './attribution-compare.js';

/**
 * A three-player party against one monster, stated the way `new_battle` states
 * it: names, opening health and mana, counters at zero.
 */
function newBattle() {
    return {
        type: 'new_battle',
        payload: {
            players: [
                { name: 'Archer', currentHitpoints: 1000, currentManapoints: 500 },
                { name: 'Mage', currentHitpoints: 900, currentManapoints: 800 },
                { name: 'Tank', currentHitpoints: 1500, currentManapoints: 300 },
            ],
            monsters: [{ name: 'Rat', currentHitpoints: 10000, combatDetails: { dmgCounter: 0, critCounter: 0 } }],
        },
    };
}

/** @param {Object} pMap - This tick's players @param {Object} mMap - This tick's monsters */
function tick(pMap, mMap) {
    return { type: 'battle_updated', payload: { pMap, mMap } };
}

/**
 * A full-state opening tick, as recordings begin with.
 *
 * Both engines and the referee learn counter baselines from sightings, so a
 * swing on a player's very first appearance is invisible to all of them. Real
 * feeds state everyone within the first tick; this is that tick.
 */
function warmup() {
    return tick(
        {
            0: { cHP: 1000, cMP: 500, atkCounter: 0 },
            1: { cHP: 900, cMP: 800, atkCounter: 0 },
            2: { cHP: 1500, cMP: 300, atkCounter: 0 },
        },
        {}
    );
}

describe('presenceTick', () => {
    it('credits the lone present player with every monster health fall', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick({ pMap: { 1: { cHP: 900, cMP: 800 } }, mMap: { 0: { cHP: 9600 } } }, state);
        expect(result).toEqual({ damage: 400, credited: { 1: 400 }, mode: 'solo' });
    });

    it('picks the unique mana-spender out of a crowd', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick(
            { pMap: { 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 700 } }, mMap: { 0: { cHP: 9700 } } },
            state
        );
        expect(result.mode).toBe('cast');
        expect(result.credited).toEqual({ 1: 300 });
    });

    it('splits equally when nobody or everybody spent mana', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick(
            { pMap: { 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 800 } }, mMap: { 0: { cHP: 9800 } } },
            state
        );
        expect(result.mode).toBe('split');
        expect(result.credited).toEqual({ 0: 100, 1: 100 });
    });

    it('counts nothing before a battle has been stated', () => {
        const state = newPresenceState();
        const result = presenceTick({ pMap: { 0: {} }, mMap: { 0: { cHP: 5 } } }, state);
        expect(result.damage).toBe(0);
    });
});

describe('compareRecording', () => {
    it('agrees when the present player provably swung', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
        ]);

        expect(report.damageTicks).toBe(1);
        expect(report.classes.agree).toEqual({ ticks: 1, damage: 100 });
        expect(report.players['0']).toEqual({ name: 'Archer', ours: 100, presence: 100 });
        expect(report.grouping).toMatchObject({ hitTicks: 1, swungNow: 1 });
    });

    it('agrees with presence on the reflect tick, which the hybrid rung adopted', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The archer swings and lands
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            // Four ticks later the tank — alone in the payload, being hit —
            // coincides with a hit landing on the monster: thorns. Both engines
            // credit the tank now; the referee still records the tick's shape.
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 2: { cHP: 1400, cMP: 300, dmgCounter: 1 } }, { 0: { cHP: 9750, dmgCounter: 2 } }),
        ]);

        expect(report.classes.agree).toEqual({ ticks: 2, damage: 250 });
        expect(report.players['0'].ours).toBe(100);
        expect(report.players['2'].ours).toBe(150);
        expect(report.players['2'].presence).toBe(150);
        expect(report.grouping.victimOnly).toBe(1);
    });

    it('scores a presence split against a counter-confirmed single swinger', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick(
                { 0: { cHP: 1000, cMP: 500, atkCounter: 1 }, 1: { cHP: 900, cMP: 800 } },
                { 0: { cHP: 9800, dmgCounter: 1 } }
            ),
        ]);

        expect(report.classes['split-vs-single']).toEqual({ ticks: 1, damage: 200 });
        expect(report.adjudication.oursConfirmed).toEqual({ ticks: 1, damage: 200 });
        expect(report.players['0'].ours).toBe(200);
        expect(report.players['0'].presence).toBe(100);
        expect(report.players['1'].presence).toBe(100);
    });

    it('sets bleed ticks apart, and both engines now credit them alike', () => {
        const report = compareRecording([
            newBattle(),
            // Health falls with no counter movement: no counter can arbitrate it,
            // so it is tallied apart — but it is real damage and both credit it
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9950, dmgCounter: 0 } }),
        ]);

        expect(report.classes.bleed).toEqual({ ticks: 1, damage: 50 });
        expect(report.adjudication.bleed).toEqual({ ticks: 1, damage: 50 });
        expect(report.players['1'].presence).toBe(50);
        expect(report.players['1'].ours).toBe(50);
    });

    it('reports the tick ours cannot attribute at all', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // Two players present, a hit lands, nobody swung, nobody alone,
            // no mana moved: ours refuses; presence splits it evenly
            tick({ 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
        ]);

        expect(report.classes['ours-orphan']).toEqual({ ticks: 1, damage: 100 });
        expect(report.totals.oursUncredited).toBe(100);
        expect(report.totals.presenceUncredited).toBe(0);
    });

    it('accepts a swing one tick before its damage as confirmation', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The mage swings — no damage lands yet
            tick({ 1: { cHP: 900, cMP: 800, atkCounter: 1 } }, {}),
            // The damage arrives one tick later with only the mage present
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9700, dmgCounter: 1 } }),
        ]);

        expect(report.classes.agree).toEqual({ ticks: 1, damage: 300 });
        expect(report.grouping.recentSwing).toBe(1);
    });

    it('re-baselines every side at a new battle', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            newBattle(),
            // Fresh wave: the monster is back to 10,000 and nothing reads the
            // reset as a heal or a phantom hit. The player's counter carries
            // across the boundary, as the game's does
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 2 } }, { 0: { cHP: 9500, dmgCounter: 1 } }),
        ]);

        expect(report.battles).toBe(2);
        expect(report.monsterHpLost).toBe(600);
        expect(report.players['0'].ours).toBe(600);
        expect(report.players['0'].presence).toBe(600);
    });

    it('counts a miss without inventing damage on either side', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The counter rises, the health does not move: a miss
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 10000, dmgCounter: 1 } }),
        ]);

        expect(report.damageTicks).toBe(0);
        expect(report.missOnlyTicks).toBe(1);
        expect(report.totals.ours).toBe(0);
        expect(report.totals.presence).toBe(0);
    });
});

/**
 * A `new_guild_battle` payload: the roster (id and name, for `rosterFromBattle`)
 * plus opening health and mana (for the two engines' own baselines), and a
 * monster whose name resolves to the `badger` encounter.
 */
function newGuildBattle(overrides = {}) {
    return {
        type: 'new_guild_battle',
        payload: {
            battleId: 1,
            tier: 1,
            players: [
                { character: { id: 101, name: 'Tib' }, currentHitpoints: 1000, currentManapoints: 500 },
                { character: { id: 102, name: 'Moo' }, currentHitpoints: 900, currentManapoints: 800 },
            ],
            monsters: [{ name: 'Badger', currentHitpoints: 10000, combatDetails: { dmgCounter: 0, critCounter: 0 } }],
            ...overrides,
        },
    };
}

/** @param {Object} pMap @param {Object} mMap @param {number} [at] - Wall-clock ms, for the reflect window */
function guildTick(pMap, mMap, at) {
    return { type: 'guild_battle_updated', payload: { pMap, mMap }, at };
}

/** @param {number} [at] */
function guildWarmup(at) {
    return guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 0 }, 1: { cHP: 900, cMP: 800, atkCounter: 0 } }, {}, at);
}

/** @param {Array<Object>} guildTrialStatList @param {number} [at] */
function trialStatsMessage(guildTrialStatList, at) {
    return { type: 'guild_trial_stats_updated', payload: { guildTrialStatList }, at };
}

describe('compareRecording in trial mode', () => {
    it('names players from the roster and reports itself as trial mode', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }, 100),
            ],
            { mode: 'trial' }
        );

        expect(report.mode).toBe('trial');
        // Trial mode's `players` is keyed by name, not by slot index — a tier
        // re-deals the indices, so a trial-long tally kept by index would mix
        // two different people's damage under one key at a rollover
        expect(report.players.Tib).toMatchObject({ name: 'Tib', ours: 100 });
    });

    it('a zero-present tick is unattributed rather than falling to the last swinger', () => {
        // B4/soloFallback:false — a spectated trial states no party, so a tick
        // nobody is present in must credit nobody rather than whoever swung last
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }, 100),
                // Nobody present, yet the boss lost more health
                guildTick({}, { 0: { cHP: 9800, dmgCounter: 2 } }, 200),
            ],
            { mode: 'trial' }
        );

        expect(Object.keys(report.players)).toEqual(['Tib']);
        expect(report.monsterHpLost).toBe(200);
        expect(report.totals.ours).toBe(100);
        // The second tick's 100 damage is real (the game's boss bar moved) but
        // credited nobody — G14/unattributed, not silently dropped
        expect(report.totals.oursUncredited).toBe(100);
    });

    it('a struck reflect tank is not filed as the presence-victim suspect', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                // Moo casts Spike Shell; nothing moves yet
                guildTick({ 1: { cHP: 900, cMP: 800, abilityHrid: '/abilities/spike_shell' } }, {}, 50),
                // Tib swings and lands (rung 1: a lone riser). Moo, in the same
                // tick, spends mana and takes damage — presence's unique
                // mana-drop names her alone; the referee has to adjudicate
                guildTick(
                    { 0: { cHP: 1000, cMP: 500, atkCounter: 1 }, 1: { cHP: 850, cMP: 750 } },
                    { 0: { cHP: 9900, dmgCounter: 1 } },
                    80
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.classes['single-conflict']).toEqual({ ticks: 1, damage: 100 });
        expect(report.adjudication.reflectTank).toEqual({ ticks: 1, damage: 100 });
        expect(report.adjudication.presenceVictim).toEqual({ ticks: 0, damage: 0 });
    });

    it('the same tick without a live reflect is still filed as the aggro-tank suspect', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                // No reflect cast this time
                guildTick(
                    { 0: { cHP: 1000, cMP: 500, atkCounter: 1 }, 1: { cHP: 850, cMP: 750 } },
                    { 0: { cHP: 9900, dmgCounter: 1 } },
                    80
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.adjudication.presenceVictim).toEqual({ ticks: 1, damage: 100 });
        expect(report.adjudication.reflectTank).toEqual({ ticks: 0, damage: 0 });
    });

    it('a reflect cast more than the remembered window ago no longer excuses the tick', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                guildTick({ 1: { cHP: 900, cMP: 800, abilityHrid: '/abilities/spike_shell' } }, {}, 0),
                guildTick(
                    { 0: { cHP: 1000, cMP: 500, atkCounter: 1 }, 1: { cHP: 850, cMP: 750 } },
                    { 0: { cHP: 9900, dmgCounter: 1 } },
                    40_000 // past REFLECT_WINDOW_MS (33s)
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.adjudication.presenceVictim).toEqual({ ticks: 1, damage: 100 });
        expect(report.adjudication.reflectTank).toEqual({ ticks: 0, damage: 0 });
    });

    it('reports each player’s error against the game’s own end-of-trial totals', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                // Tib alone, twice
                guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }, 100),
                // Moo alone
                guildTick({ 1: { cHP: 900, cMP: 800, atkCounter: 1 } }, { 0: { cHP: 9850, dmgCounter: 2 } }, 200),
                trialStatsMessage(
                    [
                        { trialHrid: '/guild_combat/badger', characterId: 101, damageDealt: 90 },
                        { trialHrid: '/guild_combat/badger', characterId: 102, damageDealt: 60 },
                    ],
                    300
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.trialStats.encounter).toBe('badger');
        expect(report.trialStats.ambiguous).toBe(false);
        expect(report.trialStats.reported).toEqual({
            Tib: { damage: 90, healing: 0, taken: 0 },
            Moo: { damage: 60, healing: 0, taken: 0 },
        });
        expect(report.trialStats.errors.Tib).toMatchObject({ reportedDamage: 90, measuredOurs: 100, absErrorOurs: 10 });
        expect(report.trialStats.errors.Moo).toMatchObject({ reportedDamage: 60, measuredOurs: 50, absErrorOurs: 10 });
        // (10 + 10) / (90 + 60) — the headline figure is one number over the
        // whole trial, not an average of the two players' own percentages
        expect(report.trialStats.meanAbsPercentOurs).toBeCloseTo((20 / 150) * 100, 5);
    });

    it('an id the roster never named is still counted, by a placeholder', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                trialStatsMessage([{ trialHrid: '/guild_combat/badger', characterId: 999, damageDealt: 10 }], 100),
            ],
            { mode: 'trial' }
        );

        expect(report.trialStats.reported).toEqual({ 'Character 999': { damage: 10, healing: 0, taken: 0 } });
    });

    it('a skilling trial’s rows are not mistaken for the combat trial’s', () => {
        const report = compareRecording(
            [
                newGuildBattle(),
                guildWarmup(0),
                trialStatsMessage(
                    [
                        { trialHrid: '/guild_combat/badger', characterId: 101, damageDealt: 90 },
                        { trialHrid: '/guild_skilling/crafting', characterId: 101, damageDealt: 12_345 },
                    ],
                    100
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.trialStats.reported).toEqual({ Tib: { damage: 90, healing: 0, taken: 0 } });
    });

    it('two trials’ rows with no encounter identified are reported as ambiguous, not guessed at', () => {
        const report = compareRecording(
            [
                // No monster stated, so no encounter is ever identified
                newGuildBattle({ monsters: [] }),
                guildWarmup(0),
                trialStatsMessage(
                    [
                        { trialHrid: '/guild_combat/badger', characterId: 101, damageDealt: 90 },
                        { trialHrid: '/guild_combat/swarm', characterId: 101, damageDealt: 40 },
                    ],
                    100
                ),
            ],
            { mode: 'trial' }
        );

        expect(report.trialStats.encounter).toBeNull();
        expect(report.trialStats.ambiguous).toBe(true);
        expect(report.trialStats.otherEncounters.sort()).toEqual(['badger', 'swarm']);
        expect(report.trialStats.reported).toBeNull();
    });

    it('no guild_trial_stats_updated at all reports no trial stats, not an empty one', () => {
        const report = compareRecording(
            [newGuildBattle(), guildWarmup(0), guildTick({ 0: { cHP: 1000, cMP: 500 } }, { 0: { cHP: 9950 } }, 100)],
            { mode: 'trial' }
        );

        expect(report.trialStats).toBeNull();
    });

    it('a tier rollover that re-deals a slot to someone else does not swap their damage', () => {
        // The bug `bankWave` exists for: a trial-long tally kept by slot index
        // was seen moving one member's damage to whoever inherited their slot
        // at the next tier's roster re-deal, because `new_guild_battle` states
        // `players[]` afresh every tier with no promise the order repeats.
        const report = compareRecording(
            [
                newGuildBattle(), // tier 1: index 0 = Tib, index 1 = Moo
                guildWarmup(0),
                guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }, 100),
                // Tier 2: the roster re-deals the same two slots the other way
                // around — index 0 is now Moo, index 1 is now Tib
                newGuildBattle({
                    players: [
                        { character: { id: 102, name: 'Moo' }, currentHitpoints: 900, currentManapoints: 800 },
                        { character: { id: 101, name: 'Tib' }, currentHitpoints: 1000, currentManapoints: 500 },
                    ],
                }),
                guildTick(
                    { 0: { cHP: 900, cMP: 800, atkCounter: 0 }, 1: { cHP: 1000, cMP: 500, atkCounter: 1 } },
                    {},
                    200
                ),
                // Now index 1 (Tib, this tier) swings and lands
                guildTick({ 1: { cHP: 1000, cMP: 500, atkCounter: 2 } }, { 0: { cHP: 9700, dmgCounter: 2 } }, 300),
            ],
            { mode: 'trial' }
        );

        // Tib's tier-1 100 must stay hers; the tier-2 300 that landed while
        // Tib now sits at index 1 must not be read as index 0's owner (Moo)
        expect(report.players.Tib.ours).toBe(400);
        expect(report.players.Moo?.ours || 0).toBe(0);
        expect(report.totals.ours).toBe(400);
    });

    it('a slot’s counter baseline does not carry across a tier rollover to its new occupant', () => {
        // Without a per-wave baseline reset, whoever inherits a slot next tier
        // is compared against the *previous* occupant's leftover attack count.
        // Tib leaves index 0 on 10; if that survives the reroll, Moo's first
        // stated 15 there reads as a lone swing (rung 1) and takes the whole
        // tick alone — reset, the tick is unresolved and split between the two
        // present, which is the honest answer when neither side truly knows
        const report = compareRecording(
            [
                newGuildBattle(), // tier 1: index 0 = Tib, index 1 = Moo
                guildWarmup(0),
                guildTick({ 0: { cHP: 1000, cMP: 500, atkCounter: 10 } }, { 0: { cHP: 9900, dmgCounter: 1 } }, 100),
                // Tier 2: the same two slots, the other way around
                newGuildBattle({
                    players: [
                        { character: { id: 102, name: 'Moo' }, currentHitpoints: 900, currentManapoints: 800 },
                        { character: { id: 101, name: 'Tib' }, currentHitpoints: 1000, currentManapoints: 500 },
                    ],
                    monsters: [
                        { name: 'Badger', currentHitpoints: 9900, combatDetails: { dmgCounter: 0, critCounter: 0 } },
                    ],
                }),
                // No fresh warmup: the first tier-2 tick states both slots
                // outright, the way a spectator tuning in mid-wave sees them
                guildTick(
                    { 0: { cHP: 900, cMP: 800, atkCounter: 15 }, 1: { cHP: 1000, cMP: 500, atkCounter: 0 } },
                    { 0: { cHP: 9800, dmgCounter: 1 } },
                    200
                ),
            ],
            { mode: 'trial' }
        );

        // Tier 1's 100 is Tib's alone; tier 2's 100 is unresolved and split
        expect(report.players.Tib.ours).toBe(150);
        expect(report.players.Moo.ours).toBe(50);
    });

    it('personal mode is unaffected: no roster import, no trial stats, plain new_battle/battle_updated', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
        ]);

        expect(report.mode).toBe('personal');
        expect(report.trialStats).toBeNull();
    });
});
