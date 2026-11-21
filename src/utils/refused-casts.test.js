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

/** The fixture's own player, with a kit and haste chosen per test */
function battlePlayer({ kit = [DRAIN, ENTANGLE], haste = 0, mana = 500, counter = 10 } = {}) {
    const player = buildNewBattle().players[0];
    player.combatAbilities = kit.map((abilityHrid) => ({ abilityHrid, level: 1 }));
    player.combatDetails.combatStats.abilityHaste = haste;
    player.currentManapoints = mana;
    player.attackAttemptCounter = counter;
    player.isPreparingAutoAttack = false;
    player.preparingAbilityHrid = DRAIN;
    return player;
}

/**
 * A pMap entry in the captured shape. A player preparing an auto attack carries `isAutoAtk: true` as the
 * captured monster entries do; no captured player entry shows it yet (needs a live capture).
 */
function tick({ counter, mana, auto = false, ability = '' }) {
    const entry = buildBattleUpdated(0).pMap[0];
    entry.atkCounter = counter;
    entry.cMP = mana;
    delete entry.abilityHrid;
    if (auto) entry.isAutoAtk = true;
    else if (ability) entry.abilityHrid = ability;
    return entry;
}

describe('casts refused for lack of mana', () => {
    test('an auto attack while a cast ability is ready and unaffordable counts once per ability', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer());

        // Life Drain fires (prepared at battle start), then the unit winds up an auto attack
        foldRefusalTick(state, tick({ counter: 11, mana: 30, auto: true }), { at: 0, abilityInfo });
        // Entangle never cast: not counted. Drain ready again after 10 s, 30 mana < 100
        expect(foldRefusalTick(state, tick({ counter: 12, mana: 30, auto: true }), { at: 11_000, abilityInfo })).toEqual([
            DRAIN,
        ]);
        foldRefusalTick(state, tick({ counter: 13, mana: 30, auto: true }), { at: 14_000, abilityInfo });

        expect(refusalSummary(state)).toEqual({ turns: 2, abilities: [{ abilityHrid: DRAIN, refused: 2 }] });
    });

    test('an ability still on cooldown, or affordable, is not refused', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer());
        foldRefusalTick(state, tick({ counter: 11, mana: 30, auto: true }), { at: 0, abilityInfo });
        // 5 s after the cast: still cooling down
        expect(foldRefusalTick(state, tick({ counter: 12, mana: 300, auto: true }), { at: 5_000, abilityInfo })).toEqual(
            []
        );
        // Ready, but the bar (300 before this auto) could pay for it
        expect(foldRefusalTick(state, tick({ counter: 13, mana: 300, auto: true }), { at: 12_000, abilityInfo })).toEqual(
            []
        );
        expect(refusalSummary(state).turns).toBe(0);
    });

    test('ability haste shortens the cooldown the way the simulator does', () => {
        const state = newRefusalState();
        // 100 haste halves a 10 s cooldown
        noteRefusalBattle(state, battlePlayer({ haste: 100 }));
        foldRefusalTick(state, tick({ counter: 11, mana: 30, auto: true }), { at: 0, abilityInfo });
        expect(foldRefusalTick(state, tick({ counter: 12, mana: 30, auto: true }), { at: 6_000, abilityInfo })).toEqual([
            DRAIN,
        ]);
    });

    test('a tick whose counter did not rise, or with no baseline, counts nothing', () => {
        const state = newRefusalState();
        // No battle seen: the first tick is only a baseline
        expect(foldRefusalTick(state, tick({ counter: 5, mana: 0, auto: true }), { at: 0, abilityInfo })).toEqual([]);
        noteRefusalBattle(state, battlePlayer());
        foldRefusalTick(state, tick({ counter: 11, mana: 0, auto: true }), { at: 0, abilityInfo });
        // Struck, not acting: same counter
        expect(foldRefusalTick(state, tick({ counter: 11, mana: 0, auto: true }), { at: 20_000, abilityInfo })).toEqual(
            []
        );
        forgetRefusalBaseline(state);
        expect(foldRefusalTick(state, tick({ counter: 12, mana: 0, auto: true }), { at: 40_000, abilityInfo })).toEqual(
            []
        );
        expect(refusalSummary(state).turns).toBe(0);
    });

    test('an unknown ability, and one turn refusing two abilities, are handled', () => {
        const state = newRefusalState();
        noteRefusalBattle(state, battlePlayer({ kit: [DRAIN, ENTANGLE, '/abilities/unknown'] }));
        // Cast all three, one per turn
        foldRefusalTick(state, tick({ counter: 11, mana: 500, ability: ENTANGLE }), { at: 0, abilityInfo });
        foldRefusalTick(state, tick({ counter: 12, mana: 500, ability: '/abilities/unknown' }), { at: 0, abilityInfo });
        foldRefusalTick(state, tick({ counter: 13, mana: 10, auto: true }), { at: 0, abilityInfo });
        // Twelve seconds on: Drain and Entangle ready, 10 mana pays for neither; the unknown one is skipped
        foldRefusalTick(state, tick({ counter: 14, mana: 10, auto: true }), { at: 12_000, abilityInfo });

        expect(refusalSummary(state)).toEqual({
            turns: 1,
            abilities: [
                { abilityHrid: DRAIN, refused: 1 },
                { abilityHrid: ENTANGLE, refused: 1 },
            ],
        });
    });
});
