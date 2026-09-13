/**
 * B1 — the first hit on every monster in every wave.
 *
 * `mMap` is a delta: a monster's first entry in it is usually the tick it is
 * first struck, so a baseline taken from that entry is already post-hit and
 * the blow that set it contributes nothing — a one-shot kill contributes
 * neither damage nor a kill. `new_battle` is the one message that states a
 * monster's health and swing counters before anything has touched it, so
 * seeding the attribution baseline from it (see `onNewBattle` in
 * `damage-tracker.js`) recovers exactly that first hit.
 *
 * This replays five recorded fights end to end through the real tracker and
 * checks the recovered total against the same fixtures replayed by hand in
 * the investigation that found the bug — both with the fix (seeded) and
 * without it (the first-sighting baseline, reverted here by skipping
 * `new_battle`'s monster map so nothing is proven twice by the same code
 * path).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import dungeon from '../../utils/__fixtures__/combat-dungeon.json';
import party from '../../utils/__fixtures__/combat-party.json';
import run from '../../utils/__fixtures__/combat-run.json';

const listeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ abilityDetailMap: {}, itemDetailMap: {} }) },
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

/**
 * Feed a whole recording through the real tracker.
 *
 * @param {Object} recording - `{ticks: [{type, payload}]}`
 * @param {Object} [options] - `{seed}` — false drops every `new_battle`'s
 *   monster map, reproducing the pre-fix baseline (first sighting in `mMap`)
 *   on the same code path rather than a hand-rolled second implementation
 * @returns {number} Total attributed damage, players summed
 */
function replay(recording, { seed = true } = {}) {
    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            const payload = seed ? tick.payload : { ...tick.payload, monsters: {} };
            listeners.new_battle(payload);
        } else if (tick.type === 'battle_updated') {
            listeners.battle_updated(tick.payload);
        }
    }
    return tracker.damageBreakdown().players.reduce((sum, player) => sum + player.damage, 0);
}

describe('replaying recorded fights, seeded from new_battle', () => {
    beforeEach(() => {
        tracker.default.initialize();
        // Isolates B1 from B2 (the default "Filter Nondamage" dropping
        // counter-confirmed hits carrying no ability label) — see the
        // investigation notes. Both are real bugs; conflating them here would
        // make this test's numbers depend on a fix this one is not about.
        tracker.setFilterNonDamaging(false);
    });

    afterEach(() => {
        tracker.default.cleanup();
    });

    // Figures from replaying the same fixtures with `attributeTick`/`foldEvents`
    // directly (filterNonDamaging off, so B2's separate idle-label drop cannot
    // hide part of B1's effect) — see the investigation notes. The unseeded
    // baseline reproduces the undercount the bug report measured (25,402 /
    // 192,487 / 24,249); seeding recovers it (29,335 / 233,768 / 31,278).
    test.each([
        ['combat-dungeon', dungeon, 25402, 29335],
        ['combat-party', party, 192487, 233768],
        ['combat-run', run, 24249, 31278],
    ])('%s: the seeded total equals ground truth, not the undercount', (_name, recording, unseeded, seeded) => {
        expect(Math.round(replay(recording, { seed: false }))).toBe(unseeded);
        tracker.default.cleanup();
        tracker.default.initialize();
        expect(Math.round(replay(recording, { seed: true }))).toBe(seeded);
    });
});
