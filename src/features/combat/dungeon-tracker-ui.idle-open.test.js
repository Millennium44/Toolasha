/**
 * @vitest-environment happy-dom
 *
 * Opening the Dungeon Tracker from the command palette with no dungeon running.
 *
 * The panel is built with placeholders ("Loading...", "No runs yet", 0 runs) and
 * only a live run, the pending card or a filter change ever drew the stored
 * history over them, so a palette-opened panel sat at the placeholders while the
 * chart below it plotted the real runs. This drives the real store, the real run
 * list and the real panel; only the chart, interactions and ROI board are stubs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    currentRun: null,
    pending: null,
    characterId: '603281',
    characterName: 'Marketcow',
    saved: {},
    unreadable: false,
    settings: { dungeonTrackerUI: true, dungeonPace: true, dungeonKeyRunway: true, dungeonTrackerAverageWindow: 0 },
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: {
        getCurrentRun: () => world.currentRun,
        getPendingDungeon: () => world.pending,
        onUpdate: vi.fn(),
        offUpdate: vi.fn(),
    },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({
    default: { annotateAllMessages: vi.fn(), refreshRunCounts: async () => {} },
}));
vi.mock('./dungeon-tracker-ui-state.js', () => ({
    default: {
        load: vi.fn(async () => {}),
        updatePosition: vi.fn(),
        isKeysExpanded: false,
        isChartExpanded: false,
        isRoiExpanded: false,
        expandedGroups: new Set(),
        groupBy: 'dungeon',
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'mine',
        hasActiveFilters: () => false,
        isDungeonFilterManual: false,
        isTierFilterManual: false,
        autoScopeToRun: vi.fn(() => false),
        save: vi.fn(async () => {}),
    },
}));
const stubModule = vi.hoisted(() => () => ({
    default: class {
        render = vi.fn(async () => {});
        update = vi.fn(async () => {});
        setupAll = vi.fn();
        applyInitialStates = vi.fn();
        onDelete = vi.fn();
        onImport = vi.fn();
        dispose = vi.fn();
    },
}));
vi.mock('./dungeon-tracker-ui-chart.js', stubModule);
vi.mock('./dungeon-tracker-ui-interactions.js', stubModule);
vi.mock('./dungeon-roi-board-ui.js', stubModule);

vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key, storeName) => {
            if (world.unreadable) return null;
            const raw = world.saved[storeName]?.[key];
            return raw == null ? { found: false, value: null } : { found: true, value: structuredClone(raw) };
        },
        updateMany: async (storeName, keys, mutate) => {
            if (world.unreadable) return null;
            const stored = structuredClone(world.saved[storeName] || {});
            const entries = mutate(Object.fromEntries(keys.map((key) => [key, stored[key]])));
            world.saved[storeName] = { ...stored, ...structuredClone(entries) };
            return { values: world.saved[storeName], written: Object.keys(entries || {}) };
        },
        getJSON: async (key, storeName, defaultValue) => world.saved[storeName]?.[key] ?? defaultValue,
        setJSON: async () => true,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { name: 'Marketcow' } },
        getCurrentCharacterId: () => world.characterId,
        getCurrentCharacterName: () => world.characterName,
        getActionDetails: () => undefined,
        on: vi.fn(),
        off: vi.fn(),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => world.settings[key],
        getSettingValue: (key, fallback) => world.settings[key] ?? fallback,
        onSettingChange: vi.fn(() => () => {}),
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    PANEL_Z_CAP: 100,
}));
vi.mock('../../utils/command-registry.js', () => ({ registerCommand: vi.fn(), unregisterCommand: vi.fn() }));

const {
    default: dungeonTrackerStorage,
    RUNS_STORE,
    RUNS_KEY,
    filterRunsForCharacter,
} = await import('./dungeon-tracker-storage.js');
const ui = (await import('./dungeon-tracker-ui.js')).default;

/** A stored run as the game-fed tracker writes it. */
function storedRun(overrides = {}) {
    return {
        dungeonName: 'Chimerical Den',
        tier: 1,
        teamKey: 'Marketcow',
        team: ['Marketcow'],
        duration: 600_000,
        timestamp: '2026-10-01T10:00:00.000Z',
        recordedBy: '603281',
        ...overrides,
    };
}

function seed(runs) {
    world.saved[RUNS_STORE] = { [RUNS_KEY]: runs };
    dungeonTrackerStorage._resetCache();
}

const text = (selector) => ui.container.querySelector(selector)?.textContent.trim();
const runListText = () => ui.container.querySelector('#mwi-dt-run-list').textContent;
const buttons = () => [...ui.container.querySelectorAll('#mwi-dt-run-list button')].map((b) => b.textContent.trim());

/** Open the panel the way the palette does, and wait for the idle draw it starts. */
async function openFromPalette() {
    const spy = vi.spyOn(ui, 'showIdle');
    ui.toggle();
    const drawing = spy.mock.results[0]?.value;
    spy.mockRestore();
    await drawing;
}

async function freshPanel() {
    document.body.innerHTML = '';
    ui.isInitialized = false;
    ui.container = null;
    ui.pricingChangeUnregisters.forEach((unregister) => unregister());
    ui.pricingChangeUnregisters = [];
    if (ui.updateInterval) clearInterval(ui.updateInterval);
    await ui.initialize();
}

beforeEach(async () => {
    world.currentRun = null;
    world.pending = null;
    world.characterId = '603281';
    world.characterName = 'Marketcow';
    world.unreadable = false;
    seed([]);
    await freshPanel();
});

describe('opening the panel with no dungeon running', () => {
    test('lists the stored runs with the Export and Import bar, and fills the header', async () => {
        seed([storedRun(), storedRun({ timestamp: '2026-10-02T10:00:00.000Z', duration: 300_000 })]);

        await openFromPalette();

        expect(ui.container.style.display).not.toBe('none');
        expect(buttons()).toContain('Import');
        expect(buttons()).toContain('Export');
        expect(runListText()).not.toContain('No runs yet');
        expect(text('#mwi-dt-header-runs')).toBe('2');
        expect(text('#mwi-dt-header-avg')).not.toBe('--:--');
        expect(text('#mwi-dt-header-last')).not.toBe('--:--');
    });

    test('reads as idle rather than "Loading..."', async () => {
        seed([storedRun()]);
        await openFromPalette();

        expect(text('#mwi-dt-dungeon-name')).toBe('No dungeon running');
        expect(text('#mwi-dt-character-name')).toBe('Marketcow');
        expect(ui.container.textContent).not.toContain('Loading...');
    });

    test('with no stored runs says so, and still offers Import', async () => {
        await openFromPalette();

        expect(runListText()).toContain('No runs yet');
        expect(buttons()).toContain('Import');
        expect(text('#mwi-dt-header-runs')).toBe('0');
    });

    test('a failed read is not drawn as an empty history', async () => {
        seed([storedRun()]);
        world.unreadable = true;

        await openFromPalette();

        expect(runListText()).toContain('could not be read');
        expect(runListText()).not.toContain('No runs yet');
        expect(text('#mwi-dt-header-runs')).toBe('--');
        expect(buttons()).not.toContain('Import');
    });

    test('a later open redraws once the store can be read again', async () => {
        seed([storedRun()]);
        world.unreadable = true;
        await openFromPalette();
        expect(runListText()).toContain('could not be read');
        ui.toggle(); // hide

        world.unreadable = false;
        await openFromPalette();

        expect(text('#mwi-dt-header-runs')).toBe('1');
        expect(buttons()).toContain('Import');
    });

    test('reopening after a run ended does not keep the finished run on the card', async () => {
        seed([storedRun()]);
        ui.container.querySelector('#mwi-dt-dungeon-name').textContent = 'Pirate Cove (T3)';
        ui.container.querySelector('#mwi-dt-wave-counter').textContent = 'Wave 40/65';
        ui.container.querySelector('#mwi-dt-header-keys').textContent = '12';
        ui.hide();

        await openFromPalette();

        expect(text('#mwi-dt-dungeon-name')).toBe('No dungeon running');
        expect(text('#mwi-dt-wave-counter')).toBe('');
        expect(text('#mwi-dt-header-keys')).toBe('--');
    });

    test('reopening after a character switch shows the arriving character, not the departing one', async () => {
        seed([
            storedRun({ recordedBy: '603281' }),
            storedRun({ recordedBy: '777', timestamp: '2026-10-03T10:00:00.000Z' }),
        ]);
        await openFromPalette();
        expect(text('#mwi-dt-header-runs')).toBe('1');
        ui.hide();

        // The switch: teardown, then the arriving character's own initialize
        ui.cleanup();
        world.characterId = '777';
        world.characterName = 'Ironcow';
        await freshPanel();
        expect(ui.container.style.display).toBe('none');

        await openFromPalette();

        expect(text('#mwi-dt-header-runs')).toBe('1');
        expect(text('#mwi-dt-character-name')).toBe('Marketcow'); // data-manager's name for the session
        expect(document.querySelectorAll('#mwi-dungeon-tracker')).toHaveLength(1);
    });
});

describe('opening the panel while a dungeon is running', () => {
    test('a live run is left to its own draw', async () => {
        world.currentRun = { dungeonName: 'Pirate Cove', tier: 1 };
        const spy = vi.spyOn(dungeonTrackerStorage, 'getAllRunsOrNull');
        ui.container.querySelector('#mwi-dt-dungeon-name').textContent = 'Pirate Cove (T1)';

        ui.toggle();
        await Promise.resolve();

        expect(ui.container.style.display).toBe('block');
        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('the pending card is drawn as it always was', async () => {
        world.pending = { dungeonName: 'Pirate Cove', tier: 1 };

        ui.toggle();
        await vi.waitFor(() => {
            if (text('#mwi-dt-dungeon-name') !== 'Pirate Cove (T1)') throw new Error('not drawn');
        });

        expect(text('#mwi-dt-wave-counter')).toBe('waiting for next wave');
    });
});

describe('"This character" for runs imported from an older build', () => {
    const me = { id: '603281', name: 'Marketcow' };

    test('a stamp matches whether the id is a number or a string on either side', () => {
        const runs = [storedRun({ recordedBy: 603281 }), storedRun({ recordedBy: '603281' })];
        expect(filterRunsForCharacter(runs, 'mine', me)).toHaveLength(2);
        expect(filterRunsForCharacter(runs, 'mine', { id: 603281, name: 'Marketcow' })).toHaveLength(2);
    });

    test('a run with no stamp matches by roster, from the team list or the team key', () => {
        const byTeamList = storedRun({ recordedBy: undefined, team: ['Marketcow', 'Pal'], teamKey: 'Marketcow,Pal' });
        const byKeyOnly = storedRun({ recordedBy: undefined, team: undefined, teamKey: 'Marketcow,Pal' });
        const someoneElses = storedRun({ recordedBy: undefined, team: ['Pal'], teamKey: 'Pal' });
        const kept = filterRunsForCharacter([byTeamList, byKeyOnly, someoneElses], 'mine', me);
        expect(kept).toEqual([byTeamList, byKeyOnly]);
    });

    test('another character’s stamp does not match, even if the roster does', () => {
        const run = storedRun({ recordedBy: '777', teamKey: 'Marketcow,Pal' });
        expect(filterRunsForCharacter([run], 'mine', me)).toEqual([]);
    });
});

describe('the close button', () => {
    const live = (overrides = {}) => ({
        dungeonName: 'Pirate Cove',
        tier: 1,
        currentWave: 3,
        maxWaves: 65,
        totalElapsed: 30_000,
        keyCountsMap: {},
        ...overrides,
    });
    const tick = (run = world.currentRun, completed = null) => ui.dungeonUpdateHandler(run, completed);
    const closeButton = () => ui.container.querySelector('#mwi-dt-close-btn');
    const isOpen = () => ui.container.style.display !== 'none';

    test('closing while idle stays closed', () => {
        ui.toggle();
        expect(isOpen()).toBe(true);
        closeButton().click();
        expect(isOpen()).toBe(false);
        tick(null);
        expect(isOpen()).toBe(false);
    });

    test('closing during a run survives further ticks', () => {
        world.currentRun = live();
        tick();
        expect(isOpen()).toBe(true);
        closeButton().click();
        tick();
        tick(live({ currentWave: 4 }));
        expect(isOpen()).toBe(false);
    });

    test('a new dungeon action opens the panel again', () => {
        world.currentRun = live();
        tick();
        closeButton().click();
        // The action ends...
        world.currentRun = null;
        tick(null, { dungeonName: 'Pirate Cove' });
        expect(isOpen()).toBe(false);
        // ...and the next one starts
        world.currentRun = live({ currentWave: 1 });
        tick();
        expect(isOpen()).toBe(true);
    });

    test('a different dungeon opens the panel even if the end was never seen', () => {
        world.currentRun = live();
        tick();
        closeButton().click();
        world.currentRun = live({ dungeonName: 'Chimerical Den' });
        tick();
        expect(isOpen()).toBe(true);
    });

    test('the gap between runs of a repeating action stays closed', () => {
        world.currentRun = live();
        tick();
        closeButton().click();
        world.currentRun = null;
        world.pending = { dungeonName: 'Pirate Cove', tier: 1, betweenRuns: true };
        tick(null, { dungeonName: 'Pirate Cove' });
        expect(isOpen()).toBe(false);
        world.pending = null;
        world.currentRun = live({ currentWave: 1 });
        tick();
        expect(isOpen()).toBe(false);
    });

    test('Ctrl+K during a dismissed run reopens it and clears the dismissal', () => {
        world.currentRun = live();
        tick();
        closeButton().click();
        ui.toggle();
        expect(isOpen()).toBe(true);
        tick();
        expect(isOpen()).toBe(true);
    });

    test('a character switch clears the dismissal', async () => {
        world.currentRun = live();
        tick();
        closeButton().click();
        ui.cleanup();
        expect(ui.dismissed).toBe(null);
        await freshPanel();
        tick();
        expect(isOpen()).toBe(true);
    });
});
