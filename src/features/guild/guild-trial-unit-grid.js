/**
 * Keeps every guild trial party player in a fixed place, and wraps the extras under the leading card.
 *
 * The game draws the trial party as a flex-wrap grid: a big leading card, then columns of up to three
 * mini tiles. Two things go wrong with it. At some combat tier changes the game rotates its party list
 * (the same ring of players, a different first one) and re-renders the tiles in that order, so a player
 * jumps to another stack. And with more players than fit beside the card, the extra columns wrap below
 * it and stack into a tall narrow column.
 *
 * So the grid is turned into a CSS grid laid out from JS, and every tile is placed explicitly:
 *
 * - **Order** is derived from data every time, never from the game's order: in the combat trial by the
 *   member's signed-up role for this week (tank, support, damage dealer, then no role), then by name; in
 *   the skilling trial (no roles) by name. Names are compared locale-aware and case-insensitively. A
 *   tile is matched to a member by its `MiniUnit_name` text, which is unique in a guild — the tile
 *   carries no id. A player not in the guild data, or with no sign-up this week, is in the no-role group.
 *   Nothing is stored: a newcomer takes their sorted place and a leaver's place closes up (no gaps).
 * - **Beside the card**, tiles fill columns of three, top to bottom, left to right, as the game's own
 *   stacks do, starting tight to the card. The card always comes first, spanning those three rows.
 * - **Under the card**, the tiles that do not fit beside it run in rows from the left edge under the
 *   card, with the game's 4px spacing.
 *
 * The two regions do not share column positions (the card is wider than a tile), so the columns are
 * built from the union of every edge either region needs: column gap 0, and every track a measured
 * pixel width between two consecutive edges. Each item then spans from its left edge's line to its
 * right edge's. That is exact for both regions and never makes the grid wider than its area (which
 * implicit tracks or negative margins would, waking an ancestor's scrollbar).
 *
 * The available width is measured off the trial area (never styled here), not off the grid.
 *
 * Only styles and attributes are written; the game's nodes are never moved, so every reader that walks
 * the tiles in DOM order (`guild-trial-units.js`, the badges, `guild-member-skills.js`) is unaffected.
 * Scoped to the two trial areas; a normal party fight is never touched.
 */

import config from '../../core/config.js';
import { guildXPTracker } from './guild-xp-tracker.js';
import { currentSignup } from './guild-trial-signups.js';

/** The setting that turns it on and off, live */
export const SETTING = 'guildTrialPackUnits';

/** Marks a grid container this module lays out */
export const GRID_MARK = 'data-toolasha-trial-grid';
/** Marks a card or tile this module placed */
export const PLACED_MARK = 'data-toolasha-trial-placed';
/** The id of the stylesheet */
export const STYLE_ID = 'toolasha-trial-unit-grid-style';

/** The game's gap between tiles, px */
export const GAP = 4;

/** The trial areas (combat trial, skilling trial) and the leading card inside each */
export const AREAS = [
    { area: '[class*="BattlePanel_guildPartyArea"]', card: '[class*="CombatUnit_combatUnit"]', roles: true },
    {
        area: '[class*="SkillingInstancePanel_playerArea"]',
        card: '[class*="SkillingInstancePanel_skillingUnit"]',
        roles: false,
    },
];

export const AREA_SEL = AREAS.map((a) => a.area).join(', ');
export const GRID_SEL = '[class*="MiniUnitGrid_miniUnitGrid"]';
export const COLUMN_SEL = '[class*="MiniUnitGrid_miniUnitColumn"]';
export const TILE_SEL = '[class*="MiniUnit_miniUnit"]';
export const NAME_SEL = '[class*="MiniUnit_name"]';

/** Role group rank: tank, support, damage dealer, then anyone with no role */
const ROLE_RANK = { tank: 0, support: 1, damage_dealer: 2 };
const NO_ROLE = 3;

const CSS = `
:is(${AREA_SEL}) [${GRID_MARK}] {
    display: grid !important;
    column-gap: 0 !important;
    row-gap: ${GAP}px !important;
    grid-auto-rows: auto;
    justify-content: start !important;
    align-items: start !important;
    justify-items: start !important;
}
:is(${AREA_SEL}) [${GRID_MARK}] > ${COLUMN_SEL} {
    display: contents !important;
}
`;

const PLACE_PROPS = ['gridRow', 'gridColumn'];

/** Round to a hundredth of a pixel so equal edges compare equal */
const px = (n) => Math.round(n * 100) / 100;

/**
 * Where every item goes, from measured sizes (all positive; the caller skips an area it cannot measure).
 *
 * @param {Object} sizes - Measured, px
 * @param {number} sizes.cardW - The leading card's width
 * @param {number} sizes.tileW - A tile's width (the widest)
 * @param {number} sizes.areaW - The grid container's width
 * @param {number} sizes.count - How many tiles
 * @param {number} [sizes.gap] - Spacing between tiles
 * @returns {{columns: number[], card: {row: string, column: string}, tiles: Array<{row: number, column: string}>,
 *   beside: number}} Track widths, the card's and each tile's placement, how many tiles sit beside the card
 */
export function computeLayout({ cardW, tileW, areaW, count, gap = GAP }) {
    const step = tileW + gap;
    // Stacks of three that fit beside the card: stack k spans [cardW + gap + k*step, ... + tileW]
    const fitCols = Math.max(0, Math.floor((areaW - cardW - gap - tileW) / step) + 1);
    const beside = Math.min(count, fitCols * 3);
    // Under the card: as many as fit across the whole area, never fewer than one a row
    const perRow = Math.max(1, Math.floor((areaW + gap) / step));

    const spans = [];
    spans.push([0, cardW]);
    const placed = [];
    for (let i = 0; i < count; i++) {
        if (i < beside) {
            const k = Math.floor(i / 3);
            const start = cardW + gap + k * step;
            placed.push({ row: 1 + (i % 3), span: [start, start + tileW] });
        } else {
            const j = i - beside;
            const start = (j % perRow) * step;
            placed.push({ row: 4 + Math.floor(j / perRow), span: [start, start + tileW] });
        }
    }
    for (const p of placed) spans.push(p.span);

    const edges = [...new Set(spans.flat().map(px))].sort((a, b) => a - b);
    const columns = [];
    for (let i = 1; i < edges.length; i++) columns.push(px(edges[i] - edges[i - 1]));
    const line = (x) => edges.indexOf(px(x)) + 1;
    const column = ([a, b]) => `${line(a)} / ${line(b)}`;

    return {
        columns,
        // The card always comes first, spanning the three rows the stacks beside it use
        card: { row: '1 / span 3', column: column([0, cardW]) },
        tiles: placed.map((p) => ({ row: p.row, column: column(p.span) })),
        beside,
    };
}

/**
 * The fixed order of a set of tiles.
 *
 * @param {Array<{name: string, index: number}>} tiles - Each tile's name and DOM position
 * @param {Object} options - How to sort
 * @param {boolean} options.roles - Group by signed-up combat role first
 * @param {Map<string, string>} [options.roleOf] - Name to role, for members signed up this week
 * @returns {Array<{name: string, index: number}>} Sorted copy
 */
export function sortTiles(tiles, { roles, roleOf = new Map() }) {
    const rank = (t) => (roles ? (ROLE_RANK[roleOf.get(t.name)] ?? NO_ROLE) : 0);
    return [...tiles].sort((a, b) => {
        // A tile with no name yet (mid-render) goes last, in DOM order
        if (!a.name !== !b.name) return a.name ? -1 : 1;
        const r = rank(a) - rank(b);
        if (r) return r;
        const n = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        return n || a.index - b.index;
    });
}

/**
 * Each guild member's signed-up combat role for this week, by name.
 * @returns {Map<string, string>} Name to role (`tank`, `support`, `damage_dealer`); members with none absent
 */
function rolesByName() {
    const roles = new Map();
    try {
        const week = guildXPTracker.getCurrentWeekStartAt?.() ?? null;
        for (const meta of guildXPTracker.getMemberList?.() || []) {
            const role = currentSignup(meta, week)?.role;
            if (meta?.name && role) roles.set(meta.name, role);
        }
    } catch (error) {
        console.error('[GuildTrialUnitGrid] Reading roles failed:', error);
    }
    return roles;
}

/**
 * The width the grid may use, measured off the trial area (a box this module never styles), not off
 * the grid: a grid that sizes to its content would report the tracks it was given and ratchet narrower
 * every run. The area's content box; the grid's own width only when the area cannot be measured.
 * @param {Element} area - The trial area
 * @param {Element} grid - The game's unit grid inside it
 * @returns {number} px
 */
function availableWidth(area, grid) {
    const outer = area.getBoundingClientRect().width;
    if (outer > 0) {
        const cs = getComputedStyle(area);
        const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const border = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
        const inner = outer - pad - border;
        if (inner > 0) return inner;
    }
    return grid.getBoundingClientRect().width;
}

const nameOf = (tile) => (tile.querySelector(NAME_SEL)?.textContent || '').trim();

class GuildTrialUnitGrid {
    constructor() {
        this.unwatch = null;
        this.unwatchMeta = null;
        this.observer = null;
        this.raf = 0;
        this.enabled = false;
        this.onResize = () => this._schedule();
    }

    /** Follow the setting; start working when it is on */
    initialize() {
        this.unwatch?.();
        this.unwatch = config.onSettingChange(SETTING, (enabled) => (enabled ? this._start() : this._stop()));
        if (config.getSetting(SETTING, true)) this._start();
        else this._stop();
    }

    /** Stop following the setting, restore everything this module changed */
    cleanup() {
        this.unwatch?.();
        this.unwatch = null;
        this._stop();
    }

    _start() {
        if (this.enabled) {
            this._schedule();
            return;
        }
        this.enabled = true;
        this.observer = new MutationObserver((mutations) => {
            if (mutations.some((m) => this._relevant(m))) this._schedule();
        });
        // The body for areas coming and going; each area itself (added in `_run`) for name text rewrites,
        // so text changing anywhere else on the page never reaches the callback
        this.observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', this.onResize);
        // A role signed up or changed re-sorts the combat trial
        this.unwatchMeta = guildXPTracker.onMetaChanged?.(() => this._schedule()) || null;
        this._schedule();
    }

    _stop() {
        this.enabled = false;
        this.observer?.disconnect();
        this.observer = null;
        this.unwatchMeta?.();
        this.unwatchMeta = null;
        window.removeEventListener('resize', this.onResize);
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        for (const grid of document.querySelectorAll(`[${GRID_MARK}]`)) this._restoreGrid(grid);
        for (const el of document.querySelectorAll(`[${PLACED_MARK}]`)) this._restoreItem(el);
        document.getElementById(STYLE_ID)?.remove();
    }

    /**
     * Cheap filter. Relevant: a trial area came or went; a card, column or tile was added or removed in
     * one; or a tile's name changed (the game may re-render a rotated party by rewriting names in place).
     * Fight numbers changing inside a tile are not.
     */
    _relevant(m) {
        const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!target) return false;
        if (m.type === 'characterData') return Boolean(target.closest?.(NAME_SEL) && target.closest(AREA_SEL));
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (!nodes.length) return false;
        if (target.closest?.(AREA_SEL)) {
            if (target.closest(NAME_SEL)) return true;
            return nodes.some(
                (n) =>
                    n.nodeType === 1 &&
                    (n.matches?.(`${TILE_SEL}, ${COLUMN_SEL}, ${GRID_SEL}`) ||
                        n.querySelector?.(`${TILE_SEL}, ${GRID_SEL}`) ||
                        AREAS.some((a) => n.matches?.(a.card)))
            );
        }
        return nodes.some((n) => n.nodeType === 1 && (n.matches?.(AREA_SEL) || n.querySelector?.(AREA_SEL)));
    }

    _schedule() {
        if (!this.enabled || this.raf) return;
        this.raf = requestAnimationFrame(() => {
            this.raf = 0;
            this._run();
        });
    }

    _restoreGrid(grid) {
        grid.removeAttribute(GRID_MARK);
        grid.style.gridTemplateColumns = '';
    }

    _restoreItem(el) {
        for (const prop of PLACE_PROPS) el.style[prop] = '';
        el.removeAttribute(PLACED_MARK);
    }

    _ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }

    _run() {
        if (!this.enabled) return;
        const plans = [];
        // Grids already laid out that cannot be measured this run keep what they have
        const live = new Set();
        let roleOf = null;
        // Measure everything first, then write
        for (const { area: areaSel, card: cardSel, roles } of AREAS) {
            for (const area of document.querySelectorAll(areaSel)) {
                const grid = area.querySelector(GRID_SEL);
                const card = grid?.querySelector(cardSel);
                if (!card) continue;
                // Name rewrites inside the area (re-observing a node only replaces its options)
                this.observer?.observe(area, { childList: true, subtree: true, characterData: true });
                const tiles = [...grid.querySelectorAll(TILE_SEL)];
                if (!tiles.length) continue;
                if (roles && !roleOf) roleOf = rolesByName();
                const order = sortTiles(
                    tiles.map((el, index) => ({ el, name: nameOf(el), index })),
                    { roles, roleOf: roleOf || undefined }
                );
                const cardW = card.getBoundingClientRect().width;
                const tileW = Math.max(...tiles.map((t) => t.getBoundingClientRect().width));
                const areaW = availableWidth(area, grid);
                // Not laid out (hidden, mid-render): nothing is changed until a run that can measure it
                if (!(cardW > 0 && tileW > 0 && areaW > 0)) {
                    if (grid.hasAttribute(GRID_MARK)) {
                        live.add(grid);
                        for (const el of grid.querySelectorAll(`[${PLACED_MARK}]`)) live.add(el);
                    }
                    continue;
                }
                const layout = computeLayout({ cardW, tileW, areaW, count: tiles.length });
                plans.push({ grid, card, order, layout });
            }
        }
        if (plans.length) this._ensureStyle();
        for (const { grid, card, order, layout } of plans) {
            grid.setAttribute(GRID_MARK, '');
            grid.style.gridTemplateColumns = layout.columns.map((w) => `${w}px`).join(' ');
            live.add(grid);
            this._place(card, layout.card.row, layout.card.column, live);
            order.forEach(({ el }, i) => this._place(el, String(layout.tiles[i].row), layout.tiles[i].column, live));
        }
        // Anything marked that is no longer in a laid-out trial grid goes back to how the game drew it
        for (const grid of document.querySelectorAll(`[${GRID_MARK}]`)) if (!live.has(grid)) this._restoreGrid(grid);
        for (const el of document.querySelectorAll(`[${PLACED_MARK}]`)) if (!live.has(el)) this._restoreItem(el);
        if (!live.size) document.getElementById(STYLE_ID)?.remove();
    }

    _place(el, row, column, live) {
        el.style.gridRow = row;
        el.style.gridColumn = column;
        el.setAttribute(PLACED_MARK, '');
        live.add(el);
    }
}

const guildTrialUnitGrid = new GuildTrialUnitGrid();

export default {
    name: 'Guild Trial Unit Grid',
    initialize: () => guildTrialUnitGrid.initialize(),
    cleanup: () => guildTrialUnitGrid.cleanup(),
};

export { guildTrialUnitGrid };
