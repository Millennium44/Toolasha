/**
 * Tests for Profile Cache Module
 */
import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';

const stored = vi.hoisted(() => new Map());

vi.mock('./storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (stored.has(key) ? stored.get(key) : fallback),
        set: async (key, value) => {
            stored.set(key, value);
            return true;
        },
    },
}));

const {
    setCurrentProfile,
    getCurrentProfile,
    clearCurrentProfile,
    evidenceFromSharedProfile,
    noteSharedClassEvidence,
    sharedClassEvidenceFor,
    _resetSharedClassEvidence,
} = await import('./profile-manager.js');

beforeEach(() => {
    stored.clear();
    _resetSharedClassEvidence();
});

afterEach(() => {
    clearCurrentProfile();
});

describe('profile-manager', () => {
    test('returns null before any profile is set', () => {
        expect(getCurrentProfile()).toBeNull();
    });

    test('setCurrentProfile stores the value returned by getCurrentProfile', () => {
        const profile = { characterID: '123', characterName: 'Alice' };
        setCurrentProfile(profile);
        expect(getCurrentProfile()).toBe(profile);
    });

    test('setCurrentProfile overwrites the previous profile', () => {
        setCurrentProfile({ characterID: '1' });
        setCurrentProfile({ characterID: '2' });
        expect(getCurrentProfile()).toEqual({ characterID: '2' });
    });

    test('clearCurrentProfile resets the cache to null', () => {
        setCurrentProfile({ characterID: '1' });
        clearCurrentProfile();
        expect(getCurrentProfile()).toBeNull();
    });
});

describe('evidenceFromSharedProfile', () => {
    test('reads the weapon from the main-hand or two-hand slot, and the kit from equipped abilities', () => {
        const parsed = {
            profile: {
                wearableItemMap: {
                    1: { itemLocationHrid: '/item_locations/two_hand', itemHrid: '/items/blooming_trident' },
                    2: { itemLocationHrid: '/item_locations/body', itemHrid: '/items/robe' },
                },
                equippedAbilities: [{ abilityHrid: '/abilities/entangle' }, { abilityHrid: '/abilities/water_strike' }],
            },
        };

        expect(evidenceFromSharedProfile(parsed)).toEqual({
            weaponHrid: '/items/blooming_trident',
            kit: [{ hrid: '/abilities/entangle' }, { hrid: '/abilities/water_strike' }],
        });
    });

    test('a main-hand weapon is read the same way as a two-hand one', () => {
        const parsed = {
            profile: {
                wearableItemMap: {
                    1: { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/crossbow' },
                    2: { itemLocationHrid: '/item_locations/off_hand', itemHrid: '/items/shield' },
                },
            },
        };

        expect(evidenceFromSharedProfile(parsed)).toEqual({ weaponHrid: '/items/crossbow', kit: null });
    });

    test('a profile with neither a weapon slot nor abilities is nothing', () => {
        expect(evidenceFromSharedProfile({ profile: { wearableItemMap: {}, equippedAbilities: [] } })).toBeNull();
        expect(evidenceFromSharedProfile({})).toBeNull();
        expect(evidenceFromSharedProfile(null)).toBeNull();
    });

    test('an ability slot with no hrid is skipped rather than kept as a blank', () => {
        const parsed = { profile: { equippedAbilities: [{ abilityHrid: '' }, { abilityHrid: '/abilities/heal' }] } };
        expect(evidenceFromSharedProfile(parsed)).toEqual({ weaponHrid: null, kit: [{ hrid: '/abilities/heal' }] });
    });
});

describe('noteSharedClassEvidence and sharedClassEvidenceFor', () => {
    test('a name with no evidence yet answers null', () => {
        expect(sharedClassEvidenceFor('Nobody')).toBeNull();
    });

    test('what is noted is what comes back, keyed case-insensitively', () => {
        noteSharedClassEvidence('Estevao', { weaponHrid: '/items/crossbow', kit: [{ hrid: '/abilities/pierce' }] });

        expect(sharedClassEvidenceFor('Estevao')).toEqual({
            weaponHrid: '/items/crossbow',
            kit: [{ hrid: '/abilities/pierce' }],
        });
        expect(sharedClassEvidenceFor('ESTEVAO')).toEqual(sharedClassEvidenceFor('Estevao'));
        expect(sharedClassEvidenceFor(' estevao ')).toEqual(sharedClassEvidenceFor('Estevao'));
    });

    test('noting again for the same name overwrites rather than merges', () => {
        noteSharedClassEvidence('Estevao', { weaponHrid: '/items/crossbow', kit: null });
        noteSharedClassEvidence('Estevao', { weaponHrid: null, kit: [{ hrid: '/abilities/entangle' }] });

        expect(sharedClassEvidenceFor('Estevao')).toEqual({ weaponHrid: null, kit: [{ hrid: '/abilities/entangle' }] });
    });

    test('a falsy or empty evidence is a no-op', () => {
        noteSharedClassEvidence('Nobody', null);
        noteSharedClassEvidence('Nobody', { weaponHrid: null, kit: null });
        expect(sharedClassEvidenceFor('Nobody')).toBeNull();
    });

    test('a name that is blank after trimming is never cached', () => {
        noteSharedClassEvidence('   ', { weaponHrid: '/items/sword', kit: null });
        expect(sharedClassEvidenceFor('   ')).toBeNull();
    });

    test('persists to storage, not only in memory', async () => {
        noteSharedClassEvidence('Estevao', { weaponHrid: '/items/crossbow', kit: null });
        await vi.waitFor(() => expect(stored.get('sharedProfileClassEvidence')).toBeDefined());

        expect(stored.get('sharedProfileClassEvidence').estevao).toMatchObject({ weaponHrid: '/items/crossbow' });
    });

    test('bounded: the oldest name is dropped once the cap is passed', () => {
        // A cap of 300 would make a real test slow for no extra proof — the
        // production limit only needs proving that eviction happens and that
        // it evicts the least recently noted entry, which any small cap shows
        const at = vi.spyOn(Date, 'now');
        let now = 0;
        at.mockImplementation(() => now++);

        for (let i = 0; i < 301; i++) {
            noteSharedClassEvidence(`Player${i}`, { weaponHrid: `/items/weapon_${i}`, kit: null });
        }

        expect(sharedClassEvidenceFor('Player0')).toBeNull();
        expect(sharedClassEvidenceFor('Player300')).not.toBeNull();

        at.mockRestore();
    });
});
