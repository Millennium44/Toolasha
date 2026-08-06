/** @vitest-environment happy-dom */

/**
 * Putting names to a spectated trial's unit indexes.
 *
 * The numbers in here are the capture's own: `pMap["1"]` reading `mHP 2612,
 * mMP 2180`, and a guild whose loadout store holds one member with `Max HP
 * 2,612` and `Max MP 2,180`. What is worth asserting is the discipline rather
 * than the arithmetic — an ambiguous signature must name nobody, because a
 * wrong name on a damage row is acted on.
 */

import { describe, test, expect, afterEach } from 'vitest';

import {
    fightViewBossNames,
    fightViewNames,
    loadoutVitals,
    matchByVitals,
    nameCoverage,
    resolveUnitNames,
    rosterFromBattle,
} from './guild-trial-units.js';
import { NEW_GUILD_BATTLE } from './guild-trial-messages.fixture.js';

/**
 * A captured sheet, as the loadout store holds one.
 * @param {string} name - Whose
 * @param {number} hp - Max HP, as the game displayed it
 * @param {number} mp - Max MP
 * @returns {Object} A snapshot
 */
const sheet = (name, hp, mp) => ({
    name,
    at: 1,
    rows: [
        { label: 'Max HP', value: hp.toLocaleString('en-US') },
        { label: 'Max MP', value: mp.toLocaleString('en-US') },
        { label: 'Armor', value: '339' },
    ],
    // The multiplier the sheet also carries, which must never be matched against
    stats: { maxHitpoints: 932, maxManapoints: 500 },
});

/** The unit the capture actually showed */
const icmeow = { cHP: 2612, mHP: 2612, cMP: 2180, mMP: 2180, isActive: true, leftCombat: false };

afterEach(() => {
    document.body.innerHTML = '';
});

describe('loadoutVitals', () => {
    test('reads the displayed maximums, not the multiplier beside them', () => {
        expect(loadoutVitals(sheet('ICMeow', 2612, 2180))).toEqual({ mHP: 2612, mMP: 2180 });
    });

    test('a sheet without them says so rather than guessing', () => {
        expect(loadoutVitals({ rows: [{ label: 'Armor', value: '339' }] })).toEqual({ mHP: null, mMP: null });
        expect(loadoutVitals(null)).toEqual({ mHP: null, mMP: null });
    });
});

describe('matchByVitals', () => {
    test('one member with that health and mana is an identification', () => {
        const match = matchByVitals(icmeow, [sheet('Cream', 1923, 1923), sheet('ICMeow', 2612, 2180)]);
        expect(match).toMatchObject({ name: 'ICMeow' });
    });

    test('two members in the same gear identify nobody', () => {
        // A near-miss is worse than a blank: a guild acts on the name
        expect(matchByVitals(icmeow, [sheet('ICMeow', 2612, 2180), sheet('Twin', 2612, 2180)])).toBeNull();
    });

    test('the same member captured twice is still one candidate', () => {
        const match = matchByVitals(icmeow, [sheet('ICMeow', 2612, 2180), sheet('icmeow', 2612, 2180)]);
        expect(match).toMatchObject({ name: 'ICMeow' });
    });

    test('health alone is not enough, and neither is nothing', () => {
        expect(matchByVitals({ mHP: 2612 }, [sheet('ICMeow', 2612, 2180)])).toBeNull();
        expect(matchByVitals(icmeow, [])).toBeNull();
        expect(matchByVitals(null, [sheet('ICMeow', 2612, 2180)])).toBeNull();
    });
});

describe('fightViewNames', () => {
    test('reads the party tiles in slot order', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_playersArea__a">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Tib</div></div>' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">ICMeow</div></div>' +
            '</div>' +
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';

        // The boss is in the monsters area and is not a party name
        expect(fightViewNames(document)).toEqual(['Tib', 'ICMeow']);
    });

    test('no fight view is no answer, not an empty party', () => {
        expect(fightViewNames(document)).toEqual([]);
        expect(fightViewNames(null)).toEqual([]);
    });
});

describe('fightViewBossNames', () => {
    test('reads what is being fought, from the monsters area only', () => {
        document.body.innerHTML =
            '<div class="BattlePanel_playersArea__a">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">ICMeow</div></div>' +
            '</div>' +
            '<div class="BattlePanel_monstersArea__d">' +
            '<div class="CombatUnit_combatUnit__b"><div class="CombatUnit_name__c">Trial Chameleon</div></div>' +
            '</div>';

        // The identity of the stream: a week with two combat trials had the
        // Chameleon fight filed under Hedgehog because nothing read this
        expect(fightViewBossNames(document)).toEqual(['Trial Chameleon']);
    });

    test('no fight view is no answer', () => {
        expect(fightViewBossNames(document)).toEqual([]);
        expect(fightViewBossNames(null)).toEqual([]);
    });
});

describe('resolveUnitNames', () => {
    test('a portrait outranks a build, because it is on screen', () => {
        const names = resolveUnitNames({
            pMap: { 1: icmeow },
            portraits: ['Tib', 'TheirRealName'],
            loadouts: [sheet('ICMeow', 2612, 2180)],
        });

        expect(names['1']).toEqual({ name: 'TheirRealName', source: 'portrait' });
    });

    test('without a portrait the build’s vitals answer', () => {
        const names = resolveUnitNames({ pMap: { 1: icmeow }, loadouts: [sheet('ICMeow', 2612, 2180)] });
        expect(names['1']).toEqual({ name: 'ICMeow', source: 'vitals' });
    });

    test('when neither can say, the placeholder says it is one', () => {
        const names = resolveUnitNames({ pMap: { 1: icmeow, 3: { mHP: 9 } } });
        expect(names['1']).toEqual({ name: 'Player 2', source: 'placeholder' });
        expect(names['3']).toEqual({ name: 'Player 4', source: 'placeholder' });
    });

    test('a name already resolved survives the fight view closing', () => {
        const first = resolveUnitNames({ pMap: { 1: icmeow }, portraits: ['Tib', 'ICMeow'] });
        const later = resolveUnitNames({ pMap: { 1: icmeow }, portraits: [], known: first });

        expect(later['1']).toEqual({ name: 'ICMeow', source: 'portrait' });
    });

    test('a placeholder does not survive it opening', () => {
        const first = resolveUnitNames({ pMap: { 1: icmeow } });
        const later = resolveUnitNames({ pMap: { 1: icmeow }, portraits: ['Tib', 'ICMeow'], known: first });

        expect(later['1']).toEqual({ name: 'ICMeow', source: 'portrait' });
    });

    test('a portrait slot the party does not reach is not borrowed from', () => {
        // Index 4 with two tiles on screen is not tile 0 wrapped around
        const names = resolveUnitNames({ pMap: { 4: icmeow }, portraits: ['Tib', 'Moo'] });
        expect(names['4'].source).toBe('placeholder');
    });
});

describe('rosterFromBattle', () => {
    test('slot order is the join, and it is exact', () => {
        const roster = rosterFromBattle(NEW_GUILD_BATTLE);

        expect(Object.keys(roster)).toHaveLength(30);
        // Verified against the recording: a tick's `pMap` key "19" is players[19]
        expect(roster[19]).toEqual({ name: 'TakoTsubo', characterId: 585247 });
        expect(roster[0]).toEqual({ name: 'Duskey', characterId: 611244 });
    });

    test('a payload with no roster on it gives none, rather than throwing', () => {
        expect(rosterFromBattle({})).toEqual({});
        expect(rosterFromBattle({ players: 'nope' })).toEqual({});
        expect(rosterFromBattle(null)).toEqual({});
    });

    test('a slot with no name is skipped rather than filled with a placeholder', () => {
        const roster = rosterFromBattle({ players: [{ character: { id: 1, name: 'Tib' } }, { character: {} }] });
        expect(Object.keys(roster)).toEqual(['0']);
    });
});

describe('the roster outranks everything', () => {
    const unit = { mHP: 2612, mMP: 2180 };

    test('a stated name beats a portrait and a build alike', () => {
        const names = resolveUnitNames({
            pMap: { 1: unit },
            roster: { 1: { name: 'Stated', characterId: 7 } },
            portraits: ['Tib', 'Portrait'],
            loadouts: [
                {
                    name: 'Vitals',
                    rows: [
                        { label: 'Max HP', value: '2,612' },
                        { label: 'Max MP', value: '2,180' },
                    ],
                },
            ],
        });

        expect(names['1']).toEqual({ name: 'Stated', source: 'roster', characterId: 7 });
    });

    test('and it restates a slot that had already been resolved', () => {
        // A new battle is a new roster; a slot that changed hands must not keep
        // the name the last one had
        const first = resolveUnitNames({ pMap: { 1: unit }, portraits: ['Tib', 'WasHere'] });
        const later = resolveUnitNames({ pMap: { 1: unit }, roster: { 1: { name: 'NowHere' } }, known: first });

        expect(later['1']).toMatchObject({ name: 'NowHere', source: 'roster' });
    });

    test('a slot the roster does not cover still falls through', () => {
        const names = resolveUnitNames({ pMap: { 4: unit }, roster: { 1: { name: 'Stated' } } });
        expect(names['4'].source).toBe('placeholder');
    });
});

describe('nameCoverage', () => {
    test('counts what was named and lists what was not', () => {
        const coverage = nameCoverage({
            0: { name: 'Tib', source: 'portrait' },
            1: { name: 'ICMeow', source: 'vitals' },
            2: { name: 'Player 3', source: 'placeholder' },
        });

        expect(coverage).toEqual({
            named: 2,
            of: 3,
            placeholders: ['Player 3'],
            bySource: { portrait: 1, vitals: 1, placeholder: 1 },
        });
    });

    test('nothing resolved is nothing claimed', () => {
        expect(nameCoverage(null)).toEqual({ named: 0, of: 0, placeholders: [], bySource: {} });
    });
});
