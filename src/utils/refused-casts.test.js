import { describe, expect, test } from 'vitest';

import { buildNewBattle } from '../__fixtures__/wire/new-battle.js';
import { buildBattleUpdated } from '../__fixtures__/wire/battle-updated.js';
import {
    foldRefusalTick,
    forgetRefusalBaseline,
    newRefusalState,
    noteRefusalBattle,
    refusalSummary,
} from './refused-casts.js';

const DRAIN = '/abilities/life_drain';
const ENTANGLE = '/abilities/entangle';
/** Stated costs and base cooldowns, ms */
const INFO = {
    [DRAIN]: { manaCost: 100, cooldownMs: 10_000 },
    [ENTANGLE]: { manaCost: 40, cooldownMs: 10_000 },
};
const abilityInfo = (hrid) => INFO[hrid] ?? null;

/** The fixture's own player, with a kit and haste chosen per test, preparing `preparing` */
function battlePlayer({ kit = [DRAIN, ENTANGLE], haste = 0, mana = 500, counter = 10, preparing = DRAIN } = {}) {
    const player = buildNewBattle().players[0];
    player.combatAbilities = kit.map((abilityHrid) => ({ abilityHrid, level: 1 }));
    player.combatDetails.combatStats.abilityHaste = haste;
    player.currentManapoints = mana;
    player.attackAttemptCounter = counter;
    player.isPreparingAutoAttack = !preparing;
    player.preparingAbilityHrid = preparing || '';
    return player;
}

/**
 * A pMap entry in the captured shape: the counter, the bar, and what is now being prepared. A player preparing
 * an auto attack carries `isAutoAtk: true` as the captured monster entries do; no captured player entry shows
 * it yet (needs a live capture).
 */
function tick({ counter, mana, ability = '' }) {
    const entry = buildBattleUpdated(0).pMap[0];
    entry.atkCounter = counter;
    entry.cMP = mana;
    delete entry.abilityHrid;
    if (ability) entry.abilityHrid = ability;
    else entry.isAutoAtk = true;
    return entry;
}

/** Feed ticks `[at, counter, mana, ability?]` and return what each counted */
function feed(state, ticks) {
    return ticks.map(([at, counter, mana, ability]) => foldRefusalTick(state, tick({ counter, mana, ability }), { at, abilityInfo }));
}

describe('casts refused for lack of mana', () => {
    test('an auto attack chosen while a cast ability was ready and unaffordable is one refusal', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer({ kit: [DRAIN] }));

        const counted = feed(state, [
            // Life Drain runs at 0 and goes on cooldown; an auto attack is chosen then: not a refusal
            [0, 11, 30],
            // That auto lands at 11 s, and another is chosen with Drain ready and 30 mana: refused
            [11_000, 12, 30],
            [14_000, 13, 30],
            [17_000, 14, 30],
        ]);

        expect(counted).toEqual([[], [], [DRAIN], [DRAIN]]);
        expect(refusalSummary(state)).toEqual({
            measured: true,
            turns: 2,
            abilities: [{ abilityHrid: DRAIN, refused: 2 }],
        });
    });

    test('readiness and the bar are judged when the action was chosen, not when it landed', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer({ kit: [DRAIN] }));
        const counted = feed(state, [
            [0, 11, 30],
            // Chosen at 0 (Drain cooling down), landed at 12 s: Drain was ready by then, but not when chosen
            [12_000, 12, 300],
            // Chosen at 12 s with 300 mana: affordable, so not a refusal (its trigger did not hold)
            [13_000, 13, 300],
            [14_000, 14, 300],
        ]);
        expect(counted.flat()).toEqual([]);
    });

    test('one turn refuses only the first ready, unaffordable ability in slot order', () => {
        const state = newRefusalState();
        // Server order Drain, Entangle; the known slots put Entangle first
        noteRefusalBattle(state, battlePlayer({ preparing: ENTANGLE }), {
            slots: { [ENTANGLE]: 1, [DRAIN]: 2 },
        });
        feed(state, [
            // Entangle runs, Drain is chosen and runs, then an auto is chosen
            [0, 11, 500, DRAIN],
            [0, 12, 10],
            // Both ready by 12 s and both unaffordable at 10 mana: Entangle is walked first
            [12_000, 13, 10],
            [13_000, 14, 10],
        ]);
        expect(refusalSummary(state).abilities).toEqual([{ abilityHrid: ENTANGLE, refused: 1 }]);
        expect(refusalSummary(state).turns).toBe(1);
    });

    test('a ready ability the bar could pay for is passed over, and the walk goes on', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer({ preparing: ENTANGLE }), {
            slots: { [ENTANGLE]: 1, [DRAIN]: 2 },
        });
        feed(state, [
            [0, 11, 500, DRAIN],
            [0, 12, 50],
            // 50 mana pays for Entangle (40) but not Drain (100): Entangle's trigger did not hold, Drain is refused
            [12_000, 13, 50],
            [13_000, 14, 50],
        ]);
        expect(refusalSummary(state).abilities).toEqual([{ abilityHrid: DRAIN, refused: 1 }]);
    });

    test('ability haste shortens the cooldown the way the simulator does', () => {
        const state = newRefusalState();
        // 100 haste halves a 10 s cooldown
        noteRefusalBattle(state, battlePlayer({ kit: [DRAIN], haste: 100 }));
        const counted = feed(state, [
            [0, 11, 30],
            [6_000, 12, 30],
            [9_000, 13, 30],
        ]);
        expect(counted).toEqual([[], [], [DRAIN]]);
    });

    test('nothing is measured before a baseline, and a counter that did not rise counts nothing', () => {
        const state = newRefusalState();
        expect(refusalSummary(state).measured).toBe(false);
        // No battle seen: the first tick is only a baseline
        expect(feed(state, [[0, 5, 0]])).toEqual([[]]);
        expect(refusalSummary(state).measured).toBe(true);

        noteRefusalBattle(state, battlePlayer({ kit: [DRAIN] }));
        feed(state, [
            [0, 11, 0],
            [20_000, 12, 0],
        ]);
        // Struck, not acting: same counter
        expect(feed(state, [[40_000, 12, 0]])).toEqual([[]]);
        forgetRefusalBaseline(state);
        expect(feed(state, [[60_000, 13, 0]])).toEqual([[]]);
        expect(refusalSummary(state).turns).toBe(0);
    });

    test('an ability the game data does not know, or one never cast, is skipped', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer({ kit: ['/abilities/unknown', ENTANGLE, DRAIN], preparing: '/abilities/unknown' }));
        feed(state, [
            // The unknown one runs, then autos only: Drain and Entangle were never cast
            [0, 11, 0],
            [12_000, 12, 0],
            [13_000, 13, 0],
        ]);
        expect(refusalSummary(state).turns).toBe(0);
    });
});
