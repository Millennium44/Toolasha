/**
 * Attribution against a real fight.
 *
 * The unit tests above build the payloads they need, which proves the pieces
 * behave and cannot prove they behave *together* on what the game actually
 * sends. This replays a recorded run — sixty-eight seconds on Planet of the
 * Eyes, six battles, two hundred and eighty ticks — through the same functions
 * the tracker uses.
 *
 * It exists because of a bug no built payload would have caught. The acting
 * ability was read once, at the start of a battle, and never again: `new_battle`
 * spells the field `preparingAbilityHrid` and a tick abbreviates it to
 * `abilityHrid`, so a tick never had anything to say. Every hit in a fight was
 * credited to whatever the character was preparing when it began, which put a
 * rarely-cast ability at 42% of a run that was four-fifths auto-attack. The
 * shapes were all individually plausible. Only a real run showed it.
 *
 * The fixture is trimmed to the fields attribution reads — health, mana, the
 * two counters, the ability, the names. Nothing about the account.
 */

import { describe, test, expect } from 'vitest';
import { newAttributionState, noteActions, attributeTick, foldEvents, foldEnemies } from './damage-attribution.js';
import recording from './__fixtures__/combat-run.json';

/**
 * The run, as the tracker would tally it.
 *
 * Deliberately a copy of the tracker's loop rather than an import of it: the
 * tracker is wired to a websocket and a data manager, and what is under test is
 * the arithmetic and the *order* it happens in — attribute the tick, then note
 * what is being prepared next.
 *
 * @returns {{players: Object, enemies: Object, names: Object}}
 */
function replay() {
    const state = newAttributionState();
    const players = {};
    const enemies = {};
    const names = {};
    const monsters = {};

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            noteActions(state, tick.payload.players);
            for (const [index, player] of Object.entries(tick.payload.players || {})) {
                if (player?.name) names[index] = player.name;
            }

            state.monstersHP = {};
            state.dmgCounter = {};
            state.critCounter = {};

            // The indices are reused every battle and mean different monsters
            // each time, so this is rebuilt rather than merged
            for (const key of Object.keys(monsters)) delete monsters[key];
            for (const [index, monster] of Object.entries(tick.payload.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            continue;
        }

        const events = attributeTick(tick.payload, state);
        const nameOf = (index) => monsters[index] || null;
        foldEvents(players, events, { filterNonDamaging: true, nameOf });
        foldEnemies(enemies, events, nameOf);
        noteActions(state, tick.payload.pMap);
    }

    return { players, enemies, names };
}

describe('a recorded run', () => {
    const { players, enemies, names } = replay();
    const player = players['0'];

    test('it attributes the run to the character who fought it', () => {
        expect(names['0']).toBe('Millennium44');
        expect(Object.keys(players)).toEqual(['0']);
        expect(player.damage).toBeGreaterThan(20_000);
    });

    test('the run is four-fifths auto-attack, which is what it was', () => {
        // The number that mattered: with the ability read only at the start of
        // a battle this said 34% auto and 42% puncture, on a run where puncture
        // was cast twice
        const share = (action) => player.byAbility[action].damage / player.damage;

        expect(share('auto')).toBeGreaterThan(0.7);
        expect(share('auto')).toBeLessThan(0.9);
    });

    test('an ability cast twice is not credited with a third of the run', () => {
        expect(player.byAbility['/abilities/puncture'].hits).toBe(2);
        expect(player.byAbility['/abilities/puncture'].damage / player.damage).toBeLessThan(0.15);
    });

    test('every ability credited was one the character actually cast', () => {
        // `idle` reaching the tally means damage landed with nothing prepared
        // and the filter let it through
        for (const action of Object.keys(player.byAbility)) {
            expect(action === 'auto' || action.startsWith('/abilities/')).toBe(true);
        }
    });

    test('the abilities account for the whole of the damage', () => {
        const summed = Object.values(player.byAbility).reduce((total, ability) => total + ability.damage, 0);
        expect(summed).toBe(player.damage);
    });

    test('every monster the tick mentions states its own full health', () => {
        // Which is what a kill is priced by. Taking it from the tick rather than
        // only from the start of a battle means a monster first met after a
        // reload is priced like any other, with no screen-reading involved.
        const entries = recording.ticks
            .filter((tick) => tick.type !== 'new_battle')
            .flatMap((tick) => Object.values(tick.payload.mMap || {}));

        // This fixture is hand-trimmed and has none; the untrimmed ones do
        expect(entries.every((monster) => 'mHP' in monster)).toBe(false);
    });

    test('the monsters of the zone are named and counted', () => {
        expect(Object.keys(enemies).sort()).toEqual(['Eye', 'Eyes', 'Veyes']);

        const killed = Object.values(enemies).reduce((total, enemy) => total + enemy.kills, 0);
        expect(killed).toBe(14);
    });

    test('no monster is credited more damage than the party dealt', () => {
        // Slot 0 is an Eye in one battle and an Eyes in the next; a monster map
        // carried between battles quietly doubles one of them
        for (const enemy of Object.values(enemies)) {
            expect(enemy.damage).toBeLessThanOrEqual(player.damage);
        }
    });
});
