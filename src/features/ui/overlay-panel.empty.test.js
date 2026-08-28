/**
 * @vitest-environment happy-dom
 *
 * What the overlay looks like before anything has happened.
 *
 * The panel's first open used to be a wall of placeholders: every registered row
 * on by default, and every one of them saying "No run measured yet", "Nothing
 * watched", "No loot tracked yet" — twice each, in some cases, since two tiles
 * are allowed to be idle in the same words. The three figures that were actually
 * live were somewhere in the middle of it.
 *
 * Two things fix that and both are tested here: a curated set of rows for a
 * character who has never arranged the overlay, and a rule about what a tile
 * does when it has drawn nothing. Neither may touch a player who already has a
 * layout — the last test is the one that matters most.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
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
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

/** What storage hands back for this character, and what the panel wrote to it */
const saved = vi.hoisted(() => ({ read: null, written: null }));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async () => saved.read,
    writeScoped: async (key, value) => {
        saved.written = value;
    },
}));

/**
 * The rows the game has registered, decided per test.
 *
 * The registry itself is real — the class table and the curated set are the
 * things under test — so only the list of rows is replaced.
 */
const game = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => game.rows,
}));

const overlayPanel = (await import('./overlay-panel.js')).default;
const { CURATED_ROWS, TILE_CLASS, EMPTY_POLICY, emptyPolicyFor, compactLabel, waitingLine, emptyContract } =
    await import('../../utils/overlay-rows.js');

/**
 * A row that draws whatever it is told to.
 * @param {string} key - Row key, which is what the class table is keyed by
 * @param {Object} [options] - `{name, text, empty, onOpen, tileClass}`
 * @returns {Object} A row definition
 */
function row(key, { name = key, text = '', empty = '', onOpen = null, tileClass = '' } = {}) {
    return {
        key,
        name,
        empty,
        onOpen,
        tileClass,
        defaultVisible: true,
        defaultSize: { width: 160, height: 40 },
        render: (el) => {
            el.replaceChildren();
            if (text) el.textContent = text;
        },
    };
}

/** Every tile the panel has drawn, by row key. @returns {Map<string, HTMLElement>} */
function tiles() {
    const found = new Map();
    for (const element of overlayPanel.canvasEl.querySelectorAll('[data-overlay-row]')) {
        found.set(element.dataset.overlayRow, element);
    }
    return found;
}

/** The keys of the tiles that are actually on screen. @returns {string[]} */
function shown() {
    return [...tiles()]
        .filter(([, element]) => element.style.display !== 'none')
        .map(([key]) => key)
        .sort();
}

/** Everything the panel is currently saying. @returns {string} */
function text() {
    return overlayPanel.panel.textContent;
}

beforeEach(() => {
    saved.read = null;
    saved.written = null;
    game.rows = [];
    document.body.replaceChildren();
    overlayPanel.isInitialized = false;
    overlayPanel.justEnabled.clear();
});

afterEach(() => {
    overlayPanel.hide();
    overlayPanel.isInitialized = false;
});

describe('a character who has never arranged the overlay', () => {
    test('starts with the curated set and nothing else', async () => {
        game.rows = [...CURATED_ROWS, 'combatRevenue', 'treasure', 'watchlist', 'houses'].map((key) =>
            row(key, { text: 'x' })
        );

        await overlayPanel.initialize();
        overlayPanel.show();

        expect(shown()).toEqual([...CURATED_ROWS].sort());
    });

    test('the curated tiles are placed in the curated order, packed from the top left', async () => {
        // Registration order is whatever the bundles happen to import in, and a
        // fresh layout has no saved positions — so the order the curated set is
        // written in is the only thing deciding what sits where
        game.rows = [...CURATED_ROWS].reverse().map((key) => row(key, { text: 'x' }));

        await overlayPanel.initialize();
        overlayPanel.show();

        const first = tiles().get(CURATED_ROWS[0]);
        expect(first.style.left).toBe('0px');
        expect(first.style.top).toBe('0px');
    });

    test('nothing is said about a row that failed to draw', async () => {
        game.rows = CURATED_ROWS.map((key) => row(key, { text: 'x' }));

        await overlayPanel.initialize();
        overlayPanel.show();

        expect(text()).not.toContain('unavailable');
    });
});

describe('a character who arranged the overlay before the curated set existed', () => {
    test('keeps every row their own layout had on', async () => {
        // The saved settings have no opinion on rows they never ticked, and the
        // rows themselves default to on — which is the arrangement that player
        // is used to and has to keep
        game.rows = [row('luck', { text: 'x' }), row('dps', { text: 'x' }), row('netWorth', { text: 'x' })];
        saved.read = { visible: { dps: false }, order: ['luck', 'dps', 'netWorth'], positions: {}, sizes: {} };

        await overlayPanel.initialize();
        overlayPanel.show();

        expect(shown()).toEqual(['luck', 'netWorth']);
        expect(overlayPanel.settings.curatedDefaults).toBe(false);
    });

    test('their saved positions and sizes are left exactly as they were', async () => {
        game.rows = [row('luck', { text: 'x' })];
        saved.read = {
            visible: { luck: true },
            order: ['luck'],
            positions: { luck: { x: 40, y: 90 } },
            sizes: { luck: { width: 200, height: 60 } },
        };

        await overlayPanel.initialize();
        overlayPanel.show();

        expect(tiles().get('luck').style.left).toBe('40px');
        expect(tiles().get('luck').style.top).toBe('90px');
        expect(tiles().get('luck').style.height).toBe('60px');
    });
});

describe('a tile with nothing to show', () => {
    /**
     * Open the panel on the given rows, with the given empty-tile setting.
     * @param {Array<Object>} rows - Row definitions
     * @param {string} [setting] - The `emptyTiles` setting
     */
    async function open(rows, setting = EMPTY_POLICY.AUTO) {
        game.rows = rows;
        saved.read = {
            visible: Object.fromEntries(rows.map((entry) => [entry.key, true])),
            order: rows.map((entry) => entry.key),
            emptyTiles: setting,
            locked: true,
        };
        await overlayPanel.initialize();
        overlayPanel.show();
    }

    test('the left tile of a pair going quiet does not leave a hole', async () => {
        // Reported from the Skilling preset on a character crafting quietly: the
        // top line came out as an empty left cell with the time-to-level tile
        // hugging the right column, which reads as the layout being jumbled
        game.rows = [
            row('experiencePerHour', { name: 'Experience/hr', empty: 'No experience yet' }),
            row('timeToLevel', { name: 'Time to Level', text: 'Melee 151: —' }),
        ];
        saved.read = {
            visible: { experiencePerHour: true, timeToLevel: true },
            order: ['experiencePerHour', 'timeToLevel'],
            positions: { experiencePerHour: { x: 0, y: 0 }, timeToLevel: { x: 220, y: 0 } },
            sizes: { experiencePerHour: { width: 220, height: 30 }, timeToLevel: { width: 220, height: 30 } },
            emptyTiles: EMPTY_POLICY.AUTO,
            locked: true,
        };
        await overlayPanel.initialize();
        overlayPanel.show();

        const quiet = tiles().get('experiencePerHour');
        expect(quiet.style.display).not.toBe('none');
        expect(quiet.style.left).toBe('0px');
        expect(quiet._content.textContent).toBe('Experience/hr');
        // And the tile beside it has not moved to fill the space
        expect(tiles().get('timeToLevel').style.left).toBe('220px');
    });

    test('a measurement waiting on an activity keeps its slot and names itself', async () => {
        // It used to go away, which in a grid of saved positions leaves a hole
        // where it sat rather than closing the line up
        await open([row('dps', { name: 'DPS', empty: 'No damage tracked yet' }), row('coins', { text: '1,024' })]);

        expect(shown()).toEqual(['coins', 'dps']);
        expect(tiles().get('dps')._content.textContent).toBe('DPS');
        expect(tiles().get('dps').style.height).toBe('20px');
        expect(text()).not.toContain('No damage tracked yet');
    });

    test('and comes back to full size the moment it has something to say', async () => {
        const dps = row('dps', { name: 'DPS', empty: 'No damage tracked yet' });
        await open([dps, row('coins', { text: '1,024' })]);
        expect(tiles().get('dps').style.height).toBe('20px');

        // The fight starts
        dps.render = (el) => (el.textContent = '412 dps');
        overlayPanel.refresh();

        expect(shown()).toEqual(['coins', 'dps']);
        expect(tiles().get('dps').style.height).toBe('40px');
        expect(text()).toContain('412 dps');
    });

    test('a figure that will fill itself in shrinks to a dim name', async () => {
        await open([row('netWorth', { name: 'Net Worth', empty: 'No net worth yet' })]);

        const tile = tiles().get('netWorth');
        expect(tile.style.display).not.toBe('none');
        expect(tile._content.textContent).toBe('Net Worth');
        expect(tile.style.height).toBe('20px');
        expect(text()).not.toContain('No net worth yet');
    });

    test('the strip is confined to its own tile, whatever the row had drawn', async () => {
        // A row styles the tile's content box to draw itself and `blank` clears
        // the children without putting any of it back. So the strip used to be
        // laid out by whatever shape the row had left behind — a grid set up for
        // three columns of figures lays a strip out in one of those columns.
        const netWorth = row('netWorth', { name: 'Net Worth', empty: 'No net worth yet' });
        netWorth.render = (element) => {
            Object.assign(element.style, { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto auto' });
            element.textContent = '12.4M';
        };
        await open([netWorth]);
        expect(tiles().get('netWorth')._content.style.display).toBe('grid');

        netWorth.render = (element) => element.replaceChildren();
        overlayPanel.refresh();

        const content = tiles().get('netWorth')._content;
        expect(content.textContent).toBe('Net Worth');
        // The box is back to its own shape, and the label is held inside it
        expect(content.style.gridTemplateColumns).toBe('');
        expect(content.style.width).toBe('100%');
        expect(content.style.overflow).toBe('hidden');

        const label = content.children[0];
        expect(label.style.textOverflow).toBe('ellipsis');
        expect(label.style.maxWidth).toBe('100%');
        expect(label.style.whiteSpace).toBe('nowrap');
    });

    test('and is centred in the tile rather than pinned to a fixed line height', async () => {
        // Which is what lets it sit level with a taller neighbour on the same
        // line instead of floating above its text
        await open([row('netWorth', { name: 'Net Worth', empty: 'No net worth yet' })]);

        const content = tiles().get('netWorth')._content;
        expect(content.style.display).toBe('flex');
        expect(content.style.alignItems).toBe('center');
    });

    test('a watch tile offers the click that would fill it', async () => {
        await open([row('watchlist', { name: 'Watchlist', empty: 'Nothing watched', onOpen: () => {} })]);

        expect(tiles().get('watchlist')._content.textContent).toBe('Watchlist — click to add');
    });

    test('a watch tile with nowhere to click stands down instead', async () => {
        // "Nothing watched" is only worth a line when there is something you can
        // do about it from here
        await open([
            row('equipmentWatch', { name: 'Equipment Watch', empty: 'Nothing watched' }),
            row('coins', { text: '1,024' }),
        ]);

        expect(shown()).toEqual(['coins']);
    });

    test('two tiles idle in the same words are still told apart', async () => {
        // The screenshot that started this had two "Nothing watched" tiles and
        // two "No run measured yet" ones. Whatever they say when compact, it
        // cannot be the same thing twice.
        await open(
            [
                row('watchlist', { name: 'Watchlist', empty: 'Nothing watched', onOpen: () => {} }),
                row('equipmentWatch', { name: 'Equipment Watch', empty: 'Nothing watched', onOpen: () => {} }),
                row('luck', { name: 'Drop Luck', empty: 'No run measured yet' }),
                row('overExpected', { name: 'Over Expected %', empty: 'No run measured yet' }),
            ],
            EMPTY_POLICY.COMPACT
        );

        const lines = [...tiles().values()].map((tile) => tile._content.textContent);
        expect(new Set(lines).size).toBe(lines.length);
        expect(lines).toContain('Watchlist — click to add');
        expect(lines).toContain('Drop Luck');
    });

    test('a row that fell over says so rather than quietly disappearing', async () => {
        const broken = row('dps', { name: 'DPS' });
        broken.render = () => {
            throw new Error('boom');
        };
        await open([broken]);

        expect(shown()).toEqual(['dps']);
        expect(text()).toContain('unavailable');
    });

    test('an icon on its own counts as having drawn something', async () => {
        const iconOnly = row('coins', { name: 'Coins' });
        iconOnly.render = (el) => {
            el.replaceChildren(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
        };
        await open([iconOnly]);

        expect(tiles().get('coins')._content.textContent).toBe('');
        expect(shown()).toEqual(['coins']);
    });

    test('the panel says why it is blank when every tile has been taken away', async () => {
        await open([row('dps', { empty: 'No damage tracked yet' })], EMPTY_POLICY.HIDE);

        expect(shown()).toEqual([]);
        expect(text()).toContain('appear as data arrives');
    });
});

describe('the empty-tiles setting', () => {
    /**
     * Open on one measurement row and one value row, under a chosen setting.
     * @param {string} setting - `auto`, `hide`, `compact` or `full`
     */
    async function openWith(setting) {
        game.rows = [
            row('dps', { name: 'DPS', empty: 'No damage tracked yet' }),
            row('netWorth', { name: 'Net Worth', empty: 'No net worth yet' }),
        ];
        saved.read = {
            visible: { dps: true, netWorth: true },
            order: ['dps', 'netWorth'],
            emptyTiles: setting,
            locked: true,
        };
        await overlayPanel.initialize();
        overlayPanel.show();
    }

    test('hide takes every empty tile away, whatever its class', async () => {
        await openWith(EMPTY_POLICY.HIDE);
        expect(shown()).toEqual([]);
    });

    test('compact leaves every empty tile as a dim name', async () => {
        await openWith(EMPTY_POLICY.COMPACT);

        expect(shown()).toEqual(['dps', 'netWorth']);
        expect(tiles().get('dps')._content.textContent).toBe('DPS');
        expect(tiles().get('dps').style.height).toBe('20px');
    });

    test('full is the old behaviour: the row says its own line, at full size', async () => {
        await openWith(EMPTY_POLICY.FULL);

        expect(shown()).toEqual(['dps', 'netWorth']);
        expect(tiles().get('dps')._content.textContent).toBe('No damage tracked yet');
        expect(tiles().get('dps').style.height).toBe('40px');
    });

    test('is offered in the gear popover, and changing it redraws', async () => {
        await openWith(EMPTY_POLICY.AUTO);
        overlayPanel.pickerEl.style.display = '';
        overlayPanel._renderPicker();

        const select = overlayPanel.pickerEl.querySelector('[data-overlay-setting="emptyTiles"]');
        expect(select).toBeTruthy();
        expect(select.value).toBe(EMPTY_POLICY.AUTO);

        select.value = EMPTY_POLICY.FULL;
        select.dispatchEvent(new Event('change'));

        expect(overlayPanel.settings.emptyTiles).toBe(EMPTY_POLICY.FULL);
        expect(text()).toContain('No damage tracked yet');
    });

    test('arranging the layout shows everything, whatever the policy says', async () => {
        // Unlocked, the tiles are being placed rather than read — and a tile
        // that has hidden itself cannot be placed
        await openWith(EMPTY_POLICY.HIDE);
        expect(shown()).toEqual([]);

        overlayPanel.settings.locked = false;
        overlayPanel.refresh();

        expect(shown()).toEqual(['dps', 'netWorth']);
        expect(text()).toContain('No damage tracked yet');
    });
});

describe('switching a tile on by hand', () => {
    /**
     * Open with a hidden-by-default measurement row switched off, plus one live
     * row so the panel is not empty.
     * @param {Array<Object>} [rows] - Rows to register
     */
    async function openWithOffRow(rows) {
        game.rows = rows || [
            row('guildTrialsPace', { name: 'Guild Trials', empty: 'Open the guild In Progress tab' }),
            row('coins', { name: 'Coins', text: '1,024' }),
        ];
        saved.read = {
            visible: { guildTrialsPace: false, coins: true },
            order: game.rows.map((entry) => entry.key),
            locked: true,
        };
        await overlayPanel.initialize();
        overlayPanel.show();
        overlayPanel.pickerEl.style.display = '';
        overlayPanel._renderPicker();
    }

    /**
     * Tick or untick a row's box in the ⚙ list, the way a player does.
     * @param {string} key - Row key
     * @param {boolean} on - Whether to switch it on
     */
    function tick(key, on) {
        const box = overlayPanel.pickerEl.querySelector(`[data-overlay-row-chip="${key}"] input`);
        box.checked = on;
        box.dispatchEvent(new Event('change'));
    }

    test('answers the gesture: the tile appears, dim, saying what it waits for', async () => {
        // The bug as reported — "clicking it on doesn't add anything to the
        // overlay". Under the passive policy this row is hide-until-data, and
        // hide-until-data is indistinguishable from broken when it is the
        // response to a click.
        await openWithOffRow();
        expect(shown()).toEqual(['coins']);

        tick('guildTrialsPace', true);

        expect(shown()).toEqual(['coins', 'guildTrialsPace']);
        const content = tiles().get('guildTrialsPace')._content.textContent;
        expect(content).toContain('Guild Trials');
        expect(content).toContain('waiting for data');
        expect(content).toContain('Open the guild In Progress tab');
    });

    test('and keeps saying it, refresh after refresh, until there is data', async () => {
        await openWithOffRow();
        tick('guildTrialsPace', true);

        overlayPanel.refresh();
        overlayPanel.refresh();

        expect(shown()).toContain('guildTrialsPace');
    });

    test('the moment it has something real to say, it says that instead', async () => {
        await openWithOffRow();
        tick('guildTrialsPace', true);

        game.rows[0].render = (el) => (el.textContent = 'T7 · 4m');
        overlayPanel.refresh();

        expect(tiles().get('guildTrialsPace')._content.textContent).toBe('T7 · 4m');
        expect(overlayPanel.justEnabled.has('guildTrialsPace')).toBe(false);
    });

    test('and having been seen to work, it goes back to standing down when it empties', async () => {
        // The acknowledgment is owed once. A tile that has proved itself may
        // hide again, which is the decluttering this policy exists for.
        await openWithOffRow();
        tick('guildTrialsPace', true);

        game.rows[0].render = (el) => (el.textContent = 'T7 · 4m');
        overlayPanel.refresh();
        game.rows[0].render = (el) => el.replaceChildren();
        overlayPanel.refresh();

        // Standing down is now a dim strip in its own slot rather than an
        // absence, so the tile is still there — just no longer promising
        expect(shown()).toEqual(['coins', 'guildTrialsPace']);
        expect(tiles().get('guildTrialsPace')._content.textContent).toBe('Guild Trials');
    });

    test('switching it off again withdraws the question', async () => {
        await openWithOffRow();
        tick('guildTrialsPace', true);
        tick('guildTrialsPace', false);

        expect(overlayPanel.justEnabled.has('guildTrialsPace')).toBe(false);
        expect(shown()).toEqual(['coins']);
    });

    test('a tile nobody touched names itself rather than pleading, which is the point', async () => {
        await openWithOffRow([
            row('guildTrialsPace', { name: 'Guild Trials', empty: 'Open the guild In Progress tab' }),
            row('dps', { name: 'DPS', empty: 'No damage tracked yet' }),
            row('coins', { name: 'Coins', text: '1,024' }),
        ]);
        overlayPanel.settings.visible = { ...overlayPanel.settings.visible, dps: true };
        overlayPanel.refresh();

        // `dps` is on, empty, and was switched on by a saved setting rather than
        // by a click in front of the player — so it gets a dim name rather than
        // the placeholder sentence the gesture would have earned it
        expect(tiles().get('dps')._content.textContent).toBe('DPS');
        expect(text()).not.toContain('No damage tracked yet');
    });

    test('the explicit empty-tiles setting still outranks the gesture', async () => {
        await openWithOffRow();
        overlayPanel.settings.emptyTiles = EMPTY_POLICY.HIDE;
        tick('guildTrialsPace', true);

        expect(shown()).toEqual(['coins']);
    });

    test('nothing about the gesture is written to storage', async () => {
        // It records a click, not a preference — and `emptyTiles` is the durable
        // version of the same wish
        await openWithOffRow();
        saved.written = null;
        tick('guildTrialsPace', true);

        expect(saved.written).not.toBeNull();
        expect(JSON.stringify(saved.written)).not.toContain('justEnabled');
    });

    test('the ⚙ list says which rows only appear once they have data', async () => {
        await openWithOffRow();

        const chip = overlayPanel.pickerEl.querySelector('[data-overlay-row-chip="guildTrialsPace"]');
        expect(chip.title).toContain('shows when it has data');
        expect(chip.querySelector('[data-overlay-contract]')).toBeTruthy();

        // And says nothing about the ones that fill themselves in
        const coins = overlayPanel.pickerEl.querySelector('[data-overlay-row-chip="coins"]');
        expect(coins.querySelector('[data-overlay-contract]')).toBeNull();
    });
});

describe('the policy each row gets', () => {
    test('classes a row by its key, and lets a row say for itself', () => {
        expect(emptyPolicyFor({ key: 'netWorth' })).toBe(EMPTY_POLICY.COMPACT);
        expect(emptyPolicyFor({ key: 'dps' })).toBe(EMPTY_POLICY.COMPACT);
        expect(emptyPolicyFor({ key: 'dps', whenEmpty: EMPTY_POLICY.FULL })).toBe(EMPTY_POLICY.FULL);
        expect(emptyPolicyFor({ key: 'dps', tileClass: TILE_CLASS.VALUE })).toBe(EMPTY_POLICY.COMPACT);
    });

    test('a row nobody has classified shows a name rather than vanishing', () => {
        // Which is what a row added by a later update gets, sight unseen
        expect(emptyPolicyFor({ key: 'somethingNew', name: 'Something New' })).toBe(EMPTY_POLICY.COMPACT);
        expect(compactLabel({ key: 'somethingNew', name: 'Something New' })).toBe('Something New');
    });

    test('the trials tile stands down to its name when nobody has asked for it', () => {
        // Its data comes off a game tab that may never have been opened, so it
        // says nothing about itself until then — but keeps its place while
        expect(emptyPolicyFor({ key: 'guildTrialsPace' })).toBe(EMPTY_POLICY.COMPACT);
        expect(waitingLine({ key: 'guildTrialsPace' })).toBe('waiting for data');
        expect(emptyContract({ key: 'guildTrialsPace' })).toBe('shows when it has data');
    });

    test('what a tile is waiting for is said in its own terms', () => {
        expect(waitingLine({ key: 'watchlist', onOpen: () => {} })).toContain('watch');
        expect(waitingLine({ key: 'netWorth' })).toContain('waiting');
        expect(emptyContract({ key: 'netWorth' })).toBe('');
    });

    test('the setting overrides every one of them', () => {
        expect(emptyPolicyFor({ key: 'netWorth' }, EMPTY_POLICY.HIDE)).toBe(EMPTY_POLICY.HIDE);
        expect(emptyPolicyFor({ key: 'dps', whenEmpty: EMPTY_POLICY.FULL }, EMPTY_POLICY.HIDE)).toBe(EMPTY_POLICY.HIDE);
    });
});
