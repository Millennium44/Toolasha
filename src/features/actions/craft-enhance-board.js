/**
 * Craft & Enhance window
 *
 * Gear whose recipe takes dungeon drops or dungeon-token shop items, crafted, enhanced to a target
 * level (+5 unless the player picks another) and sold. One table, one row per recipe, rated at the target
 * and at +0 beside it: what the craft costs, what the enhancement run costs on the player's own bench, what
 * it sells for after tax, the profit per item and per hour, and the crafting and enhancing XP an hour.
 *
 * The ranking is `craft-enhance.js` (the game-facing half) over `craft-enhance-rank.js` (the arithmetic).
 * What is here is the window: the shared `simple-panel` shell, the controls, the table, and the button on
 * the cheesesmithing, crafting and tailoring pages that opens it. It is its own window, not a mode of the
 * Production Arbitrage board, and is opened the same way that board is.
 *
 * ## An unpriced figure is shown as one
 *
 * A cell whose price is missing reads "—" and says why in its tooltip; the row's Data column names what is
 * missing. The ranking never gives such a row a profit, so it cannot be sorted above one that has a full
 * figure and the "Profitable only" filter drops it. An owned input counted at 0 on purpose (the Sunk
 * switch) is a different thing and is badged "sunk" beside the name.
 *
 * ## Volume is asked for visible rows only
 *
 * Daily volume at the target level reads the pooled market history that is already set up, one lookup per
 * row, so it is requested for the rows currently on screen and cached per item and level. A volume that
 * could not be measured is "?", apart from a measured 0.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { formatKMB } from '../../utils/formatters.js';
import { createPanel } from '../../utils/simple-panel.js';
import { GAME_COLORS, styleGameButton } from '../../utils/game-look.js';
import { navigateToAction, navigateToItem } from '../../utils/item-navigation.js';
import { itemDailyVolume } from '../../utils/liquidity-cap.js';
import { itemLabel } from '../../utils/overlay-format.js';
import { PRODUCTION_SKILLS } from './production-arbitrage.js';
import {
    CRAFT_ENHANCE_SETTING,
    OWNED_MODE_SETTING,
    TARGET_LEVEL_SETTING,
    clearCraftEnhanceCache,
    craftEnhanceAvailable,
    craftEnhancePriceStamp,
    rankCraftEnhance,
} from './craft-enhance.js';
import {
    MAX_TARGET_LEVEL,
    OWNED_MODES,
    arrangeCraftEnhanceRows,
    normalizeOwnedMode,
    normalizeTargetLevel,
} from './craft-enhance-rank.js';

export { CRAFT_ENHANCE_SETTING };

/** The open button's class, for not adding it twice and for the title bar's mobile fold */
export const OPEN_BUTTON_CLASS = 'mwi-craft-enhance-open';

const PANEL_ID = 'craft-enhance';
const MAX_ROWS = 100;
/** Rows whose volume is looked up; the rest are off the first screen */
const VOLUME_ROWS = 40;

/** The skills whose pages carry the button: the ones that make gear */
const BUTTON_SKILLS = PRODUCTION_SKILLS.filter((skill) =>
    ['/skills/cheesesmithing', '/skills/crafting', '/skills/tailoring'].includes(skill.skillHrid)
);

const MUTED = 'rgba(232, 236, 245, 0.55)';
const INK = '#e8ecf5';
const GOOD = '#4ade80';
const BAD = '#f87171';
const WARN = '#ffb74d';

/** What each owned-drops mode means, for the status line */
const OWNED_NOTES = {
    market: 'Dungeon inputs are valued at what they would sell for after tax (you own them).',
    buy: 'Dungeon inputs are valued at their buy price, untaxed (you buy them); a token-shop item takes the cheaper of that and its token value.',
    sunk: 'Dungeon inputs are counted at 0 (already owned, sunk).',
};

const REASON_LABELS = {
    input: 'input unpriced',
    'dungeon-input': 'drop unpriced',
    tea: 'drink unpriced',
    enhance: 'enhance unpriced',
    sale: 'no sale quote',
    rate: 'no output rate',
};

/**
 * @param {HTMLElement} titleElement - A skill page's title
 * @returns {boolean} Whether it is a gear-making skill page
 */
function isGearSkillTitle(titleElement) {
    const text = titleElement?.textContent || '';
    return BUTTON_SKILLS.some((skill) => text.includes(skill.label));
}

/**
 * @param {string} label - Text
 * @param {Function} onClick - Handler
 * @param {boolean} [active=false] - Drawn pressed
 * @returns {HTMLButtonElement}
 */
function controlButton(label, onClick, active = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    styleGameButton(button, active ? 'primary' : 'quiet', true);
    button.addEventListener('click', onClick);
    return button;
}

/**
 * @param {string|number} text - Content
 * @param {Object} [style] - Extra styles
 * @returns {HTMLTableCellElement}
 */
function cell(text, style = {}) {
    const td = document.createElement('td');
    td.textContent = text;
    Object.assign(td.style, { padding: '3px 6px', whiteSpace: 'nowrap' }, style);
    return td;
}

/**
 * A gold cell that is "—" when the figure is missing, colored by its sign otherwise.
 * @param {number|null} value - Gold, or null when it could not be priced
 * @param {string} [missingNote] - Why it is missing, for the tooltip
 * @param {boolean} [signed=true] - Color by sign
 * @returns {HTMLTableCellElement}
 */
function goldCell(value, missingNote = '', signed = true) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        const td = cell('—', { textAlign: 'right', color: MUTED });
        td.setAttribute('data-ce-missing', 'true');
        if (missingNote) td.title = missingNote;
        return td;
    }
    const rounded = Math.round(value);
    return cell(formatKMB(rounded), {
        textAlign: 'right',
        color: !signed ? INK : rounded >= 0 ? GOOD : BAD,
    });
}

/**
 * @param {Object} level - A row's `base` or `target`
 * @returns {string} The reasons it has no profit, in words
 */
function reasonText(level) {
    return level.reasons.map((reason) => REASON_LABELS[reason] || reason).join(', ');
}

class CraftEnhanceBoard {
    constructor() {
        this.initialized = false;
        this.panel = null;
        this.unregisterTitleObserver = null;
        this.rows = null;
        this.computing = false;
        this.progress = { done: 0, total: 0 };
        this.sort = 'hour';
        this.descending = true;
        this.profitableOnly = false;
        this.craftableOnly = false;
        this.skillHrid = null;
        this.query = '';
        this.error = null;
        /** Bumped whenever a run is abandoned (a character switch, a recompute, a changed target or mode) */
        this.generation = 0;
        /** `${itemHrid}:${level}` to a measured volume, `{known, unitsPerDay}` */
        this.volumes = new Map();
        /** `${itemHrid}:${level}` to the token of the lookup in flight, so a stale one cannot clear a newer marker */
        this.volumePending = new Map();
        /** The target and mode the held rows were costed for; a settings change from elsewhere makes them stale */
        this.rowsKey = null;
    }

    /** The target level in force */
    get targetLevel() {
        return normalizeTargetLevel(config.getSettingValue(TARGET_LEVEL_SETTING, 5));
    }

    /** The owned-drops mode in force */
    get ownedMode() {
        return normalizeOwnedMode(config.getSettingValue(OWNED_MODE_SETTING, OWNED_MODES.MARKET));
    }

    /**
     * What the held rows were costed for: the target, the owned-drops mode and the market data's age.
     * @returns {string}
     */
    currentKey() {
        return `${this.targetLevel}|${this.ownedMode}|${craftEnhancePriceStamp()}`;
    }

    /** Feature-registry entry point */
    initialize() {
        if (this.initialized) return;
        if (!config.getSetting(CRAFT_ENHANCE_SETTING)) return;
        // No market, no sale, no tax: nothing here to rank for an Iron Cow character
        if (!craftEnhanceAvailable()) return;
        this.initialized = true;

        this.panel = createPanel({
            id: PANEL_ID,
            title: 'Craft & Enhance',
            size: { width: 1100, height: 560 },
            refreshMs: 10 * 60_000,
            draw: (body) => this.draw(body),
        });

        this.unregisterTitleObserver = domObserver.onClass(
            'CraftEnhance-Title',
            'GatheringProductionSkillPanel_title',
            (titleElement) => this.injectOpenButton(titleElement)
        );
        document
            .querySelectorAll('[class*="GatheringProductionSkillPanel_title"]')
            .forEach((titleElement) => this.injectOpenButton(titleElement));
    }

    /** Feature-registry teardown */
    disable() {
        try {
            this.generation++;
            this.unregisterTitleObserver?.();
            this.unregisterTitleObserver = null;
            document.querySelectorAll(`.${OPEN_BUTTON_CLASS}`).forEach((button) => button.remove());
            this.panel?.destroy();
        } catch (error) {
            console.error('[CraftEnhance] Disable failed part-way:', error);
        } finally {
            this.panel = null;
            this.rows = null;
            this.computing = false;
            this.error = null;
            // Nothing measured for one character is another's
            this.volumes.clear();
            this.volumePending.clear();
            clearCraftEnhanceCache();
            this.initialized = false;
        }
    }

    /**
     * Put a "Craft & Enhance" button on a gear-making skill page's title bar.
     * @param {HTMLElement} titleElement - The page's title element
     */
    injectOpenButton(titleElement) {
        if (!titleElement || !isGearSkillTitle(titleElement)) return;
        if (titleElement.querySelector(`.${OPEN_BUTTON_CLASS}`)) return;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = OPEN_BUTTON_CLASS;
        button.textContent = 'Craft & Enhance';
        button.title = 'Gear made from dungeon drops or token-shop items, enhanced and sold: ranked by profit and XP';
        button.style.cssText = `
            padding: 8px 12px;
            font-size: 14px;
            border: 1px solid rgba(255, 255, 255, 0.23);
            border-radius: 4px;
            background: transparent;
            color: inherit;
            cursor: pointer;
            font-family: inherit;
            flex-shrink: 0;
        `;
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.open();
        });
        const controlsRow = titleElement.querySelector(':scope > #mwi-action-controls');
        if (controlsRow) {
            controlsRow.appendChild(button);
            return;
        }
        const skillName = [...titleElement.children].find((child) => child.tagName === 'DIV');
        titleElement.insertBefore(button, skillName || null);
    }

    /** Show the window, computing the ranking if it is not already known */
    open() {
        // Not started: the setting is off, or this character has no market
        if (!this.initialized) return;
        this.panel?.show();
        this.ensureRows();
    }

    /** Forget the ranking and cost everything again */
    recompute() {
        clearCraftEnhanceCache();
        this.volumes.clear();
        this.volumePending.clear();
        this.generation++;
        this.rows = null;
        this.computing = false;
        this.error = null;
        this.ensureRows();
    }

    /**
     * Start the ranking if nothing is known yet; redraw as it lands.
     * @returns {Promise<void>}
     */
    async ensureRows() {
        if (this.rows || this.computing) return;
        const generation = ++this.generation;
        const isCurrent = () => generation === this.generation;
        this.rowsKey = this.currentKey();
        this.computing = true;
        this.error = null;
        this.progress = { done: 0, total: 0 };
        this.panel?.render();

        try {
            const rows = await rankCraftEnhance({
                targetLevel: this.targetLevel,
                ownedMode: this.ownedMode,
                isCurrent,
                onProgress: (done, total, partial) => {
                    if (!isCurrent()) return;
                    this.progress = { done, total };
                    this.rows = partial;
                    this.panel?.render();
                },
            });
            // null: superseded while it ran, so these rows are not for what is on screen
            if (rows === null || !isCurrent()) return;
            this.rows = rows;
        } catch (error) {
            if (!isCurrent()) return;
            console.error('[CraftEnhance] Ranking failed:', error);
            this.error = error;
        } finally {
            if (isCurrent()) {
                this.computing = false;
                this.panel?.render();
            }
        }
    }

    /**
     * Change a setting the ranking depends on and cost again.
     * @param {string} key - Setting id
     * @param {*} value - New value
     */
    changeSetting(key, value) {
        config.setSettingValue(key, value);
        this.recompute();
    }

    /**
     * @param {HTMLElement} body - The panel's body
     */
    draw(body) {
        // The target or the owned-drops mode was changed somewhere else (the settings panel), or the market data
        // has refreshed since: the rows held are for the old one
        // (started on a microtask: both paths render the panel, and a render inside a draw would paint twice)
        if (this.rows && !this.computing && this.rowsKey !== this.currentKey()) {
            queueMicrotask(() => this.recompute());
        } else if (!this.rows && !this.computing && !this.error) {
            queueMicrotask(() => this.ensureRows());
        }

        body.appendChild(this.drawControls());

        const status = document.createElement('div');
        Object.assign(status.style, { color: MUTED, fontSize: '11px' });
        if (this.computing) {
            const { done, total } = this.progress;
            status.textContent = total ? `Costing recipes… ${done}/${total}` : 'Costing recipes…';
        } else if (this.error) {
            status.textContent = `The ranking could not be computed: ${this.error.message}`;
            status.style.color = BAD;
        } else {
            status.textContent =
                `${OWNED_NOTES[this.ownedMode]} ` +
                'Enhancing uses your own detected bench and counts its drinks. A "—" is a price that is missing, never a 0.';
        }
        body.appendChild(status);

        body.appendChild(this.drawTable());
    }

    /**
     * @returns {HTMLElement}
     */
    drawControls() {
        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' });

        const label = (text) => {
            const span = document.createElement('span');
            span.textContent = text;
            span.style.color = MUTED;
            return span;
        };

        controls.appendChild(label('Enhance to:'));
        const levelSelect = document.createElement('select');
        levelSelect.classList.add('toolasha-select');
        levelSelect.setAttribute('data-ce-level', 'true');
        this.styleSelect(levelSelect);
        for (let level = 1; level <= MAX_TARGET_LEVEL; level++) {
            const option = document.createElement('option');
            option.value = String(level);
            option.textContent = `+${level}`;
            levelSelect.appendChild(option);
        }
        levelSelect.value = String(this.targetLevel);
        levelSelect.addEventListener('change', () =>
            this.changeSetting(TARGET_LEVEL_SETTING, normalizeTargetLevel(levelSelect.value))
        );
        controls.appendChild(levelSelect);

        controls.appendChild(label('Owned drops:'));
        const owned = this.ownedMode;
        const modes = [
            [
                OWNED_MODES.MARKET,
                'Sale value',
                'You own them: count each dungeon drop or token-shop input at what it would sell for after tax (the cost of using it)',
            ],
            [
                OWNED_MODES.BUY,
                'Buy price',
                'You buy them: count each at the buy side of your pricing mode, with no tax. A token-shop item takes the cheaper of that and its token value.',
            ],
            [
                OWNED_MODES.SUNK,
                'Sunk (0)',
                'Already owned and not worth selling: count them at 0. Rows using them are badged "sunk".',
            ],
        ];
        for (const [mode, text, title] of modes) {
            const button = controlButton(text, () => this.changeSetting(OWNED_MODE_SETTING, mode), owned === mode);
            button.title = title;
            button.setAttribute('data-ce-owned', mode);
            controls.appendChild(button);
        }

        const skillSelect = document.createElement('select');
        skillSelect.classList.add('toolasha-select');
        skillSelect.setAttribute('data-ce-skill', 'true');
        this.styleSelect(skillSelect);
        skillSelect.style.marginLeft = '8px';
        const all = document.createElement('option');
        all.value = '';
        all.textContent = 'All skills';
        skillSelect.appendChild(all);
        for (const skill of BUTTON_SKILLS) {
            const option = document.createElement('option');
            option.value = skill.skillHrid;
            option.textContent = skill.label;
            skillSelect.appendChild(option);
        }
        skillSelect.value = this.skillHrid || '';
        skillSelect.addEventListener('change', () => {
            this.skillHrid = skillSelect.value || null;
            this.panel?.render();
        });
        controls.appendChild(skillSelect);

        const search = document.createElement('input');
        search.type = 'text';
        search.placeholder = 'Filter items…';
        search.value = this.query;
        search.setAttribute('data-ce-search', 'true');
        this.styleSelect(search);
        search.style.width = '140px';
        search.addEventListener('input', () => {
            this.query = search.value;
            this.redrawTable();
        });
        controls.appendChild(search);

        const profitable = controlButton(
            'Profitable only',
            () => {
                this.profitableOnly = !this.profitableOnly;
                this.panel?.render();
            },
            this.profitableOnly
        );
        profitable.setAttribute('data-ce-profitable', 'true');
        profitable.title = 'Hide rows that lose money or have any price missing';
        controls.appendChild(profitable);

        const craftable = controlButton(
            'Only craftable now',
            () => {
                this.craftableOnly = !this.craftableOnly;
                this.panel?.render();
            },
            this.craftableOnly
        );
        craftable.setAttribute('data-ce-craftable', 'true');
        controls.appendChild(craftable);

        const spacer = document.createElement('span');
        spacer.style.flex = '1';
        controls.appendChild(spacer);

        const recompute = controlButton('Recompute', () => this.recompute());
        recompute.setAttribute('data-ce-recompute', 'true');
        recompute.title = 'Throw the ranking away and cost everything again';
        controls.appendChild(recompute);

        return controls;
    }

    /**
     * @param {HTMLElement} element - A select or input
     */
    styleSelect(element) {
        Object.assign(element.style, {
            padding: '2px 6px',
            borderRadius: '4px',
            border: '1px solid rgba(255,255,255,0.25)',
            background: GAME_COLORS.background,
            color: INK,
            fontSize: '11px',
        });
    }

    /** Replace just the table, so typing in the filter box does not rebuild the box being typed in */
    redrawTable() {
        const old = this.panel?.panel?.querySelector('[data-ce-table]');
        if (!old) {
            this.panel?.render();
            return;
        }
        old.replaceWith(this.drawTable());
    }

    /**
     * Ask for the volume of the rows on screen, once each, and redraw as they land.
     * @param {Array<Object>} visible - The rows being drawn
     */
    requestVolumes(visible) {
        const generation = this.generation;
        const level = this.targetLevel;
        for (const row of visible.slice(0, VOLUME_ROWS)) {
            const key = `${row.itemHrid}:${level}`;
            if (this.volumes.has(key) || this.volumePending.has(key)) continue;
            const token = {};
            this.volumePending.set(key, token);
            this.loadVolume(key, row.itemHrid, level, token, generation);
        }
    }

    /**
     * One volume lookup. Only the lookup that still holds the marker for its key may clear it or store a result.
     * @param {string} key - `${itemHrid}:${level}`
     * @param {string} itemHrid - The item
     * @param {number} level - Enhancement level
     * @param {Object} token - The marker this lookup set
     * @param {number} generation - The run this lookup belongs to
     */
    async loadVolume(key, itemHrid, level, token, generation) {
        try {
            const volume = await itemDailyVolume(itemHrid, level);
            // A run abandoned since (character switch, new target) leaves this answer unused
            if (generation !== this.generation || this.volumePending.get(key) !== token) return;
            this.volumes.set(key, volume);
            this.redrawTable();
        } catch (error) {
            console.error('[CraftEnhance] Reading volume failed:', error);
        } finally {
            if (this.volumePending.get(key) === token) this.volumePending.delete(key);
        }
    }

    /**
     * @param {string} key - Sort key
     * @param {string} label - Header text
     * @param {string} align - Alignment
     * @returns {HTMLTableCellElement}
     */
    headerCell(key, label, align) {
        const th = document.createElement('th');
        const sortable = Boolean(key);
        const arrow = sortable && this.sort === key ? (this.descending ? ' ▼' : ' ▲') : '';
        th.textContent = label + arrow;
        th.style.cssText = `padding: 4px 6px; text-align: ${align}; color: ${MUTED}; font-weight: 500; white-space: nowrap;${
            sortable ? ' cursor: pointer;' : ''
        }`;
        if (sortable) {
            th.setAttribute('data-ce-sort', key);
            th.addEventListener('click', () => {
                if (this.sort === key) this.descending = !this.descending;
                else {
                    this.sort = key;
                    this.descending = true;
                }
                this.panel?.render();
            });
        }
        return th;
    }

    /**
     * @returns {HTMLElement}
     */
    drawTable() {
        const wrap = document.createElement('div');
        wrap.setAttribute('data-ce-table', 'true');
        wrap.style.overflow = 'auto';

        const arranged = arrangeCraftEnhanceRows(this.rows || [], {
            sort: this.sort,
            descending: this.descending,
            profitableOnly: this.profitableOnly,
            craftableOnly: this.craftableOnly,
            skillHrid: this.skillHrid,
            query: this.query,
        });

        if (!arranged.length) {
            const empty = document.createElement('div');
            empty.style.cssText = `color: ${MUTED}; padding: 16px; text-align: center;`;
            empty.textContent = this.computing
                ? 'Costing recipes…'
                : this.rows?.length
                  ? 'No recipes match'
                  : 'No recipe of yours takes a dungeon drop or token-shop item and makes gear that can be enhanced';
            wrap.appendChild(empty);
            return wrap;
        }

        const shown = arranged.slice(0, MAX_ROWS);
        if (!this.computing) this.requestVolumes(shown);
        const target = this.targetLevel;

        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 11px;';

        const thead = document.createElement('thead');
        const head = document.createElement('tr');
        head.style.borderBottom = '1px solid rgba(255,255,255,0.2)';
        const columns = [
            [null, '#', 'center'],
            [null, 'Item', 'left'],
            [null, 'Lvl', 'center'],
            [null, 'Craft cost', 'right'],
            [null, `Enhance to +${target}`, 'right'],
            [null, `Sale +${target} (after tax)`, 'right'],
            ['unit', `Profit/item +${target}`, 'right'],
            ['hour', `Profit/hr +${target}`, 'right'],
            [null, 'Profit/item +0', 'right'],
            ['base', 'Profit/hr +0', 'right'],
            ['craftXp', 'Craft XP/hr', 'right'],
            ['enhanceXp', 'Enhance XP/hr', 'right'],
            [null, `Vol/day +${target}`, 'right'],
            [null, 'Data', 'left'],
        ];
        for (const [key, label, align] of columns) head.appendChild(this.headerCell(key, label, align));
        thead.appendChild(head);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        shown.forEach((row, index) => tbody.appendChild(this.drawRow(row, index, target)));
        table.appendChild(tbody);
        wrap.appendChild(table);

        if (arranged.length > MAX_ROWS) {
            const more = document.createElement('div');
            more.style.cssText = `color: ${MUTED}; text-align: center; padding: 6px; font-size: 11px;`;
            more.textContent = `Showing top ${MAX_ROWS} of ${arranged.length} recipes`;
            wrap.appendChild(more);
        }
        return wrap;
    }

    /**
     * @param {Object} row - A ranking row
     * @param {number} index - Position
     * @param {number} target - The target level
     * @returns {HTMLTableRowElement}
     */
    drawRow(row, index, target) {
        const tr = document.createElement('tr');
        tr.setAttribute('data-ce-row', row.actionHrid);
        tr.style.cssText = 'border-bottom: 1px solid rgba(255,255,255,0.07); cursor: pointer;';
        tr.title = `${row.actionName} (${row.skillLabel}) — click to open the action`;
        tr.addEventListener('mouseenter', () => (tr.style.background = 'rgba(255,255,255,0.05)'));
        tr.addEventListener('mouseleave', () => (tr.style.background = ''));
        tr.addEventListener('click', () => {
            if (!navigateToAction(row.actionHrid)) navigateToItem(row.itemHrid);
        });

        const t = row.target;
        const b = row.base;

        tr.appendChild(cell(index + 1, { textAlign: 'center', color: MUTED }));

        const name = cell('', { color: '#93c5fd' });
        name.appendChild(itemLabel(row.itemHrid, row.itemName));
        if (row.sunkInputs.length > 0) {
            const badge = document.createElement('span');
            badge.textContent = ' sunk';
            badge.setAttribute('data-ce-sunk', 'true');
            badge.style.cssText = `color: ${WARN}; font-size: 10px;`;
            badge.title = `Counted at 0 because the Sunk switch is on: ${row.sunkInputs
                .map((hrid) => hrid.split('/').pop().replace(/_/g, ' '))
                .join(', ')}`;
            name.appendChild(badge);
        }
        tr.appendChild(name);

        const level = cell(row.levelMet ? row.requiredLevel : `${row.requiredLevel} ✗`, {
            textAlign: 'center',
            color: row.levelMet ? MUTED : BAD,
        });
        level.title = row.levelMet
            ? `Requires ${row.requiredLevel}, you are ${row.level}`
            : `Requires ${row.requiredLevel}, you are ${row.level} — not craftable yet`;
        tr.appendChild(level);

        const inputNote = t.unpricedInputs.length
            ? `No price for: ${t.unpricedInputs.map((input) => input.itemHrid.split('/').pop().replace(/_/g, ' ')).join(', ')}`
            : '';
        tr.appendChild(goldCell(t.craftCostPerUnit, inputNote, false));
        tr.appendChild(
            goldCell(
                t.enhanceCost,
                'The enhancement run could not be priced (a material or protection has no price)',
                false
            )
        );
        tr.appendChild(goldCell(t.saleAfterTax, `No real sell quote at +${target}`, false));
        tr.appendChild(goldCell(t.profitPerUnit, reasonText(t)));
        tr.appendChild(goldCell(t.profitPerHour, reasonText(t)));
        tr.appendChild(goldCell(b.profitPerUnit, reasonText(b)));
        tr.appendChild(goldCell(b.profitPerHour, reasonText(b)));
        tr.appendChild(goldCell(t.craftXpPerHour, 'Not known', false));
        tr.appendChild(goldCell(t.enhanceXpPerHour, 'Not known', false));

        const volume = this.volumes.get(`${row.itemHrid}:${target}`);
        const volumeCell = !volume
            ? cell('…', { textAlign: 'right', color: MUTED })
            : volume.known
              ? cell(formatKMB(Math.round(volume.unitsPerDay)), { textAlign: 'right' })
              : cell('?', { textAlign: 'right', color: MUTED });
        volumeCell.setAttribute('data-ce-volume', volume ? (volume.known ? 'known' : 'unknown') : 'pending');
        volumeCell.title = !volume
            ? 'Looking up traded volume'
            : volume.known
              ? `About ${Math.round(volume.unitsPerDay)} traded a day at +${target}`
              : 'Traded volume could not be measured (not a measured 0)';
        tr.appendChild(volumeCell);

        const flags = [...new Set([...t.reasons, ...b.reasons])];
        const labels = flags.map((reason) => REASON_LABELS[reason] || reason);
        // An input priced from the game's value estimate is usable but not a live order
        if (row.estimatedInputs?.length) labels.push('price estimated');
        const data = cell(labels.join(', '), { color: labels.length ? WARN : MUTED });
        data.setAttribute('data-ce-data', flags.length ? 'unpriced' : row.estimatedInputs?.length ? 'estimated' : 'ok');
        data.title = [
            ...row.notes,
            reasonText(t) ? `+${target}: ${reasonText(t)}` : '',
            reasonText(b) ? `+0: ${reasonText(b)}` : '',
        ]
            .filter(Boolean)
            .join('\n');
        tr.appendChild(data);

        return tr;
    }
}

const craftEnhanceBoard = new CraftEnhanceBoard();

export default craftEnhanceBoard;
