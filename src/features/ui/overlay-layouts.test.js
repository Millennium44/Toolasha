/**
 * Named overlay layouts.
 *
 * The map operations are where the mistakes live — an overwrite that appends
 * instead of replacing, a delete that silently misses because the name had a
 * trailing space — so they are tested directly, and the storage round trip is
 * tested against a map held in memory rather than against IndexedDB.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { gridOrder } from '../../utils/overlay-layout.js';

const store = vi.hoisted(() => ({ data: new Map(), fail: false, unavailable: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (store.fail) throw new Error('storage is down');
            if (store.unavailable) return null;
            return store.data.has(key)
                ? { found: true, value: JSON.parse(JSON.stringify(store.data.get(key))) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            if (store.fail) throw new Error('storage is down');
            if (store.unavailable) return false;
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    normalizeName,
    layoutNames,
    putLayout,
    removeLayout,
    loadLayouts,
    saveLayout,
    deleteLayout,
    getLayout,
    flushLayoutWrites,
    LAYOUTS_KEY,
    MAX_NAME_LENGTH,
    ACTIVITY,
    PRESET_LAYOUTS,
    PRESET_SUFFIX,
    presetNames,
    presetFile,
    isPreset,
    offeredLayouts,
    layoutForActivity,
    freshSwitchState,
    decideAutoSwitch,
    pauseForManualChoice,
    SWITCH_STABILITY_MS,
} = await import('./overlay-layouts.js');

/**
 * A stand-in for what `toOPanelConfig` produces.
 * @param {string[]} order - Row keys
 * @returns {Object}
 */
function file(order) {
    return { config: { order }, toolasha: { version: 1, settings: { order } } };
}

beforeEach(async () => {
    store.data.clear();
    store.fail = false;
    store.unavailable = false;
    vi.restoreAllMocks();
    // The record keeps the map it last read; start each test from an empty,
    // read-back one
    await loadLayouts();
});

describe('names', () => {
    test('trimmed, collapsed and capped', () => {
        expect(normalizeName('  Dungeon  ')).toBe('Dungeon');
        expect(normalizeName('Market\t \n runs')).toBe('Market runs');
        expect(normalizeName('x'.repeat(MAX_NAME_LENGTH + 20))).toHaveLength(MAX_NAME_LENGTH);
    });

    test('nothing usable is not a name', () => {
        expect(normalizeName('   ')).toBe('');
        expect(normalizeName(null)).toBe('');
        expect(normalizeName(42)).toBe('');
    });
});

describe('the map', () => {
    test('adding does not touch the map handed in', () => {
        const before = {};
        const after = putLayout(before, 'Dungeon', file(['dps']));

        expect(before).toEqual({});
        expect(layoutNames(after)).toEqual(['Dungeon']);
    });

    test('the same name replaces rather than appends', () => {
        let map = putLayout({}, 'Dungeon', file(['dps']));
        map = putLayout(map, 'Dungeon', file(['coins', 'luck']));

        expect(layoutNames(map)).toEqual(['Dungeon']);
        expect(map.Dungeon.file.config.order).toEqual(['coins', 'luck']);
    });

    test('a name with stray whitespace lands on the same entry', () => {
        let map = putLayout({}, 'Dungeon', file(['dps']));
        map = putLayout(map, '  Dungeon ', file(['luck']));

        expect(layoutNames(map)).toEqual(['Dungeon']);
        expect(removeLayout(map, ' Dungeon')).toEqual({});
    });

    test('an unusable name saves nothing', () => {
        expect(putLayout({}, '   ', file(['dps']))).toEqual({});
        expect(putLayout({}, 'Dungeon', null)).toEqual({});
    });

    test('deleting a name that is not there changes nothing', () => {
        const map = putLayout({}, 'Dungeon', file(['dps']));
        expect(layoutNames(removeLayout(map, 'Market'))).toEqual(['Dungeon']);
    });

    test('names come back sorted', () => {
        let map = putLayout({}, 'Market', file([]));
        map = putLayout(map, 'Dungeon', file([]));
        map = putLayout(map, 'alchemy', file([]));

        expect(layoutNames(map)).toEqual(['alchemy', 'Dungeon', 'Market']);
        expect(layoutNames(null)).toEqual([]);
    });
});

describe('the round trip', () => {
    test('save, list, read back, delete', async () => {
        expect(await loadLayouts()).toEqual({});

        await saveLayout('Dungeon', file(['dps', 'luck']));
        await saveLayout('Market', file(['coins']));

        expect(layoutNames(await loadLayouts())).toEqual(['Dungeon', 'Market']);
        expect((await getLayout('Dungeon')).config.order).toEqual(['dps', 'luck']);
        // Everything lives under the one key rather than a key per layout
        expect([...store.data.keys()]).toEqual([LAYOUTS_KEY]);

        await deleteLayout('Dungeon');
        expect(layoutNames(await loadLayouts())).toEqual(['Market']);
        expect(await getLayout('Dungeon')).toBeNull();
    });

    test('switching between two saved layouts gets each one back whole', async () => {
        await saveLayout('Dungeon', file(['dps', 'luck']));
        await saveLayout('Market', file(['coins', 'marketListings']));

        expect((await getLayout('Market')).toolasha.settings.order).toEqual(['coins', 'marketListings']);
        expect((await getLayout('Dungeon')).toolasha.settings.order).toEqual(['dps', 'luck']);
    });

    test('saving records when it happened', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
        const map = await saveLayout('Dungeon', file([]));
        expect(map.Dungeon.savedAt).toBe(1_700_000_000_000);
    });

    test('storage falling over reads as no layouts rather than as an error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        store.fail = true;

        await expect(loadLayouts()).resolves.toEqual({});
        await expect(saveLayout('Dungeon', file([]))).resolves.toEqual({});
        await expect(getLayout('Dungeon')).resolves.toBeNull();
    });

    test('a read that cannot be made keeps the map in hand rather than reading as empty', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        await saveLayout('Dungeon', file(['dps']));
        await saveLayout('Market', file(['coins']));
        store.unavailable = true;
        expect(layoutNames(await loadLayouts())).toEqual(['Dungeon', 'Market']);
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        store.data.set(LAYOUTS_KEY, { Dungeon: { savedAt: 1, file: file(['dps']) } });
        store.unavailable = true;

        // The map reads empty (nothing was ever read), so the save is made
        // against nothing — and goes nowhere
        const map = await saveLayout('Market', file(['coins']));
        expect(layoutNames(map)).toEqual([]);
        store.unavailable = false;
        expect(layoutNames(await loadLayouts())).toEqual(['Dungeon']);
    });

    test('a save before the map was read back loses no stored layout', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        store.data.set(LAYOUTS_KEY, { Dungeon: { savedAt: 1, file: file(['dps']) } });
        store.unavailable = true;
        await loadLayouts();
        store.unavailable = false;

        const map = await saveLayout('Market', file(['coins']));
        await flushLayoutWrites();
        expect(layoutNames(map)).toEqual(['Dungeon', 'Market']);
        expect(layoutNames(store.data.get(LAYOUTS_KEY))).toEqual(['Dungeon', 'Market']);
    });

    test('after a readable load a delete sticks', async () => {
        store.data.set(LAYOUTS_KEY, {
            Dungeon: { savedAt: 1, file: file(['dps']) },
            Market: { savedAt: 2, file: file(['coins']) },
        });
        await deleteLayout('Dungeon');
        expect(layoutNames(store.data.get(LAYOUTS_KEY))).toEqual(['Market']);
    });

    test('once storage is back, the next save lands', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        store.unavailable = true;
        await saveLayout('Dungeon', file(['dps']));
        expect(store.data.has(LAYOUTS_KEY)).toBe(false);

        store.unavailable = false;
        await saveLayout('Dungeon', file(['dps']));
        expect(layoutNames(store.data.get(LAYOUTS_KEY))).toEqual(['Dungeon']);
    });
});

describe('presets', () => {
    test('all five ship, each with rows and an activity', () => {
        expect(presetNames()).toEqual(['Combat', 'Skilling', 'Labyrinth', 'Market', 'Default']);

        for (const name of presetNames()) {
            expect(PRESET_LAYOUTS[name].rows.length).toBeGreaterThan(0);
            expect(Object.values(ACTIVITY)).toContain(PRESET_LAYOUTS[name].activity);
        }
    });

    test('a preset names each of its rows once, in the order its grid reads', () => {
        for (const name of presetNames()) {
            const { rows, grid } = PRESET_LAYOUTS[name];
            expect(new Set(rows).size).toBe(rows.length);
            expect(rows).toEqual(gridOrder(grid));
        }
    });

    test('every line of every preset is full, so no line leaves a sliver', () => {
        // The complaint, as a rule: a line with one tile in a two-column grid is
        // the orphan half-row the screenshot was full of
        for (const name of presetNames()) {
            const { columns, grid } = PRESET_LAYOUTS[name];
            for (const line of grid) {
                const cells = Array.isArray(line) ? line : line.cells;
                expect(cells).toHaveLength(columns);
                expect(cells.every((cell) => typeof cell === 'string')).toBe(true);
            }
        }
    });

    test('a preset arrives placed, aligned and inside the canvas', () => {
        const rows = PRESET_LAYOUTS.Combat.rows.map((key) => ({ key, defaultSize: { width: 200, height: 30 } }));
        const { positions, sizes } = presetFile('Combat', { width: 456, rows }).toolasha.settings;

        const tiles = PRESET_LAYOUTS.Combat.rows.map((key) => ({ key, ...positions[key], ...sizes[key] }));
        for (const tile of tiles) {
            expect(Number.isFinite(tile.x)).toBe(true);
            expect(tile.x % 10).toBe(0);
            expect(tile.x + tile.width).toBeLessThanOrEqual(456);
        }
        // Two columns, and every tile starts at one of them
        expect(new Set(tiles.map((tile) => tile.x)).size).toBe(2);

        for (let i = 0; i < tiles.length; i += 1) {
            for (let j = i + 1; j < tiles.length; j += 1) {
                const [a, b] = [tiles[i], tiles[j]];
                const apart =
                    a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
                expect(apart).toBe(true);
            }
        }
    });

    test('every preset claims a different activity, so none of them is unreachable', () => {
        const activities = presetNames().map((name) => PRESET_LAYOUTS[name].activity);
        expect(new Set(activities).size).toBe(activities.length);
    });

    test('a preset is a layout file of exactly the shape a saved one has', () => {
        const built = presetFile('Combat');

        expect(built.toolasha.settings.order).toEqual(PRESET_LAYOUTS.Combat.rows);
        // Placed, but placed *here* rather than shipped as coordinates — see the
        // canvas-width tests below
        expect(Object.keys(built.toolasha.settings.positions).length).toBeGreaterThan(0);
        expect(built.toolasha.settings.locked).toBe(true);
    });

    test('a preset switches its own rows on, and says nothing about the rest', () => {
        const visible = presetFile('Market').toolasha.settings.visible;

        for (const key of PRESET_LAYOUTS.Market.rows) expect(visible[key]).toBe(true);
        expect(visible.dps).toBeUndefined();
    });

    test('the arrangement follows the canvas it is built against', () => {
        const rows = PRESET_LAYOUTS.Market.rows.map((key) => ({ key, defaultSize: { width: 180, height: 30 } }));
        const wide = presetFile('Market', { width: 456, rows }).toolasha.settings;
        const narrow = presetFile('Market', { width: 300, rows }).toolasha.settings;

        // Wide enough for the design, so the two columns it was designed as
        expect(new Set(Object.values(wide.positions).map((spot) => spot.x)).size).toBe(2);
        // Too narrow to squeeze it into two, so one column of whole tiles rather
        // than two columns of ellipsis
        expect(new Set(Object.values(narrow.positions).map((spot) => spot.x))).toEqual(new Set([0]));
        for (const size of Object.values(narrow.sizes)) expect(size.width).toBeLessThanOrEqual(300);
    });

    test('a row no feature has registered is left out rather than left as a hole', () => {
        const rows = [{ key: 'netWorth', defaultSize: { width: 180, height: 30 } }];
        const built = presetFile('Market', { width: 456, rows }).toolasha.settings;

        // Still switched on, so it appears if its feature comes back
        expect(built.visible.watchlist).toBe(true);
        expect(built.positions.watchlist).toBeUndefined();
        expect(built.positions.netWorth).toEqual({ x: 0, y: 0 });
    });

    test('names are recognised, and anything else is not', () => {
        expect(isPreset('Combat')).toBe(true);
        expect(isPreset('  Combat  ')).toBe(true);
        expect(isPreset('Dungeon')).toBe(false);
        expect(presetFile('Dungeon')).toBeNull();
    });

    test('a preset can be applied without ever having been saved', async () => {
        await expect(getLayout('Skilling')).resolves.not.toBeNull();
        expect(await loadLayouts()).toEqual({});
    });

    test('presets cannot be deleted — deleting one leaves it exactly where it was', async () => {
        await deleteLayout('Combat');

        expect(isPreset('Combat')).toBe(true);
        expect(await getLayout('Combat')).not.toBeNull();
    });

    test('saving under a preset name shadows it rather than failing', async () => {
        await saveLayout('Combat', file(['coins']));

        // The name now resolves to the copy
        expect((await getLayout('Combat')).toolasha.settings.order).toEqual(['coins']);
        // And the dropdown offers it once, as a saved layout
        const offered = offeredLayouts(await loadLayouts());
        expect(offered.filter((entry) => entry.name === 'Combat')).toEqual([
            { name: 'Combat', preset: false, label: 'Combat' },
        ]);
    });

    test('the dropdown lists what is saved first, then the presets, marked', () => {
        const offered = offeredLayouts({ Dungeon: { file: file([]) } });

        expect(offered[0]).toEqual({ name: 'Dungeon', preset: false, label: 'Dungeon' });
        expect(offered[1]).toEqual({ name: 'Combat', preset: true, label: `Combat${PRESET_SUFFIX}` });
        expect(offered).toHaveLength(1 + presetNames().length);
    });
});

describe('which layout an activity wants', () => {
    test('the preset for it, when nothing has been said', () => {
        expect(layoutForActivity(ACTIVITY.COMBAT, {}, [])).toBe('Combat');
        expect(layoutForActivity(ACTIVITY.LABYRINTH, {}, [])).toBe('Labyrinth');
    });

    test('a layout the player mapped to it beats the preset', () => {
        expect(layoutForActivity(ACTIVITY.COMBAT, { Dungeon: ACTIVITY.COMBAT }, ['Dungeon'])).toBe('Dungeon');
    });

    test('a mapping naming a layout that no longer exists is ignored', () => {
        expect(layoutForActivity(ACTIVITY.COMBAT, { Gone: ACTIVITY.COMBAT }, [])).toBe('Combat');
    });

    test('nothing is wanted for no activity', () => {
        expect(layoutForActivity(null, {}, [])).toBeNull();
        expect(layoutForActivity(ACTIVITY.NONE, { Dungeon: ACTIVITY.NONE }, ['Dungeon'])).toBeNull();
    });
});

describe('deciding whether to switch', () => {
    const at = 1_700_000_000_000;

    /**
     * Run the decision with everything defaulted to "yes, switch".
     * @param {Object} input - Overrides
     * @returns {Object} What `decideAutoSwitch` returned
     */
    function decide(input) {
        return decideAutoSwitch({ enabled: true, locked: true, mappings: {}, saved: [], ...input });
    }

    test('an activity that has just appeared is not acted on yet', () => {
        const first = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at });
        expect(first.apply).toBeNull();

        const tooSoon = decide({ state: first.state, activity: ACTIVITY.COMBAT, now: at + 9_000 });
        expect(tooSoon.apply).toBeNull();
    });

    test('an activity that holds long enough brings up its layout', () => {
        const first = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at });
        const settled = decide({ state: first.state, activity: ACTIVITY.COMBAT, now: at + SWITCH_STABILITY_MS });

        expect(settled.apply).toBe('Combat');
    });

    test('it only switches once — the same activity does not reapply every second', () => {
        let state = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at }).state;
        const applied = decide({ state, activity: ACTIVITY.COMBAT, now: at + SWITCH_STABILITY_MS });
        state = applied.state;

        expect(applied.apply).toBe('Combat');
        expect(decide({ state, activity: ACTIVITY.COMBAT, now: at + 60_000 }).apply).toBeNull();
    });

    test('a brief flick to something else does not switch, and does not restart the wait for the real one', () => {
        let state = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at }).state;
        state = decide({ state, activity: ACTIVITY.COMBAT, now: at + SWITCH_STABILITY_MS }).state;

        // A second of nothing between two combat batches
        const blip = decide({ state, activity: ACTIVITY.SKILLING, now: at + 20_000 });
        expect(blip.apply).toBeNull();

        const back = decide({ state: blip.state, activity: ACTIVITY.SKILLING, now: at + 25_000 });
        expect(back.apply).toBeNull();
    });

    test('a change that holds does switch', () => {
        let state = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at }).state;
        state = decide({ state, activity: ACTIVITY.COMBAT, now: at + SWITCH_STABILITY_MS }).state;

        state = decide({ state, activity: ACTIVITY.SKILLING, now: at + 20_000 }).state;
        const settled = decide({ state, activity: ACTIVITY.SKILLING, now: at + 20_000 + SWITCH_STABILITY_MS });

        expect(settled.apply).toBe('Skilling');
    });

    test('switched off, nothing happens however long anything holds', () => {
        let state = freshSwitchState();
        state = decide({ state, activity: ACTIVITY.COMBAT, now: at, enabled: false }).state;

        expect(decide({ state, activity: ACTIVITY.COMBAT, now: at + 60_000, enabled: false }).apply).toBeNull();
    });

    test('an unlocked layout is never switched out from under whoever is arranging it', () => {
        let state = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at, locked: false }).state;
        const held = decide({ state, activity: ACTIVITY.COMBAT, now: at + 60_000, locked: false });

        expect(held.apply).toBeNull();

        // And the wait is not restarted by the lock going back on: the timer is
        // about the world, not about permission
        state = held.state;
        expect(decide({ state, activity: ACTIVITY.COMBAT, now: at + 61_000 }).apply).toBe('Combat');
    });

    test('an unknown activity switches nothing', () => {
        const state = decide({ state: freshSwitchState(), activity: null, now: at }).state;
        expect(decide({ state, activity: null, now: at + 60_000 }).apply).toBeNull();
    });

    test('picking a layout by hand holds off the next switch', () => {
        let state = decide({ state: freshSwitchState(), activity: ACTIVITY.COMBAT, now: at }).state;
        state = pauseForManualChoice(state, ACTIVITY.COMBAT);

        expect(decide({ state, activity: ACTIVITY.COMBAT, now: at + 60_000 }).apply).toBeNull();
    });

    test('the hold lifts at the next change of activity, not on a timer', () => {
        let state = pauseForManualChoice(freshSwitchState(), ACTIVITY.COMBAT);

        state = decide({ state, activity: ACTIVITY.SKILLING, now: at }).state;
        expect(state.paused).toBe(false);

        const settled = decide({ state, activity: ACTIVITY.SKILLING, now: at + SWITCH_STABILITY_MS });
        expect(settled.apply).toBe('Skilling');
    });

    test('a hand-picked layout during an unrecognised activity still holds off', () => {
        let state = pauseForManualChoice(freshSwitchState(), null);

        state = decide({ state, activity: null, now: at }).state;
        expect(state.paused).toBe(true);

        state = decide({ state, activity: ACTIVITY.COMBAT, now: at + 1000 }).state;
        expect(state.paused).toBe(false);
    });

    test('a mapped layout of the player’s own is what gets applied', () => {
        const state = decide({
            state: freshSwitchState(),
            activity: ACTIVITY.COMBAT,
            now: at,
            mappings: { Dungeon: ACTIVITY.COMBAT },
            saved: ['Dungeon'],
        }).state;

        const settled = decide({
            state,
            activity: ACTIVITY.COMBAT,
            now: at + SWITCH_STABILITY_MS,
            mappings: { Dungeon: ACTIVITY.COMBAT },
            saved: ['Dungeon'],
        });
        expect(settled.apply).toBe('Dungeon');
    });
});
