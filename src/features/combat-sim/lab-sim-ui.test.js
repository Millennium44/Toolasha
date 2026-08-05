/** @vitest-environment happy-dom
 *
 * Where the Lab Sim panel opens, and what its Upgrade tab offers.
 *
 * The panel used to hardcode `top:60px; right:60px` on every build and throw
 * away the result of both its resize grips, so a panel you dragged somewhere
 * useful was back in the top-right corner on the next reload. The first half of
 * this file is about the geometry store now doing that remembering.
 *
 * The second half is about the Upgrade tab, which used to be a single Mode
 * dropdown whose entries were the cross-product of "which kind of upgrade" and
 * "which fights" — with most of the cross missing. It is now a set of
 * checkboxes plus a target scope, and what is worth asserting is that the two
 * controls are actually independent and that a combination the analysis cannot
 * run is visibly unavailable rather than quietly ignored.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null, wasOpen: false, restoreCalls: [], saveCalls: [], openCalls: [] }));
const game = vi.hoisted(() => ({
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
}));
const sim = vi.hoisted(() => ({ calls: [] }));
/** Every key the panel wrote, so a persisted choice can be asserted on */
const storage = vi.hoisted(() => ({ written: {} }));
const rowActions = vi.hoisted(() => ({ wired: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 100,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        setSetting: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        set: async (key, value) => {
            storage.written[key] = value;
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: {} }),
        getItemDetails: () => null,
        getSkills: () => [],
        getInventory: () => [],
        // The scoped-storage helpers key on the character; without these the
        // panel's own restore throws before it can read anything back
        getCurrentCharacterId: () => 'me',
        getCurrentCharacterGameMode: () => 'standard',
        characterItems: [],
        characterEquipment: new Map(),
        characterData: { characterAbilities: [] },
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
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({
        itemDetailMap: {},
        actionDetailMap: { '/actions/combat/fly': {} },
        houseRoomDetailMap: game.houseRoomDetailMap,
    }),
    buildAllPlayerDTOs: async () => ({ players: game.players, selfHrid: game.players[0]?.hrid }),
    getCombatZones: () => [],
    getCommunityBuffs: () => ({}),
    getLabyrinthMonsters: () => game.monsters,
}));

vi.mock('./combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (params) => {
        sim.calls.push(params);
        return { labyAttemptCount: 100, encounters: 70, deaths: {}, simulatedTime: 3 * 3600 * 1e9 };
    },
    cancelSimulation: () => {},
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
vi.mock('./combat-sim-ui.js', () => ({
    default: {
        upgradeRowPurchase: () => null,
        upgradeRowActionsHtml: (result) =>
            `<button data-shared-action="${result?.candidate?.description || ''}">buttons</button>`,
        wireUpgradeRowActions: (container) => {
            rowActions.wired.push(container);
        },
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
        getLabyrinthCombatBuffs: () => [],
        getCombatSkipRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getCombatRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getRecommendedCombatRoomLevel: (hrid) => game.recommendedLevels[hrid] || 0,
        getLabyrinthLoadoutId: () => null,
        buildLabyrinthPlayerDTO: () => ({ equipment: {}, abilities: [], houseRooms: { ...game.houseRooms } }),
        getPlayerEffectiveCombatLevel: () => 100,
        estimateCombatXpPerHour: () => 0,
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
            clearChance: Math.min(1, 0.5 + metrics.efficiencyBonus + metrics.gatheringBonus),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
        computeEnhancingClearWithParams: (metrics, baseLevel, roomLevel) => ({
            clearChance: Math.min(1, 0.5 + metrics.actionSpeedBonus),
            xpPerRoom: roomLevel * 50 * (1 + metrics.experienceBonus),
            baseLevel,
            effectiveLevel: baseLevel,
            successChance: 0.8,
            attempts: 10,
        }),
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: { get: () => null, snapshots: {} } }));

const { default: ui, describeAllFightsPlan } = await import('./lab-sim-ui.js');
const { estimateLabUpgradeSims } = await import('./lab-sim-upgrade-modes.js');

/** A pointer event happy-dom will hand to the drag helper's listeners. */
function pointer(type, x, y) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, button: 0 });
    return event;
}

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

describe('the Lab Sim panel remembers where it was left', () => {
    beforeEach(() => {
        geometry.saved = null;
        geometry.wasOpen = false;
        geometry.restoreCalls = [];
        geometry.saveCalls = [];
        geometry.openCalls = [];
        game.monsters = [];
        game.skipLevels = {};
    });

    afterEach(() => {
        ui.destroy();
    });

    test('with nothing saved it opens at its designed corner', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.right).toBe('60px');
        expect(ui.panel.style.top).toBe('60px');
        // The viewport-clamped `min(900px, 96vw)` from the stylesheet still
        // governs the size — nothing has overwritten it with a pixel figure
        expect(ui.panel.style.width).not.toMatch(/px/);
    });

    test('a saved geometry wins over the corner it would otherwise open at', async () => {
        geometry.saved = { left: 120, top: 40, width: 640, height: 480 };

        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.left).toBe('120px');
        expect(ui.panel.style.top).toBe('40px');
        expect(ui.panel.style.width).toBe('640px');
        expect(ui.panel.style.height).toBe('480px');
        // Anchoring by the left edge from here on, or a window resize moves it
        expect(ui.panel.style.right).toBe('auto');
    });

    test('it asks the store under its own key, with its own floor size', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(geometry.restoreCalls[0]).toMatchObject({
            panelKey: 'labSimPanel',
            min: { width: 400, height: 300 },
        });
    });

    test('dropping it somewhere writes that somewhere down', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointermove', 260, 180));
        document.dispatchEvent(pointer('pointerup', 260, 180));

        expect(geometry.saveCalls).toHaveLength(1);
        expect(geometry.saveCalls[0].panelKey).toBe('labSimPanel');
        expect(geometry.saveCalls[0].values).toMatchObject({ left: 60, top: 80 });
    });

    test('a click on the header that never moved is not a move worth saving', async () => {
        ui.buildPanel();
        await Promise.resolve();

        const header = ui.panel.firstChild;
        header.dispatchEvent(pointer('pointerdown', 200, 100));
        document.dispatchEvent(pointer('pointerup', 200, 100));

        expect(geometry.saveCalls).toHaveLength(0);
    });

    test('a panel left closed stays closed on the next load', async () => {
        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.display).toBe('none');
    });

    test('but a panel left open comes back up', async () => {
        // A refresh mid-analysis used to lose the panel entirely, which is what
        // reversed the original "a simulator opens when asked" choice
        geometry.wasOpen = true;

        ui.buildPanel();
        await Promise.resolve();

        expect(ui.panel.style.display).toBe('flex');
        // Restoring a panel is not itself an opening worth recording
        expect(geometry.openCalls).toEqual([]);
    });

    test('opening and closing it by hand is what gets remembered', async () => {
        ui.buildPanel();
        await Promise.resolve();

        ui.toggle();
        ui.toggle();

        expect(geometry.openCalls).toEqual([
            { panelKey: 'labSimPanel', open: true },
            { panelKey: 'labSimPanel', open: false },
        ]);
    });
});

describe('the Upgrade tab asks two questions instead of one', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [
            { hrid: '/monsters/gobo_chief', name: 'Gobo Chief' },
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/gobo_chief': 110, '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
    });

    afterEach(() => {
        ui.destroy();
    });

    const boxes = () => [...ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')];
    const box = (key) => ui.panel.querySelector(`[data-lab-upgrade-dimension="${key}"]`);
    const scope = () => ui.panel.querySelector('#mwi-labsim-upgrade-scope');

    const setScope = (value) => {
        scope().value = value;
        scope().dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const check = (key, checked) => {
        box(key).checked = checked;
        box(key).dispatchEvent(new window.Event('change', { bubbles: true }));
    };

    test('the single Mode dropdown is gone, replaced by one checkbox per candidate set', () => {
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-mode')).toBeNull();
        expect(boxes().map((b) => b.getAttribute('data-lab-upgrade-dimension'))).toEqual([
            'equipment',
            'ability_level',
            'ability_swap',
            'house',
            'combat_level',
            'guild_shrine',
        ]);
    });

    test('several sets can be checked at once', () => {
        check('ability_level', true);
        check('guild_shrine', true);
        expect(ui._getUpgradeDimensions()).toEqual(['equipment', 'ability_level', 'guild_shrine']);
    });

    test('the target scope is its own control, with all targets among the options', () => {
        expect([...scope().options].map((o) => o.value)).toEqual(['current', 'all', 'selected']);
        // Opens where the old dropdown opened: the Configure tab's fight
        expect(scope().value).toBe('current');
    });

    test('choosing a subset lists every fight that resolves to a room level', () => {
        setScope('selected');

        const list = ui.panel.querySelector('#mwi-labsim-target-list');
        expect(list.style.display).toBe('flex');
        expect([...list.querySelectorAll('[data-lab-target]')].map((b) => b.getAttribute('data-lab-target'))).toEqual([
            '/monsters/gobo_chief',
            '/monsters/mimic',
            '/monsters/eye_watcher',
        ]);
        expect(list.textContent).toContain('Gobo Chief');
        expect(list.textContent).toContain('L130');
    });

    test('a fight with no resolvable room level is not offered as a target', () => {
        game.skipLevels = { '/monsters/mimic': 130 };
        ui._populateUpgradeTargets();

        const offered = [...ui.panel.querySelectorAll('[data-lab-target]')].map((b) =>
            b.getAttribute('data-lab-target')
        );
        expect(offered).toEqual(['/monsters/mimic']);
    });

    test('the subset picker only shows for the subset scope', () => {
        setScope('all');
        expect(ui.panel.querySelector('#mwi-labsim-target-list').style.display).toBe('none');
        setScope('selected');
        expect(ui.panel.querySelector('#mwi-labsim-target-list').style.display).toBe('flex');
    });

    test('the skip-level rule only appears once the labyrinth fight list is in play', () => {
        const label = ui.panel.querySelector('#mwi-labsim-allfights-useskip-label');
        expect(label.style.display).toBe('none');
        setScope('all');
        expect(label.style.display).toBe('flex');
    });

    test('scope and sets are independent — the old exclusive "— All Fights" modes are gone', () => {
        check('equipment', true);
        check('guild_shrine', true);
        setScope('all');

        const plan = ui._planFromControls();
        expect(plan).toMatchObject({ kind: 'allFights', modes: ['equipment', 'guild_shrine'] });
        expect(plan.monsterHrids).toHaveLength(3);
    });

    test('a subset of the fights runs only those fights', () => {
        setScope('selected');
        const mimic = ui.panel.querySelector('[data-lab-target="/monsters/mimic"]');
        mimic.checked = true;
        mimic.dispatchEvent(new window.Event('change', { bubbles: true }));

        expect(ui._planFromControls()).toMatchObject({ kind: 'allFights', monsterHrids: ['/monsters/mimic'] });
    });

    test('ability swaps are offered across several fights, with no refusal left on the label', () => {
        // They used to be disabled here, on the grounds that a hundred-odd
        // candidates times a labyrinth is thousands of sims. The size is now
        // handled by shortening each sim and saying the count up front.
        setScope('all');

        expect(box('ability_swap').disabled).toBe(false);
        const label = ui.panel.querySelector('[data-lab-mode-label="ability_swap"]');
        expect(label.title).not.toMatch(/single target|one fight at a time/);
        expect(ui.panel.querySelector('[data-lab-mode-chip="ability_swap"]').style.opacity).toBe('1');
    });

    test('and they reach the multi-fight analysis instead of being dropped from the plan', () => {
        check('ability_swap', true);
        setScope('all');

        expect(ui._planFromControls()).toMatchObject({
            kind: 'allFights',
            modes: ['equipment', 'ability_swap'],
            dropped: [],
        });
    });

    test('the Crit Aura switch is gone, superseded by the guide-based aura swaps', () => {
        // It was a hand-built one-off candidate for one ability. Ability Swaps
        // now offers whichever aura the loadout's archetype actually calls for,
        // both sides of the OR, ranked with everything else and priced the same
        expect(ui.panel.querySelector('#mwi-labsim-crit-aura')).toBeNull();
        expect(ui.panel.querySelector('#mwi-labsim-crit-aura-label')).toBeNull();
    });

    test('Signature only sits inside the Ability Swaps chip and hides with it', () => {
        const group = ui.panel.querySelector('[data-lab-mode-options="ability_swap"]');
        expect(ui.panel.querySelector('[data-lab-mode-chip="ability_swap"]').contains(group)).toBe(true);

        check('ability_swap', false);
        expect(group.style.display).toBe('none');
        check('ability_swap', true);
        expect(group.style.display).toBe('inline-flex');
    });

    test('and means nothing while Ability Swaps is unchecked', () => {
        ui.panel.querySelector('#mwi-labsim-swap-signature-only').checked = true;
        check('ability_swap', false);
        expect(ui._getSignatureSwapsOnly()).toBe(false);

        check('ability_swap', true);
        expect(ui._getSignatureSwapsOnly()).toBe(true);
    });

    test('the choice is written down like its neighbours, box state and all', async () => {
        check('ability_swap', true);
        const signature = ui.panel.querySelector('#mwi-labsim-swap-signature-only');
        signature.checked = true;
        signature.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();
        expect(storage.written['labSimSwapSignatureOnly_me']).toBe(true);

        // Unchecking the set must not save a false over the tick — it would be
        // lost the moment Ability Swaps was checked again
        check('ability_swap', false);
        await settle();
        expect(storage.written['labSimSwapSignatureOnly_me']).toBe(true);
    });

    test('the size of a swap run across every fight is said before it starts', () => {
        check('ability_swap', true);
        setScope('all');

        const estimate = estimateLabUpgradeSims(ui._getUpgradeDimensions(), ui._upgradeTargetCount());
        // The count and the fights it covers, before the first simulation and
        // while Stop still costs nothing. Not flagged heavy any more: the build
        // guide narrowed swaps from every style-compatible ability to one
        // archetype's set, which is what took this run under the warning bar
        expect(estimate.heavy).toBe(false);
        expect(estimate.text).toMatch(/about [\d,]+ simulations \(3 fights\)/);
    });

    test('and what the analysis actually planned replaces the estimate', () => {
        const text = describeAllFightsPlan({
            candidates: 284,
            fights: 12,
            sims: 1043,
            requestedHours: 10,
            trialScale: 0.48,
            reduced: true,
        });

        expect(text).toContain('284 upgrades across 12 fights');
        expect(text).toContain('1,043 simulations');
        // Bounded trials, never sampled fights — the sentence has to say which
        expect(text).toContain('48% of the 10h');
        expect(text).toContain('every fight is still simulated');
    });

    test('a run small enough to leave the trials alone does not claim it shortened them', () => {
        const text = describeAllFightsPlan({
            candidates: 30,
            fights: 3,
            sims: 64,
            requestedHours: 10,
            trialScale: 1,
            reduced: false,
        });

        expect(text).toContain('64 simulations');
        expect(text).not.toContain('%');
    });

    test('the per-ability Target Lv rule is disabled where it cannot be honoured', () => {
        const levelType = ui.panel.querySelector('#mwi-labsim-upgrade-level-type');
        check('ability_level', true);
        expect(levelType.disabled).toBe(false);

        setScope('all');

        expect(levelType.disabled).toBe(true);
        expect(levelType.value).toBe('increment');
        expect(levelType.title).toMatch(/uniform/);
    });

    test('the options for a set only show while that set is checked', () => {
        const levelGroup = ui.panel.querySelector('#mwi-labsim-upgrade-level-group');
        expect(levelGroup.style.display).toBe('none');
        check('ability_level', true);
        expect(levelGroup.style.display).toBe('inline-flex');
        check('ability_level', false);
        expect(levelGroup.style.display).toBe('none');
    });

    test('combat levels borrow the boost box, and get a number to work with', () => {
        const levelGroup = ui.panel.querySelector('#mwi-labsim-upgrade-level-group');
        const levelInput = ui.panel.querySelector('#mwi-labsim-upgrade-target-level');
        levelInput.value = '';

        check('combat_level', true);

        expect(levelGroup.style.display).toBe('inline-flex');
        expect(levelInput.value).toBe('5');
    });

    test('nothing checked is refused rather than run empty', () => {
        for (const b of boxes()) if (b.checked) check(b.getAttribute('data-lab-upgrade-dimension'), false);
        expect(ui._planFromControls().kind).toBe('none');
    });

    test('house rooms are offered for every scope now, not just the Configure fight', () => {
        for (const value of ['current', 'all', 'selected']) {
            setScope(value);
            expect(box('house').disabled).toBe(false);
            expect(ui.panel.querySelector('[data-lab-mode-chip="house"]').style.opacity).toBe('1');
        }
    });

    test('and a whole-run selection carries them into the analysis rather than dropping them', () => {
        check('equipment', false);
        check('house', true);
        setScope('all');

        expect(ui._planFromControls()).toMatchObject({ kind: 'allFights', modes: ['house'], dropped: [] });
    });
});

/**
 * The one thing about a house room that used to be silently wrong.
 *
 * A room level is not held in a loadout, and the applier both labyrinth
 * analyses build each candidate's character with had no branch for one — so a
 * house candidate was installed as a piece of equipment in a slot named after
 * the room, the simulation ran the *unchanged* character, and the row came back
 * a confident +0.00%. The panel worked around it with a pass of its own, which
 * is why the dimension was Configure-fight only.
 *
 * The branch exists, the workaround is gone, and what is worth asserting is the
 * thing the workaround existed to guarantee: that the raised level reaches the
 * character the simulation is handed — through the shared path, in both scopes.
 * The advisor is deliberately *not* mocked here; only the simulator is.
 */
describe('a house room level reaches the character the simulation is handed', () => {
    const DAIRY = '/house_rooms/dairy_barn';
    const GARDEN = '/house_rooms/garden';

    const houseRoomsSimmed = () => sim.calls.map((call) => call.playerDTOs[0].houseRooms);

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        sim.calls = [];
        game.monsters = [
            { hrid: '/monsters/mimic', name: 'Mimic' },
            { hrid: '/monsters/eye_watcher', name: 'Eye Watcher' },
        ];
        game.skipLevels = { '/monsters/mimic': 130, '/monsters/eye_watcher': 150 };
        game.houseRooms = { [DAIRY]: 4, [GARDEN]: 2 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: { ...game.houseRooms } }];
        // Two rooms the combat engine reads, so both are candidates
        game.houseRoomDetailMap = {
            [DAIRY]: { name: 'Dairy Barn', actionBuffs: [{ typeHrid: '/buff_types/armor' }] },
            [GARDEN]: { name: 'Garden', actionBuffs: [{ typeHrid: '/buff_types/damage' }] },
            // A skilling-only room, which must never appear
            '/house_rooms/brewery': { name: 'Brewery', actionBuffs: [{ typeHrid: '/buff_types/efficiency' }] },
        };

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        // After the restore rather than before it, or the restore's own default
        // lands last. This suite is about the room, not the level it is fought at.
        await ui._restoreUpgradeSelection();
        ui.panel.querySelector('#mwi-labsim-level-source').value = 'configure';
    });

    afterEach(() => {
        game.houseRooms = {};
        game.houseRoomDetailMap = {};
        game.players = [];
        ui.destroy();
    });

    const checkOnlyHouse = () => {
        for (const b of ui.panel.querySelectorAll('[data-lab-upgrade-dimension]')) {
            b.checked = b.getAttribute('data-lab-upgrade-dimension') === 'house';
            b.dispatchEvent(new window.Event('change', { bubbles: true }));
        }
    };

    test('the Configure fight sims each room one level up, and nothing else moved', async () => {
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        // A baseline plus one run per combat-relevant room
        expect(sim.calls).toHaveLength(3);
        expect(houseRoomsSimmed()[0]).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });
        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 5, [GARDEN]: 2 });
        expect(houseRoomsSimmed()).toContainEqual({ [DAIRY]: 4, [GARDEN]: 3 });
        // The Brewery buffs a skill, not a fight
        expect(JSON.stringify(houseRoomsSimmed())).not.toContain('brewery');
    });

    test('the panel’s own character is never the one that gets the level', async () => {
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        expect(game.players[0].houseRooms).toEqual({ [DAIRY]: 4, [GARDEN]: 2 });
    });

    test('across every fight the same room level is installed into each of them', async () => {
        checkOnlyHouse();
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));

        await ui._onUpgradeAnalyze();

        // Two fights' baselines, then each room against each fight — a room
        // level is the character's, so every fight is one it reaches
        const raised = houseRoomsSimmed().filter((rooms) => rooms[DAIRY] === 5);
        expect(raised).toHaveLength(2);
        const levels = sim.calls.filter((call) => call.playerDTOs[0].houseRooms[DAIRY] === 5).map((c) => c.roomLevel);
        expect(levels.sort()).toEqual([130, 150]);
    });

    test('a house with every combat room maxed says so rather than reading as no upgrades', async () => {
        game.houseRooms = { [DAIRY]: 8, [GARDEN]: 8 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: { ...game.houseRooms } }];
        checkOnlyHouse();

        await ui._onUpgradeAnalyze();

        expect(ui.panel.querySelector('#mwi-labsim-status').textContent).toMatch(
            /all 2 combat house rooms are already maxed/
        );
    });
});

/**
 * Which level the Configure fight is analysed at.
 *
 * It used to be the Configure tab's Level box and nothing else, which meant the
 * most-used analysis in the panel ran at 100 — the number the box opens on, and
 * the one number in it that carries no intent. The source is now a choice with
 * the level it comes to shown beside it.
 */
describe('the Configure fight is analysed at a level that was chosen', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        sim.calls = [];
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = { '/monsters/mimic': 130 };
        game.recommendedLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
        game.houseRoomDetailMap = {};

        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._restoreUpgradeSelection();
        ui._maxLevelByMonster = {};
        storage.written = {};
    });

    afterEach(() => {
        game.recommendedLevels = {};
        game.players = [];
        ui._maxLevelByMonster = {};
        ui.destroy();
    });

    const source = () => ui.panel.querySelector('#mwi-labsim-level-source');
    const setSource = (value) => {
        source().value = value;
        source().dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const setScope = (value) => {
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = value;
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    const readout = () => ui.panel.querySelector('#mwi-labsim-level-source-resolved').textContent;

    test('the choice sits beside Targets, with all three levels a fight has', () => {
        expect([...source().options].map((o) => o.value)).toEqual(['sim_max', 'skip', 'configure']);
        expect(source().closest('#mwi-labsim-upgrade-scope')).toBeNull();
        expect(ui.panel.querySelector('#mwi-labsim-upgrade-scope').parentElement).toBe(
            source().closest('label').parentElement
        );
    });

    test('and only for the scope it means anything to', () => {
        const label = ui.panel.querySelector('#mwi-labsim-level-source-label');
        expect(label.style.display).toBe('inline-flex');
        setScope('all');
        expect(label.style.display).toBe('none');
        setScope('current');
        expect(label.style.display).toBe('inline-flex');
    });

    test('a Level box left on its default means Sim max — nobody asked for 100', async () => {
        await ui._restoreUpgradeSelection();
        expect(source().value).toBe('sim_max');
    });

    test('a Level box that was typed into means the number that was typed', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '232';
        await ui._restoreUpgradeSelection();
        expect(source().value).toBe('configure');
    });

    test('the resolved level is on screen before Analyze is pressed', () => {
        setSource('skip');
        expect(readout()).toBe('= L130');
        expect(ui.panel.querySelector('#mwi-labsim-level-source-resolved').title).toContain('Skip level (L130)');
    });

    test('a sim max nothing has searched for yet says so rather than a number', () => {
        setSource('sim_max');
        expect(readout()).toMatch(/not simmed yet/);
    });

    test('and reads as a level once a Find Max has produced one', () => {
        ui._maxLevelByMonster['/monsters/mimic'] = 232;
        setSource('sim_max');
        expect(readout()).toBe('= L232');
    });

    test('a Recommend result wins over the threshold currently configured', () => {
        game.recommendedLevels['/monsters/mimic'] = 141;
        setSource('skip');
        expect(readout()).toBe('= L141');
    });

    test('the analysis actually runs at the level the source resolved to', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '100';
        setSource('skip');

        await ui._onUpgradeAnalyze();

        expect(sim.calls.length).toBeGreaterThan(0);
        for (const call of sim.calls) expect(call.roomLevel).toBe(130);
    });

    test('a cached sim max is used without searching for it again', async () => {
        ui._maxLevelByMonster['/monsters/mimic'] = 232;
        setSource('sim_max');

        await ui._onUpgradeAnalyze();

        for (const call of sim.calls) expect(call.roomLevel).toBe(232);
    });

    test('and the Configure box is still exactly what Configure value means', async () => {
        ui.panel.querySelector('#mwi-labsim-level').value = '175';
        setSource('configure');

        await ui._onUpgradeAnalyze();

        for (const call of sim.calls) expect(call.roomLevel).toBe(175);
    });

    test('a source with nothing behind it falls through rather than analysing level 0', () => {
        game.skipLevels = {};
        ui.panel.querySelector('#mwi-labsim-level').value = '150';
        setSource('skip');

        expect(readout()).toBe('= L150');
        expect(ui._resolveTargetLevel('/monsters/mimic')).toMatchObject({ usedSource: 'configure', fellBack: true });
    });

    test('the choice survives being made — it is written down like its neighbours', async () => {
        setSource('skip');
        await settle();
        expect(storage.written['labSimUpgradeLevelSource_me']).toBe('skip');
    });
});

describe('a single-target result can be read against the last one', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        ui.buildPanel();
        await settle();
        ui._switchTab('maxlevel');
    });

    afterEach(() => {
        ui.destroy();
    });

    /** Run a fixed-level fight and record it the way `_onSimulate` does. */
    const simulate = async (roomLevel, { attempts = 1000, encounters = 700, deaths = 30 } = {}) => {
        const simResult = {
            labyAttemptCount: attempts,
            encounters,
            deaths: { p1: deaths },
            simulatedTime: 3 * 3600 * 1e9,
        };
        ui._displaySimResults(simResult, '/monsters/mimic', roomLevel, 3, Date.now(), 'p1');
        await ui._recordSingleTargetRun(simResult, {
            monsterHrid: '/monsters/mimic',
            roomLevel,
            hours: 3,
            crates: [],
            playerHrid: 'p1',
        });
    };

    const comparison = () => ui.panel.querySelector('#mwi-labsim-comparison');

    test('the first run has nothing to be read against, so no table is drawn', async () => {
        await simulate(130);

        expect(ui._comparison.runs).toHaveLength(1);
        expect(comparison().textContent).toBe('');
    });

    test('the second run brings up the comparison, with the first pinned as the baseline', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });

        const text = comparison().textContent;
        expect(text).toContain('Comparison (2 runs)');
        expect(text).toContain('★');
        expect(ui._comparison.baselineId).toBe(ui._comparison.runs[0].id);
        // 70% → 82% is the delta the table exists to show
        expect(text).toContain('+12.00%');
    });

    test('the table survives the run after it, still measuring from the pinned baseline', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });
        await simulate(130, { encounters: 650 });

        const text = comparison().textContent;
        expect(text).toContain('Comparison (3 runs)');
        expect(text).toContain('+12.00%');
        expect(text).toContain('-5.00%');
    });

    test('a run can be forgotten from the table', async () => {
        await simulate(130);
        await simulate(140);
        const doomed = ui._comparison.runs[1].id;

        comparison()
            .querySelector(`[data-labsim-cmp-delete="${doomed}"]`)
            .dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect(ui._comparison.runs.map((e) => e.id)).not.toContain(doomed);
        // One run left is not a comparison
        expect(comparison().textContent).toBe('');
    });

    test('and the lot can be cleared at once', async () => {
        await simulate(130);
        await simulate(140);
        await simulate(150);

        comparison()
            .querySelector('#mwi-labsim-cmp-clear')
            .dispatchEvent(new window.Event('click', { bubbles: true }));
        await settle();

        expect(ui._comparison.runs).toEqual([]);
        expect(comparison().textContent).toBe('');
    });

    test('pinning a different baseline re-reads every row against it', async () => {
        await simulate(130, { encounters: 700 });
        await simulate(130, { encounters: 820 });

        const select = comparison().querySelector('#mwi-labsim-cmp-baseline');
        select.value = ui._comparison.runs[1].id;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        await settle();

        expect(ui._comparison.baselineId).toBe(ui._comparison.runs[1].id);
        // Read the other way round now: 82% → 70% is a loss
        expect(comparison().textContent).toContain('-12.00%');
    });

    test('a Find Max result is a different question, so it does not join the table', async () => {
        await simulate(130);
        await simulate(140);

        ui._displayFindMaxResults(
            { cleared: true, maxLevel: 145, winRate: 0.72, threshold: 0.7, steps: 6, minLevel: 20, maxSearched: 200 },
            '/monsters/mimic',
            Date.now()
        );

        expect(ui._comparison.runs).toHaveLength(2);
        expect(ui.panel.querySelector('#mwi-labsim-comparison')).toBeNull();
    });
});

describe('a labyrinth fight is never a task fight', () => {
    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = {};
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], houseRooms: {} }];
        sim.calls = [];
        ui.buildPanel();
        await settle();
    });

    afterEach(() => {
        ui.destroy();
        game.players = [];
    });

    test('the Task Fight option is gone from the Configure tab', () => {
        // A labyrinth monster is not your combat task, so the taskDamage the box
        // applied pays nothing — the only thing ticking it could do was produce
        // a wrong number
        expect(ui.panel.querySelector('#mwi-labsim-taskfight')).toBeNull();
        expect(ui.panel.textContent).not.toContain('Task Fight');
    });

    test('and the simulation is told so outright rather than by an absent box', async () => {
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._onSimulate();

        expect(sim.calls).toHaveLength(1);
        expect(sim.calls[0].isTaskFight).toBe(false);
    });

    test('nothing recorded from the panel carries the flag either', async () => {
        ui.panel.querySelector('#mwi-labsim-monster').value = '/monsters/mimic';
        await ui._onSimulate();

        expect(ui._comparison.runs).toHaveLength(1);
        expect(ui._comparison.runs[0].settings).not.toHaveProperty('taskFight');
    });
});

describe('the upgrade table reads like the combat sim’s', () => {
    /** One gold row and one token row, the shape `_renderUpgradeResults` takes. */
    const analysis = () => ({
        baseline: { winRate: 0.4962 },
        results: [
            {
                candidate: {
                    type: 'cross_slot',
                    description:
                        'Royal Nature Robe Top +7 + Royal Nature Robe Bottoms +7 → ' +
                        'Royal Fire Robe Top +7 + Royal Fire Robe Bottoms +7',
                },
                costType: 'gold',
                cost: 8879530,
                winRate: 0.5136,
                winRateDelta: 0.0174,
                metricType: 'winRate',
                costDetail: null,
            },
            {
                candidate: { type: 'labyrinth_buff', description: 'Fireball Lv48 → Lv53' },
                costType: 'token',
                tokenCost: 120,
                winRate: 0.52,
                winRateDelta: 0.02,
                metricType: 'winRate',
            },
        ],
    });

    let host;
    let container;

    beforeEach(async () => {
        geometry.saved = null;
        geometry.wasOpen = false;
        game.monsters = [];
        game.skipLevels = {};
        rowActions.wired = [];
        ui.buildPanel();
        await settle();

        host = document.createElement('div');
        container = document.createElement('div');
        host.appendChild(container);
        document.body.appendChild(host);
    });

    afterEach(() => {
        host.remove();
        ui.destroy();
    });

    test('every row carries whatever the shared builder emits, in both tables', () => {
        ui._renderUpgradeResults(analysis(), container);

        const emitted = [...container.querySelectorAll('[data-shared-action]')].map((b) =>
            b.getAttribute('data-shared-action')
        );
        expect(emitted).toContain('Fireball Lv48 → Lv53');
        expect(emitted.some((d) => d.startsWith('Royal Nature Robe Top +7'))).toBe(true);
    });

    test('and they are given their behaviour once the strings are in the document', () => {
        ui._renderUpgradeResults(analysis(), container);

        expect(rowActions.wired).toContain(container);
    });

    test('re-sorting rebuilds the rows, so it wires them again', () => {
        ui._renderUpgradeResults(analysis(), container);
        const before = rowActions.wired.length;

        container.querySelector('th[data-sort-key="cost"]').dispatchEvent(new window.Event('click', { bubbles: true }));

        expect(rowActions.wired.length).toBeGreaterThan(before);
    });

    test('a long upgrade name wraps instead of running off the panel on one line', () => {
        ui._renderUpgradeResults(analysis(), container);

        const nameCells = [...container.querySelectorAll('td')].filter((td) =>
            td.textContent.includes('Royal Fire Robe Top')
        );
        expect(nameCells.length).toBeGreaterThan(0);
        for (const cell of nameCells) {
            expect(cell.getAttribute('style')).toContain('white-space:normal');
        }
    });

    test('the measured columns still never wrap — only the name does', () => {
        ui._renderUpgradeResults(analysis(), container);

        const costCell = container.querySelector('tr[data-gold-row="0"] td:nth-child(2)');
        expect(costCell.getAttribute('style')).toContain('white-space:nowrap');
    });
});

describe('a skilling run only weighs what the skill being run can feel', () => {
    const ITEMS = {
        '/items/holy_chisel': {
            name: 'Holy Chisel',
            equipmentDetail: { type: '/equipment_types/crafting_tool', noncombatStats: { craftingSpeed: 0.3 } },
        },
        '/items/holy_pot': {
            name: 'Holy Pot',
            equipmentDetail: { type: '/equipment_types/cooking_tool', noncombatStats: { cookingSpeed: 0.3 } },
        },
        '/items/philosophers_necklace': {
            name: "Philosopher's Necklace",
            equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingEfficiency: 0.02 } },
        },
        '/items/combat_necklace': {
            name: 'Combat Necklace',
            equipmentDetail: { type: '/equipment_types/neck', combatStats: { stabAccuracy: 0.1 } },
        },
    };
    const gameData = { itemDetailMap: ITEMS };
    const worn = {
        '/equipment_types/crafting_tool': { hrid: '/items/holy_chisel', enhancementLevel: 5 },
        '/equipment_types/cooking_tool': { hrid: '/items/holy_pot', enhancementLevel: 3 },
        '/equipment_types/neck': { hrid: '/items/combat_necklace', enhancementLevel: 0 },
    };

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
    });

    afterEach(() => {
        ui.destroy();
    });

    test('another skill’s tool is taken out of the kit a single-skill run weighs', () => {
        // The complaint: a Cooking run spending a room evaluation on "Holy
        // Chisel +5 → +7", which is a crafting tool and cannot move a cooking
        // room by any amount
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']['/equipment_types/crafting_tool']).toBeUndefined();
        expect(scoped['/skills/cooking']['/equipment_types/cooking_tool']).toBeDefined();
    });

    test('and put back for the skill it belongs to', () => {
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/crafting', gameData);

        expect(scoped['/skills/crafting']['/equipment_types/crafting_tool']).toBeDefined();
        expect(scoped['/skills/crafting']['/equipment_types/cooking_tool']).toBeUndefined();
    });

    test('a piece with no skilling stats at all is left alone, so a swap into it is still priced', () => {
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']['/equipment_types/neck']?.hrid).toBe('/items/combat_necklace');
    });

    test('the kit is materialised even where no loadout is assigned, or the base kit leaks back in', () => {
        // The analysis falls back to the character's base equipment when the map
        // has no entry for a skill — which is the unscoped kit all over again
        const scoped = ui._scopeSkillEquipmentMap({}, { equipment: worn }, '/skills/cooking', gameData);

        expect(scoped['/skills/cooking']).toBeDefined();
    });

    test('every skill keeps its own kit when the run is over all of them', () => {
        const map = { '/skills/crafting': worn };

        expect(ui._scopeSkillEquipmentMap(map, { equipment: worn }, null, gameData)).toBe(map);
    });
});

describe('what one more level of a community buff is worth to a skilling room', () => {
    const gameData = { itemDetailMap: {}, houseRoomDetailMap: {}, labyrinthCrateDetailMap: {} };
    const player = () => ({
        cookingLevel: 100,
        foragingLevel: 100,
        equipment: {},
        houseRooms: {},
        tokenUpgrades: {},
        communityBuffLevels: { productionEfficiency: 5, enhancingSpeed: 0, gatheringQuantity: 3, experience: 4 },
    });

    /** Run the pass for one skill and hand back what it appended. */
    const run = async (targetSkill, dto = player()) => {
        const analysisResult = { baseline: { clearRate: 0, xpPerRoom: 0 }, results: [] };
        await ui._runSkillingCommunityPass({
            dto,
            roomLevel: { '/skills/cooking': 100, '/skills/foraging': 100 },
            crateHrids: [],
            skillEquipmentMap: {},
            targetSkill,
            gameData,
            analysisResult,
        });
        return analysisResult;
    };

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
        ui._skillingAborted = false;
    });

    afterEach(() => {
        ui.destroy();
    });

    test('the efficiency buff moves a production room’s clear rate', async () => {
        const { results } = await run('/skills/cooking');
        const row = results.find((r) => r.candidate.buffKey === 'productionEfficiency');

        expect(row.costType).toBe('community');
        expect(row.clearRateDelta).toBeGreaterThan(0);
    });

    test('the Experience buff moves what the room pays rather than how often it clears', async () => {
        const { results } = await run('/skills/cooking');
        const row = results.find((r) => r.candidate.buffKey === 'experience');

        expect(row.metricType).toBe('xpPerRoom');
        expect(row.xpPerRoomDelta).toBeGreaterThan(0);
        expect(row.clearRateDelta).toBeCloseTo(0, 10);
    });

    test('and its current level is part of the baseline it is measured from', async () => {
        // Not a fresh question: the level has been on the DTO all along and was
        // dropped on the way into the buff array, so the XP baseline every row
        // is read against was the one with the buff switched off
        const withBuff = await run('/skills/cooking');
        const without = await run('/skills/cooking', { ...player(), communityBuffLevels: { experience: 0 } });

        expect(withBuff.baseline.xpPerRoom).toBeGreaterThan(without.baseline.xpPerRoom);
    });

    test('a Cooking run is never offered the gathering buff', async () => {
        const { results } = await run('/skills/cooking');

        expect(results.map((r) => r.candidate.buffKey)).not.toContain('gatheringQuantity');
    });

    test('a Foraging run is, and it moves the room', async () => {
        const { results } = await run('/skills/foraging');
        const row = results.find((r) => r.candidate.buffKey === 'gatheringQuantity');

        expect(row.clearRateDelta).toBeGreaterThan(0);
    });

    test('a buff already at the cap has no next level to donate for', async () => {
        const maxed = { ...player(), communityBuffLevels: { productionEfficiency: 20, experience: 4 } };
        const { results } = await run('/skills/cooking', maxed);

        expect(results.map((r) => r.candidate.buffKey)).toEqual(['experience']);
    });

    test('a Stop click lands between candidates rather than at the end of the run', async () => {
        ui._skillingAborted = true;
        const { results } = await run('/skills/cooking');

        expect(results).toEqual([]);
    });
});

describe('the skilling upgrade tables give a community buff one of its own', () => {
    const analysis = () => ({
        baseline: { clearRate: 0.62, xpPerRoom: 5000 },
        results: [
            {
                candidate: { type: 'community_buff', buffKey: 'experience', description: 'Experience Lv4 → Lv5' },
                costType: 'community',
                cost: null,
                cowbellCost: 20,
                clearRate: 0.62,
                clearRateDelta: 0,
                xpPerRoom: 5125,
                xpPerRoomDelta: 125,
                metricType: 'xpPerRoom',
            },
            {
                candidate: { type: 'skilling_gear', description: 'Holy Pot +5 (cooking)', skillKey: '/skills/cooking' },
                costType: 'gold',
                cost: 1000,
                clearRate: 0.65,
                clearRateDelta: 0.03,
                metricType: 'clearRate',
            },
        ],
    });

    let container;

    beforeEach(async () => {
        ui.buildPanel();
        await settle();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
        ui.destroy();
    });

    test('the row is drawn, in a table of its own rather than among the gear', () => {
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('Community Buffs');
        expect(container.textContent).toContain('Experience Lv4 → Lv5');
    });

    test('with the XP it buys, since a wisdom level buys no clears', () => {
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('+125.0');
    });

    test('and the cowbell rate rather than a gold price it has not got', () => {
        // A community buff level is the whole server's donated minutes; the only
        // price the game names is the cowbells per minute of uptime
        ui._renderSkillingUpgradeResults(analysis(), container);

        expect(container.textContent).toContain('20/min');
        expect(container.textContent).toContain('Lv20 (max)');
    });

    test('a run with no community rows draws no community table', () => {
        const result = analysis();
        result.results = result.results.filter((r) => r.costType !== 'community');

        ui._renderSkillingUpgradeResults(result, container);

        expect(container.textContent).not.toContain('Community Buffs');
    });
});
