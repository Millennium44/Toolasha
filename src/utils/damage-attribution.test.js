import { describe, test, expect } from 'vitest';
import {
    newAttributionState,
    noteActions,
    findCaster,
    attributeTick,
    foldEvents,
    isDamagingAction,
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
