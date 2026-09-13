/**
 * The class override is a layer: it never changes the inference, only what is drawn.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {}, sets: [] }));

vi.mock('../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => store.data[key] ?? fallback,
        set: async (key, value, storeName) => {
            store.sets.push({ key, storeName });
            store.data[key] = value;
        },
    },
}));

const { applyClassOverride, classOverrideFor, setClassOverride, loadClassOverrides, _resetClassOverrides } =
    await import('./class-override.js');
const { CLASS_BUCKETS } = await import('./class-inference.js');

const inferredMelee = {
    ...CLASS_BUCKETS.melee,
    basis: 'the styles cast in this trial',
    evidence: ['/abilities/cleave'],
    style: 'slash',
    curse: false,
    weaponHrid: '/items/regal_sword',
};

beforeEach(() => {
    store.data = {};
    store.sets = [];
    _resetClassOverrides();
});

describe('applyClassOverride', () => {
    test('with nothing set, the inferred verdict passes through untouched', () => {
        expect(applyClassOverride('Abe', inferredMelee)).toBe(inferredMelee);
        expect(applyClassOverride('Abe', null)).toBeNull();
    });

    test('a set class replaces the bucket, says so, and keeps the evidence', async () => {
        await setClassOverride('Abe', 'tank');
        const verdict = applyClassOverride('abe', inferredMelee);
        expect(verdict).toMatchObject({ key: 'tank', short: 'TANK', manual: true, basis: 'set by you' });
        expect(verdict.evidence).toEqual(['/abilities/cleave']);
        // A different bucket's drawing hints would draw the wrong weapon
        expect(verdict.style).toBe('');
        expect(verdict.weaponHrid).toBeNull();
        expect(verdict.inferred).toBe(inferredMelee);
    });

    test('confirming the inferred class keeps how it is drawn', async () => {
        await setClassOverride('Abe', 'melee');
        expect(applyClassOverride('Abe', inferredMelee)).toMatchObject({
            key: 'melee',
            manual: true,
            style: 'slash',
            weaponHrid: '/items/regal_sword',
        });
    });

    test('a class can be forced on a player the inference had nothing for', async () => {
        await setClassOverride('Bo', 'healer');
        expect(applyClassOverride('Bo', null)).toMatchObject({ key: 'healer', manual: true, inferred: null });
    });

    test('clearing it hands the player back to the inference', async () => {
        await setClassOverride('Abe', 'tank');
        await setClassOverride('Abe', null);
        expect(classOverrideFor('Abe')).toBeNull();
        expect(applyClassOverride('Abe', inferredMelee)).toBe(inferredMelee);
    });
});

describe('storage', () => {
    test('only real buckets are stored or read back', async () => {
        await setClassOverride('Abe', 'wizard');
        expect(store.sets).toHaveLength(0);

        store.data.playerClassOverrides = { bo: { value: 'nonsense', at: 1 }, cy: { value: 'ranged', at: 1 } };
        _resetClassOverrides();
        await loadClassOverrides();
        expect(classOverrideFor('Bo')).toBeNull();
        expect(classOverrideFor('Cy')).toBe('ranged');
    });

    test('it is kept account-wide in the settings store', async () => {
        await setClassOverride('Abe', 'ranged');
        expect(store.sets.at(-1)).toEqual({ key: 'playerClassOverrides', storeName: 'settings' });
    });
});
