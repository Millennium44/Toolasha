/** @vitest-environment happy-dom */

/**
 * simulateScrollEffects now ships on for new players. That is only safe because nothing is
 * selected until a chip is pressed: with the switch on and no selection, every figure that reads
 * the simulation must equal the figure with the switch off. These tests pin each link of that.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    simulateScrollEffects: true,
    saved: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => (key === 'simulateScrollEffects' ? game.simulateScrollEffects : false) },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('./loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));

const scrollSimulator = (await import('./scroll-simulator.js')).default;
const { default: dataManager } = await import('../../core/data-manager.js');

const FORAGING = '/action_types/foraging';
const BREWING = '/action_types/brewing';
const SCROLL_BUFFS = [
    '/buff_types/efficiency',
    '/buff_types/gathering',
    '/buff_types/wisdom',
    '/buff_types/action_speed',
    '/buff_types/rare_find',
    '/buff_types/processing',
    '/buff_types/gourmet',
];

async function freshSimulator() {
    scrollSimulator.scrollsByLoadout = {};
    scrollSimulator.initialized = false;
    scrollSimulator.switchHandler = null;
    scrollSimulator.owner = null;
    await scrollSimulator.initialize();
}

describe('simulation on, nothing selected', () => {
    beforeEach(async () => {
        game.simulateScrollEffects = true;
        game.saved = {};
        dataManager.scrollSimulationByActionType = {};
        await freshSimulator();
    });

    test('a new player has no selection: the resolved set is empty, for every action type', () => {
        for (const type of [FORAGING, BREWING, '/action_types/tailoring']) {
            expect(scrollSimulator.getScrollSetForActionType(type)).toEqual(new Set());
            expect(scrollSimulator.resolveSelection(type).set).toEqual(new Set());
        }
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set());
    });

    test('the set is the same as with the switch off', () => {
        const on = scrollSimulator.getScrollSetForActionType(BREWING);
        game.simulateScrollEffects = false;
        const off = scrollSimulator.getScrollSetForActionType(BREWING);

        expect(on).toEqual(off);
    });

    test('arming that empty set arms nothing, so no buff value and no simulated sprite differs', () => {
        dataManager.setScrollSimulation(BREWING, scrollSimulator.getScrollSetForActionType(BREWING));

        expect(dataManager.scrollSimulationByActionType[BREWING]).toBeUndefined();
        for (const buff of SCROLL_BUFFS) {
            const armed = dataManager.getPersonalBuffFlatBoost(BREWING, buff);
            const armedSprite = dataManager.isBuffBeingSimulated(BREWING, buff);
            dataManager.clearScrollSimulation(BREWING);
            expect(dataManager.getPersonalBuffFlatBoost(BREWING, buff)).toBe(armed);
            expect(dataManager.isBuffBeingSimulated(BREWING, buff)).toBe(armedSprite);
            expect(armedSprite).toBe(false);
        }
    });

    test('a stored selection of an existing player is still honored, and only with the switch on', async () => {
        game.saved.scroll_simulation_default = { __default__: ['/buff_types/efficiency'] };
        await freshSimulator();

        expect(scrollSimulator.getScrollSetForActionType(BREWING)).toEqual(new Set(['/buff_types/efficiency']));
        game.simulateScrollEffects = false;
        expect(scrollSimulator.getScrollSetForActionType(BREWING)).toEqual(new Set());
    });

    test('pressing a chip arms exactly that scroll and no other', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['/buff_types/gourmet']);
        dataManager.setScrollSimulation(BREWING, scrollSimulator.getScrollSetForActionType(BREWING));

        expect(dataManager.getPersonalBuffFlatBoost(BREWING, '/buff_types/gourmet')).toBeGreaterThan(0);
        expect(dataManager.getPersonalBuffFlatBoost(BREWING, '/buff_types/efficiency')).toBe(0);
        dataManager.clearScrollSimulation(BREWING);
    });
});
