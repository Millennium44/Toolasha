/** @vitest-environment happy-dom
 *
 * The Upgrade tab's Stop and failure paths. A run empties the results at its start; one that is stopped, or
 * fails, before it draws a row used to leave the tab empty. The view that was on screen (the all-fights table,
 * the single-fight table, the Ability order section) goes back instead, footer line and queued-swap note
 * included. A run that drew a row keeps it. The mocks above the tests are lab-sim-ui.check-swap.test.js's,
 * trimmed.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/enhancement-input-pricing.js', () => {
    const unpriced = { price: null, unpriced: true, estimated: false };
    return {
        priceMirror: () => unpriced,
        priceBase: () => unpriced,
        getCheapestProtectionPrice: () => ({ price: null, itemHrid: null }),
        perAttemptMaterialCost: () => ({ cost: 0, hasCost: false, hasMissingPrices: true }),
    };
});
import * as upgradeAdvisor from './upgrade-advisor.js';

const game = vi.hoisted(() => ({
    monsters: [],
    skipLevels: {},
    players: [],
    abilityDetailMap: {},
    editedDTOs: null,
    characterId: 'me',
}));
const sim = vi.hoisted(() => ({ cancelled: 0 }));
const storage = vi.hoisted(() => ({ written: {}, values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        setSetting: () => {},
        setSettingValue: () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in storage.values ? storage.values[key] : fallback),
        tryGet: async (key) =>
            key in storage.values ? { found: true, value: storage.values[key] } : { found: false, value: null },
        getMany: async function (keys, store) {
            return new Map(await Promise.all(keys.map(async (key) => [key, await this.get(key, store, null)])));
        },
        tryGetMany: async function (keys, store) {
            const reads = await Promise.all(keys.map((key) => this.tryGet(key, store)));
            return new Map(keys.map((key, i) => [key, reads[i]]));
        },
        set: async (key, value) => {
            storage.written[key] = value;
        },
        delete: async (key) => {
            delete storage.written[key];
            return true;
        },
        update: async (key, mutate) => {
            const current = key in storage.written ? storage.written[key] : storage.values[key];
            const value = mutate(current, key in storage.written || key in storage.values);
            if (value === undefined) return { written: false, value: current };
            storage.written[key] = value;
            return { written: true, value };
        },
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
        abilityDetailMap: game.abilityDetailMap,
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
            return game.editedDTOs;
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

const { default: ui } = await import('./lab-sim-ui.js');

async function settle() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

const A = '/abilities/poke';
const B = '/abilities/smack';
const C = '/abilities/fireball';
const SPECIAL = '/abilities/special';

describe('an Upgrade run stopped or failed before any row puts the previous view back', () => {
    const tick = (...keys) => {
        for (const el of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            el.checked = keys.includes(el.getAttribute('data-lab-upgrade-dimension'));
            el.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    };
    const setScope = (value) => {
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = value;
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const results = () => ui.panel.querySelector('#mwi-labsim-upgrade-results');
    const section = () => ui.panel.querySelector('#mwi-labsim-upgrade-order');
    const status = () => ui.panel.querySelector('#mwi-labsim-status').textContent;
    const pressStop = () => ui.panel.querySelector('#mwi-labsim-upgrade-stop').click();

    const fightRow = (i) => ({
        monsterHrid: `/monsters/m${i}`,
        monsterName: `Monster ${i}`,
        loadoutName: 'Loadout',
        roomLevel: 100,
        winRate: 0.6,
        winRateDelta: 0.1,
        applied: true,
        trials: 1000,
    });
    /** An all-fights table with a queued-swap note riding on it, as the analysis returns it */
    const allFightsTable = (name = 'Plain → Fancy Helm') => ({
        baseline: { fights: [fightRow(0), fightRow(1)], runClearChance: 0.25, expectedAttempts: 4 },
        queuedNote: { included: 1, trailer: 'Queued note: kept.' },
        results: [
            {
                candidate: { type: 'equipment', slot: '/equipment_types/head', description: name },
                costType: 'gold',
                cost: 1_000_000,
                fights: [fightRow(0), fightRow(1)],
                appliedFights: 2,
                expectedAttempts: 3.4,
                attemptsDelta: -0.6,
                attemptsDeltaNoise: 0.1,
                significant: true,
                avgWinDelta: 0.1,
                attemptsSavedPerMillion: 0.6,
                costDetail: null,
            },
        ],
    });
    const singleTable = (name = 'Plain → Fancy Boots') => ({
        baseline: { winRate: 0.4962 },
        results: [
            {
                candidate: { type: 'cross_slot', description: name },
                costType: 'gold',
                cost: 8879530,
                winRate: 0.5136,
                winRateDelta: 0.0174,
                metricType: 'winRate',
                costDetail: null,
            },
        ],
    });
    /** What the analysis returns when Stop lands before the baseline is measured */
    const nothing = () => ({ baseline: null, results: [] });
    const rawOrders = (params) => ({
        baseline: {
            fights: params.fights.map((fight) => ({
                monsterHrid: fight.monsterHrid,
                roomLevel: fight.roomLevel,
                monsterName: fight.monsterName,
                loadoutName: fight.loadoutName,
                winRate: 0.5,
                trials: 1000,
            })),
        },
        context: { fights: params.fights },
        results: [
            {
                candidate: { checkedAbilityKey: 'ability_order', order: [B, A, C] },
                fights: params.fights.map((fight) => ({
                    monsterHrid: fight.monsterHrid,
                    roomLevel: fight.roomLevel,
                    winRate: 0.7,
                    trials: 1000,
                    applied: true,
                })),
            },
            {
                candidate: { checkedAbilityKey: 'ability_order', keepCurrent: true, order: [A, B, C] },
                fights: params.fights.map((fight) => ({
                    monsterHrid: fight.monsterHrid,
                    roomLevel: fight.roomLevel,
                    winRate: 0.5,
                    trials: 1000,
                    applied: true,
                })),
            },
        ],
    });

    let singleSpy;
    let allSpy;
    /** What the analyses return now; a test swaps these between runs */
    let onSingle;
    let onAll;

    /** A run of the chosen view: its scope and ticked sets, then the real Run press path */
    const run = async (view) => {
        if (view === 'all') {
            setScope('all');
            tick('equipment');
        } else if (view === 'single') {
            setScope('single');
            tick('equipment');
        } else {
            setScope('single');
            tick('ability_order');
        }
        await ui._onUpgradeAnalyze();
    };

    beforeEach(async () => {
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.abilityDetailMap = { [A]: { name: 'Poke' }, [B]: { name: 'Smack' }, [C]: { name: 'Fireball' } };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = {
            p1: { hrid: 'p1', equipment: {}, abilities: [SPECIAL, A, B, C].map((hrid) => ({ hrid, level: 10 })) },
        };
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        onSingle = async () => singleTable();
        onAll = async (params) => (params.modes?.length ? allFightsTable() : rawOrders(params));
        singleSpy = vi
            .spyOn(upgradeAdvisor, 'runLabyrinthUpgradeAnalysis')
            .mockImplementation((...a) => onSingle(...a));
        allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis').mockImplementation((...a) => onAll(...a));
    });

    afterEach(() => {
        singleSpy.mockRestore();
        allSpy.mockRestore();
        game.players = [];
        game.editedDTOs = null;
        game.abilityDetailMap = {};
        game.monsters = [];
        game.skipLevels = {};
        ui.destroy();
    });

    /** The previous run's view, drawn by a real run of `view`; returns what to compare against */
    const firstRun = async (view) => {
        await run(view);
        const snapshot = {
            tableHtml: results().innerHTML,
            orderHtml: section().innerHTML,
            orderShown: section().style.display,
            status: status(),
        };
        expect(snapshot.status.length).toBeGreaterThan(0);
        if (view === 'all') {
            expect(snapshot.tableHtml).toContain('Fancy Helm');
            expect(snapshot.status).toContain('Queued note: kept.');
        } else if (view === 'single') {
            expect(snapshot.tableHtml).toContain('Fancy Boots');
        } else {
            expect(snapshot.orderShown).toBe('block');
            expect(snapshot.tableHtml).toBe('');
        }
        return snapshot;
    };
    const expectBack = (snapshot) => {
        expect(results().innerHTML).toBe(snapshot.tableHtml);
        expect(section().innerHTML).toBe(snapshot.orderHtml);
        expect(section().style.display).toBe(snapshot.orderShown);
        expect(status()).toBe(snapshot.status);
    };
    /** Stop pressed through the real button while the analysis is running; it returns what a stopped run does */
    const stopDuringRun = () => {
        const stopping = async (params) => {
            pressStop();
            return params?.modes?.length === 0 ? { baseline: null, results: [] } : nothing();
        };
        onSingle = stopping;
        onAll = stopping;
    };

    describe.each([
        ['all-fights', 'all'],
        ['single-fight', 'single'],
        ['Ability order', 'order'],
    ])('the %s view', (_label, view) => {
        test('stopped before any row, the previous view is back with its footer and note', async () => {
            const before = await firstRun(view);
            stopDuringRun();
            await run(view);
            expect(sim.cancelled).toBeGreaterThan(0);
            expectBack(before);
        });

        test('failed before any row, the previous view is back and the failure stays in the footer', async () => {
            const before = await firstRun(view);
            const failing = async () => {
                throw new Error('worker blew up');
            };
            onSingle = failing;
            onAll = failing;
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            try {
                await run(view);
            } finally {
                errorSpy.mockRestore();
            }
            expect(results().innerHTML).toBe(before.tableHtml);
            expect(section().innerHTML).toBe(before.orderHtml);
            expect(status()).toContain('failed: worker blew up');
        });

        test('a Cancelled rejection with no Stop press also puts it back', async () => {
            const before = await firstRun(view);
            const cancelled = async () => {
                throw new Error('Cancelled');
            };
            onSingle = cancelled;
            onAll = cancelled;
            await run(view);
            expectBack(before);
        });

        test('no previous view: the tab stays empty as before', async () => {
            stopDuringRun();
            await run(view);
            expect(results().innerHTML).not.toContain('<table');
            expect(section().style.display).not.toBe('block');
        });

        test('a following full run draws normally, and nothing stale is left behind', async () => {
            await firstRun(view);
            stopDuringRun();
            await run(view);
            // The next run is a different analysis: nothing of the put-back view is mixed into it
            onSingle = async () => singleTable('Next → Boots');
            onAll = async (params) => (params.modes?.length ? allFightsTable('Next → Helm') : rawOrders(params));
            await run(view);
            expect(ui._upgradeAborted).toBe(false);
            expect(ui._upgradeRunning).toBe(false);
            if (view === 'all') expect(results().textContent).toContain('Next → Helm');
            else if (view === 'single') expect(results().textContent).toContain('Next → Boots');
            else expect(section().style.display).toBe('block');
            expect(status()).not.toContain('cancelled');
        });
    });

    test('stopped after a row was drawn, the partial table stays as today', async () => {
        await firstRun('all');
        onAll = async (params) => {
            if (params.modes?.length) {
                pressStop();
                return allFightsTable('Partial → Helm');
            }
            return rawOrders(params);
        };
        await run('all');
        expect(results().textContent).toContain('Partial → Helm');
        expect(results().textContent).not.toContain('Plain → Fancy Helm');
    });

    test('a single-fight run stopped after a row keeps the partial rows', async () => {
        await firstRun('single');
        onSingle = async () => {
            pressStop();
            return singleTable('Partial → Boots');
        };
        await run('single');
        expect(results().textContent).toContain('Partial → Boots');
        expect(results().textContent).not.toContain('Fancy Boots');
    });

    test('a table drawn and Stop landing in the Ability order pass: the rows stay, no old section returns', async () => {
        await firstRun('order');
        onSingle = async () => singleTable('Rows → Boots');
        onAll = async () => {
            pressStop();
            return { baseline: null, results: [] };
        };
        setScope('single');
        tick('equipment', 'ability_order');
        await ui._onUpgradeAnalyze();
        expect(results().textContent).toContain('Rows → Boots');
        expect(section().style.display).not.toBe('block');
    });

    test('a previous view of another kind comes back as it was, not the stopped run’s kind', async () => {
        const order = await firstRun('order');
        stopDuringRun();
        await run('all');
        expectBack(order);
        const table = await (async () => {
            onSingle = async () => singleTable();
            await run('single');
            return { html: results().innerHTML, order: section().innerHTML, status: status() };
        })();
        stopDuringRun();
        await run('all');
        expect(results().innerHTML).toBe(table.html);
        expect(section().innerHTML).toBe(table.order);
        expect(status()).toBe(table.status);
    });

    test('a refused run (no fights) puts the table back and says why', async () => {
        const before = await firstRun('all');
        // The chosen fights are not among the ones with a room level
        const realPlan = ui._planFromControls.bind(ui);
        const planSpy = vi
            .spyOn(ui, '_planFromControls')
            .mockImplementation(() => ({ ...realPlan(), monsterHrids: ['/monsters/none'] }));
        try {
            await run('all');
        } finally {
            planSpy.mockRestore();
        }
        expect(results().innerHTML).toBe(before.tableHtml);
        expect(status()).toContain('No labyrinth fights found');
    });

    test('a character switch while the run is out puts nothing on the new panel', async () => {
        await firstRun('all');
        onAll = async () => {
            game.characterId = 'alt';
            return nothing();
        };
        try {
            await run('all');
            expect(results().innerHTML).not.toContain('Fancy Helm');
        } finally {
            game.characterId = 'me';
        }
    });

    test('the remembered table is put back with its banner and Clear still forgets it', async () => {
        await firstRun('all');
        // The table on screen is a remembered one: restored from storage, no run started on this panel
        ui._upgradeRunStarted = false;
        ui._restoredUpgradeAt = Date.now();
        ui._restoredUpgradeMeta = { characterName: 'Tester' };
        ui._renderAllFightsResults(ui._allFightsResult, results());
        expect(results().textContent).toContain('Showing results remembered from');
        stopDuringRun();
        await run('all');
        expect(results().textContent).toContain('Showing results remembered from');
        expect(results().querySelector('[data-clear-remembered-upgrade]')).toBeTruthy();
        results().querySelector('[data-clear-remembered-upgrade]').click();
        await settle();
        expect(results().innerHTML).toBe('');
        expect(ui._restoredUpgradeAt).toBeNull();
    });
});
