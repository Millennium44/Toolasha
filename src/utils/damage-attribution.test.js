import { describe, test, expect } from 'vitest';
import {
    newAttributionState,
    noteActions,
    findCaster,
    attributeTick,
    foldEvents,
    isDamagingAction,
    foldEnemies,
} from './damage-attribution.js';

const monster = (cHP, dmgCounter = 0, critCounter = 0) => ({ cHP, dmgCounter, critCounter });
const tick = (mMap, pMap) => ({ mMap, pMap });

describe('findCaster', () => {
    test('is whoever’s mana went down', () => {
        // The payload never says who hit, and only the caster's mana falls
        const state = newAttributionState();
        findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state);

        expect(findCaster({ 0: { cMP: 100 }, 1: { cMP: 70 } }, state)).toBe('1');
    });

    test('solo needs no mana at all', () => {
        // Otherwise an auto-attacking character never registers a hit
        const state = newAttributionState();
        expect(findCaster({ 0: { cMP: 100 } }, state)).toBe('0');
    });

    test('a party with nobody spending credits nobody rather than a guess', () => {
        const state = newAttributionState();
        findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state);
        expect(findCaster({ 0: { cMP: 100 }, 1: { cMP: 100 } }, state)).toBeNull();
    });

    test('mana going up is not a cast', () => {
        const state = newAttributionState();
        findCaster({ 0: { cMP: 50 }, 1: { cMP: 50 } }, state);
        expect(findCaster({ 0: { cMP: 80 }, 1: { cMP: 80 } }, state)).toBeNull();
    });
});

describe('attributeTick', () => {
    function started(hp = 1000) {
        const state = newAttributionState();
        attributeTick(tick({ 0: monster(hp) }, { 0: { cMP: 100 } }), state);
        return state;
    }

    test('a rising damage counter with lost health is a hit', () => {
        const state = started();
        const events = attributeTick(tick({ 0: monster(600, 1) }, { 0: { cMP: 90 } }), state);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ playerIndex: '0', monsterIndex: '0', amount: 400, isMiss: false });
    });

    test('health falling with no counter rise is a bleed, not a hit', () => {
        // Crediting it would hand a damage-over-time effect to whatever ability
        // happened to be mid-cast
        const state = started();
        expect(attributeTick(tick({ 0: monster(900, 0) }, { 0: { cMP: 100 } }), state)).toEqual([]);
    });

    test('a counter rise with no health lost is a miss', () => {
        // The one case a health diff can never express on its own
        const state = started();
        const [event] = attributeTick(tick({ 0: monster(1000, 1) }, { 0: { cMP: 90 } }), state);

        expect(event.isMiss).toBe(true);
        expect(event.amount).toBe(0);
    });

    test('a rising crit counter marks the hit', () => {
        const state = started();
        const [event] = attributeTick(tick({ 0: monster(500, 1, 1) }, { 0: { cMP: 90 } }), state);
        expect(event.isCrit).toBe(true);
    });

    test('a monster seen for the first time is not hit for its whole bar', () => {
        const state = newAttributionState();
        expect(attributeTick(tick({ 0: monster(1000, 5) }, { 0: { cMP: 100 } }), state)).toEqual([]);
    });

    test('the hit carries what the player was preparing', () => {
        const state = started();
        noteActions(state, { 0: { preparingAbilityHrid: '/abilities/smack' } });

        const [event] = attributeTick(tick({ 0: monster(500, 1) }, { 0: { cMP: 90 } }), state);
        expect(event.action).toBe('/abilities/smack');
    });

    test('an auto-attack is labelled as one', () => {
        const state = started();
        noteActions(state, { 0: { isPreparingAutoAttack: true } });

        expect(attributeTick(tick({ 0: monster(500, 1) }, { 0: { cMP: 90 } }), state)[0].action).toBe('auto');
    });

    test('several monsters hit in one tick each get an event', () => {
        const state = newAttributionState();
        attributeTick(tick({ 0: monster(100), 1: monster(100) }, { 0: { cMP: 100 } }), state);

        const events = attributeTick(tick({ 0: monster(90, 1), 1: monster(40, 1) }, { 0: { cMP: 90 } }), state);
        expect(events.map((event) => event.amount).sort((a, b) => a - b)).toEqual([10, 60]);
    });

    test('nothing at all is nothing, not a crash', () => {
        expect(attributeTick(null, newAttributionState())).toEqual([]);
    });
});

describe('foldEvents', () => {
    const hit = (over) => ({ playerIndex: '0', amount: 100, action: 'auto', isCrit: false, isMiss: false, ...over });

    test('sums damage, hits and crits per player', () => {
        const tally = foldEvents({}, [hit({}), hit({ isCrit: true }), hit({ playerIndex: '1', amount: 50 })]);

        expect(tally['0']).toMatchObject({ damage: 200, hits: 2, crits: 1 });
        expect(tally['1']).toMatchObject({ damage: 50, hits: 1 });
    });

    test('a miss is a swing that happened, so it counts even when filtered out', () => {
        // Dropping it would flatter the hit rate of whatever was cast
        const tally = foldEvents({}, [hit({ isMiss: true, action: 'idle' })]);
        expect(tally['0'].misses).toBe(1);
        expect(tally['0'].hits).toBe(0);
    });

    test('the non-damaging filter drops damage credited while idle', () => {
        const tally = foldEvents({}, [hit({ action: 'idle' })]);
        expect(tally['0'].damage).toBe(0);
    });

    test('and can be turned off', () => {
        const tally = foldEvents({}, [hit({ action: 'idle' })], { filterNonDamaging: false });
        expect(tally['0'].damage).toBe(100);
    });

    test('a heal is not damage of the other sign', () => {
        const tally = foldEvents({}, [hit({ isHeal: true, amount: 300 })]);
        expect(tally['0'].damage).toBe(0);
    });

    test('damage is broken down by what was cast', () => {
        const tally = foldEvents({}, [hit({ action: '/abilities/smack' }), hit({ action: 'auto', amount: 40 })]);

        expect(tally['0'].byAbility['/abilities/smack'].damage).toBe(100);
        expect(tally['0'].byAbility.auto.damage).toBe(40);
    });

    test('folding twice accumulates rather than replacing', () => {
        const tally = foldEvents({}, [hit({})]);
        foldEvents(tally, [hit({})]);
        expect(tally['0'].damage).toBe(200);
    });
});

describe('isDamagingAction', () => {
    test('idle is not an attack', () => {
        expect(isDamagingAction('idle')).toBe(false);
    });

    test('an auto-attack and a named ability are', () => {
        expect(isDamagingAction('auto')).toBe(true);
        expect(isDamagingAction('/abilities/smack')).toBe(true);
    });

    test('the caller can name more', () => {
        expect(isDamagingAction('/abilities/heal', new Set(['/abilities/heal']))).toBe(false);
    });
});

describe('foldEnemies', () => {
    const nameOf = (index) => ({ 0: 'Rat', 1: 'Wolf' })[index] || null;

    test('damage lands against the monster that took it', () => {
        const tally = foldEnemies(
            {},
            [
                { monsterIndex: '0', amount: 100, isCrit: false, isMiss: false },
                { monsterIndex: '1', amount: 40, isCrit: true, isMiss: false },
                { monsterIndex: '0', amount: 60, isCrit: false, isMiss: false },
            ],
            nameOf
        );

        expect(tally.Rat).toMatchObject({ damage: 160, hits: 2, crits: 0 });
        expect(tally.Wolf).toMatchObject({ damage: 40, hits: 1, crits: 1 });
    });

    test('a kill is counted and is not also a hit', () => {
        // A death is not a swing; counting it as one adds a phantom hit
        const tally = foldEnemies({}, [{ monsterIndex: '0', isKill: true }], nameOf);

        expect(tally.Rat).toMatchObject({ kills: 1, hits: 0, damage: 0 });
    });

    test('a bleed kill still counts, though no counter moved', () => {
        // The killing blow can land on a tick with no hit at all, and those are
        // the long fights — exactly the ones worth measuring
        const tally = foldEnemies({}, [{ monsterIndex: '1', isKill: true }], nameOf);

        expect(tally.Wolf.kills).toBe(1);
    });

    test('a monster it cannot name is left out rather than lumped together', () => {
        // The index is a slot in this fight; without a name behind it the
        // damage belongs to nobody in particular
        const tally = foldEnemies({}, [{ monsterIndex: '9', amount: 500, isMiss: false }], nameOf);

        expect(Object.keys(tally)).toHaveLength(0);
    });

    test('misses count as swings against the monster', () => {
        const tally = foldEnemies({}, [{ monsterIndex: '0', amount: 0, isMiss: true }], nameOf);

        expect(tally.Rat).toMatchObject({ misses: 1, hits: 0, damage: 0 });
    });
});

describe('kills in a tick', () => {
    test('a monster reaching zero emits a kill', () => {
        const state = newAttributionState();
        attributeTick({ mMap: { 0: { cHP: 100, dmgCounter: 0 } }, pMap: { 0: { cMP: 50 } } }, state);
        const events = attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 40 } } }, state);

        expect(events.filter((event) => event.isKill)).toHaveLength(1);
    });

    test('a monster already dead is not killed twice', () => {
        // It stays in the payload at zero health until the battle turns over
        const state = newAttributionState();
        attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 50 } } }, state);
        const events = attributeTick({ mMap: { 0: { cHP: 0, dmgCounter: 1 } }, pMap: { 0: { cMP: 50 } } }, state);

        expect(events.filter((event) => event.isKill)).toHaveLength(0);
    });

    test('a kill event does not reach the player tally', () => {
        const tally = foldEvents({}, [{ playerIndex: '0', monsterIndex: '0', isKill: true }]);
        expect(tally['0']).toBeUndefined();
    });
});

describe('foldEvents, split by enemy', () => {
    const nameOf = (index) => ({ 0: 'Rat', 1: 'Wolf' })[index] || null;

    test('a player carries what they did to each monster', () => {
        const tally = foldEvents(
            {},
            [
                { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
                { playerIndex: '0', monsterIndex: '1', amount: 40, action: 'auto', isMiss: false },
            ],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Rat).toMatchObject({ damage: 100, hits: 1 });
        expect(tally['0'].byEnemy.Wolf).toMatchObject({ damage: 40, hits: 1 });
    });

    test('two players fighting different monsters are not merged', () => {
        // One kiting while another burns the boss is two fights; a party-wide
        // enemy total averages them into neither
        const tally = foldEvents(
            {},
            [
                { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
                { playerIndex: '1', monsterIndex: '1', amount: 900, action: 'auto', isMiss: false },
            ],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Wolf).toBeUndefined();
        expect(tally['1'].byEnemy.Rat).toBeUndefined();
    });

    test('the split names the ability used against each monster', () => {
        const tally = foldEvents(
            {},
            [{ playerIndex: '0', monsterIndex: '0', amount: 100, action: '/abilities/cleave', isMiss: false }],
            { nameOf }
        );

        expect(tally['0'].byEnemy.Rat.byAbility['/abilities/cleave'].damage).toBe(100);
    });

    test('without a name resolver the player tally is unchanged', () => {
        // The split is extra; a caller that cannot name monsters still gets its
        // players, abilities and totals
        const tally = foldEvents({}, [
            { playerIndex: '0', monsterIndex: '0', amount: 100, action: 'auto', isMiss: false },
        ]);

        expect(tally['0'].damage).toBe(100);
        expect(tally['0'].byEnemy).toEqual({});
    });
});

describe('the acting ability, tick by tick', () => {
    /**
     * A tick where the player casts (mana falls) and one monster takes a hit.
     * @param {number} mana - The player's mana after this tick
     * @param {number} health - The monster's health after this tick
     * @param {number} counter - Its damage counter after this tick
     * @param {Object} preparing - What the player is preparing, in tick spelling
     * @returns {Object}
     */
    const tick = (mana, health, counter, preparing = {}) => ({
        pMap: { 0: { cMP: mana, ...preparing } },
        mMap: { 0: { cHP: health, dmgCounter: counter } },
    });

    test('a tick payload names the ability under its own spelling', () => {
        // `new_battle` writes preparingAbilityHrid; a tick abbreviates it to
        // abilityHrid. Reading only the long one leaves the label frozen at
        // whatever was being prepared when the fight began.
        const state = newAttributionState();
        noteActions(state, { 0: { abilityHrid: '/abilities/cleave' } });

        expect(state.actions['0']).toBe('/abilities/cleave');
    });

    test('an auto-attack is recognised under its own spelling too', () => {
        const state = newAttributionState();
        noteActions(state, { 0: { isAutoAtk: true } });

        expect(state.actions['0']).toBe('auto');
    });

    test('a hit is credited to what was prepared before it, not after', () => {
        // The ability that lands on this tick was cast before the payload
        // arrived; by now the player has started the next one. Reading the
        // label from this tick would credit every hit to its successor.
        const state = newAttributionState();

        noteActions(state, { 0: { abilityHrid: '/abilities/first' } });
        attributeTick(tick(100, 1000, 0), state);

        // The hit lands while the player has moved on to the second ability
        const events = attributeTick(tick(90, 800, 1, { abilityHrid: '/abilities/second' }), state);

        expect(events[0].action).toBe('/abilities/first');
    });

    test('the label changes as the fight goes on', () => {
        // Frozen at the first ability, one ability takes the whole fight —
        // which is the shape of the bug this catches
        const state = newAttributionState();

        noteActions(state, { 0: { abilityHrid: '/abilities/first' } });
        attributeTick(tick(100, 1000, 0), state);

        const first = attributeTick(tick(90, 800, 1), state);
        noteActions(state, { 0: { abilityHrid: '/abilities/second' } });
        const second = attributeTick(tick(80, 600, 2), state);

        expect(first[0].action).toBe('/abilities/first');
        expect(second[0].action).toBe('/abilities/second');
    });
});
