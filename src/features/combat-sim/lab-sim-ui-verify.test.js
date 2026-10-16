/** @vitest-environment happy-dom
 *
 * The Lab Sim's Verify controls: re-measuring an analysis' winners on fresh paired seeds.
 *
 * The verify engine (`verify-runner.js`) has its own tests; here it is replaced by a stand-in the test controls,
 * and what is asserted is the panel around it: which buttons exist, which rows a click hands the engine, how each
 * ending is worded, and that the verdicts follow the analysis they were measured for and no other.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as upgradeAdvisor from './upgrade-advisor.js';
import { renderLabTriggerResultsHtml, verifyChipHtml } from './lab-trigger-view.js';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({ monsters: [], skipLevels: {}, players: [], characterId: 'me' }));
const settings = vi.hoisted(() => ({ autoVerify: false }));
const verify = vi.hoisted(() => ({ lab: null, trigger: null, labCalls: [], triggerCalls: [] }));
const sim = vi.hoisted(() => ({ cancelled: 0 }));

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
        getLabyrinthCombatBuffs: () => [],
        getCombatSkipRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
        getCombatRoomLevel: (hrid) => game.skipLevels[hrid] || 0,
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
vi.mock('./verify-runner.js', async (importOriginal) => ({
    ...(await importOriginal()),
    verifyLabCandidates: (params) => {
        verify.labCalls.push(params);
        return verify.lab(params);
    },
    verifyTriggerChanges: (params) => {
        verify.triggerCalls.push(params);
        return verify.trigger(params);
    },
}));

const { default: ui } = await import('./lab-sim-ui.js');

async function settle() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
}

const slot = (n) => `/equipment_types/slot_${n}`;
const fightOf = (applied = true) => ({
    monsterName: 'Mimic',
    roomLevel: 130,
    loadoutName: 'Lab',
    winRate: 0.55,
    winRateDelta: 0.05,
    applied,
});

/** One all-fights row; `delta` is the change in expected attempts (negative is better) */
function upgradeRow(n, delta, noise, significant) {
    return {
        candidate: {
            type: 'equipment',
            slot: slot(n),
            upgradeHrid: `/items/gear_${n}`,
            upgradeLevel: 1,
            description: `Gear ${n}`,
        },
        costType: 'gold',
        cost: 1e6,
        attemptsSavedPerMillion: -delta,
        expectedAttempts: 10 + delta,
        attemptsDelta: delta,
        attemptsDeltaNoise: noise,
        significant,
        appliedFights: 1,
        avgWinDelta: 0.05,
        fights: [fightOf()],
    };
}

function analysisOf(rows, extra = {}) {
    return {
        baseline: {
            expectedAttempts: 10,
            runClearChance: 0.1,
            fights: [{ monsterName: 'Mimic', roomLevel: 130, loadoutName: 'Lab', winRate: 0.5 }],
        },
        results: rows,
        budget: {},
        archetypes: [],
        pairing: { seed: 7, rules: [] },
        context: { fights: [{ monsterHrid: '/monsters/mimic', dto: {} }], crates: [], hours: 1 },
        ...extra,
    };
}

const verdictRow = (key, verdict, mean, se = 0.2, seeds = 8) => ({ key, description: key, mean, se, seeds, verdict });
const keyOf = (row) => `equip:${row.candidate.slot}=${row.candidate.upgradeHrid}@1!`;

const resultsEl = () => ui.panel.querySelector('#mwi-labsim-upgrade-results');
const statusText = () => ui.panel.querySelector('#mwi-labsim-status').textContent;
const topButton = () => resultsEl().querySelector('[data-af-verify-top]');
const rowButtons = () => [...resultsEl().querySelectorAll('[data-af-verify]')];
const chips = () => [...resultsEl().querySelectorAll('[data-verify-chip]')];

describe('the Lab Sim Verify controls', () => {
    let allSpy;

    beforeEach(async () => {
        game.characterId = 'me';
        settings.autoVerify = false;
        verify.labCalls = [];
        verify.triggerCalls = [];
        verify.lab = async () => ({ rows: [], metric: 'attempts', unit: 'attempts', seeds: 8, stopped: false });
        verify.trigger = async () => ({ rows: [], metric: 'attempts', unit: 'attempts', seeds: 8, stopped: false });
        game.monsters = [{ hrid: '/monsters/mimic', name: 'Mimic' }];
        game.skipLevels = { '/monsters/mimic': 130 };
        game.players = [{ hrid: 'p1', equipment: {}, abilities: [], guildShrineLevels: {} }];
        ui.buildPanel();
        await settle();
        ui._switchTab('upgrade');
        // A teardown leaves the stop flag set; a run clears it, and these tests call the helpers directly
        ui._upgradeAborted = false;
        const scope = ui.panel.querySelector('#mwi-labsim-upgrade-scope');
        scope.value = 'all';
        scope.dispatchEvent(new window.Event('change', { bubbles: true }));
        allSpy = vi.spyOn(upgradeAdvisor, 'runLabyrinthAllFightsAnalysis').mockResolvedValue(analysisOf([]));
    });

    afterEach(() => {
        allSpy.mockRestore();
        game.players = [];
        game.monsters = [];
        game.skipLevels = {};
        ui.destroy();
    });

    /** Run an analysis that returns `analysis`, as the panel's Analyze button does */
    async function analyze(analysis) {
        allSpy.mockResolvedValue(analysis);
        await ui._onUpgradeAnalyze();
    }

    const fiveRows = () => [
        upgradeRow(1, -3.0, 0.1, true),
        upgradeRow(2, -2.0, 0.1, true),
        upgradeRow(3, -1.0, 0.1, true),
        upgradeRow(4, -0.5, 0.1, true),
        upgradeRow(5, +0.7, 0.1, true),
    ];

    test('the setting exists, off by default, labeled for both simulators', () => {
        const def = getSettingDefinition('combatSim_autoVerifyCloseCalls');
        expect(def.type).toBe('checkbox');
        expect(def.default).toBe(false);
        expect(def.label).toContain('Combat & Lab');
        expect(def.help).toContain('3');
    });

    describe('the all-fights table', () => {
        test('a fresh run offers Verify top 3 and a verify action on every row', async () => {
            await analyze(analysisOf(fiveRows()));
            expect(topButton().textContent).toBe('Verify top 3');
            expect(topButton().disabled).toBe(false);
            expect(rowButtons()).toHaveLength(5);
        });

        test('Verify top 3 hands the engine the first three improving rows, in the table’s order, with the analysis record', async () => {
            const analysis = analysisOf(fiveRows());
            await analyze(analysis);
            verify.lab = async ({ rows }) => ({
                rows: rows.map((row) => verdictRow(keyOf(row), 'confirmed', -1.1)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            topButton().click();
            await settle();

            expect(verify.labCalls).toHaveLength(1);
            const call = verify.labCalls[0];
            expect(call.rows.map((r) => r.candidate.description)).toEqual(['Gear 1', 'Gear 2', 'Gear 3']);
            expect(call.context).toBe(analysis.context);
            expect(call.pairing).toBe(analysis.pairing);
            expect(typeof call.abortSignal).toBe('function');
        });

        test('verdict chips read confirmed, not confirmed, worse and error', async () => {
            const rows = fiveRows();
            await analyze(analysisOf(rows));
            verify.lab = async () => ({
                rows: [
                    verdictRow('a', 'confirmed', -0.84, 0.21),
                    verdictRow('b', 'not-confirmed', -0.1, 0.3),
                    verdictRow('c', 'worse', 0.5, 0.1),
                ],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            topButton().click();
            await settle();
            const text = chips().map((c) => c.textContent);
            expect(text[0]).toBe('✓ confirmed −0.84 ±0.21 attempts');
            expect(text[1]).toContain('not confirmed');
            expect(text[2]).toBe('✗ worse +0.50 ±0.10 attempts');
            expect(statusText()).toContain('1 confirmed, 1 not confirmed, 1 worse of 3');

            const errorChip = verifyChipHtml({ verdict: 'error', error: 'boom' });
            expect(errorChip).toContain('verify error');
            expect(errorChip).toContain('title="boom"');
        });

        test('a per-row verify measures just that row and does not toggle its breakdown', async () => {
            await analyze(analysisOf(fiveRows()));
            verify.lab = async ({ rows }) => ({
                rows: rows.map((row) => verdictRow(keyOf(row), 'confirmed', -0.9)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            rowButtons()[1].click();
            await settle();
            expect(verify.labCalls[0].rows.map((r) => r.candidate.description)).toEqual(['Gear 2']);
            const detail = resultsEl().querySelector('[data-allfights-detail="1"]');
            expect(detail.style.display).toBe('none');
            expect(chips()).toHaveLength(1);
        });

        test('verdicts survive a re-sort of the table', async () => {
            await analyze(analysisOf(fiveRows()));
            verify.lab = async ({ rows }) => ({
                rows: rows.map((row) => verdictRow(keyOf(row), 'confirmed', -1.1)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            topButton().click();
            await settle();
            expect(chips()).toHaveLength(3);
            resultsEl().querySelector('[data-af-sort="cost"]').click();
            resultsEl().querySelector('[data-af-sort="upgrade"]').click();
            expect(chips()).toHaveLength(3);
            // The redraw left the verify outcome on the status line rather than replacing it
            expect(statusText()).toContain('Verify: 3 confirmed');
        });

        test('a new analysis clears the verdicts', async () => {
            await analyze(analysisOf(fiveRows()));
            verify.lab = async ({ rows }) => ({
                rows: rows.map((row) => verdictRow(keyOf(row), 'confirmed', -1.1)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            topButton().click();
            await settle();
            expect(chips()).toHaveLength(3);
            await analyze(analysisOf(fiveRows()));
            expect(chips()).toHaveLength(0);
            expect(resultsEl().querySelector('[data-verify-note]')).toBeNull();
        });

        test('a remembered table has no Verify controls and says to re-run', async () => {
            // Drawn the way a restore draws it: nothing registered the analysis as live
            ui._renderAllFightsResults(analysisOf(fiveRows()), resultsEl());
            expect(topButton()).toBeNull();
            expect(rowButtons()).toHaveLength(0);
            expect(resultsEl().querySelector('[data-verify-bar]').textContent).toContain('re-run the analysis');
        });

        test('the checked-swaps table has no Verify controls', async () => {
            ui._renderAllFightsResults(analysisOf(fiveRows()), resultsEl(), { checked: true });
            expect(resultsEl().querySelector('[data-verify-bar]')).toBeNull();
            expect(rowButtons()).toHaveLength(0);
        });

        test('with no improving row, Verify top 3 is disabled', async () => {
            await analyze(analysisOf([upgradeRow(1, +0.7, 0.1, true), upgradeRow(2, +0.2, 0.1, true)]));
            expect(topButton().disabled).toBe(true);
        });

        test('a draw that throws as the verify starts cannot leave the tab stuck busy', async () => {
            await analyze(analysisOf(fiveRows()));
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const redraw = vi.spyOn(ui, '_redrawVerify').mockImplementationOnce(() => {
                throw new Error('draw failed');
            });
            topButton().click();
            await settle();
            redraw.mockRestore();
            errorSpy.mockRestore();
            expect(ui._upgradeRunning).toBe(false);
            expect(ui._verify.running).toBeNull();
            expect(ui.panel.querySelector('#mwi-labsim-upgrade-run').style.display).toBe('');
            expect(ui.panel.querySelector('#mwi-labsim-upgrade-stop').style.display).toBe('none');
        });

        test('Stop mid-verify cancels the engine and marks partial results, leaving unfinished rows unmarked', async () => {
            await analyze(analysisOf(fiveRows()));
            let release;
            let signal;
            verify.lab = ({ abortSignal }) => {
                signal = abortSignal;
                return new Promise((resolve) => {
                    release = resolve;
                });
            };
            topButton().click();
            await settle();
            // While it runs: the buttons are off and the progress box shows Stop
            expect(statusText()).toContain('Verifying 3 upgrades');
            expect(ui.panel.querySelector('#mwi-labsim-upgrade-stop').style.display).toBe('inline-block');
            expect(topButton().disabled).toBe(true);
            expect(resultsEl().querySelectorAll('[data-verify-running]')).toHaveLength(3);
            expect(signal()).toBe(false);

            ui.panel.querySelector('#mwi-labsim-upgrade-stop').click();
            expect(signal()).toBe(true);
            release({
                rows: [
                    verdictRow('a', 'confirmed', -1.2, 0.3, 5),
                    verdictRow('b', 'not-confirmed', null, null, 0),
                    verdictRow('c', 'not-confirmed', null, null, 0),
                ],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: true,
            });
            await settle();

            expect(chips()).toHaveLength(1);
            expect(chips()[0].textContent).toContain('stopped early, 5 seeds');
            expect(statusText()).toContain('Stopped early');
            expect(statusText()).toContain('2 unfinished');
            // Verify is available again afterwards
            expect(ui._upgradeRunning).toBe(false);
            expect(topButton().disabled).toBe(false);
            expect(ui.panel.querySelector('#mwi-labsim-upgrade-run').style.display).toBe('');
        });

        test('a refused run says why and marks nothing', async () => {
            await analyze(analysisOf(fiveRows()));
            verify.lab = async () => ({ rows: [], metric: 'attempts', unit: 'attempts', seeds: 8, refused: 'context' });
            topButton().click();
            await settle();
            expect(chips()).toHaveLength(0);
            expect(statusText()).toContain('Verify did not run');
            expect(resultsEl().querySelector('[data-verify-note]').textContent).toContain('did not run');
        });

        test('an engine that throws is reported and leaves the tab usable', async () => {
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await analyze(analysisOf(fiveRows()));
            verify.lab = async () => {
                throw new Error('worker died');
            };
            topButton().click();
            await settle();
            expect(statusText()).toContain('Verify failed: worker died');
            expect(ui._upgradeRunning).toBe(false);
            spy.mockRestore();
        });

        test('error rows show an error chip', async () => {
            await analyze(analysisOf(fiveRows()));
            verify.lab = async () => ({
                rows: [{ key: 'a', mean: null, se: null, seeds: 0, verdict: 'error', error: 'sim failed' }],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            rowButtons()[0].click();
            await settle();
            expect(chips()[0].dataset.verifyChip).toBe('error');
            expect(chips()[0].textContent).toBe('verify error');
        });

        test('a character switch mid-verify discards the result', async () => {
            await analyze(analysisOf(fiveRows()));
            let release;
            verify.lab = () =>
                new Promise((resolve) => {
                    release = resolve;
                });
            topButton().click();
            await settle();
            game.characterId = 'someone-else';
            release({
                rows: [verdictRow('a', 'confirmed', -1, 0.1)],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            await settle();
            expect(ui._verify.all.size).toBe(0);
            expect(statusText()).not.toContain('confirmed');
        });

        test('the single-fight table says Verify needs All or Chosen targets and offers none', () => {
            const container = resultsEl();
            const row = {
                candidate: {
                    type: 'equipment',
                    slot: slot(1),
                    description: 'Gear 1',
                    upgradeHrid: '/items/g',
                    upgradeLevel: 1,
                },
                costType: 'gold',
                cost: 1e6,
                winRate: 0.5,
                winRateDelta: 0.1,
                clearRate: 0.5,
                deltaClearRate: 0.1,
                value: 1,
                valueSingle: 1,
            };
            try {
                ui._renderUpgradeResults({ baseline: { winRate: 0.4 }, results: [row] }, container);
            } catch {
                // The single-fight renderer reads many fields this fixture omits; the note is written first
            }
            expect(container.querySelector('[data-verify-single-note]')?.textContent).toContain(
                'All or Chosen targets'
            );
            expect(container.querySelector('[data-af-verify-top]')).toBeNull();
        });
    });

    describe('auto-verify', () => {
        const closeRows = () => [
            upgradeRow(1, -0.5, 0.4, false), // close, improving
            upgradeRow(2, -3.0, 0.1, true), // clearly better: not a close call
            upgradeRow(3, +0.3, 0.4, false), // close but worse
            upgradeRow(4, -0.3, 0.3, false), // close, improving
        ];

        test('off by default: nothing runs after an analysis', async () => {
            await analyze(analysisOf(closeRows()));
            expect(verify.labCalls).toHaveLength(0);
        });

        test('on: verifies only the close rows that improve, and says so', async () => {
            settings.autoVerify = true;
            verify.lab = async ({ rows }) => ({
                rows: rows.map((row) => verdictRow(keyOf(row), 'not-confirmed', -0.1, 0.3)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            await analyze(analysisOf(closeRows()));
            expect(verify.labCalls).toHaveLength(1);
            expect(verify.labCalls[0].rows.map((r) => r.candidate.description)).toEqual(['Gear 1', 'Gear 4']);
            expect(chips()).toHaveLength(2);
            expect(statusText()).toContain('Auto-verify: 0 confirmed, 2 not confirmed of 2');
            // The analysis is finished and the tab is usable again
            expect(ui._upgradeRunning).toBe(false);
        });

        test('on: at most three rows, the best improvements first', async () => {
            settings.autoVerify = true;
            const many = [1, 2, 3, 4, 5].map((n) => upgradeRow(n, -0.1 * n, 0.5, false));
            await analyze(analysisOf(many));
            expect(verify.labCalls[0].rows.map((r) => r.candidate.description)).toEqual(['Gear 5', 'Gear 4', 'Gear 3']);
        });

        test('on: a stopped analysis is never auto-verified', async () => {
            settings.autoVerify = true;
            allSpy.mockImplementation(async () => {
                ui._upgradeAborted = true;
                return analysisOf(closeRows());
            });
            await ui._onUpgradeAnalyze();
            expect(verify.labCalls).toHaveLength(0);
        });

        test('on: nothing close, nothing run', async () => {
            settings.autoVerify = true;
            await analyze(analysisOf([upgradeRow(1, -3.0, 0.1, true)]));
            expect(verify.labCalls).toHaveLength(0);
        });

        test('on: Stop during the auto-verify keeps the analysis and marks what finished', async () => {
            settings.autoVerify = true;
            verify.lab = ({ abortSignal }) => {
                ui.panel.querySelector('#mwi-labsim-upgrade-stop').click();
                return Promise.resolve({
                    rows: [
                        verdictRow(keyOf(closeRows()[0]), 'not-confirmed', -0.2, 0.3, 4),
                        verdictRow(keyOf(closeRows()[3]), 'not-confirmed', null, null, 0),
                    ],
                    metric: 'attempts',
                    unit: 'attempts',
                    seeds: 8,
                    stopped: abortSignal(),
                });
            };
            await analyze(analysisOf(closeRows()));
            expect(resultsEl().querySelectorAll('[data-allfights-row]')).toHaveLength(4);
            expect(chips()).toHaveLength(1);
            expect(statusText()).toContain('Stopped early');
        });

        test('a remembered table is never auto-verified', async () => {
            settings.autoVerify = true;
            ui._renderAllFightsResults(analysisOf(closeRows()), resultsEl());
            await ui._autoVerifyCloseCalls({ startToken: ui._runStartToken, ownerId: 'me' });
            expect(verify.labCalls).toHaveLength(0);
        });
    });

    describe('the Ability order section', () => {
        const A = '/abilities/a';
        const B = '/abilities/b';
        const C = '/abilities/c';
        const order = (names, delta, noise, significant) => ({
            order: names,
            name: names.join(' → '),
            attemptsDelta: delta,
            attemptsDeltaNoise: noise,
            runClearDelta: 0.01,
            significant,
        });
        const orderRow = (names) => ({
            candidate: { checkedAbilityKey: 'ability_order', abilityOrder: true, order: names },
            fights: [{ applied: true }, { applied: true }],
        });
        const section = () => ({
            groups: [
                {
                    loadoutName: 'Lab',
                    currentName: 'A → B → C',
                    orders: [order([B, A, C], -0.5, 0.4, false), order([C, B, A], +0.4, 0.2, true)],
                },
                {
                    loadoutName: 'Spare',
                    currentName: 'A → B → C',
                    orders: [order([B, A, C], -1.5, 0.2, true)],
                },
            ],
        });
        const raw = () => ({
            baseline: { fights: [{ winRate: 0.5 }, { winRate: 0.5 }] },
            results: [orderRow([B, A, C]), orderRow([C, B, A])],
            pairing: { seed: 9, rules: [] },
            context: {
                fights: [
                    { loadoutId: 1, dto: { abilities: [null, { hrid: A }, { hrid: B }, { hrid: C }] } },
                    { loadoutId: 2, dto: { abilities: [null, { hrid: A }, { hrid: B }, { hrid: C }] } },
                ],
                hours: 1,
            },
        });
        const orderEl = () => ui.panel.querySelector('#mwi-labsim-upgrade-order');
        const draw = (live) => {
            const s = section();
            ui._upgradeOrderSection = s;
            if (live) ui._registerVerifyLive('order', { raw: raw(), section: s }, 'me');
            ui._drawUpgradeAbilityOrder();
            return s;
        };

        test('a fresh section has a Verify top button per loadout group that has an improving order', () => {
            draw(true);
            const buttons = [...orderEl().querySelectorAll('[data-order-verify]')];
            expect(buttons.map((b) => [b.dataset.orderVerify, b.textContent])).toEqual([
                ['0', 'Verify top 1'],
                ['1', 'Verify top 1'],
            ]);
        });

        test('a remembered section has no button and says to re-run', () => {
            draw(false);
            expect(orderEl().querySelector('[data-order-verify]')).toBeNull();
            expect(orderEl().textContent).toContain('re-run the analysis');
        });

        test('Verify hands the engine the group’s orders narrowed to that group’s fights', async () => {
            draw(true);
            verify.lab = async ({ rows }) => ({
                rows: rows.map(() => verdictRow('x', 'confirmed', -1.4, 0.2)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            orderEl().querySelector('[data-order-verify="1"]').click();
            await settle();
            const call = verify.labCalls[0];
            expect(call.rows).toHaveLength(1);
            expect(call.rows[0].candidate.order).toEqual([B, A, C]);
            // Group 1 owns the second fight only
            expect(call.rows[0].fights.map((f) => f.applied)).toEqual([false, true]);
            expect(call.pairing.seed).toBe(9);
        });

        test('a confirmed order leads the verdict line and the collapsed summary', async () => {
            draw(true);
            const before = orderEl().textContent;
            expect(before).toContain('best -1.5'.replace('-', '−') + ' attempts');
            verify.lab = async () => ({
                rows: [verdictRow('x', 'confirmed', -0.9, 0.2)],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            orderEl().querySelector('[data-order-verify="0"]').click();
            await settle();
            const text = orderEl().textContent;
            expect(text).toContain('Confirmed on fresh seeds');
            expect(text).toContain('best confirmed −0.9 attempts');
            expect(orderEl().querySelector('[data-verify-chip="confirmed"]')).not.toBeNull();
        });

        test('verdicts survive Show all and a redraw; a new analysis clears them', async () => {
            draw(true);
            verify.lab = async () => ({
                rows: [verdictRow('x', 'worse', 0.4, 0.1)],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            orderEl().querySelector('[data-order-verify="0"]').click();
            await settle();
            expect(orderEl().querySelectorAll('[data-verify-chip]')).toHaveLength(1);
            ui._drawUpgradeAbilityOrder();
            expect(orderEl().querySelectorAll('[data-verify-chip]')).toHaveLength(1);
            ui._clearVerify(['all', 'order']);
            ui._drawUpgradeAbilityOrder();
            expect(orderEl().querySelectorAll('[data-verify-chip]')).toHaveLength(0);
            // Cleared along with the live record: the stale section no longer offers Verify
            expect(orderEl().querySelector('[data-order-verify]')).toBeNull();
        });

        test('auto-verify takes close improving orders from the section', async () => {
            settings.autoVerify = true;
            draw(true);
            verify.lab = async ({ rows }) => ({
                rows: rows.map(() => verdictRow('x', 'not-confirmed', -0.1, 0.3)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            await ui._autoVerifyCloseCalls({ startToken: ui._runStartToken, ownerId: 'me' });
            // Group 0's -0.5 ± 0.4 order is a close call; group 1's -1.5 ± 0.2 is significant and clear
            expect(verify.labCalls).toHaveLength(1);
            expect(verify.labCalls[0].rows).toHaveLength(1);
            expect(orderEl().textContent).toContain('Auto-verify: 0 confirmed, 1 not confirmed of 1');
        });
    });

    describe('auto-verify across both sections', () => {
        const A = '/abilities/a';
        const B = '/abilities/b';
        const C = '/abilities/c';
        test('takes at most three rows in all, the best improvements against noise first', async () => {
            // Scores (improvement over noise): all rows 1.25, 1.0 and 0.2; the order below 1.25
            await analyze(
                analysisOf([
                    upgradeRow(1, -0.5, 0.4, false),
                    upgradeRow(2, -0.4, 0.4, false),
                    upgradeRow(3, -0.1, 0.5, false),
                ])
            );
            const s = {
                groups: [
                    {
                        loadoutName: 'Lab',
                        currentName: 'A → B → C',
                        orders: [
                            {
                                order: [B, A, C],
                                name: 'B → A → C',
                                attemptsDelta: -0.5,
                                attemptsDeltaNoise: 0.4,
                                runClearDelta: 0.01,
                                significant: false,
                            },
                        ],
                    },
                ],
            };
            ui._upgradeOrderSection = s;
            ui._registerVerifyLive(
                'order',
                {
                    raw: {
                        baseline: { fights: [{ winRate: 0.5 }] },
                        results: [
                            {
                                candidate: { checkedAbilityKey: 'ability_order', abilityOrder: true, order: [B, A, C] },
                                fights: [{ applied: true }],
                            },
                        ],
                        pairing: { seed: 9, rules: [] },
                        context: {
                            fights: [
                                { loadoutId: 1, dto: { abilities: [null, { hrid: A }, { hrid: B }, { hrid: C }] } },
                            ],
                            hours: 1,
                        },
                    },
                    section: s,
                },
                'me'
            );
            settings.autoVerify = true;
            verify.lab = async ({ rows }) => ({
                rows: rows.map(() => verdictRow('x', 'not-confirmed', -0.1, 0.3)),
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
            });
            await ui._autoVerifyCloseCalls({ startToken: ui._runStartToken, ownerId: 'me' });
            const total = verify.labCalls.reduce((sum, call) => sum + call.rows.length, 0);
            expect(total).toBe(3);
            const names = verify.labCalls.flatMap((call) => call.rows.map((r) => r.candidate.description ?? 'order'));
            expect(names).toContain('Gear 1');
            expect(names).toContain('Gear 2');
            expect(names).not.toContain('Gear 3');
        });
    });

    describe('trigger tuning', () => {
        const groupOf = (extra = {}) => ({
            key: 'loadout:3',
            name: 'Mage',
            fights: [],
            baselineAttempts: 3.11,
            tunedAttempts: 2.36,
            result: {
                changes: [
                    {
                        key: 'k',
                        slotType: 'abilities',
                        itemName: 'Fireball',
                        from: 1,
                        to: 300,
                        deltaScore: 0.75,
                        se: 0.1,
                        dependencyHrid: '/d',
                        conditionHrid: '/c',
                        comparatorHrid: '/m',
                    },
                ],
                rejected: [],
                unused: [],
                reliable: true,
                verifyContext: { kind: 'lab', tunables: [{}], fights: [{}] },
                ...extra,
            },
        });
        const run = (group) => ({ groups: [group], simCount: 1, stopped: false, precision: 'standard', minGain: 0.02 });
        const triggerEl = () => ui.panel.querySelector('#mwi-labsim-trigger-results');
        const show = (group) => {
            ui._verifyLive.trigger = { run: run(group), gameData: {}, ownerId: 'me' };
            ui._drawTriggerResults();
        };

        test('a live group offers Verify; a cached one says to re-tune', () => {
            show(groupOf());
            expect(triggerEl().querySelector('[data-lab-trigger-verify]')).not.toBeNull();
            const cached = groupOf({ verifyContext: undefined });
            show(cached);
            expect(triggerEl().querySelector('[data-lab-trigger-verify]')).toBeNull();
            expect(triggerEl().textContent).toContain('Re-run the tuning to verify');
        });

        test('a result drawn without verify controls has none', () => {
            const html = renderLabTriggerResultsHtml(run(groupOf()), {});
            expect(html).not.toContain('data-lab-trigger-verify');
        });

        test('Verify shows the verdict, the basis and the tuner’s baseline and tuned attempts', async () => {
            show(groupOf());
            verify.trigger = async () => ({
                rows: [
                    {
                        ...verdictRow('triggers', 'confirmed', 0.62, 0.2),
                        baselineAttempts: 3.2,
                        tunedAttempts: 2.58,
                    },
                ],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
                basis: 'recommended',
            });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            const call = verify.triggerCalls[0];
            expect(call.result.verifyContext.kind).toBe('lab');
            const text = triggerEl().textContent;
            expect(text).toContain('✓ confirmed −0.62 ±0.20 attempts');
            expect(text).toContain('basis: recommended changes');
            expect(text).toContain('Baseline 3.20 → tuned 2.58');
        });

        test('a verdict below the minimum gain says so', async () => {
            show(groupOf());
            verify.trigger = async () => ({
                rows: [{ ...verdictRow('triggers', 'confirmed', 0.01, 0.002), meetsMinGain: false }],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
                basis: 'recommended',
            });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            expect(triggerEl().textContent).toContain('Below your minimum gain');
        });

        test('Stop mid-verify marks the partial verdict', async () => {
            show(groupOf());
            let release;
            verify.trigger = () =>
                new Promise((resolve) => {
                    release = resolve;
                });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            expect(triggerEl().textContent).toContain('Verifying on fresh seeds');
            ui.panel.querySelector('#mwi-labsim-upgrade-stop').click();
            release({
                rows: [verdictRow('triggers', 'not-confirmed', 0.1, 0.4, 3)],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: true,
                basis: 'best-found',
            });
            await settle();
            expect(triggerEl().textContent).toContain('stopped early, 3 seeds');
            expect(triggerEl().textContent).toContain('best value found');
            expect(ui._upgradeRunning).toBe(false);
        });

        test('a stop before any seed finished leaves no verdict', async () => {
            show(groupOf());
            verify.trigger = async () => ({
                rows: [],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: true,
                basis: 'recommended',
            });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            expect(triggerEl().querySelector('[data-verify-chip]')).toBeNull();
            expect(statusText()).toContain('stopped before any seed finished');
        });

        test('a refusal is worded, and a failure reported', async () => {
            show(groupOf());
            verify.trigger = async () => ({
                rows: [],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                refused: 'nothing',
            });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            expect(triggerEl().textContent).toContain('Nothing to verify (nothing)');
        });

        test('a new tuning run clears the trigger verdicts', async () => {
            show(groupOf());
            verify.trigger = async () => ({
                rows: [verdictRow('triggers', 'worse', -0.3, 0.1)],
                metric: 'attempts',
                unit: 'attempts',
                seeds: 8,
                stopped: false,
                basis: 'recommended',
            });
            triggerEl().querySelector('[data-lab-trigger-verify]').click();
            await settle();
            expect(triggerEl().querySelector('[data-verify-chip]')).not.toBeNull();
            ui._clearVerify(['trigger']);
            expect(ui._verify.trigger.size).toBe(0);
            expect(ui._verifyLive.trigger).toBeNull();
        });
    });
});
