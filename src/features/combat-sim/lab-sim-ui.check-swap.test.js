/** @vitest-environment happy-dom
 *
 * The Lab Sim's Check a swap row: its queue, the table it feeds, and the queue riding along in every
 * Upgrade run. Split from lab-sim-ui.test.js, which had outgrown a test worker's heap; the mocks and
 * helpers above the tests are that file's, copied.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// The advisor's mirror and base prices go through the shared enhancement input rule; this file is not
// about prices, so nothing is priced
vi.mock('../../utils/enhancement-input-pricing.js', () => {
    const unpriced = { price: null, unpriced: true, estimated: false };
    return {
        priceMirror: () => unpriced,
        priceBase: () => unpriced,
        getCheapestProtectionPrice: () => ({ price: null, itemHrid: null }),
        perAttemptMaterialCost: () => ({ cost: 0, hasCost: false, hasMissingPrices: true }),
    };
});
// The real module — never mocked in this file, unlike combat-sim-ui.test.js,
// so a `guild shrine guild-allowed cap` test spies on individual exports
// rather than replacing the whole module.
import * as upgradeAdvisor from './upgrade-advisor.js';

const geometry = vi.hoisted(() => ({ saved: null, wasOpen: false, restoreCalls: [], saveCalls: [], openCalls: [] }));
const game = vi.hoisted(() => ({
    /** Arguments of every estimateCombatXpPerHour call */
    xpCalls: [],
    monsters: [],
    /** Monster hrid → room level the skip thresholds resolve to */
    skipLevels: {},
    /** Monster hrid → room level a Recommend run picked out */
    recommendedLevels: {},
    players: [],
    /** What `buildGameDataPayload` reports about the character's house */
    houseRoomDetailMap: {},
    /** The room levels every labyrinth loadout's DTO carries */
    houseRooms: {},
    /** Ability hrid → display name, for the target grid's labels */
    abilityDetailMap: {},
    /** The game's three trigger detail maps, for trigger wording (`{ dependencies, conditions, comparators }`) */
    triggerMaps: null,
    /** Monster hrid → the loadout id the labyrinth has assigned it */
    loadoutByMonster: {},
    /** Loadout id → the name the game shows for it */
    loadoutNames: {},
    /** Loadout id → the abilities that loadout casts */
    loadoutAbilities: {},
    /** buffHrid → level, on every labyrinth loadout's DTO */
    guildShrineLevels: {},
    /** What `getGuildBuffDetailMap` reports */
    guildBuffDetailMap: {},
    /** What `dataManager.characterData.characterInfo` holds */
    characterInfo: null,
    /** The character's equipped labyrinth crates, or null before data loads */
    characterLabyrinth: null,
    /** Fallback crate hrids, mirroring characterData.characterSetting */
    characterSetting: null,
    /** What the Configure editor reports, or null when it has none */
    editedDTOs: null,
    /** Optional delayed/failed live-profile read for run-start lifecycle tests */
    buildPlayers: null,
    /** Who is logged in; a test moves it mid-run to stage a character switch */
    characterId: 'me',
    /** Whether the opt-in "remember upgrade results" setting is on */
    rememberUpgradeResults: false,
    /** Clear rate a skilling room loses per room level; 0 keeps it level-blind */
    levelPenalty: 0,
    /** What `buildGameDataPayload` reports as the game's items */
    itemDetailMap: {},
    /** Loadout id → the equipment that loadout wears */
    loadoutEquipment: {},
}));
const sim = vi.hoisted(() => ({
    cancelled: 0,
    calls: [],
    onCall: null,
}));
/**
 * Every key the panel wrote, so a persisted choice can be asserted on.
 * `pending`: key → an in-flight promise a test controls, for staging a read
 * that resolves after a character switch rather than before it.
 */
const storage = vi.hoisted(() => ({ written: {}, values: {}, pending: {} }));
const rowActions = vi.hoisted(() => ({ wired: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: (key) => (key === 'combatSim_rememberUpgradeResults' ? game.rememberUpgradeResults : false),
        getSettingValue: (_key, fallback) => fallback,
        setSetting: () => {},
        setSettingValue: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (key in storage.pending) return storage.pending[key];
            return key in storage.values ? storage.values[key] : fallback;
        },
        // A read that says whether it worked: `storage.unreadable` makes every one fail, as a wedged database does
        tryGet: async (key) => {
            if (storage.unreadable) return null;
            if (key in storage.pending) {
                const value = await storage.pending[key];
                return value == null ? { found: false, value: null } : { found: true, value };
            }
            return key in storage.values ? { found: true, value: storage.values[key] } : { found: false, value: null };
        },
        set: async (key, value) => {
            storage.written[key] = value;
        },
        delete: async (key) => {
            delete storage.written[key];
            return true;
        },
        // One transaction against the newest value: a write already made, else what is stored
        update: async (key, mutate) => {
            const found = key in storage.written || key in storage.values;
            const current = key in storage.written ? storage.written[key] : storage.values[key];
            const value = mutate(current, found);
            if (value === undefined) return { written: false, value: current };
            storage.written[key] = value;
            return { written: true, value };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            abilityDetailMap: {},
            itemDetailMap: game.itemDetailMap,
            guildShrineDetailMap: game.guildShrineDetailMap,
        }),
        getItemDetails: () => null,
        getSkills: () => [],
        getInventory: () => [],
        // The scoped-storage helpers key on the character; without these the
        // panel's own restore throws before it can read anything back
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        characterItems: [],
        characterEquipment: new Map(),
        get characterData() {
            return {
                characterAbilities: [],
                characterInfo: game.characterInfo,
                characterLabyrinth: game.characterLabyrinth,
                characterSetting: game.characterSetting,
            };
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

// The store itself lives in IndexedDB. What matters here is that the panel asks
// it, and hands it back what a drag or a resize produced — so the mock applies a
// geometry the way the real one does and records what it is told.
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async (panel, panelKey, min) => {
        geometry.restoreCalls.push({ panelKey, min });
        const saved = geometry.saved;
        if (!saved || !panel) return;
        if (saved.width) panel.style.width = `${saved.width}px`;
        if (saved.height) panel.style.height = `${saved.height}px`;
        if (saved.left !== undefined) {
            panel.style.left = `${saved.left}px`;
            panel.style.top = `${saved.top}px`;
            panel.style.right = 'auto';
        }
    },
    saveGeometry: async (panelKey, values) => {
        geometry.saveCalls.push({ panelKey, values });
    },
    saveOpenState: async (panelKey, open) => {
        geometry.openCalls.push({ panelKey, open });
    },
    wasOpen: async (panelKey) => (geometry.wasOpen ? panelKey === 'labSimPanel' : false),
    reopenIfLeftOpen: async (panelKey, reopen) => {
        if (geometry.wasOpen) reopen();
    },
    markPanelInteracted: () => {},
}));

vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildGameDataPayload: () => ({
        itemDetailMap: game.itemDetailMap,
        actionDetailMap: { '/actions/combat/fly': {} },
        houseRoomDetailMap: game.houseRoomDetailMap,
        abilityDetailMap: game.abilityDetailMap,
        combatTriggerDependencyDetailMap: game.triggerMaps?.dependencies,
        combatTriggerConditionDetailMap: game.triggerMaps?.conditions,
        combatTriggerComparatorDetailMap: game.triggerMaps?.comparators,
    }),
    buildAllPlayerDTOs: async () =>
        game.buildPlayers ? game.buildPlayers() : { players: game.players, selfHrid: game.players[0]?.hrid },
    getCombatZones: () => [],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => game.monsters,
    getGuildBuffDetailMap: () => game.guildBuffDetailMap,
    guildBuffMaxLevel: (detail) => {
        const levels = Object.keys(detail?.levelCosts || {}).map(Number);
        return levels.length ? Math.max(...levels) : 0;
    },
    parseShykaiImport: () => null,
    buildShykaiExportPlayer: () => ({}),
    recomputeLevelGapDebuffs: () => {},
}));

vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (params) => {
        sim.calls.push(params);
        sim.onCall?.(sim.calls.length);
        return { labyAttemptCount: 100, encounters: 70, deaths: {}, simulatedTime: 3 * 3600 * 1e9 };
    },
    // The Stop buttons take the preempt-shaped path: they stop the run, not the
    // warm workers behind it
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

// The upgrade-row handoff buttons come from the combat sim panel, which brings
// two module-scope inventory panels with it. This file is about where the lab
// panel opens, so it borrows the vocabulary and none of the furniture.
//
// The stand-in emits a marker button per row rather than nothing, because what
// is worth asserting is that the lab table renders *whatever the shared builder
// hands it* — a button added over there (Save for this, Watch, Market) has to
// turn up here without this file being told about it.
// The score helpers the Combat levels table borrows stay real: what is worth
// asserting there is their arithmetic, not a stand-in for it.
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
            upgradeRowActionsHtml: (result) =>
                `<button data-shared-action="${result?.candidate?.description || ''}">buttons</button>`,
            wireUpgradeRowActions: (container) => {
                rowActions.wired.push(container);
            },
        },
    };
});

// A CSV export reaches the browser's download; the text it would save is what
// is worth reading back.
const csv = vi.hoisted(() => ({ saved: [] }));
vi.mock('../../utils/csv-export.js', async (importOriginal) => ({
    ...(await importOriginal()),
    downloadCsv: (filename, text) => {
        csv.saved.push(text);
        return true;
    },
}));

// A labyrinth fight only exists for the panel when a room level resolves and a
// loadout can be built for it, so both live here and the tests choose which
// monsters have one.
//
// The skilling half of the same module is a stand-in of the real arithmetic's
// *shape* rather than its numbers: a buff array in, one metric per buff type
// out, and a clear rate and an XP award that each move with exactly one of them.
// That is enough for the thing worth asserting — that a community buff level
// reaches the room at all, and lands on the metric it belongs to.
vi.mock('../combat/labyrinth-clear-rate.js', () => ({
    // The level finder reads the skip window off this module, and a missing
    // named export makes its search window NaN — which silently searches nothing
    SKIP_THRESHOLD_RANGE: 60,
    default: {
        getCombatExperienceBonus: () => 0,
        getLabyrinthCombatBuffs: () => [],
        getCombatSkipRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getRecommendedCombatRoomLevel: (hrid) => game.recommendedLevels[hrid] || 0,
        getLabyrinthLoadoutId: (monsterHrid) => game.loadoutByMonster[monsterHrid] ?? null,
        buildLabyrinthPlayerDTO: (loadoutId) => ({
            equipment: JSON.parse(JSON.stringify(game.loadoutEquipment[loadoutId] || {})),
            abilities: (game.loadoutAbilities[loadoutId] || []).map((ability) => ({ ...ability })),
            houseRooms: { ...game.houseRooms },
            guildShrineLevels: { ...game.guildShrineLevels },
        }),
        getPlayerEffectiveCombatLevel: () => 100,
        estimateCombatXpPerHour: (...args) => {
            game.xpCalls.push(args);
            return 0;
        },
        getTargetRoomLevel: () => 0,
        getSkillingMetricsFromOverrides: (_skillId, _actionTypeHrid, overrides) => {
            const fields = {
                '/buff_types/efficiency': 'efficiencyBonus',
                '/buff_types/action_speed': 'actionSpeedBonus',
                '/buff_types/gathering': 'gatheringBonus',
                '/buff_types/wisdom': 'experienceBonus',
            };
            const metrics = {
                skillLevelBonus: 0,
                efficiencyBonus: 0,
                actionSpeedBonus: 0,
                successBonus: 0,
                doubleProgressBonus: 0,
                gatheringBonus: 0,
                experienceBonus: 0,
            };
            const sources = [
                overrides?.equipmentBuffs,
                overrides?.communityBuffs,
                overrides?.houseBuffs,
                overrides?.crateBuffs,
            ];
            for (const buffs of sources) {
                for (const buff of buffs || []) {
                    const field = fields[buff?.typeHrid];
                    if (field) metrics[field] += (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                }
            }
            return metrics;
        },
        computeSkillingClearWithParams: (metrics, baseLevel, roomLevel) => ({
            clearChance: Math.max(
                0,
                Math.min(1, 0.5 + metrics.efficiencyBonus + metrics.gatheringBonus - roomLevel * game.levelPenalty)
            ),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
        computeEnhancingClearWithParams: (metrics, baseLevel, roomLevel) => ({
            clearChance: Math.max(0, Math.min(1, 0.5 + metrics.actionSpeedBonus - roomLevel * game.levelPenalty)),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        get: () => null,
        get snapshots() {
            return Object.fromEntries(Object.entries(game.loadoutNames).map(([id, name]) => [id, { id, name }]));
        },
        // Every named loadout, tagged with the action type the Skilling tab
        // filters them by — the shape the loadout table reads
        getAllSnapshots: () =>
            Object.values(game.loadoutNames).map((name) => ({ name, actionTypeHrid: '/action_types/woodcutting' })),
    },
}));

const { default: ui } = await import('./lab-sim-ui.js');

/**
 * Let the panel's storage-backed restore finish before asserting on it.
 *
 * Generous rather than exact: the restore reads several keys in sequence and
 * each read is two awaits deep (scoped key, then the legacy one), so the number
 * of ticks it takes grows every time a remembered control is added. Eight was
 * enough until the signature-swap key made it nine, and the failure that caused
 * was a restore landing *after* the test body — a control quietly reset to its
 * stored value half way through an assertion.
 */
async function settle() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

/**
 * Check a swap: the row on each tab, its queue, and the table it feeds.
 *
 * The analysis behind it is the generated one (`runLabyrinthAllFightsAnalysis`
 * with the queued candidates as its only candidates), so what is worth asserting
 * here is the panel's own part: the queue and its persistence, the same table
 * drawn above the generated one, and that none of it disturbs the generated
 * table when nothing is queued.
 */
describe('Check a swap', () => {
    const CAPE = '/items/sinister_cape';
    const BACK = '/equipment_types/back';

    beforeEach(async () => {
        game.characterId = 'me';
        game.itemDetailMap = {
            [CAPE]: {
                hrid: CAPE,
                name: 'Sinister Cape',
                equipmentDetail: { type: BACK, combatStats: { slashDamage: 0.1 } },
            },
        };
        storage.written = {};
        storage.values = {};
        ui.buildPanel();
        await settle();
    });

    afterEach(() => {
        game.itemDetailMap = {};
        storage.values = {};
        ui.destroy();
    });

    const type = (kind, name, level) => {
        const item = ui.panel.querySelector(`#mwi-labsim-swap-item-${kind}`);
        item.value = name;
        item.dispatchEvent(new window.Event('input', { bubbles: true }));
        ui.panel.querySelector(`#mwi-labsim-swap-level-${kind}`).value = level;
    };
    const chips = (kind) =>
        [...ui.panel.querySelectorAll(`#mwi-labsim-swap-chips-${kind} [data-swap-chip]`)].map((chip) =>
            chip.textContent.replace('×', '').trim()
        );

    test('both tabs carry the row, with an item picker, a level, Add and Check', () => {
        for (const kind of ['combat', 'skilling']) {
            expect(ui.panel.querySelector(`#mwi-labsim-swap-item-${kind}`)).toBeTruthy();
            // Combat also takes ability levels (to 200); an item level is still clamped to 20 when queued
            expect(ui.panel.querySelector(`#mwi-labsim-swap-level-${kind}`).max).toBe(kind === 'combat' ? '200' : '20');
            expect(ui.panel.querySelector(`#mwi-labsim-swap-add-${kind}`).textContent).toBe('Add');
            expect(ui.panel.querySelector(`#mwi-labsim-swap-check-${kind}`).textContent).toBe('Check');
        }
        // Each tab's table sits above the generated one
        const upgrade = ui.panel.querySelector('#mwi-labsim-upgrade-content');
        const order = [...upgrade.children].map((el) => el.id);
        expect(order.indexOf('mwi-labsim-swap-results')).toBeLessThan(order.indexOf('mwi-labsim-upgrade-results'));
        const skilling = ui.panel.querySelector('#mwi-labsim-skilling-content');
        const skillingOrder = [...skilling.children].map((el) => el.id);
        expect(skillingOrder.indexOf('mwi-labsim-skilling-swap-results')).toBeLessThan(
            skillingOrder.indexOf('mwi-labsim-skilling-results')
        );
    });

    test('the picker suggests equipment by name', () => {
        type('combat', 'sinis', '');
        const options = [...ui.panel.querySelectorAll('#mwi-labsim-swap-items-combat option')];
        expect(options.map((option) => option.value)).toEqual(['Sinister Cape']);
        // No label: Firefox shows a label instead of the value, which listed slot names
        expect(options[0].hasAttribute('label')).toBe(false);
    });

    test('Add queues a chip, which can be removed, and a repeat or an unknown name is refused', () => {
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        expect(chips('combat')).toEqual(['Sinister Cape +7']);
        expect(ui.panel.querySelector('#mwi-labsim-swap-item-combat').value).toBe('');

        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        expect(chips('combat')).toEqual(['Sinister Cape +7']);
        expect(ui.panel.querySelector('#mwi-labsim-swap-note-combat').textContent).toContain('Already queued');

        type('combat', 'no such thing', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        expect(chips('combat')).toHaveLength(1);

        ui.panel.querySelector('[data-swap-remove]').click();
        expect(chips('combat')).toEqual([]);
    });

    test('the two tabs keep separate queues', () => {
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        expect(chips('skilling')).toEqual([]);
    });

    test('the queue is saved per character through the panel storage, and comes back', async () => {
        type('skilling', 'Sinister Cape', '3');
        ui.panel.querySelector('#mwi-labsim-swap-add-skilling').click();
        await settle();
        expect(storage.written['labSimCheckedSwaps_me']).toMatchObject({
            combat: [],
            skilling: [{ hrid: CAPE, level: 3 }],
        });

        // A fresh panel for the same character reads it back
        const saved = storage.written['labSimCheckedSwaps_me'];
        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = saved;
        ui.buildPanel();
        await settle();
        expect(chips('skilling')).toEqual(['Sinister Cape +3']);
        expect(chips('combat')).toEqual([]);
    });

    test('another character does not see it, and a switch mid-read does not adopt it', async () => {
        storage.values['labSimCheckedSwaps_me'] = { combat: [{ hrid: CAPE, level: 5 }], skilling: [] };
        ui.destroy();
        game.characterId = 'alt';
        ui.buildPanel();
        await settle();
        expect(chips('combat')).toEqual([]);

        let resolveRead;
        storage.pending['labSimCheckedSwaps_alt'] = new Promise((resolve) => {
            resolveRead = resolve;
        });
        const restore = ui._restoreCheckedSwaps();
        game.characterId = 'someone-else';
        resolveRead({ combat: [{ hrid: CAPE, level: 9 }], skilling: [] });
        await restore;
        delete storage.pending['labSimCheckedSwaps_alt'];
        expect(ui._checkedSwaps.combat).toEqual([]);
        game.characterId = 'me';
    });

    test('a swap queued while a pulled queue is being read is kept, not replaced by it', async () => {
        let resolveRead;
        storage.pending['labSimCheckedSwaps_me'] = new Promise((resolve) => {
            resolveRead = resolve;
        });
        const restore = ui._restoreCheckedSwaps({ replace: true });
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        resolveRead({ combat: [], skilling: [{ hrid: CAPE, level: 2 }] });
        await restore;
        delete storage.pending['labSimCheckedSwaps_me'];

        expect(chips('combat')).toEqual(['Sinister Cape +7']);
        expect(chips('skilling')).toEqual([]);
    });

    test('destroying the panel drops the queue from memory', () => {
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        ui.destroy();
        expect(ui._checkedSwaps).toEqual({ combat: [], skilling: [] });
    });

    test('Check with nothing queued does nothing', async () => {
        sim.calls.length = 0;
        ui.panel.querySelector('#mwi-labsim-swap-check-combat').click();
        ui.panel.querySelector('#mwi-labsim-swap-check-skilling').click();
        await settle();
        expect(sim.calls).toHaveLength(0);
        expect(ui.panel.querySelector('#mwi-labsim-swap-results').innerHTML).toBe('');
        expect(ui.panel.querySelector('#mwi-labsim-skilling-swap-results').innerHTML).toBe('');
        expect(ui.panel.querySelector('#mwi-labsim-swap-note-combat').textContent).toContain('Add a swap');
    });

    const fightRow = (monsterName, applied, winRate, delta) => ({
        monsterHrid: `/monsters/${monsterName.toLowerCase()}`,
        monsterName,
        roomLevel: 199,
        loadoutName: 'Magic - Nature Lab',
        winRate,
        winRateDelta: delta,
        applied,
        replaced: applied ? 'Other Cape +3' : null,
    });
    const combatAnalysis = () => ({
        baseline: {
            fights: [
                { monsterName: 'Scorpion', winRate: 0.295 },
                { monsterName: 'Mimic', winRate: 0.6 },
            ],
            expectedAttempts: 5,
        },
        results: [
            {
                candidate: {
                    description: 'Sinister Cape +5 → +7',
                    pricingNote: 'Checked by hand.',
                    type: 'enhancement',
                },
                costType: 'gold',
                cost: 12_000_000,
                fights: [fightRow('Scorpion', true, 0.319, 0.0238), fightRow('Mimic', false, 0.6, 0)],
                appliedFights: 1,
                expectedAttempts: 4.8,
                attemptsDelta: -0.2,
                attemptsDeltaNoise: 0.05,
                significant: true,
                avgWinDelta: 0.0238,
                attemptsSavedPerMillion: 0.016,
            },
        ],
    });

    test('Check runs only the queued swap, over the fights whose loadouts use the slot', async () => {
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.loadoutByMonster = { '/monsters/mimic': 'low', '/monsters/eye_watcher': 'high' };
        game.loadoutNames = { low: 'Low Lab', high: 'High Lab' };
        game.loadoutEquipment = {
            low: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } },
            high: { [BACK]: { hrid: CAPE, enhancementLevel: 7 } },
        };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');
        sim.calls.length = 0;

        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        await ui._onCheckSwapsCombat();

        const params = allSpy.mock.calls[0][0];
        expect(params.modes).toEqual([]);
        expect(params.extraCandidates).toHaveLength(1);
        expect(params.extraCandidates[0]).toMatchObject({ checkedSwap: true, slot: BACK, reach: 1 });
        // Two baselines, and one candidate sim: the loadout already at +7 is not simulated
        expect(sim.calls).toHaveLength(3);
        const shown = ui.panel.querySelector('#mwi-labsim-swap-results');
        expect(shown.style.display).toBe('block');
        expect(shown.textContent).toContain('Checked swaps');
        expect(shown.textContent).toContain('1 / 2');
        // The generated table is untouched
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-results').innerHTML).toBe('');
        allSpy.mockRestore();
        game.loadoutByMonster = {};
        game.loadoutNames = {};
        game.loadoutEquipment = {};
        game.monsters = [];
        game.skipLevels = {};
    });

    describe('queued swaps ride along in every Upgrade run', () => {
        const tickOnly = (...keys) => {
            for (const b of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
                b.checked = keys.includes(b.getAttribute('data-lab-upgrade-dimension'));
                b.dispatchEvent(new window.Event('change', { bubbles: true }));
            }
        };
        const status = () => ui.panel.querySelector('#mwi-labsim-status').textContent;
        const twoFights = async (lowLevel, highLevel) => {
            game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
            game.editedDTOs = { p1: { hrid: 'p1', equipment: {}, abilities: [] } };
            game.monsters = [
                { hrid: '/monsters/mimic', name: 'Mimic' },
                { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
            ];
            game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
            game.loadoutByMonster = { '/monsters/mimic': 'low', '/monsters/eye_watcher': 'high' };
            game.loadoutNames = { low: 'Low Lab', high: 'High Lab' };
            game.loadoutEquipment = {
                low: { [BACK]: { hrid: CAPE, enhancementLevel: lowLevel } },
                high: { [BACK]: { hrid: CAPE, enhancementLevel: highLevel } },
            };
            ui.destroy();
            ui.buildPanel();
            await settle();
            ui._switchTab('upgrade');
            const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
            scope.value = 'all';
            scope.dispatchEvent(new window.Event('change', { bubbles: true }));
        };
        let allSpy;
        let saveSpy;
        beforeEach(() => {
            allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');
        });
        afterEach(() => {
            allSpy.mockRestore();
            saveSpy?.mockRestore();
            game.loadoutByMonster = {};
            game.loadoutNames = {};
            game.loadoutEquipment = {};
            game.monsters = [];
            game.skipLevels = {};
            game.players = [];
            game.editedDTOs = null;
        });

        test('an all-fights run hands the queued candidates to the analysis and draws and saves their row', async () => {
            await twoFights(5, 7);
            saveSpy = vi.spyOn(ui, '_saveLabUpgradeResults').mockImplementation(() => {});
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
            tickOnly('combat_level');

            await ui._onUpgradeAnalyze();

            const params = allSpy.mock.calls[0][0];
            expect(params.modes).toEqual(['combat_level']);
            expect(params.extraCandidates).toHaveLength(1);
            expect(params.extraCandidates[0]).toMatchObject({ checkedSwap: true, slot: BACK, reach: 1 });
            // Claims are every loadout the character has, as Check passes them
            expect(params.claimLoadouts.length).toBeGreaterThan(0);
            const table = ui.panel.querySelector('#mwi-labsim-upgrade-results');
            expect(table.textContent).toContain('Sinister Cape');
            expect(status()).toContain('including 1 queued swap');
            const saved = saveSpy.mock.calls[0][0];
            expect(saved.results.some((row) => row.candidate.checkedSwap)).toBe(true);
            // Check's own table is not touched by a generated run
            expect(ui.panel.querySelector('#mwi-labsim-swap-results').innerHTML).toBe('');
        });

        test('a restored or cloned redraw of the run keeps the queued-swap note', async () => {
            await twoFights(5, 7);
            saveSpy = vi.spyOn(ui, '_saveLabUpgradeResults').mockImplementation(() => {});
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
            tickOnly('combat_level');
            await ui._onUpgradeAnalyze();
            expect(status()).toContain('including 1 queued swap');
            // The saved record carries the note, and a copy read back from storage is a different object
            const saved = saveSpy.mock.calls[0][0];
            expect(saved.queuedNote).toMatchObject({ included: 1 });
            const restored = JSON.parse(JSON.stringify(saved));
            ui._setStatus('');
            ui._renderAllFightsResults(restored, ui.panel.querySelector('#mwi-labsim-upgrade-results'));
            expect(status()).toContain('including 1 queued swap');
            // An older build's record has no note at all: the status simply omits it
            delete restored.queuedNote;
            ui._renderAllFightsResults(restored, ui.panel.querySelector('#mwi-labsim-upgrade-results'));
            expect(status()).not.toContain('queued');
        });

        test('the starting line says the queued swaps are part of the run', async () => {
            await twoFights(5, 7);
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
            tickOnly('combat_level');
            // Only the starting line is asked about: no simulation needs to run (a whole file of real runs
            // outgrows a test worker's heap)
            allSpy.mockResolvedValue({ baseline: null, results: [] });
            const statusSpy = vi.spyOn(ui, '_setStatus');
            await ui._onUpgradeAnalyze();
            const seen = statusSpy.mock.calls.map(([text]) => text);
            statusSpy.mockRestore();
            expect(seen.find((text) => text.startsWith('Starting:'))).toContain(', plus 1 queued swap.');
        });

        test('with nothing queued the run is the generated one, with no extra candidates and no note', async () => {
            await twoFights(5, 7);
            tickOnly('combat_level');
            allSpy.mockResolvedValue({ baseline: null, results: [] });
            await ui._onUpgradeAnalyze();
            expect(allSpy.mock.calls[0][0].extraCandidates).toEqual([]);
            expect(status()).not.toContain('queued');
        });

        test('a queued swap that reaches no loadout is reported, and nothing is added to the run', async () => {
            await twoFights(7, 7);
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
            tickOnly('combat_level');
            allSpy.mockResolvedValue({ baseline: null, results: [] });

            await ui._onUpgradeAnalyze();

            expect(allSpy.mock.calls[0][0].extraCandidates).toEqual([]);
            expect(status()).toContain('Not in any loadout: Sinister Cape +7');
            expect(status()).not.toContain('including');
        });

        test('an ability-order-only run has no table, so the queue does not run in it', async () => {
            await twoFights(5, 7);
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
            tickOnly('ability_order');

            await ui._onUpgradeAnalyze();

            for (const call of allSpy.mock.calls) {
                expect(call[0].extraCandidates.some((candidate) => candidate.checkedSwap)).toBe(false);
            }
        });

        test('Check still draws its own table and leaves the generated one alone', async () => {
            await twoFights(5, 7);
            type('combat', 'Sinister Cape', '7');
            ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();

            await ui._onCheckSwapsCombat();

            expect(ui.panel.querySelector('#mwi-labsim-swap-results').textContent).toContain('Checked swaps');
            expect(ui.panel.querySelector('#mwi-labsim-upgrade-results').innerHTML).toBe('');
            expect(status()).toContain('Checked 1 swap');
        });

        test('a single-fight run adds the queued items as extra candidates', async () => {
            game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
            game.editedDTOs = {
                p1: { hrid: 'p1', equipment: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } }, abilities: [] },
            };
            game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
            game.skipLevels = { '/monsters/mimic': 130 };
            ui.destroy();
            ui.buildPanel();
            await settle();
            const singleSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthUpgradeAnalysis');
            try {
                ui._switchTab('upgrade');
                ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
                await ui._restoreUpgradeSelection();
                ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
                type('combat', 'Sinister Cape', '7');
                ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
                tickOnly('combat_level');

                await ui._onUpgradeAnalyze();

                const extras = singleSpy.mock.calls[0][0].extraCandidates;
                expect(extras.filter((candidate) => candidate.checkedSwap)).toHaveLength(1);
                expect(status()).toContain('including 1 queued swap');
            } finally {
                singleSpy.mockRestore();
                game.players = [];
                game.editedDTOs = null;
            }
        });
    });

    test('a saved loadout no fight wears still counts as owned and claims its pieces', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = { '/monsters/mimic': 130 };
        game.loadoutByMonster = { '/monsters/mimic': 1 };
        // Loadout 2 is saved but assigned to no monster, and it wears the +7 cape being checked
        game.loadoutNames = { 1: 'Low Lab', 2: 'Spare Lab' };
        game.loadoutEquipment = {
            1: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } },
            2: { [BACK]: { hrid: CAPE, enhancementLevel: 7 } },
        };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');

        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        await ui._onCheckSwapsCombat();

        const params = allSpy.mock.calls[0][0];
        expect(params.fights).toHaveLength(1);
        expect(params.claimLoadouts.map((entry) => entry.loadoutId).sort()).toEqual([1, 2]);
        // Already worn by the unassigned saved loadout, so nothing is bought
        expect(params.extraCandidates[0]).toMatchObject({ noPurchase: true, cost: 0 });
        allSpy.mockRestore();
        game.loadoutByMonster = {};
        game.loadoutNames = {};
        game.loadoutEquipment = {};
        game.monsters = [];
        game.skipLevels = {};
    });

    test('the section collapses from its header, starts open with a queue and remembers what was chosen', async () => {
        const body = () => ui.panel.querySelector('#mwi-labsim-swap-body-combat');
        const toggle = () => ui.panel.querySelector('#mwi-labsim-swap-toggle-combat').textContent;
        const header = () => ui.panel.querySelector('#mwi-labsim-swap-header-combat');

        // Empty queue, nothing ever chosen: closed
        expect(body().style.display).toBe('none');
        expect(toggle()).toBe('▶');
        header().click();
        expect(body().style.display).toBe('block');
        expect(toggle()).toBe('▼');
        await settle();
        expect(storage.written['labSimCheckedSwaps_me'].options.open).toEqual({ combat: true, skilling: null });

        // Remembered closed, even with a queue
        header().click();
        await settle();
        const saved = { ...storage.written['labSimCheckedSwaps_me'], combat: [{ hrid: CAPE, level: 7 }] };
        expect(saved.options.open.combat).toBe(false);
        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = saved;
        ui.buildPanel();
        await settle();
        expect(body().style.display).toBe('none');
        expect(ui.panel.querySelector('#mwi-labsim-swap-count-combat').textContent).toBe('1 queued');

        // Never chosen, with a queue: open
        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = { combat: [{ hrid: CAPE, level: 7 }], skilling: [] };
        ui.buildPanel();
        await settle();
        expect(body().style.display).toBe('block');
        expect(chips('combat')).toEqual(['Sinister Cape +7']);
    });

    test('Clear empties and hides the checked results, keeps the chips and gives the generated results the room', async () => {
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        const swapResults = ui.panel.querySelector('#mwi-labsim-swap-results');
        swapResults.style.display = 'block';
        swapResults.innerHTML = '<table><tr><td>Checked swaps</td></tr></table>';
        ui.panel.querySelector('#mwi-labsim-swap-clear-combat').click();
        expect(swapResults.innerHTML).toBe('');
        expect(swapResults.style.display).toBe('none');
        expect(chips('combat')).toEqual(['Sinister Cape +7']);
        expect(ui._checkedSwaps.combat).toHaveLength(1);
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-results').style.flex).toBe('1 0 auto');

        const skillingResults = ui.panel.querySelector('#mwi-labsim-skilling-swap-results');
        skillingResults.style.display = 'block';
        skillingResults.innerHTML = '<table></table>';
        ui.panel.querySelector('#mwi-labsim-swap-clear-skilling').click();
        expect(skillingResults.innerHTML).toBe('');
        expect(skillingResults.style.display).toBe('none');
    });

    test('Clear does nothing while a check is running', () => {
        const swapResults = ui.panel.querySelector('#mwi-labsim-swap-results');
        swapResults.style.display = 'block';
        swapResults.innerHTML = '<table></table>';
        ui._upgradeRunning = true;
        ui.panel.querySelector('#mwi-labsim-swap-clear-combat').click();
        expect(swapResults.innerHTML).toBe('<table></table>');
        ui._upgradeRunning = false;
    });

    test('the Upgrades section collapses from its header and remembers the choice', async () => {
        const results = () => ui.panel.querySelector('#mwi-labsim-upgrade-results');
        const toggle = () => ui.panel.querySelector('#mwi-labsim-upgrades-toggle-combat').textContent;
        results().innerHTML = '<table></table>';
        expect(results().style.display).not.toBe('none');
        expect(toggle()).toBe('▼');
        ui.panel.querySelector('#mwi-labsim-upgrades-header-combat').click();
        expect(results().style.display).toBe('none');
        expect(toggle()).toBe('▶');
        await settle();
        const saved = storage.written['labSimCheckedSwaps_me'];
        expect(saved.options.upgradesOpen).toEqual({ combat: false, skilling: true });

        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = saved;
        ui.buildPanel();
        await settle();
        expect(results().style.display).toBe('none');
        expect(toggle()).toBe('▶');

        // The Skilling tab has its own, independent header
        expect(ui.panel.querySelector('#mwi-labsim-skilling-results').style.display).not.toBe('none');
        ui.panel.querySelector('#mwi-labsim-upgrades-header-skilling').click();
        expect(ui.panel.querySelector('#mwi-labsim-skilling-results').style.display).toBe('none');
        ui.panel.querySelector('#mwi-labsim-upgrades-header-combat').click();
        expect(results().style.display).toBe('');
    });

    test('All loadouts is remembered per character and reaches the candidates', async () => {
        const box = () => ui.panel.querySelector('#mwi-labsim-swap-all-combat');
        expect(box().checked).toBe(false);
        box().checked = true;
        box().dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        const saved = storage.written['labSimCheckedSwaps_me'];
        expect(saved.options.all.combat).toBe(true);

        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = saved;
        ui.buildPanel();
        await settle();
        expect(box().checked).toBe(true);
        expect(ui._swapOptions.all.combat).toBe(true);
    });

    test('the Configure fight is checked against the edited player at the configured level, not the assigned loadout', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        // No skip level at all for the monster: the assigned-loadout path would find no fight
        game.skipLevels = {};
        game.loadoutEquipment = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = {
            p1: { hrid: 'p1', equipment: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } }, abilities: [] },
        };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();

        await ui._onCheckSwapsCombat();

        expect(allSpy).toHaveBeenCalledTimes(1);
        const { fights, extraCandidates } = allSpy.mock.calls[0][0];
        expect(fights).toHaveLength(1);
        expect(fights[0]).toMatchObject({ monsterHrid: '/monsters/mimic', roomLevel: 170 });
        expect(fights[0].dto.equipment[BACK]).toEqual({ hrid: CAPE, enhancementLevel: 5 });
        // A copy: the editor follows level-ups in place, and the check keeps the build it started with
        expect(fights[0].dto).not.toBe(game.editedDTOs.p1);
        expect(extraCandidates[0]).toMatchObject({ checkedSwap: true, currentLevel: 5, upgradeLevel: 7 });
        allSpy.mockRestore();
        game.editedDTOs = null;
        game.players = [];
        game.monsters = [];
    });

    test('the live character Configure fight still owns what its saved loadouts wear', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.loadoutNames = { 2: 'Spare Lab' };
        game.loadoutEquipment = { 2: { [BACK]: { hrid: CAPE, enhancementLevel: 7 } } };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = {
            p1: { hrid: 'p1', equipment: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } }, abilities: [] },
        };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();

        await ui._onCheckSwapsCombat();

        const params = allSpy.mock.calls[0][0];
        expect(params.fights).toHaveLength(1);
        expect((params.claimLoadouts || []).some((entry) => entry.loadoutId === 2)).toBe(true);
        // The +7 is worn by a saved loadout, so the swap buys nothing
        expect(params.extraCandidates[0]).toMatchObject({ noPurchase: true, cost: 0 });
        allSpy.mockRestore();
        game.editedDTOs = null;
        game.players = [];
        game.monsters = [];
        game.loadoutNames = {};
        game.loadoutEquipment = {};
    });

    test('a Configure fight that is a party member is priced without the live character spare copies', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = {
            p1: { hrid: 'p1', equipment: {}, abilities: [] },
            p2: { hrid: 'p2', equipment: { [BACK]: { hrid: CAPE, enhancementLevel: 5 } }, abilities: [] },
        };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        const select = ui.panel.querySelector('#mwi-labsim-upgrade-player');
        select.innerHTML = '<option value="0">Me</option><option value="1">Friend</option>';
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis');
        const costSpy = vi.spyOn(upgradeAdvisor, 'calculateUpgradeCost');
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();

        select.value = '1';
        await ui._onCheckSwapsCombat();
        expect(costSpy.mock.calls.at(-1)[2]).toBe(false);

        select.value = '0';
        game.editedDTOs.p1.equipment = { [BACK]: { hrid: CAPE, enhancementLevel: 5 } };
        await ui._onCheckSwapsCombat();
        expect(costSpy.mock.calls.at(-1)[2]).toBe(true);

        allSpy.mockRestore();
        costSpy.mockRestore();
        game.editedDTOs = null;
        game.players = [];
        game.monsters = [];
    });

    test('a stale check finishing after a character switch does not clear the new run guard', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = { p1: { hrid: 'p1', equipment: {}, abilities: [] } };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis').mockImplementation(async () => {
            await gate;
            return { baseline: null, results: [] };
        });
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();

        const stale = ui._onCheckSwapsCombat();
        await settle();
        expect(ui._upgradeRunning).toBe(true);

        // The character switches; a run for the arriving character is under way
        ui.destroy();
        ui._upgradeRunning = true;
        release();
        await stale;

        expect(ui._upgradeRunning).toBe(true);
        ui._upgradeRunning = false;
        allSpy.mockRestore();
        game.editedDTOs = null;
        game.players = [];
        game.monsters = [];
    });

    test('a stale check resuming after the panel was rebuilt for the same character stops without touching status', async () => {
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [] }];
        game.editedDTOs = { p1: { hrid: 'p1', equipment: {}, abilities: [] } };
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        ui.panel.querySelector('#mwi-labsim-level').value = '170';
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const results = combatAnalysis();
        let staleAbort;
        const allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis').mockImplementation(async (...args) => {
            staleAbort = args.at(-1)?.abortSignal;
            await gate;
            return results;
        });
        type('combat', 'Sinister Cape', '7');
        ui.panel.querySelector('#mwi-labsim-swap-add-combat').click();
        const stale = ui._onCheckSwapsCombat();
        await settle();
        expect(staleAbort()).toBe(false);

        // Same character, new panel; its status line says something of its own
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._setStatus('fresh panel status');
        // A new run clears the shared flag; the stale analysis is still told to stop
        ui._upgradeAborted = false;
        expect(staleAbort()).toBe(true);
        release();
        await stale;

        expect(ui.panel.querySelector('#mwi-labsim-status').textContent).toBe('fresh panel status');
        expect(ui.panel.querySelector('#mwi-labsim-swap-results').innerHTML).toBe('');
        allSpy.mockRestore();
        game.editedDTOs = null;
        game.players = [];
        game.monsters = [];
    });

    test('a stale Skilling task after a rebuild for the same character is aborted and reports nothing', async () => {
        ui.buildPanel();
        await settle();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        let sawAborted = null;
        const stale = ui._runSkillingTask(async (onProgress, isAborted) => {
            await gate;
            sawAborted = isAborted();
            onProgress({ current: 1, total: 2, description: 'late progress' });
            throw new Error('late failure');
        });

        // Same character, new panel, with its own skilling run flag already reset
        ui.destroy();
        ui.buildPanel();
        await settle();
        ui._setStatus('fresh panel status');
        const progressText = ui.panel.querySelector('#mwi-labsim-skilling-progress-text').textContent;
        release();
        await stale;

        expect(sawAborted).toBe(true);
        expect(ui.panel.querySelector('#mwi-labsim-skilling-progress-text').textContent).toBe(progressText);
        expect(ui.panel.querySelector('#mwi-labsim-status').textContent).toBe('fresh panel status');
    });

    test('the same for the Skilling task runner', async () => {
        ui.buildPanel();
        await settle();
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const stale = ui._runSkillingTask(async () => {
            await gate;
        });
        expect(ui._skillingRunning).toBe(true);

        ui.destroy();
        ui._skillingRunning = true;
        release();
        await stale;

        expect(ui._skillingRunning).toBe(true);
        ui._skillingRunning = false;
    });

    test('the checked combat table has the generated columns and a per-fight breakdown on click', () => {
        const container = document.createElement('div');
        ui._renderAllFightsResults(combatAnalysis(), container, { checked: true });

        expect(container.textContent).toContain('Checked swaps');
        const headers = [...container.querySelectorAll('th')].map((th) => th.textContent.replace(/[▲▼]/, '').trim());
        expect(headers).toEqual(['Upgrade', 'Cost', 'Per 1M', 'Attempts', 'ΔAttempts', 'Rooms', 'Avg ΔWin']);
        const row = container.querySelector('tr[data-allfights-row]');
        expect(row.textContent).toContain('Sinister Cape +5 → +7');
        expect(row.textContent).toContain('1 / 2');
        const detail = container.querySelector('[data-allfights-detail]');
        expect(detail.style.display).toBe('none');
        row.click();
        expect(detail.style.display).toBe('table-row');
        expect(detail.textContent).toContain('29.5% → 31.9%');
        expect(detail.textContent).toContain('(not in this loadout): Mimic 60.0%');
        expect(detail.textContent).toContain('Checked by hand.');
        // And it is a note, not the "on task" badge a task caveat draws
        expect(row.textContent).not.toContain('on task');
    });

    test('drawing the checked table leaves the generated table’s state alone', () => {
        const generated = document.createElement('div');
        const generatedResult = combatAnalysis();
        generatedResult.results[0].candidate.description = 'Generated Row';
        ui._renderAllFightsResults(generatedResult, generated);
        const before = generated.innerHTML;

        const checked = document.createElement('div');
        ui._renderAllFightsResults(combatAnalysis(), checked, { checked: true });
        // Sorting the checked table re-draws it, still not the generated one
        checked.querySelector('th[data-af-sort="cost"]').click();

        expect(ui._allFightsResult).toBe(generatedResult);
        expect(ui._allFightsContainer).toBe(generated);
        expect(ui._allFightsSort).toBeFalsy();
        expect(ui._checkedSwapSort).toMatchObject({ key: 'cost' });
        expect(generated.innerHTML).toBe(before);
        expect(generated.textContent).toContain('Generated Row');
        expect(generated.textContent).not.toContain('Checked swaps');
        // The generated table keeps its budget box; the checked one has none
        expect(generated.querySelector('#mwi-labsim-budget')).toBeTruthy();
        expect(checked.querySelector('#mwi-labsim-budget')).toBeNull();
    });

    test('Check a swap no longer has an Ability order button, and a saved queue drops an old order chip', async () => {
        expect(ui.panel.querySelector('#mwi-labsim-swap-order-combat')).toBeNull();
        storage.values = {
            labSimCheckedSwaps_me: {
                combat: [
                    { hrid: '/abilities/__order__', level: 0 },
                    { hrid: CAPE, level: 2 },
                ],
                skilling: [],
            },
        };
        await ui._restoreCheckedSwaps({ replace: true });
        expect(chips('combat')).toEqual(['Sinister Cape +2']);
        expect(ui._checkedSwaps.combat).toEqual([{ hrid: CAPE, level: 2 }]);
        storage.values = {};
    });

    test('the checked combat results collapse from the heading, stay collapsed on a re-render and are remembered', async () => {
        const results = ui.panel.querySelector('#mwi-labsim-swap-results');
        const heading = () => results.querySelector('[data-checked-heading]');
        const hidden = () => [...results.children].filter((el) => el !== heading()).map((el) => el.style.display);
        ui._renderAllFightsResults(combatAnalysis(), results, { checked: true });
        expect(heading().textContent).toContain('Checked swaps');
        expect(heading().textContent).toContain('▼');
        expect(hidden().every((display) => display === '')).toBe(true);

        heading().click();
        expect(heading().textContent).toContain('▶');
        expect(hidden().length).toBeGreaterThan(0);
        expect(hidden().every((display) => display === 'none')).toBe(true);

        // A re-draw (a sort here, a new Check likewise) keeps it collapsed
        results.querySelector('th[data-af-sort="cost"]').click?.();
        ui._renderAllFightsResults(combatAnalysis(), results, { checked: true });
        expect(heading().textContent).toContain('▶');
        expect(hidden().every((display) => display === 'none')).toBe(true);

        await settle();
        const saved = storage.written['labSimCheckedSwaps_me'];
        expect(saved.options.checkedOpen).toEqual({ combat: false, skilling: true });

        // Remembered per tab and across a rebuild
        ui.destroy();
        storage.values['labSimCheckedSwaps_me'] = saved;
        ui.buildPanel();
        await settle();
        const rebuilt = ui.panel.querySelector('#mwi-labsim-swap-results');
        ui._renderAllFightsResults(combatAnalysis(), rebuilt, { checked: true });
        expect(rebuilt.querySelector('[data-checked-toggle]').textContent).toBe('▶');
        const skilling = ui.panel.querySelector('#mwi-labsim-skilling-swap-results');
        ui._renderSkillingUpgradeResults(
            {
                baseline: { clearRate: 0.5 },
                results: [
                    {
                        candidate: { description: 'Tool +7', merged: true },
                        costType: 'gold',
                        cost: 5_000_000,
                        clearRate: 0.5,
                        clearRateDelta: 0.004,
                        metricType: 'clearRate',
                    },
                ],
            },
            skilling,
            { checked: true }
        );
        expect(skilling.querySelector('[data-checked-toggle]').textContent).toBe('▼');
        const tableDisplay = () => skilling.querySelector('.mwi-utable-wrap').style.display;
        expect(tableDisplay()).toBe('');
        skilling.querySelector('[data-checked-heading]').click();
        expect(tableDisplay()).toBe('none');
        expect(rebuilt.querySelector('.mwi-utable-wrap').style.display).toBe('none');
    });

    test('a kept piece worth nothing produces no resale sentence, and an unpriced one says so', () => {
        const note = (kept, keptValue) =>
            ui._renderAllFightsNotes({ costDetail: { kept, keptValue }, candidate: { checkedSwap: true } });
        expect(note([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0, priced: true }], 0)).not.toContain(
            'resale of'
        );
        expect(note([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0, priced: true }], 0)).toBe('');
        expect(note([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0 }], NaN)).toBe('');

        const unpriced = note([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0, priced: false }], 0);
        expect(unpriced).toContain('Keeping Sinister Cape +7');
        expect(unpriced).toContain('no price');
        expect(unpriced).not.toContain('resale of');

        // The cost breakdown line agrees
        const breakdown = (kept, keptValue) =>
            ui._renderCostBreakdown({ buys: [], credits: [], unpriced: [], kept, keptValue, gross: 0, net: 0 });
        expect(breakdown([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0, priced: true }], 0)).not.toContain(
            'Keeping'
        );
        expect(breakdown([{ name: 'Sinister Cape', enhancementLevel: 7, price: 0, priced: false }], 0)).toContain(
            'no price'
        );
    });

    test('a checked skilling row says a kept piece is worn by a kit the swap does not reach', () => {
        const container = document.createElement('div');
        const row = {
            candidate: {
                description: 'Celestial Milking Tool +7 (milking)',
                merged: true,
                checkedSwap: true,
                keptItems: [{ hrid: '/items/holy_milking_tool', enhancementLevel: 5 }],
                keptUnreached: true,
            },
            costType: 'gold',
            cost: 5_000_000,
            clearRate: 0.5,
            clearRateDelta: 0.004,
            metricType: 'clearRate',
            costDetail: {
                buys: [{ name: 'Celestial Milking Tool', enhancementLevel: 7, price: 5_000_000 }],
                credits: [],
                unpriced: [],
                kept: [{ name: 'Holy Milking Tool', enhancementLevel: 5, price: 2_000_000 }],
                keptValue: 2_000_000,
                gross: 5_000_000,
                net: 5_000_000,
            },
        };
        ui._renderSkillingUpgradeResults({ baseline: { clearRate: 0.496 }, results: [row] }, container, {
            checked: true,
        });

        expect(container.innerHTML).toContain('a skill kit this swap does not reach still wears it');
        expect(container.innerHTML).not.toContain('is combat gear you keep in a loadout');
    });

    test('the checked skilling table has the generated columns and the per-skill breakdown', () => {
        const container = document.createElement('div');
        const lines = [
            {
                skillHrid: '/skills/milking',
                skillName: 'Milking',
                roomLevel: 120,
                before: 0.27,
                after: 0.274,
                delta: 0.004,
                triesBefore: 3.7,
                triesAfter: 3.65,
                affected: true,
            },
            {
                skillHrid: '/skills/cooking',
                skillName: 'Cooking',
                roomLevel: 90,
                before: 0.3,
                after: 0.3,
                delta: 0,
                triesBefore: 3.33,
                triesAfter: 3.33,
                affected: false,
            },
        ];
        const row = {
            candidate: { description: 'Celestial Milking Tool +2 → +7 (milking)', merged: true },
            costType: 'gold',
            cost: 5_000_000,
            clearRate: 0.5,
            clearRateDelta: 0.004,
            metricType: 'clearRate',
            rooms: { affected: 1, total: 2 },
            tries: 6.98,
            triesDelta: -0.05,
            breakdownLines: lines,
        };
        const generatedHandler = ui._skillingSortHandler;
        ui._renderSkillingUpgradeResults({ baseline: { clearRate: 0.496 }, results: [row] }, container, {
            checked: true,
        });

        expect(container.textContent).toContain('Checked swaps');
        const headers = [...container.querySelectorAll('th')].map((th) => th.textContent.trim());
        expect(headers).toEqual(expect.arrayContaining(['Upgrade', 'Cost', 'Rooms', 'Tries', 'ΔTries']));
        expect(container.querySelector('input[data-skilling-pick]')).toBeNull();
        const tr = container.querySelector('tr[data-skilling-gold-row]');
        expect(tr.textContent).toContain('1 / 2');
        tr.click();
        const detail = container.querySelector('[data-skilling-gold-detail]');
        expect(detail.querySelector('[data-skill-breakdown-line="/skills/milking"]').textContent).toContain(
            '27.0% → 27.4% (+0.40%)'
        );
        expect(detail.querySelector('[data-skill-breakdown-line="/skills/cooking"]').textContent).toContain(
            'unaffected'
        );
        // Its click handler is its own: the generated table's is left where it was
        expect(ui._skillingSortHandler).toBe(generatedHandler);
        expect(ui._skillingSwapSortHandler).toEqual(expect.any(Function));
    });
});
