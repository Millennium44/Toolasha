/**
 * @vitest-environment happy-dom
 *
 * Presets and context layouts, through the panel.
 *
 * `overlay-layouts.test.js` covers the preset definitions and the switch
 * decision on their own, which is where the arithmetic is. What only the panel
 * can answer is whether any of it is wired up: whether applying a preset
 * actually rearranges the tiles, whether the mapping selector writes anywhere
 * that survives, and whether the tick that follows your activity reads the
 * settings it is supposed to read.
 *
 * The clock is driven rather than run. `_followActivity` is called directly with
 * `Date.now` stubbed, because the alternative is a test that waits ten real
 * seconds to find out that ten seconds is the threshold.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: new Map() }));
const game = vi.hoisted(() => ({ actions: [], labyrinth: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        // Only so the per-character storage key has something to be scoped by;
        // nothing in these tests is about which character it is
        getCurrentCharacterId: () => 'test-character',
        get characterData() {
            return { characterLabyrinth: game.labyrinth };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key) => (store.data.has(key) ? JSON.parse(JSON.stringify(store.data.get(key))) : null),
        setJSON: async (key, value) => {
            store.data.set(key, JSON.parse(JSON.stringify(value)));
            return true;
        },
        set: async () => true,
        get: async () => null,
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
    PANEL_Z_CAP: 1199,
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({ overlayPanel: { left: 10, top: 20, width: 500, height: 300 } }),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));

const dialog = vi.hoisted(() => ({ answer: null, offered: null }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async ({ choices }) => {
        dialog.offered = choices.map((choice) => choice.value);
        return dialog.answer;
    },
}));

const { registerRow } = await import('../../utils/overlay-rows.js');
const overlayPanel = (await import('./overlay-panel.js')).default;
const { PRESET_LAYOUTS, ACTIVITY, SWITCH_STABILITY_MS } = await import('./overlay-layouts.js');

/** Every row a preset names has to exist, or applying one places nothing */
const PRESET_ROWS = [...new Set(Object.values(PRESET_LAYOUTS).flatMap((preset) => preset.rows))];

const CLOCK = 1_700_000_000_000;

/**
 * Move the clock, without moving anything else.
 * @param {number} ms - Milliseconds since the start of the test
 */
function at(ms) {
    vi.spyOn(Date, 'now').mockReturnValue(CLOCK + ms);
}

/**
 * Put the character in the middle of something.
 * @param {string|null} kind - `combat`, `skilling`, `labyrinth`, or null for idle
 */
function doing(kind) {
    game.labyrinth = kind === 'labyrinth' ? { roomData: [{ id: 1 }] } : null;
    game.actions =
        kind === 'combat'
            ? [{ actionHrid: '/actions/combat/fly', isDone: false }]
            : kind === 'skilling' || kind === 'labyrinth'
              ? [{ actionHrid: '/actions/milking/cow', isDone: false }]
              : [];
}

/** The rows currently switched on, in order. @returns {string[]} */
function shown() {
    return (overlayPanel.settings.order || []).filter((key) => overlayPanel.settings.visible[key]);
}

beforeEach(() => {
    store.data.clear();
    dialog.answer = null;
    dialog.offered = null;
    document.body.replaceChildren();
    at(0);

    for (const key of [...PRESET_ROWS, 'dps', 'luck']) {
        registerRow({ key, name: key, render: (el) => (el.textContent = key) });
    }

    overlayPanel.settings = {
        visible: { dps: true },
        order: ['dps', 'luck'],
        positions: {},
        sizes: {},
        zoom: {},
        locked: true,
        snapToGrid: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
        autoSwitchLayout: false,
        layoutActivity: {},
    };
    overlayPanel.savedLayouts = [];
    overlayPanel.undoState = null;
    overlayPanel.switchState = {
        seen: null,
        seenSince: 0,
        applied: null,
        paused: false,
        pausedAt: null,
    };
    overlayPanel.show();
});

afterEach(() => {
    overlayPanel.hide();
    vi.restoreAllMocks();
    game.actions = [];
    game.labyrinth = null;
});

describe('applying a preset', () => {
    test('a preset arrives with exactly its own rows on', async () => {
        expect(await overlayPanel.applyNamedLayout('Skilling')).toBe(true);

        expect(shown()).toEqual(PRESET_LAYOUTS.Skilling.rows);
        expect(overlayPanel.settings.visible.dps).toBeFalsy();
    });

    test('a preset places its tiles rather than stacking them at the origin', async () => {
        await overlayPanel.applyNamedLayout('Combat');

        // Nothing is saved as a position — the packer puts them where the panel
        // has room, which is what makes a preset fit a panel it has never seen
        expect(overlayPanel.settings.positions).toEqual({});
        expect(overlayPanel.canvasEl.children.length).toBeGreaterThan(1);
    });

    test('switching between two presets goes back and forth cleanly', async () => {
        await overlayPanel.applyNamedLayout('Combat');
        await overlayPanel.applyNamedLayout('Market');
        expect(shown()).toEqual(PRESET_LAYOUTS.Market.rows);

        await overlayPanel.applyNamedLayout('Combat');
        expect(shown()).toEqual(PRESET_LAYOUTS.Combat.rows);
    });

    test('applying one can be taken back, like any other switch', async () => {
        await overlayPanel.applyNamedLayout('Combat');
        expect(overlayPanel.undoState.what).toBe('switch to Combat');
    });

    test('a name that is neither saved nor a preset does nothing', async () => {
        expect(await overlayPanel.applyNamedLayout('Nowhere')).toBe(false);
        expect(shown()).toEqual(['dps']);
    });
});

describe('presets are not yours to lose', () => {
    test('Delete never offers one', async () => {
        overlayPanel.settings.visible = { dps: true };
        await overlayPanel.saveNamedLayout('Mine');

        dialog.answer = null;
        await overlayPanel._promptDeleteLayout(document.createElement('select'));

        expect(dialog.offered).toEqual(['Mine', null]);
    });

    test('with nothing of your own saved, Delete has nothing to ask about', async () => {
        await overlayPanel._promptDeleteLayout(document.createElement('select'));
        expect(dialog.offered).toBeNull();
    });

    test('saving your own under a preset name shadows it, and the copy is what applies', async () => {
        overlayPanel.settings.visible = { dps: true, luck: true };
        overlayPanel.settings.order = ['dps', 'luck'];
        expect(await overlayPanel.saveNamedLayout('Combat')).toBe(true);

        await overlayPanel.applyNamedLayout('Skilling');
        await overlayPanel.applyNamedLayout('Combat');

        expect(shown()).toEqual(['dps', 'luck']);
    });
});

describe('mapping a layout to an activity', () => {
    /** Open the gear popover with the mapping selectors drawn. @returns {Promise<void>} */
    async function openPicker() {
        overlayPanel.settings.autoSwitchLayout = true;
        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();
    }

    test('the toggle is off until it is switched on', () => {
        expect(overlayPanel.settings.autoSwitchLayout).toBe(false);
    });

    test('no selectors are drawn while auto-switching is off', async () => {
        overlayPanel.pickerEl.style.display = '';
        await overlayPanel._refreshLayoutNames();

        expect(overlayPanel.pickerEl.querySelectorAll('[data-overlay-activity-for]')).toHaveLength(0);
        expect(overlayPanel.pickerEl.querySelector('[data-overlay-auto-switch]')).not.toBeNull();
    });

    test('every offered layout gets one, and a preset arrives already pointed at its own activity', async () => {
        await openPicker();

        const combat = overlayPanel.pickerEl.querySelector('[data-overlay-activity-for="Combat"]');
        expect(combat.value).toBe(ACTIVITY.COMBAT);
        expect(overlayPanel.pickerEl.querySelector('[data-overlay-activity-for="Market"]').value).toBe(ACTIVITY.MARKET);
    });

    test('choosing an activity is written into the panel’s own settings', async () => {
        overlayPanel.settings.visible = { dps: true };
        await overlayPanel.saveNamedLayout('Mine');
        await openPicker();

        const select = overlayPanel.pickerEl.querySelector('[data-overlay-activity-for="Mine"]');
        expect(select.value).toBe(ACTIVITY.NONE);

        select.value = ACTIVITY.COMBAT;
        select.dispatchEvent(new Event('change'));

        expect(overlayPanel.settings.layoutActivity).toEqual({ Mine: ACTIVITY.COMBAT });
    });

    test('a preset can be pointed somewhere else', async () => {
        await openPicker();

        const select = overlayPanel.pickerEl.querySelector('[data-overlay-activity-for="Combat"]');
        select.value = ACTIVITY.LABYRINTH;
        select.dispatchEvent(new Event('change'));

        expect(overlayPanel.settings.layoutActivity.Combat).toBe(ACTIVITY.LABYRINTH);
        expect(overlayPanel._activityFor('Combat')).toBe(ACTIVITY.LABYRINTH);
    });
});

describe('following what you are doing', () => {
    beforeEach(() => {
        overlayPanel.settings.autoSwitchLayout = true;
    });

    test('off by default, nothing follows anything', async () => {
        overlayPanel.settings.autoSwitchLayout = false;
        doing('combat');

        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS + 1000);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(['dps']);
    });

    test('an activity that holds brings up its preset', async () => {
        doing('combat');

        await overlayPanel._followActivity();
        expect(shown()).toEqual(['dps']);

        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();
        expect(shown()).toEqual(PRESET_LAYOUTS.Combat.rows);
    });

    test('a change of activity brings up the other one', async () => {
        doing('combat');
        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();

        doing('skilling');
        at(SWITCH_STABILITY_MS + 1000);
        await overlayPanel._followActivity();
        expect(shown()).toEqual(PRESET_LAYOUTS.Combat.rows);

        at(2 * SWITCH_STABILITY_MS + 1000);
        await overlayPanel._followActivity();
        expect(shown()).toEqual(PRESET_LAYOUTS.Skilling.rows);
    });

    test('a labyrinth run is not read as ordinary combat', async () => {
        doing('labyrinth');

        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(PRESET_LAYOUTS.Labyrinth.rows);
    });

    test('the marketplace being open wins over whatever is being ground', async () => {
        doing('combat');
        const market = document.createElement('div');
        market.className = 'MarketplacePanel_marketItems__abc';
        document.body.appendChild(market);

        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(PRESET_LAYOUTS.Market.rows);
    });

    test('a brief flick to something else changes nothing', async () => {
        doing('combat');
        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();

        // Two seconds of an empty queue between batches
        doing(null);
        at(SWITCH_STABILITY_MS + 1000);
        await overlayPanel._followActivity();
        doing('combat');
        at(SWITCH_STABILITY_MS + 3000);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(PRESET_LAYOUTS.Combat.rows);
    });

    test('an unlocked layout is left exactly where its owner is arranging it', async () => {
        overlayPanel.settings.locked = false;
        doing('combat');

        await overlayPanel._followActivity();
        at(60_000);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(['dps']);
    });

    test('picking one by hand holds off the next switch until the activity changes', async () => {
        doing('combat');
        await overlayPanel._followActivity();

        // Chosen deliberately, mid-fight
        await overlayPanel.applyNamedLayout('Market');
        expect(shown()).toEqual(PRESET_LAYOUTS.Market.rows);

        at(60_000);
        await overlayPanel._followActivity();
        expect(shown()).toEqual(PRESET_LAYOUTS.Market.rows);

        // Stop fighting, and it is allowed to have an opinion again
        doing('skilling');
        at(61_000);
        await overlayPanel._followActivity();
        at(61_000 + SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();
        expect(shown()).toEqual(PRESET_LAYOUTS.Skilling.rows);
    });

    test('a layout of your own mapped to an activity beats the preset for it', async () => {
        overlayPanel.settings.visible = { dps: true, luck: true };
        overlayPanel.settings.order = ['dps', 'luck'];
        await overlayPanel.saveNamedLayout('Mine');
        overlayPanel.settings.layoutActivity = { Mine: ACTIVITY.COMBAT };

        doing('combat');
        await overlayPanel._followActivity();
        at(SWITCH_STABILITY_MS);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(['dps', 'luck']);
    });

    test('doing nothing identifiable switches nothing', async () => {
        doing(null);

        await overlayPanel._followActivity();
        at(60_000);
        await overlayPanel._followActivity();

        expect(shown()).toEqual(['dps']);
    });
});
