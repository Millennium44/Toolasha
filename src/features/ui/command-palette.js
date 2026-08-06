/**
 * Command Palette
 *
 * One place that knows where everything is.
 *
 * The script has grown about a dozen panels and several hundred settings, and
 * they are reached from five unrelated places: a tab beside Inventory, a button
 * in the game's settings dialog, a button injected into the Labyrinth tab strip,
 * a double-click on an overlay tile, and the overlay's own gear. None of those
 * is wrong, and together they mean the answer to "where is the DPS panel" is
 * "somewhere". There was no index and no hotkey at all.
 *
 * So: Ctrl+K (Cmd+K on a Mac) opens a search box over everything, listing every
 * overlay row, every floating panel, every saved overlay layout and every
 * setting by its label. Type a few letters, press Enter. It is keyboard-first
 * because that is the only reason to have it — a palette you have to reach for
 * with the mouse is a menu, and there is already a menu.
 *
 * ## Not while you are typing
 *
 * The game has a chat box, and Ctrl+K in a chat box is not a request for a
 * palette. Every keystroke is checked against what has focus first, and an
 * input, a textarea or anything contenteditable declines it. The one exception
 * is the palette's own input, so the same chord that opened it closes it.
 *
 * ## Reaching panels in other bundles
 *
 * The production build is seven bundles and a module imported across a bundle
 * boundary is *copied*, state and all — so a palette that imported the Treasure
 * tracker would toggle a second, invisible copy of it while the real one stayed
 * shut. Anything outside the UI bundle is therefore reached through
 * `window.Toolasha`, which holds the instances that were actually initialised,
 * and every lookup is optional: a panel whose feature is switched off is simply
 * not offered.
 */

import config from '../../core/config.js';
import { settingsGroups } from '../../core/settings-schema.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';
import { registeredRows } from '../../utils/overlay-rows.js';
import { showToast } from '../../utils/toast.js';
import overlayPanel from './overlay-panel.js';
import {
    goalPlanner,
    ironCowFarmPanel,
    treasureTracker,
    pformancePanel,
    combatSimUI,
    labSimUI,
    guildTrialScoreboard,
} from '../../utils/bundle-bridge.js';

const PALETTE_ID = 'toolasha-command-palette';

/** More than fits on screen anyway, and the cap is what keeps typing responsive */
const MAX_RESULTS = 60;

/** How long to keep looking for the settings panel after asking the game for it */
const SETTINGS_WAIT_MS = 3000;
const SETTINGS_POLL_MS = 60;

const COLORS = {
    background: 'rgba(12, 15, 26, 0.98)',
    border: 'rgba(120, 160, 255, 0.35)',
    text: '#e8ecf5',
    textDim: 'rgba(232, 236, 245, 0.6)',
    accent: '#9ec4ff',
    selected: 'rgba(158, 196, 255, 0.16)',
};

/* ---------------------------------------------------------------------- *
 * The pure parts: what counts as a match, and what counts as typing.
 * Both are exported so they can be tested without a DOM, which is where
 * the mistakes in either actually live.
 * ---------------------------------------------------------------------- */

/**
 * How well a query matches a string, as a subsequence.
 *
 * Subsequence rather than substring because the useful queries are initials and
 * fragments — "dps" for "DPS Panel", "ovl" for "Overlay Panel", "cmbt sim" for
 * "Combat Simulator" — and a substring match finds none of those. A run of the
 * whole query in one piece still wins outright, because when somebody types the
 * name of the thing they want, that is the thing they want.
 *
 * @param {string} query - What was typed
 * @param {string} text - What it might match
 * @returns {number} Higher is better; -1 for no match at all
 */
export function fuzzyScore(query, text) {
    const needle = String(query || '')
        .toLowerCase()
        .trim();
    const hay = String(text || '').toLowerCase();
    if (!needle) return 0;
    if (!hay) return -1;

    const direct = hay.indexOf(needle);
    if (direct >= 0) return 500 + needle.length * 6 - Math.min(direct, 100) + (direct === 0 ? 20 : 0);

    let score = 0;
    let from = 0;
    let previous = -2;

    for (const character of needle) {
        // A space in the query is a gap the text does not have to contain
        if (character === ' ') continue;

        const at = hay.indexOf(character, from);
        if (at < 0) return -1;

        // Runs are worth more than scattered letters, and the start of a word is
        // worth more than the middle of one — "cs" should find "Combat Sim"
        // rather than "Consumables"
        score += at === previous + 1 ? 6 : 1;
        if (at === 0 || /[\s:\-/(]/.test(hay[at - 1])) score += 4;

        previous = at;
        from = at + 1;
    }
    return score;
}

/**
 * The commands a query leaves, best first.
 *
 * An empty query keeps the original order, which is the order the sections were
 * built in — panels, then rows, then layouts, then settings — because that is
 * roughly least to most numerous and a palette that opens onto four hundred
 * settings is a palette nobody reads.
 *
 * Ties keep their original order, so repeating a query does not shuffle the
 * list under a selection that has already moved.
 *
 * @param {Array<Object>} commands - Every command, each with `search`
 * @param {string} query - What was typed
 * @param {number} [limit] - Most to return
 * @returns {Array<Object>} Matching commands
 */
export function filterCommands(commands, query, limit = MAX_RESULTS) {
    const list = commands || [];
    if (!String(query || '').trim()) return list.slice(0, limit);

    return list
        .map((command, index) => ({ command, index, score: fuzzyScore(query, command.search || command.label) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, limit)
        .map((entry) => entry.command);
}

/**
 * Whether a keystroke is being aimed at something that takes text.
 *
 * The game has a chat box and several number inputs, and a hotkey that fires
 * inside them is a hotkey that has to be switched off. Checked on the element
 * rather than on the event, because `contenteditable` is inherited — the target
 * of a keystroke inside an editable div is often a text node's parent several
 * levels down from the element carrying the attribute.
 *
 * @param {EventTarget|null} target - Usually `event.target`
 * @returns {boolean} True when the keystroke belongs to whatever has focus
 */
export function isTypingTarget(target) {
    const element = target && target.nodeType === 1 ? target : null;
    if (!element) return false;

    const tag = (element.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (typeof element.closest === 'function' && element.closest('[contenteditable=""], [contenteditable="true"]')) {
        return true;
    }
    return element.isContentEditable === true;
}

/**
 * Whether this keystroke is the palette's chord.
 *
 * Ctrl+K and Cmd+K both, rather than one per platform: the script runs in a
 * browser, and a Mac user pressing Ctrl+K meant it.
 *
 * @param {KeyboardEvent} event - The keystroke
 * @returns {boolean}
 */
export function isPaletteHotkey(event) {
    if (!event || event.altKey || event.shiftKey) return false;
    if (!event.ctrlKey && !event.metaKey) return false;
    return (event.key || '').toLowerCase() === 'k';
}

/* ---------------------------------------------------------------------- *
 * Where the things the palette offers actually live.
 * ---------------------------------------------------------------------- */

/**
 * The floating panels, each with the call that shows or hides it.
 *
 * Resolved when the palette opens rather than at module scope, because the
 * bundles load in order and the panels register themselves as their features
 * initialise — a list built at import time would be a list of undefineds.
 * Each target is read through the bundle bridge, which answers null for
 * anything whose bundle has not published it.
 *
 * @returns {Array<{name: string, hint: string, run: Function}>}
 */
function panelCommands() {
    const entries = [
        { name: 'Overlay', hint: 'The tile overlay', run: () => overlayPanel.toggle() },
        { name: 'Goal Planner', hint: 'Ordered steps to a goal, costed', target: goalPlanner() },
        { name: 'Iron Bell Farming', hint: 'The cowbell plan, and what it earns', target: ironCowFarmPanel() },
        { name: 'Treasure Tracker', hint: 'Chests opened and what came out', target: treasureTracker() },
        { name: 'PFormance', hint: "What the script's own timers say", target: pformancePanel() },
        { name: 'Combat Simulator', hint: 'Simulate a fight', target: combatSimUI() },
        {
            name: 'Lab Simulator',
            hint: 'Simulate a labyrinth run',
            // Not exported at a global of its own, so the Labyrinth page's own
            // button is the way in. It is only meaningful on that page anyway
            target: labSimUI(),
            fallback: () => document.querySelector('.toolasha-lab-sim-btn'),
        },
        {
            name: 'Guild Trials',
            // Not a panel: the figures are drawn into the game's guild page, and
            // this is the only signpost to them there is
            hint: 'Trial pace and payout, on the guild In Progress tab',
            run: () => openGuildTrials(),
        },
        {
            name: 'Trial Damage',
            hint: 'Damage and healing per player, ranked',
            // A real panel, and reached the way every other panel here is
            target: guildTrialScoreboard(),
        },
        { name: 'Settings', hint: "Toolasha's settings tab", run: () => openSettings() },
    ];

    const commands = [];
    for (const entry of entries) {
        if (entry.run) {
            commands.push({ name: entry.name, hint: entry.hint, run: entry.run });
            continue;
        }

        const toggle = entry.target?.toggle || entry.target?.show;
        if (toggle) {
            commands.push({ name: entry.name, hint: entry.hint, run: () => toggle.call(entry.target) });
        } else if (entry.fallback) {
            // Offered only when the way in is actually on the page — a palette
            // entry that does nothing is worse than one that is missing
            const element = entry.fallback();
            if (element) commands.push({ name: entry.name, hint: entry.hint, run: () => element.click() });
        }
    }
    return commands;
}

/**
 * Every setting the schema names, flattened.
 *
 * @returns {Array<{id: string, label: string, group: string}>}
 */
function settingEntries() {
    const found = [];
    for (const group of Object.values(settingsGroups || {})) {
        for (const [id, definition] of Object.entries(group?.settings || {})) {
            if (!definition?.label) continue;
            found.push({ id, label: definition.label, group: group.title || 'Settings' });
        }
    }
    return found;
}

/**
 * Open the game's settings, switch to the Toolasha tab, and land on a setting.
 *
 * There is no programmatic way in — the panel is the game's, drawn from its own
 * navigation and mounted by React when that link is followed — so this clicks
 * the same link a player would and then waits for the tab this script injects
 * to appear, which is the moment the Toolasha panel exists in the DOM at all.
 *
 * Filling the search box narrows several hundred rows to one, but a filtered
 * list is not the same as an answer: the row may sit inside a group the player
 * collapsed months ago, or below the fold. So the three steps compose — filter,
 * then expand whatever the row is inside, then scroll it to the middle and
 * flash it — and they run in that order because each one changes what the next
 * has to look at.
 *
 * @param {string} [search] - Text to put in the settings search box
 * @param {string} [settingId] - Which row to expand to, scroll to and flash
 * @returns {Promise<void>}
 */
async function openSettings(search = '', settingId = '') {
    try {
        const links = document.querySelectorAll('[class*="NavigationBar_minorNavigationLink"]');
        const settingsLink = [...links].find((link) => (link.textContent || '').trim().toLowerCase() === 'settings');
        settingsLink?.click();

        const tab = await waitFor('#toolasha-settings-tab');
        tab?.click();

        if (!search && !settingId) return;

        if (search) {
            const box = await waitFor('.toolasha-search-input');
            if (box) {
                box.value = search;
                // The panel filters from its own input listener, so the list is
                // already narrowed by the time this returns
                box.dispatchEvent(new Event('input', { bubbles: true }));
                box.focus();
            }
        }

        if (settingId) await revealSetting(settingId);
    } catch (error) {
        console.error('[CommandPalette] Opening settings failed:', error);
    }
}

/**
 * The class the trials feature tags every block it injects with.
 *
 * Duplicated rather than imported: `guild-trials.js` is in this same bundle
 * today, but the palette's rule is that it reaches features through the page
 * and through `window.Toolasha` and never through an import that could be
 * copied across a bundle boundary. A class name is a fact about the DOM, which
 * is the surface both of them already share.
 */
const TRIAL_BLOCK_SELECTOR = '.mwi-trial-info';

/**
 * Show the player the guild trial analysis, wherever it currently is.
 *
 * There is no trials *panel* to toggle. The pace, the ETA and the payout
 * projection are drawn into the game's own guild page, under the trial cards —
 * which is a perfectly good place for them and a completely undiscoverable one,
 * since nothing anywhere says they exist. Hence this entry: it walks the same
 * path a player would (guild page, In Progress tab — not the Trials tab beside
 * it, which is the sign-up sheet) and then lights up the block, so one keystroke
 * both answers "where is it" and proves it is there.
 *
 * The blocks only exist while the game is showing trial cards, and readings are
 * only taken while that tab is open — so when nothing has been drawn, this says
 * so rather than leaving the player on a page wondering what was meant to
 * happen. That case is not a failure: it is the feature's actual contract.
 *
 * @returns {Promise<boolean>} Whether a trial block was found and lit
 */
export async function openGuildTrials() {
    try {
        const links = document.querySelectorAll('[class*="NavigationBar_minorNavigationLink"]');
        const guildLink = [...links].find((link) => (link.textContent || '').trim().toLowerCase() === 'guild');
        guildLink?.click();

        const panel = await waitFor('[class*="GuildPanel"]');
        if (!panel) {
            showToast('Could not open the guild page — the trial figures live under its Trials tab.', {
                kind: 'warning',
            });
            return false;
        }

        // The guild page has *both* a "Trials" tab and an "In Progress" tab, and
        // they are not the same thing: Trials is the setup sheet — tiers, points,
        // who signed up — and In Progress is where the pool bar and the pace are.
        // Somebody asking the palette for the trial figures wants the live one,
        // so In Progress is preferred and Trials is only the fallback.
        const tabs = [...panel.querySelectorAll('[class*="TabsComponent_tab"]')];
        const named = (pattern) => tabs.find((tab) => pattern.test((tab.textContent || '').trim()));
        const trialsTab = named(/in\s*progress/i) || named(/trial/i);
        trialsTab?.click();

        const block = await waitFor(TRIAL_BLOCK_SELECTOR);
        if (!block) {
            showToast(
                'No trial figures yet — they are drawn under the cards on the In Progress tab while a trial ' +
                    'is running. The Trials tab beside it has the tiers and sign-ups.',
                { kind: 'info' }
            );
            return false;
        }

        block.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        for (const injected of document.querySelectorAll(TRIAL_BLOCK_SELECTOR)) flash(injected);
        return true;
    } catch (error) {
        console.error('[CommandPalette] Opening the guild trials failed:', error);
        return false;
    }
}

/** How long the flash stays up before fading — long enough to find, short enough not to nag */
const FLASH_MS = 1400;
const FLASH_FADE_MS = 260;

/**
 * Put one setting in front of the eye: expanded, on screen, and briefly lit.
 *
 * Matched on `data-setting-id` rather than the label, because that attribute is
 * what both an ordinary setting row and the mode chips in the presets block
 * carry — a setting that is drawn as a chip rather than a row is still findable
 * by the same call.
 *
 * @param {string} settingId - The schema id of the setting to reveal
 * @returns {Promise<HTMLElement|null>} The element revealed, or null
 */
export async function revealSetting(settingId) {
    if (!settingId) return null;
    const element = await waitFor(`[data-setting-id="${settingId}"]`);
    if (!element) return null;

    expandFor(element);
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    flash(element);
    return element;
}

/**
 * Open whatever is holding an element shut, for this visit only.
 *
 * The panel persists its collapsed groups when the *header* is clicked; nothing
 * is clicked here, so a group opened to show one setting is collapsed again the
 * next time the panel is drawn. That is deliberate — arriving from the palette
 * should not silently rearrange a layout somebody chose.
 *
 * @param {HTMLElement} element - The row or chip being revealed
 */
function expandFor(element) {
    const group = element.closest?.('.toolasha-settings-group');
    if (!group) return;

    group.classList.remove('collapsed');
    // A search that did not match this row would have hidden it; the palette
    // asked for this one by name, so it wins over the filter
    if (group.style.display === 'none') group.style.display = 'block';
    if (element.style.display === 'none') element.style.display = 'flex';
}

/**
 * A brief highlight, then back to exactly the styles that were there.
 *
 * Inline rather than a class: the flash belongs to the palette, and the
 * settings panel's stylesheet has no business knowing that something might
 * arrive from a hotkey.
 *
 * @param {HTMLElement} element - What to light up
 */
function flash(element) {
    const before = {
        transition: element.style.transition,
        boxShadow: element.style.boxShadow,
        background: element.style.backgroundColor,
    };

    element.dataset.toolashaFlash = 'on';
    element.style.transition = `box-shadow ${FLASH_FADE_MS}ms ease, background-color ${FLASH_FADE_MS}ms ease`;
    element.style.boxShadow = `0 0 0 2px ${COLORS.accent}, 0 0 18px rgba(158, 196, 255, 0.45)`;
    element.style.backgroundColor = 'rgba(158, 196, 255, 0.18)';

    setTimeout(() => {
        element.style.boxShadow = before.boxShadow;
        element.style.backgroundColor = before.background;
        setTimeout(() => {
            element.style.transition = before.transition;
            delete element.dataset.toolashaFlash;
        }, FLASH_FADE_MS);
    }, FLASH_MS);
}

/**
 * Wait for an element the game or another feature is about to draw.
 *
 * Polled rather than observed: this runs at most twice per palette use, for a
 * few seconds, and a MutationObserver over the whole page for the same answer
 * costs more than it saves.
 *
 * @param {string} selector - What to wait for
 * @returns {Promise<HTMLElement|null>} The element, or null if it never arrives
 */
function waitFor(selector) {
    return new Promise((resolve) => {
        const deadline = Date.now() + SETTINGS_WAIT_MS;
        const look = () => {
            const found = document.querySelector(selector);
            if (found) return resolve(found);
            if (Date.now() > deadline) return resolve(null);
            setTimeout(look, SETTINGS_POLL_MS);
        };
        look();
    });
}

class CommandPalette {
    constructor() {
        this.initialized = false;
        this.backdrop = null;
        this.input = null;
        this.listEl = null;
        this.commands = [];
        this.results = [];
        this.selected = 0;
        this.onKeyDown = (event) => this._onGlobalKeyDown(event);
        this.onFocusIn = (event) => this._onFocusIn(event);
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('commandPalette')) return;
        this.initialized = true;

        // Captured, so the chord is seen before the game's own key handling and
        // before anything that stops propagation on its way up
        document.addEventListener('keydown', this.onKeyDown, true);
    }

    cleanup() {
        document.removeEventListener('keydown', this.onKeyDown, true);
        this.close();
        this.initialized = false;
    }

    /** Whether the palette is on screen */
    get isOpen() {
        return Boolean(this.backdrop);
    }

    /**
     * @param {KeyboardEvent} event - A keystroke anywhere on the page
     */
    _onGlobalKeyDown(event) {
        if (!isPaletteHotkey(event)) return;

        // The palette's own box takes text, so the general rule would lock the
        // chord out of the thing it opened
        const insideSelf = this.isOpen && this.backdrop.contains(event.target);
        if (!insideSelf && isTypingTarget(event.target)) return;

        event.preventDefault();
        event.stopPropagation();
        this.toggle();
    }

    /** Open if closed, close if open */
    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    /** Draw the palette and take focus */
    open() {
        if (this.isOpen) return;

        this.commands = this._buildCommands();
        this._build();
        this._render('');

        // Saved layouts are a storage read and the palette is not going to wait
        // for one before drawing; they join the list a moment later
        this._addLayoutCommands().catch((error) => {
            console.error('[CommandPalette] Reading the saved layouts failed:', error);
        });
    }

    /** Take the palette down and give focus back */
    close() {
        if (!this.backdrop) return;

        document.removeEventListener('focusin', this.onFocusIn, true);
        this.backdrop.remove();
        this.backdrop = null;
        this.input = null;
        this.listEl = null;
        this.results = [];
        this.selected = 0;
    }

    /**
     * Everything the palette can do, in the order it should be offered.
     * @returns {Array<Object>} Commands
     */
    _buildCommands() {
        const commands = [];

        for (const panel of panelCommands()) {
            commands.push(this._command('Panel', panel.name, panel.hint, panel.run));
        }

        for (const row of registeredRows()) {
            if (typeof row.onOpen !== 'function') continue;
            commands.push(this._command('Overlay row', row.name, 'Open what this tile summarises', () => row.onOpen()));
        }

        for (const setting of settingEntries()) {
            commands.push(
                this._command(
                    'Setting',
                    setting.label,
                    setting.group,
                    () => openSettings(setting.label, setting.id),
                    setting.group
                )
            );
        }

        return commands;
    }

    /**
     * @param {string} group - Which section it belongs to
     * @param {string} label - What it reads as
     * @param {string} hint - The dim text on the right
     * @param {Function} run - What selecting it does
     * @param {string} [extra] - Further text the query may match
     * @returns {Object} A command
     */
    _command(group, label, hint, run, extra = '') {
        return { group, label, hint, run, search: `${label} ${group} ${extra}`.toLowerCase() };
    }

    /**
     * Add the saved overlay layouts, once storage has answered.
     * @returns {Promise<void>}
     */
    async _addLayoutCommands() {
        const names = await overlayPanel.listLayouts();
        if (!this.isOpen || !names.length) return;

        // Ahead of the settings, which are the long tail — a palette is judged
        // by what it offers before you have typed anything
        const layouts = names.map((name) =>
            this._command('Overlay layout', `Layout: ${name}`, 'Switch the overlay to this arrangement', () =>
                overlayPanel.applyNamedLayout(name)
            )
        );
        const firstSetting = this.commands.findIndex((command) => command.group === 'Setting');
        const at = firstSetting < 0 ? this.commands.length : firstSetting;
        this.commands = [...this.commands.slice(0, at), ...layouts, ...this.commands.slice(at)];

        this._render(this.input?.value || '');
    }

    _build() {
        this.backdrop = document.createElement('div');
        this.backdrop.id = PALETTE_ID;
        Object.assign(this.backdrop.style, {
            position: 'fixed',
            inset: '0',
            background: 'rgba(0, 0, 0, 0.45)',
            // Above every floating panel, including one that has just been
            // raised to the cap — the palette is what opens those panels, and
            // one that opens behind them is one you cannot use twice
            zIndex: String(PANEL_Z_CAP + 1),
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
        });
        this.backdrop.addEventListener('mousedown', (event) => {
            if (event.target === this.backdrop) this.close();
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            marginTop: '12vh',
            width: 'min(560px, 92vw)',
            maxHeight: '70vh',
            display: 'flex',
            flexDirection: 'column',
            background: COLORS.background,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '10px',
            boxShadow: '0 16px 56px rgba(0, 0, 0, 0.7)',
            color: COLORS.text,
            overflow: 'hidden',
        });

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.placeholder = 'Search panels, overlay rows, layouts and settings…';
        this.input.setAttribute('aria-label', 'Command palette');
        Object.assign(this.input.style, {
            background: 'transparent',
            border: 'none',
            borderBottom: `1px solid ${COLORS.border}`,
            color: COLORS.text,
            fontSize: '15px',
            outline: 'none',
            padding: '12px 14px',
            width: '100%',
        });
        this.input.addEventListener('input', () => this._render(this.input.value));
        this.input.addEventListener('keydown', (event) => this._onInputKeyDown(event));

        this.listEl = document.createElement('div');
        Object.assign(this.listEl.style, { overflowY: 'auto', padding: '4px 0' });

        box.append(this.input, this.listEl);
        this.backdrop.appendChild(box);
        document.body.appendChild(this.backdrop);

        // Focus stays here for as long as the palette is up: it is a keyboard
        // tool, and the game happily takes focus back on its own
        document.addEventListener('focusin', this.onFocusIn, true);
        this.input.focus();
    }

    /**
     * @param {FocusEvent} event - Focus moving anywhere on the page
     */
    _onFocusIn(event) {
        if (!this.backdrop || this.backdrop.contains(event.target)) return;
        this.input?.focus();
    }

    /**
     * @param {KeyboardEvent} event - A keystroke in the palette's own box
     */
    _onInputKeyDown(event) {
        const keys = {
            Escape: () => this.close(),
            ArrowDown: () => this._move(1),
            ArrowUp: () => this._move(-1),
            Enter: () => this._run(this.selected),
            Home: () => this._select(0),
            End: () => this._select(this.results.length - 1),
        };
        const handler = keys[event.key];
        if (!handler) {
            // Ordinary typing still must not reach the game, which listens for
            // single keys of its own
            event.stopPropagation();
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        handler();
    }

    /**
     * @param {number} delta - -1 for up, 1 for down
     */
    _move(delta) {
        if (!this.results.length) return;
        // Wraps, because a list this short is faster to reach from the other end
        const next = (this.selected + delta + this.results.length) % this.results.length;
        this._select(next);
    }

    /**
     * @param {number} index - Which result to highlight
     */
    _select(index) {
        if (!this.results.length) return;
        this.selected = Math.max(0, Math.min(index, this.results.length - 1));
        this._paintSelection();
    }

    /** Show which row is selected, and keep it on screen */
    _paintSelection() {
        const rows = this.listEl?.children || [];
        for (let i = 0; i < rows.length; i++) {
            rows[i].style.background = i === this.selected ? COLORS.selected : 'transparent';
        }
        rows[this.selected]?.scrollIntoView?.({ block: 'nearest' });
    }

    /**
     * @param {number} index - Which result to run
     */
    _run(index) {
        const command = this.results[index];
        if (!command) return;

        // Closed first: most of these open a panel, and a palette still sitting
        // over the panel it just summoned is one more keystroke to dismiss
        this.close();
        try {
            command.run();
        } catch (error) {
            console.error(`[CommandPalette] "${command.label}" failed:`, error);
        }
    }

    /**
     * @param {string} query - What has been typed so far
     */
    _render(query) {
        if (!this.listEl) return;

        this.results = filterCommands(this.commands, query);
        this.selected = 0;
        this.listEl.replaceChildren();

        if (!this.results.length) {
            const empty = document.createElement('div');
            empty.textContent = 'Nothing matches that.';
            Object.assign(empty.style, { color: COLORS.textDim, padding: '14px', fontSize: '13px' });
            this.listEl.appendChild(empty);
            return;
        }

        this.results.forEach((command, index) => this.listEl.appendChild(this._row(command, index)));
        this._paintSelection();
    }

    /**
     * @param {Object} command - What to draw
     * @param {number} index - Its place in the results
     * @returns {HTMLElement}
     */
    _row(command, index) {
        const row = document.createElement('div');
        row.setAttribute('role', 'option');
        row.dataset.commandLabel = command.label;
        Object.assign(row.style, {
            display: 'flex',
            alignItems: 'baseline',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '13px',
            padding: '6px 14px',
        });

        const tag = document.createElement('span');
        tag.textContent = command.group;
        Object.assign(tag.style, {
            color: COLORS.accent,
            fontSize: '10px',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            flex: '0 0 96px',
        });

        const label = document.createElement('span');
        label.textContent = command.label;
        label.style.flex = '1 1 auto';

        const hint = document.createElement('span');
        hint.textContent = command.hint || '';
        Object.assign(hint.style, {
            color: COLORS.textDim,
            fontSize: '11px',
            flex: '0 1 auto',
            textAlign: 'right',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '40%',
        });

        row.append(tag, label, hint);
        row.addEventListener('mousemove', () => this._select(index));
        row.addEventListener('click', () => this._run(index));
        return row;
    }
}

const commandPalette = new CommandPalette();

export default commandPalette;
export { PALETTE_ID };
