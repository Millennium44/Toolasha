/** @vitest-environment happy-dom
 *
 * The budget plan's marketplace tabs arm the buy box with what each tab still
 * lacks. Before, a tab only navigated, so a book tab reading "Missing: 1,863"
 * opened a buy box holding 1.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ monsters: [], skipLevels: {}, players: [], characterId: 'me' }));
const settings = vi.hoisted(() => ({ autoVerify: false }));
const sim = vi.hoisted(() => ({ cancelled: 0 }));
const tabs = vi.hoisted(() => ({ created: [], navigations: [], container: null }));
const fill = vi.hoisted(() => ({ armed: [], cleared: 0 }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: () => false,
        getSettingValue: (key, fallback) => (key === 'combatSim_autoVerifyCloseCalls' ? settings.autoVerify : fallback),
        setSetting: () => {},
        setSettingValue: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        set: async () => {},
        delete: async () => true,
        update: async () => ({ written: false, value: undefined }),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {}, itemDetailMap: {} }),
        getItemDetails: () => null,
        getSkills: () => [],
        getInventory: () => [],
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterItems: [],
        characterEquipment: new Map(),
        get characterData() {
            return { characterAbilities: [], characterInfo: null, characterLabyrinth: null, characterSetting: null };
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
    markPanelInteracted: () => {},
}));
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildGameDataPayload: () => ({
        itemDetailMap: {},
        actionDetailMap: { '/actions/combat/fly': {} },
        houseRoomDetailMap: {},
        abilityDetailMap: {},
    }),
    buildAllPlayerDTOs: async () => ({ players: game.players, selfHrid: game.players[0]?.hrid }),
    getCombatZones: () => [],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => game.monsters,
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    parseShykaiImport: () => null,
    buildShykaiExportPlayer: () => ({}),
    recomputeLevelGapDebuffs: () => {},
}));
vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async () => ({ labyAttemptCount: 100, encounters: 70, deaths: {}, simulatedTime: 1e9 }),
    cancelActiveSimulations: () => {
        sim.cancelled++;
    },
    cancelSimulation: () => {
        sim.cancelled++;
    },
    getMaxWorkers: () => 2,
}));
vi.mock('./sim-editor.js', () => ({
    SimEditor: class {
        isInitialized() {
            return true;
        }
        initEditor() {}
        reset() {}
        getPlayerInfo() {
            return [{ name: 'Tester' }];
        }
        getEditedDTOs() {
            return null;
        }
        getSelfHrid() {
            return game.players[0]?.hrid ?? null;
        }
    },
}));
vi.mock('./combat-sim-ui.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        default: {
            applyScoreScale: original.applyScoreScale,
            DEFAULT_LEVEL_SCORE_SCALE: original.DEFAULT_LEVEL_SCORE_SCALE,
            scoreScaleTitle: original.scoreScaleTitle,
            scoreDepthLabel: original.scoreDepthLabel,
            scoreValueColor: original.scoreValueColor,
            formatScore: original.formatScore,
            formatCompactHours: original.formatCompactHours,
            upgradeRowPurchase: () => null,
            upgradeRowActionsHtml: () => '',
            wireUpgradeRowActions: () => {},
        },
    };
});
vi.mock('../combat/labyrinth-clear-rate.js', () => ({
    SKIP_THRESHOLD_RANGE: 60,
    default: {
        getCombatExperienceBonus: () => 0,
        getLabyrinthCombatBuffs: () => [],
        getCombatSkipRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getRecommendedCombatRoomLevel: () => 0,
        getLabyrinthLoadoutId: () => null,
        buildLabyrinthPlayerDTO: () => ({ equipment: {}, abilities: [], houseRooms: {}, guildShrineLevels: {} }),
        getPlayerEffectiveCombatLevel: () => 100,
        estimateCombatXpPerHour: () => 0,
        getTargetRoomLevel: () => 0,
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { get: () => null, snapshots: {}, getAllSnapshots: () => [] },
}));

vi.mock('../../utils/marketplace-tabs.js', () => ({
    createMaterialTab: (material, _reference, onClick) => {
        const tab = document.createElement('div');
        tab.setAttribute('data-missing-quantity', String(material.missing));
        tab.addEventListener('click', (e) => onClick(e, material));
        tabs.created.push({ material, tab });
        return tab;
    },
    removeMaterialTabs: () => {},
    visibleTabsContainer: () => tabs.container,
    navigateToMarketplace: (itemHrid, level) => tabs.navigations.push([itemHrid, level]),
    ensureClearAllTabsControl: () => {},
    insertTabInOrder: (container, tab) => container.appendChild(tab),
    setupMarketplaceCleanupObserver: () => {},
    watchTabForAcquisition: () => {},
}));

vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({
        initialize: () => {},
        cleanup: () => {},
        setQuantity: (quantity, opts) => fill.armed.push({ quantity: () => quantity, ...opts }),
        setPendingCalculation: (fn, opts) => fill.armed.push({ quantity: fn, ...opts }),
        clearQuantity: () => {
            fill.cleared++;
        },
    }),
}));

import combatSimUI from './combat-sim-ui.js';
import { openPlanInMarketplace } from './lab-sim-ui.js';

describe('budget plan tabs fill the buy box', () => {
    beforeEach(() => {
        tabs.created.length = 0;
        tabs.navigations.length = 0;
        fill.armed.length = 0;
        tabs.container = document.createElement('div');
        const myListings = document.createElement('div');
        myListings.textContent = 'My Listings';
        tabs.container.appendChild(myListings);
        const buys = {
            fireball: { itemHrid: '/items/fireball', enhancementLevel: 0, quantity: 1863, name: 'Fireball' },
            affinity: { itemHrid: '/items/elemental_affinity', enhancementLevel: 0, quantity: 152, name: 'Affinity' },
            ring: { itemHrid: '/items/ring', enhancementLevel: 3, quantity: 1, name: 'Ring' },
        };
        combatSimUI.upgradeRowPurchase = (pick) => buys[pick.key];
    });

    test('the first item is armed with its whole book stack as the market opens on it', async () => {
        const added = await openPlanInMarketplace([{ key: 'fireball' }, { key: 'affinity' }, { key: 'ring' }]);
        expect(added).toBe(3);
        expect(tabs.navigations[0]).toEqual(['/items/fireball', 0]);
        expect(fill.armed).toHaveLength(1);
        expect(fill.armed[0].itemHrid).toBe('/items/fireball');
        expect(fill.armed[0].quantity()).toBe(1863);
    });

    test('clicking a tab arms its own item with what the tab still lacks', async () => {
        await openPlanInMarketplace([{ key: 'fireball' }, { key: 'affinity' }, { key: 'ring' }]);
        const affinity = tabs.created.find((t) => t.material.itemHrid === '/items/elemental_affinity');
        affinity.tab.click();
        const last = fill.armed.at(-1);
        expect(last.itemHrid).toBe('/items/elemental_affinity');
        expect(last.quantity()).toBe(152);
        // Read live: books bought since the click lower what the next buy box gets
        affinity.tab.setAttribute('data-missing-quantity', '40');
        expect(last.quantity()).toBe(40);
        expect(tabs.navigations.at(-1)).toEqual(['/items/elemental_affinity', 0]);

        const ring = tabs.created.find((t) => t.material.itemHrid === '/items/ring');
        ring.tab.click();
        expect(fill.armed.at(-1)).toMatchObject({ itemHrid: '/items/ring' });
        expect(fill.armed.at(-1).quantity()).toBe(1);
        expect(tabs.navigations.at(-1)).toEqual(['/items/ring', 3]);
    });

    test('an empty plan opens nothing and arms nothing', async () => {
        expect(await openPlanInMarketplace([])).toBe(0);
        expect(tabs.navigations).toHaveLength(0);
        expect(fill.armed).toHaveLength(0);
    });
});
