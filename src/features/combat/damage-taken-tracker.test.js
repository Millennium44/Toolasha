/**
 * @vitest-environment happy-dom
 *
 * The tracker, over a session that starts in the wrong place.
 *
 * `utils/damage-taken.js` is tested on its own and replayed against a real
 * fight. What is left for the tracker is the bookkeeping around it, and the case
 * worth a test is a page reloaded mid-battle: no `new_battle` ever arrives for
 * the fight in progress, so nothing knows what it is fighting and everything it
 * does is filed under "Unknown Enemy" until the next fight begins.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const listeners = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => (listeners[type] = handler),
        off: (type) => delete listeners[type],
    },
}));

const tracker = await import('./damage-taken-tracker.js');

/**
 * The battle panel the game draws, which is where the names still are.
 * @param {Array<{name: string, hp: number, max: number}>} monsters - What to draw
 */
function drawPanel(monsters) {
    const tiles = monsters
        .map(
            (monster) =>
                `<div><div>${monster.name}</div><div>${monster.hp}/${monster.max}</div>` +
                `<div>${monster.max}/${monster.max}</div><div>Auto Attack</div></div>`
        )
        .join('');

    document.body.innerHTML = `<div class="BattlePanel_monstersArea__aB1">
        <div class="BattlePanel_combatUnitGrid__x9">${tiles}</div>
    </div>`;
}

/**
 * A tick, from the parts that matter.
 * @param {Object} players - Index → {hp, dmg}
 * @param {Object} monsters - Index → {hp}
 * @param {number} battleId - Which fight this is
 */
function tick(players, monsters, battleId = 1) {
    const pMap = {};
    for (const [index, p] of Object.entries(players)) pMap[index] = { cHP: p.hp, dmgCounter: p.dmg ?? 0 };

    const mMap = {};
    for (const [index, m] of Object.entries(monsters)) mMap[index] = { cHP: m.hp, cMP: 100, dmgCounter: 0 };

    listeners.battle_updated({ battleId, pMap, mMap });
}

beforeEach(() => {
    tracker.default.initialize();
    document.body.innerHTML = '';
});

afterEach(() => {
    tracker.default.cleanup();
    document.body.innerHTML = '';
});

describe('a session that began mid-fight', () => {
    test('the monsters are named from what the game is drawing', () => {
        // No `new_battle` will ever arrive for this fight, so without this every
        // hit of it lands under Unknown Enemy — which is what both this panel
        // and MCS's used to show after a reload
        drawPanel([{ name: 'Veyes', hp: 2395, max: 2395 }]);

        tick({ 0: { hp: 500, dmg: 3 } }, { 0: { hp: 2395 } });
        tick({ 0: { hp: 420, dmg: 4 } }, { 0: { hp: 2395 } });

        const enemies = tracker.takenBreakdown().enemies;
        expect(enemies.map((enemy) => enemy.name)).toEqual(['Veyes']);
        expect(enemies[0].damage).toBe(80);
    });

    test('a wave arriving one monster at a time is named all the way through', () => {
        // `mMap` is a delta, so the second monster of a wave may not report for
        // several ticks. Reading the panel only while the map was empty named
        // the first monster and left the rest of the wave Unknown for the whole
        // fight — which on a recorded refresh cost exactly one hit.
        drawPanel([
            { name: 'Veyes', hp: 2395, max: 2395 },
            { name: 'Eye', hp: 2035, max: 2035 },
        ]);

        // Two ticks that mention only the Veyes, then two that mention only the Eye
        tick({ 0: { hp: 500, dmg: 3 } }, { 0: { hp: 2395 } });
        tick({ 0: { hp: 480, dmg: 4 } }, { 0: { hp: 2395 } });
        tick({ 0: { hp: 480, dmg: 4 } }, { 1: { hp: 2035 } });
        tick({ 0: { hp: 400, dmg: 5 } }, { 1: { hp: 2035 } });

        const names = tracker.takenBreakdown().enemies.map((enemy) => enemy.name);
        expect(names).not.toContain('Unknown Enemy');
        expect(names).toContain('Eye');
    });

    test('with no panel to read it says Unknown Enemy, as before', () => {
        tick({ 0: { hp: 500, dmg: 3 } }, { 0: { hp: 2395 } });
        tick({ 0: { hp: 420, dmg: 4 } }, { 0: { hp: 2395 } });

        expect(tracker.takenBreakdown().enemies[0].name).toBe('Unknown Enemy');
    });

    test('once a battle is announced the payload wins over the panel', () => {
        // The panel is a recovery, not a source. A stale one left on screen must
        // never override what the game just said it spawned.
        drawPanel([{ name: 'Veyes', hp: 2395, max: 2395 }]);
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye', hrid: '/monsters/eye' } },
        });

        tick({ 0: { hp: 500, dmg: 3 } }, { 0: { hp: 2395 } }, 2);
        tick({ 0: { hp: 420, dmg: 4 } }, { 0: { hp: 2395 } }, 2);

        expect(tracker.takenBreakdown().enemies[0].name).toBe('Eye');
    });

    test('the recovered fight is not filed under a wave', () => {
        // Half a battle is not the composition that was fought, and counting it
        // as one would make that wave's per-encounter average wrong from then on
        drawPanel([{ name: 'Veyes', hp: 2395, max: 2395 }]);

        tick({ 0: { hp: 500, dmg: 3 } }, { 0: { hp: 2395 } });
        tick({ 0: { hp: 420, dmg: 4 } }, { 0: { hp: 2395 } });

        expect(tracker.takenBreakdown().waves).toEqual([]);
    });
});

/**
 * The per-fight, per-slot fold behind the enemy tiles' outgoing line.
 *
 * The session tally already answers "what is hurting the party" by name; a
 * tile is a slot in this fight, and the cases worth testing are the two ways a
 * slot figure could lie — a hit two monsters could have landed filed on one of
 * their tiles, and last fight's damage worn by this fight's monster.
 */
describe('what each slot is doing to the party this fight', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-03T01:00:00Z'));
    });

    afterEach(() => vi.useRealTimers());

    test('a hit pinned to one slot lands on that slot, with a rate', () => {
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye', hrid: '/monsters/eye' } },
        });

        tick({ 0: { hp: 500, dmg: 0 } }, { 0: { hp: 2000 } });
        vi.setSystemTime(Date.now() + 1000);
        tick({ 0: { hp: 420, dmg: 1 } }, { 0: { hp: 2000 } });

        const fight = tracker.battleTakenBreakdown();
        expect(fight.enemies['0'].damage).toBe(80);
        expect(fight.enemies['0'].dps).toBeCloseTo(80);
    });

    test('a hit either of two monsters could have landed goes on neither tile', () => {
        // "An Eye hit you" is a fine answer for a name and no answer at all
        // for a tile — filing it on one of them would move damage between
        // tiles and then be read as evidence about which monster is dangerous
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye' }, 1: { name: 'Eye' } },
        });

        // Both monsters attack on the same tick: two candidates
        tick({ 0: { hp: 500, dmg: 0 } }, { 0: { hp: 2000 }, 1: { hp: 2000 } });
        vi.setSystemTime(Date.now() + 1000);
        tick({ 0: { hp: 420, dmg: 1 } }, { 0: { hp: 2000 }, 1: { hp: 2000 } });

        expect(tracker.battleTakenBreakdown().enemies).toEqual({});
        // The session tally still counts it — the name was unambiguous
        expect(tracker.takenBreakdown().enemies[0].damage).toBe(80);
    });

    test('a new battle starts the fold from nothing', () => {
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye' } },
        });
        tick({ 0: { hp: 500, dmg: 0 } }, { 0: { hp: 2000 } });
        vi.setSystemTime(Date.now() + 1000);
        tick({ 0: { hp: 420, dmg: 1 } }, { 0: { hp: 2000 } });
        expect(tracker.battleTakenBreakdown().enemies['0'].damage).toBe(80);

        // Last fight's slot 0 was a different monster
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Veyes' } },
        });
        expect(tracker.battleTakenBreakdown().enemies).toEqual({});
    });

    test('too little of a fight gives damage and no rate', () => {
        listeners.new_battle({
            players: { 0: { name: 'You' } },
            monsters: { 0: { name: 'Eye' } },
        });

        tick({ 0: { hp: 500, dmg: 0 } }, { 0: { hp: 2000 } });
        vi.setSystemTime(Date.now() + 200);
        tick({ 0: { hp: 460, dmg: 1 } }, { 0: { hp: 2000 } });

        const fight = tracker.battleTakenBreakdown();
        expect(fight.enemies['0'].damage).toBe(40);
        expect(fight.enemies['0'].dps).toBeNull();
    });
});
