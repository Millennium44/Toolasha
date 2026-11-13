/** @vitest-environment happy-dom */

/**
 * Simulated scrolls on the skill page's action tiles: which scrolls a tile applies, that the arming is a
 * synchronous span that restores whatever was armed (so no other reader ever sees it), that a scroll
 * already active in the game is not counted twice, and what makes the tiles redraw.
 *
 * Runs against the real data manager (its simulation methods are what the action panel arms) with the
 * real scroll simulator; only the game's buff table, the settings and the loadout store are faked.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: {},
    listeners: {},
    snapshotListeners: [],
    // Game shapes: keyed by personal buff hrid, the buff beside the action-type map
    personalBuffTypeDetailMap: {
        '/personal_buff_types/efficiency': {
            usableInActionTypeMap: { '/action_types/milking': true, '/action_types/brewing': true },
            buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
        },
        '/personal_buff_types/gathering': {
            usableInActionTypeMap: { '/action_types/milking': true },
            buff: { typeHrid: '/buff_types/gathering', flatBoost: 0.18 },
        },
        '/personal_buff_types/gourmet': {
            usableInActionTypeMap: { '/action_types/brewing': true },
            buff: { typeHrid: '/buff_types/gourmet', flatBoost: 0.1 },
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        COLOR_BORDER: '#444',
        getSetting: (key) => game.settings[key],
        onSettingChange: (key, cb) => {
            (game.listeners[key] ||= new Set()).add(cb);
            return () => game.listeners[key].delete(cb);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async (_k, _s, d) => d, setJSON: async () => {} } }));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getSnapshotInfoForSkill: () => null,
        onUpdate: (fn) => game.snapshotListeners.push(fn),
        offUpdate: (fn) => {
            game.snapshotListeners = game.snapshotListeners.filter((l) => l !== fn);
        },
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    scrollSimulator: () => null,
    loadoutSnapshot: () => null,
    scrollPlannerInstance: () => null,
}));

const dataManager = (await import('../../core/data-manager.js')).default;
const scrollSimulator = (await import('../combat/scroll-simulator.js')).default;
const tiles = await import('./tile-scrolls.js');
const { SELECTION_CHANGED_EVENT } = await import('../../utils/scroll-buff-values.js');

const MILKING = '/action_types/milking';
const BREWING = '/action_types/brewing';
const EFFICIENCY = '/buff_types/efficiency';
const GATHERING = '/buff_types/gathering';
const GOURMET = '/buff_types/gourmet';

/** What a calculator sees: the same read the real efficiency code makes */
const efficiencyNow = (type = MILKING) => dataManager.getPersonalBuffFlatBoost(type, EFFICIENCY);

function choose(...hrids) {
    scrollSimulator.scrollsByLoadout = { __default__: new Set(hrids) };
}

beforeEach(() => {
    game.settings = { simulateScrollEffects: true, [tiles.TILE_SCROLLS_SETTING]: true };
    game.listeners = {};
    game.snapshotListeners = [];
    dataManager.scrollSimulationByActionType = {};
    dataManager.personalActionTypeBuffsMap = {};
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({
        personalBuffTypeDetailMap: game.personalBuffTypeDetailMap,
    });
    choose();
});

describe('what the tiles apply', () => {
    test('the chosen scrolls, while both settings are on', () => {
        choose(EFFICIENCY);
        const { result, simulated } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBeCloseTo(0.14);
        expect(simulated).toEqual(['Efficiency']);
    });

    test('nothing is applied after the call returns (the span is synchronous)', () => {
        choose(EFFICIENCY);
        tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(efficiencyNow()).toBe(0);
        expect(dataManager.scrollSimulationByActionType[MILKING]).toBeUndefined();
    });

    test('the tile setting off: real figures, nothing marked', () => {
        choose(EFFICIENCY);
        game.settings[tiles.TILE_SCROLLS_SETTING] = false;
        const { result, simulated } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBe(0);
        expect(simulated).toEqual([]);
    });

    test('the simulation switch off: real figures, nothing marked', () => {
        choose(EFFICIENCY);
        game.settings.simulateScrollEffects = false;
        const { result, simulated } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBe(0);
        expect(simulated).toEqual([]);
    });

    test('no scrolls chosen: real figures, nothing marked', () => {
        const { result, simulated } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBe(0);
        expect(simulated).toEqual([]);
    });

    test('a scroll the skill cannot use is not applied or named, even when chosen in the shared defaults', () => {
        choose(EFFICIENCY, GOURMET);
        const { simulated } = tiles.runWithTileScrolls(MILKING, () =>
            dataManager.getPersonalBuffFlatBoost(MILKING, GOURMET)
        );
        expect(simulated).toEqual(['Efficiency']);
        expect([...tiles.getChosenScrolls(MILKING)]).toEqual([EFFICIENCY]);
        expect([...tiles.getChosenScrolls(BREWING)].sort()).toEqual([EFFICIENCY, GOURMET].sort());
    });

    test('an action type outside the simulation applies nothing', () => {
        choose(EFFICIENCY);
        expect(tiles.getChosenScrolls('/action_types/combat').size).toBe(0);
    });

    test('a scroll already active in the game is neither added twice nor marked', () => {
        choose(EFFICIENCY);
        dataManager.personalActionTypeBuffsMap = { [MILKING]: [{ typeHrid: EFFICIENCY, flatBoost: 0.14 }] };
        const { result, simulated } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBeCloseTo(0.14); // max(active, simulated), not 0.28
        expect(simulated).toEqual([]);
    });

    test('only the chosen scroll is named when another is already active', () => {
        choose(EFFICIENCY, GATHERING);
        dataManager.personalActionTypeBuffsMap = { [MILKING]: [{ typeHrid: EFFICIENCY, flatBoost: 0.14 }] };
        const { simulated } = tiles.runWithTileScrolls(MILKING, () => 0);
        expect(simulated).toEqual(['Gathering']);
    });
});

describe('a simulation armed by someone else', () => {
    test('is hidden from the real figures and restored after', () => {
        const panelSet = new Set([EFFICIENCY]);
        dataManager.setScrollSimulation(MILKING, panelSet);
        expect(tiles.runWithoutScrolls(MILKING, efficiencyNow)).toBe(0);
        expect(dataManager.scrollSimulationByActionType[MILKING]).toBe(panelSet);
    });

    test('is hidden from a tile with nothing chosen, and restored after', () => {
        const panelSet = new Set([EFFICIENCY]);
        dataManager.setScrollSimulation(MILKING, panelSet);
        const { result } = tiles.runWithTileScrolls(MILKING, efficiencyNow);
        expect(result).toBe(0);
        expect(dataManager.scrollSimulationByActionType[MILKING]).toBe(panelSet);
    });

    test('is restored when the calculation throws', () => {
        choose(EFFICIENCY);
        const panelSet = new Set([GATHERING]);
        dataManager.setScrollSimulation(MILKING, panelSet);
        expect(() =>
            tiles.runWithTileScrolls(MILKING, () => {
                throw new Error('boom');
            })
        ).toThrow('boom');
        expect(dataManager.scrollSimulationByActionType[MILKING]).toBe(panelSet);
    });
});

describe('the marks', () => {
    test('a simulated tile names its scrolls on hover; clearing removes every trace', () => {
        const box = document.createElement('div');
        tiles.paintTileScrollMark(box, ['Efficiency', 'Gathering']);
        expect(box.title).toContain('Efficiency, Gathering scrolls');
        expect(box.title).toContain('not active in the game');
        expect(box.dataset.mwiSimulatedScrolls).toBe('Efficiency,Gathering');
        tiles.paintTileScrollMark(box, []);
        expect(box.title).toBe('');
        expect(box.dataset.mwiSimulatedScrolls).toBeUndefined();
    });

    test('a tile that never was simulated is left untouched', () => {
        const box = document.createElement('div');
        box.title = 'something else';
        tiles.paintTileScrollMark(box, []);
        expect(box.title).toBe('something else');
    });

    test('the figure marker is empty without scrolls', () => {
        expect(tiles.tileScrollMarker([])).toBe('');
        expect(tiles.tileScrollMarker(['Efficiency'])).toBe(' 📜');
    });
});

describe('what makes the tiles redraw', () => {
    test('a changed selection, the tile setting, the simulation switch and a loadout change', () => {
        const redraw = vi.fn();
        const stop = tiles.onTileScrollsChanged(redraw);
        document.dispatchEvent(new CustomEvent(SELECTION_CHANGED_EVENT, { detail: { key: '__default__' } }));
        game.listeners[tiles.TILE_SCROLLS_SETTING].forEach((cb) => cb(false));
        game.listeners.simulateScrollEffects.forEach((cb) => cb(false));
        game.snapshotListeners.forEach((cb) => cb());
        expect(redraw).toHaveBeenCalledTimes(4);
        stop();
    });

    test('saving a selection through the simulator is announced', async () => {
        scrollSimulator.owner = dataManager.getCurrentCharacterId() || 'default';
        const redraw = vi.fn();
        const stop = tiles.onTileScrollsChanged(redraw);
        await scrollSimulator.saveScrollsForLoadout(null, [EFFICIENCY]);
        expect(redraw).toHaveBeenCalled();
        stop();
    });

    test('the saved selections finishing their load is announced', async () => {
        scrollSimulator.initialized = false;
        scrollSimulator.owner = null;
        scrollSimulator._registerSwitchHandler = () => {};
        const redraw = vi.fn();
        const stop = tiles.onTileScrollsChanged(redraw);
        await scrollSimulator.initialize();
        expect(redraw).toHaveBeenCalledTimes(1);
        stop();
    });

    test('nothing is called after the undo', () => {
        const redraw = vi.fn();
        tiles.onTileScrollsChanged(redraw)();
        document.dispatchEvent(new CustomEvent(SELECTION_CHANGED_EVENT));
        game.listeners[tiles.TILE_SCROLLS_SETTING]?.forEach((cb) => cb(false));
        game.snapshotListeners.forEach((cb) => cb());
        expect(redraw).not.toHaveBeenCalled();
    });
});
