/**
 * @vitest-environment happy-dom
 *
 * Dungeon Tracker UI Interactions — filter indicator, destructive-confirm
 * routing, and the removed global reset-position shortcut.
 *
 * Dependencies that reach storage, the game's websocket hook, or build their
 * own DOM (dungeonTracker, chat annotations, config, storage, panel z-index,
 * the choice dialog) are mocked so the test is about this module's wiring,
 * not theirs.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const askChoiceMock = vi.fn();

vi.mock('./dungeon-tracker.js', () => ({ default: { backfillFromChatHistory: vi.fn() } }));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({ default: { refreshRunCounts: vi.fn() } }));
vi.mock('../../core/config.js', () => ({ default: { Z_NOTIFICATION: 9999 } }));
vi.mock('./dungeon-tracker-storage.js', () => ({ default: { clearAllRuns: vi.fn(async () => true) } }));
vi.mock('../../utils/panel-z-index.js', () => ({ bringPanelToFront: vi.fn() }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: (...args) => askChoiceMock(...args) }));

const { default: DungeonTrackerUIInteractions } = await import('./dungeon-tracker-ui-interactions.js');
const { default: dungeonTrackerStorage } = await import('./dungeon-tracker-storage.js');

/**
 * Build a minimal DOM container plus a fake state object. Only the elements
 * exercised in a given test need to exist — every setup*() method here
 * guards on `if (!element) return;`.
 */
function buildContainer(html) {
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    return container;
}

function makeState(overrides = {}) {
    return {
        filterDungeon: 'all',
        filterTeam: 'all',
        position: null,
        hasActiveFilters() {
            return this.filterDungeon !== 'all' || this.filterTeam !== 'all';
        },
        clearFilters() {
            this.filterDungeon = 'all';
            this.filterTeam = 'all';
        },
        save: vi.fn(),
        updatePosition: vi.fn(),
        ...overrides,
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    askChoiceMock.mockReset();
    dungeonTrackerStorage.clearAllRuns.mockClear();
});

describe('filter indicator', () => {
    test('hidden on setup when no filters are active', () => {
        const container = buildContainer('<span id="mwi-dt-filter-indicator" style="display: none;"></span>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();

        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('none');
    });

    test('shown on setup when a filter was left active from a previous session', () => {
        const container = buildContainer('<span id="mwi-dt-filter-indicator" style="display: none;"></span>');
        const state = makeState({ filterDungeon: 'Chimeratos Lair' });
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();

        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');
    });

    test('clicking the indicator clears both filters, resets the dropdowns, saves, and refreshes', () => {
        const container = buildContainer(`
            <span id="mwi-dt-filter-indicator" style="display: none;"></span>
            <select id="mwi-dt-filter-dungeon">
                <option value="all">All Dungeons</option>
                <option value="Chimeratos Lair">Chimeratos Lair</option>
            </select>
            <select id="mwi-dt-filter-team">
                <option value="all">All Teams</option>
                <option value="Solo">Solo</option>
            </select>
        `);
        container.querySelector('#mwi-dt-filter-dungeon').value = 'Chimeratos Lair';
        container.querySelector('#mwi-dt-filter-team').value = 'Solo';

        const state = makeState({ filterDungeon: 'Chimeratos Lair', filterTeam: 'Solo' });
        const onUpdateHistory = vi.fn();
        const onUpdateChart = vi.fn();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory, onUpdateChart };

        interactions.setupFilterIndicator();
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');

        container.querySelector('#mwi-dt-filter-indicator').click();

        expect(state.filterDungeon).toBe('all');
        expect(state.filterTeam).toBe('all');
        expect(state.save).toHaveBeenCalled();
        expect(container.querySelector('#mwi-dt-filter-dungeon').value).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-team').value).toBe('all');
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('none');
        expect(onUpdateHistory).toHaveBeenCalledTimes(1);
        expect(onUpdateChart).toHaveBeenCalledTimes(1);
    });

    test('changing a filter dropdown updates the indicator immediately', () => {
        const container = buildContainer(`
            <span id="mwi-dt-filter-indicator" style="display: none;"></span>
            <select id="mwi-dt-filter-dungeon">
                <option value="all">All Dungeons</option>
                <option value="Chimeratos Lair">Chimeratos Lair</option>
            </select>
            <select id="mwi-dt-filter-team"><option value="all">All Teams</option></select>
        `);
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupFilterIndicator();
        interactions.setupGroupingControls();

        const dungeonSelect = container.querySelector('#mwi-dt-filter-dungeon');
        dungeonSelect.value = 'Chimeratos Lair';
        dungeonSelect.dispatchEvent(new Event('change'));

        expect(state.filterDungeon).toBe('Chimeratos Lair');
        expect(container.querySelector('#mwi-dt-filter-indicator').style.display).toBe('inline-flex');
    });
});

describe('clear-history confirmation', () => {
    test('routes through askChoice, not window.confirm, and does nothing on cancel', async () => {
        const container = buildContainer('<button id="mwi-dt-clear-all"></button>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory: vi.fn(), onUpdateChart: vi.fn() };

        askChoiceMock.mockResolvedValue(null); // user cancelled

        interactions.setupClearAll();
        container.querySelector('#mwi-dt-clear-all').click();
        await vi.waitFor(() => expect(askChoiceMock).toHaveBeenCalledTimes(1));

        const [call] = askChoiceMock.mock.calls[0];
        expect(call.choices.some((c) => c.tone === 'danger')).toBe(true);
        expect(dungeonTrackerStorage.clearAllRuns).not.toHaveBeenCalled();
    });

    test('deletes all history once the danger choice is confirmed', async () => {
        const container = buildContainer('<button id="mwi-dt-clear-all"></button>');
        const state = makeState();
        const onUpdateHistory = vi.fn();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = { onUpdateHistory, onUpdateChart: vi.fn() };

        askChoiceMock.mockResolvedValue('delete');
        vi.stubGlobal('alert', vi.fn());

        interactions.setupClearAll();
        container.querySelector('#mwi-dt-clear-all').click();
        await vi.waitFor(() => expect(dungeonTrackerStorage.clearAllRuns).toHaveBeenCalledTimes(1));

        expect(onUpdateHistory).toHaveBeenCalled();
        vi.unstubAllGlobals();
    });
});

describe('reset-position button', () => {
    test('clicking it clears the saved position and does not start a drag', () => {
        const container = buildContainer('<button id="mwi-dt-reset-position-btn"></button>');
        const state = makeState({ position: { x: 40, y: 60 } });
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        interactions.setupResetPositionButton();
        container.querySelector('#mwi-dt-reset-position-btn').click();

        expect(state.position).toBeNull();
        expect(state.updatePosition).toHaveBeenCalledWith(container);
        expect(state.save).toHaveBeenCalled();
    });
});

describe('global Ctrl+Shift+D shortcut removal', () => {
    test('no longer exists as a method, and setup registers no document keydown listener', () => {
        const container = buildContainer('<div id="mwi-dt-header"></div>');
        const state = makeState();
        const interactions = new DungeonTrackerUIInteractions(state, null, null);
        interactions.container = container;
        interactions.callbacks = {};

        expect(interactions.setupKeyboardShortcut).toBeUndefined();

        const addSpy = vi.spyOn(document, 'addEventListener');
        interactions.setupDragging();
        const keydownRegistrations = addSpy.mock.calls.filter(([type]) => type === 'keydown');
        expect(keydownRegistrations).toHaveLength(0);

        addSpy.mockRestore();
    });
});
