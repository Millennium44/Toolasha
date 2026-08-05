/**
 * Who is carrying the trial, as a panel rather than four lines under a card.
 *
 * The per-player split already exists (`guild-trial-damage.js`) and is drawn as
 * a short list under the combat trial's card. That is the right size for a
 * glance and the wrong size for the question a guild actually argues about after
 * a tier fails, which wants ranks, shares, bars, and the healing beside the
 * damage. So the same numbers get a panel.
 *
 * ## Two tabs, and both are honest about what they are
 *
 * **Damage** is attributed off the battle feed — the attack counter identifies
 * the attacker, a hit is the damage counter rising. **Healing** is the same
 * discipline applied to health *rising*: a heal cast on a tick with exactly one
 * healer is theirs, and anything else is kept as unattributed rather than
 * assigned to whoever looked likely (`guild-trial-support.js`). Both tabs say
 * where their numbers came from, because neither is the game's own figure:
 *
 * - Only fights **this client took part in** are counted. A trial somebody else
 *   is running sends no battle traffic here at all.
 * - The party DPS on the trial card is measured off the boss's health bar and
 *   covers everybody; this panel's total covers the fights it saw. They are two
 *   measurements of overlapping things and the panel says so rather than
 *   quietly showing the smaller one.
 *
 * ## Colour
 *
 * By damage type, from the loadouts already captured off `battle_unit_fetched`
 * (`combatStats.damageType`, or the combat style when the type is absent) —
 * which is a fact about the player rather than a guess from their name. A player
 * whose loadout has never been seen gets the neutral accent, because a colour
 * that means "unknown" and a colour that means "physical" must not be the same
 * colour.
 */

import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import guildTrialDamage from './guild-trial-damage.js';
import { guildLoadoutCapture } from './guild-loadout-capture.js';
import { guildTrialRecorder } from './guild-trial-recorder.js';

/** Class every part of this panel carries, so teardown is one query */
export const PANEL_CLASS = 'mwi-trial-scoreboard';

const ACCENT = '#8fd3ff';
const DIM = '#9ca3af';
const GOOD = '#4ade80';
const WARN = '#f0a830';

/**
 * Bar colour per damage type.
 *
 * Read from the loadout rather than inferred from a name. The neutral accent is
 * reserved for "no loadout seen", which is a different statement from any of the
 * others and must look different.
 */
export const TYPE_COLORS = {
    physical: '#f0a830',
    water: '#5aa9e6',
    nature: '#4ade80',
    fire: '#ef6f5a',
    slash: '#f0a830',
    stab: '#f0a830',
    smash: '#f0a830',
    ranged: '#c084fc',
    magic: '#5aa9e6',
};

/**
 * The damage type a player fights with, from their captured loadout.
 * @param {string} name - Player name
 * @param {Object} [capture] - The loadout store, injectable for tests
 * @returns {string|null} A key of {@link TYPE_COLORS}, or null when unseen
 */
export function damageTypeOf(name, capture = guildLoadoutCapture) {
    const stats = capture?.forPlayer?.(name)?.stats;
    if (!stats) return null;

    const type = String(stats.damageType || '')
        .split('/')
        .pop();
    if (type && TYPE_COLORS[type]) return type;

    const style = String(stats.combatStyleHrids?.[0] || '')
        .split('/')
        .pop();
    return style && TYPE_COLORS[style] ? style : null;
}

/**
 * The rows one tab shows, ranked, with shares.
 *
 * Pure: it takes a breakdown and returns numbers, so the arithmetic is tested
 * without a DOM. Rows with nothing in them are dropped — a healer with no damage
 * on the damage tab is a zero-length bar and a rank nobody wanted.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {'damage'|'healing'} tab - Which figures
 * @returns {{rows: Array<Object>, total: number, perSecond: number|null, seconds: number}} The tab
 */
export function scoreboardRows(breakdown, tab = 'damage') {
    const seconds = breakdown?.seconds || 0;
    const support = breakdown?.support?.players || [];

    const raw =
        tab === 'healing'
            ? support.map((row) => ({ index: row.index, name: row.name, value: row.healingDone || 0 }))
            : (breakdown?.players || []).map((row) => ({ index: row.index, name: row.name, value: row.damage || 0 }));

    const rows = raw.filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
    const total = rows.reduce((sum, row) => sum + row.value, 0);

    return {
        rows: rows.map((row, position) => ({
            ...row,
            rank: position + 1,
            perSecond: seconds > 0 ? row.value / seconds : null,
            share: total > 0 ? (row.value / total) * 100 : null,
        })),
        total,
        perSecond: seconds > 0 ? total / seconds : null,
        seconds,
    };
}

/**
 * The panel's contents as plain text, for the clipboard.
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @param {'damage'|'healing'} tab - Which figures
 * @returns {string} One line per player
 */
export function scoreboardText(breakdown, tab = 'damage') {
    const { rows, total, perSecond } = scoreboardRows(breakdown, tab);
    const label = tab === 'healing' ? 'healing' : 'damage';
    if (!rows.length) return `Trial ${label}: nothing measured — ${breakdown?.reason || 'no trial fight seen'}`;

    const header =
        `Trial ${label} — ${formatWithSeparator(Math.round(total))} total` +
        (perSecond === null ? '' : `, ${formatWithSeparator(Math.round(perSecond))}/s`) +
        ` over ${Math.round(breakdown?.seconds || 0)}s (estimated from the battle feed)`;

    const lines = rows.map(
        (row) =>
            `${row.rank}. ${row.name} — ${formatWithSeparator(Math.round(row.value))}` +
            (row.perSecond === null ? '' : ` (${formatWithSeparator(Math.round(row.perSecond))}/s`) +
            (row.share === null ? ')' : `, ${row.share.toFixed(1)}%)`)
    );

    const unattributed = breakdown?.support?.unattributedHealing || 0;
    if (tab === 'healing' && unattributed > 0) {
        lines.push(
            `Unattributed: ${formatWithSeparator(Math.round(unattributed))} (regeneration, or two healers at once)`
        );
    }

    return [header, ...lines].join('\n');
}

class GuildTrialScoreboard {
    constructor() {
        this.container = null;
        this.tab = 'damage';
        this.refreshId = null;
    }

    /** @returns {boolean} Whether the panel is on screen */
    get isOpen() {
        return Boolean(this.container?.isConnected);
    }

    /** Open it, or bring it forward if it is already open */
    open() {
        if (this.isOpen) {
            bringPanelToFront?.(this.container);
            this.render();
            return;
        }
        this._build();
        this.render();
    }

    /** Close it */
    close() {
        if (this.refreshId) clearInterval(this.refreshId);
        this.refreshId = null;
        // The drag listeners live on the document rather than on the panel, so
        // closing has to take them off by hand or every open leaves a pair
        this._release?.();
        this._release = null;
        if (this.container) {
            unregisterFloatingPanel?.(this.container);
            this.container.remove();
        }
        this.container = null;
    }

    /** Open when shut, shut when open — what the command palette calls */
    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    /** Build the shell once; the body is redrawn in place */
    _build() {
        const container = document.createElement('div');
        container.className = PANEL_CLASS;
        container.style.cssText =
            'position:fixed; top:80px; right:24px; width:320px; z-index:9000;' +
            'background:rgba(18,20,28,0.97); border:1px solid rgba(255,255,255,0.12); border-radius:8px;' +
            'box-shadow:0 6px 24px rgba(0,0,0,0.45); font-size:12px; color:#e8ecf5;' +
            'display:flex; flex-direction:column; max-height:70vh;';

        const header = document.createElement('div');
        header.className = `${PANEL_CLASS}__header`;
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:8px;' +
            'padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.08); cursor:move;';
        header.innerHTML = `<span style="font-weight:700; color:${ACCENT};">Trial damage</span>`;

        const close = document.createElement('button');
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close');
        close.style.cssText =
            'background:none; border:none; color:#aaa; font-size:16px; line-height:1; cursor:pointer; padding:0 2px;';
        close.addEventListener('click', () => this.close());
        header.appendChild(close);

        const body = document.createElement('div');
        body.className = `${PANEL_CLASS}__body`;
        body.style.cssText = 'padding:8px 10px; overflow-y:auto;';

        container.appendChild(header);
        container.appendChild(body);
        document.body.appendChild(container);
        registerFloatingPanel?.(container);

        this.container = container;
        this._drag(header);

        // A trial is live while this is open; five seconds is the cadence the
        // rest of the feature samples at
        this.refreshId = setInterval(() => this.render(), 5000);
    }

    /**
     * Make the header drag the panel.
     * @param {Element} header - The drag handle
     */
    _drag(header) {
        let from = null;
        header.addEventListener('mousedown', (event) => {
            if (event.target.tagName === 'BUTTON') return;
            const box = this.container.getBoundingClientRect();
            from = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
            event.preventDefault();
        });
        const move = (event) => {
            if (!from || !this.container) return;
            this.container.style.left = `${from.left + event.clientX - from.x}px`;
            this.container.style.top = `${from.top + event.clientY - from.y}px`;
            this.container.style.right = 'auto';
        };
        const up = () => {
            from = null;
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        this._release = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
        };
    }

    /** Redraw the body from the current breakdown */
    render() {
        if (!this.isOpen) return;
        const body = this.container.querySelector(`.${PANEL_CLASS}__body`);
        if (!body) return;

        const breakdown = guildTrialDamage.breakdown?.() || null;
        body.innerHTML = this._bodyHTML(breakdown);

        body.querySelectorAll('[data-tab]').forEach((button) => {
            button.addEventListener('click', () => {
                this.tab = button.dataset.tab;
                this.render();
            });
        });
        body.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
            const text = scoreboardText(breakdown, this.tab);
            navigator.clipboard?.writeText?.(text).catch(() => {});
        });
        body.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
            guildTrialRecorder.restart();
            this.render();
        });
    }

    /**
     * The body's markup.
     * @param {Object|null} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} HTML
     */
    _bodyHTML(breakdown) {
        const { rows, total, perSecond } = scoreboardRows(breakdown, this.tab);
        const healing = this.tab === 'healing';
        const unit = healing ? 'hps' : 'dps';

        const head =
            `<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:2px;">` +
            `<span style="font-size:20px; font-weight:700; color:${ACCENT};">` +
            `${perSecond === null ? '—' : formatKMB(Math.round(perSecond))}</span>` +
            `<span style="color:${DIM};">party ${unit}</span>` +
            `<span style="margin-left:auto; color:${GOOD}; font-weight:600;">${formatKMB(Math.round(total))}</span>` +
            `</div>`;

        const tabs =
            `<div style="display:flex; gap:6px; margin:6px 0;">` +
            [
                { key: 'damage', label: 'Damage' },
                { key: 'healing', label: 'Healing' },
            ]
                .map(
                    (entry) =>
                        `<button data-tab="${entry.key}" style="flex:1; cursor:pointer; padding:3px 0;` +
                        `border:1px solid ${this.tab === entry.key ? ACCENT : 'rgba(255,255,255,0.15)'};` +
                        `border-radius:4px; background:${this.tab === entry.key ? 'rgba(143,211,255,0.15)' : 'transparent'};` +
                        `color:${this.tab === entry.key ? ACCENT : DIM}; font-size:11px;">${entry.label}</button>`
                )
                .join('') +
            `</div>`;

        const disclaimer =
            `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
            'Estimated from the battle feed — the game publishes no per-player figure. Only fights this ' +
            'character took part in are counted, so a trial you are not in shows nothing.</div>';

        const list = rows.length
            ? rows.map((row) => this._rowHTML(row)).join('')
            : `<div style="color:${DIM}; padding:6px 0;">Nothing measured yet — ` +
              `${breakdown?.reason || 'no trial fight seen'}.</div>`;

        const unattributed = breakdown?.support?.unattributedHealing || 0;
        const footnote =
            healing && unattributed > 0
                ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">` +
                  `${formatKMB(Math.round(unattributed))} unattributed — regeneration, or two healers on one tick.</div>`
                : '';

        const buttons =
            `<div style="display:flex; gap:6px; margin-top:8px;">` +
            `<button data-action="copy" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(255,255,255,0.15); background:transparent; color:${DIM}; font-size:11px;">` +
            'Copy stats</button>' +
            `<button data-action="restart" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(240,168,48,0.5); background:transparent; color:${WARN}; font-size:11px;">` +
            'End &amp; start new</button></div>';

        return head + tabs + disclaimer + list + footnote + buttons;
    }

    /**
     * One ranked row, with its bar.
     * @param {Object} row - From {@link scoreboardRows}
     * @returns {string} HTML
     */
    _rowHTML(row) {
        const type = damageTypeOf(row.name);
        const color = type ? TYPE_COLORS[type] : ACCENT;
        const width = Math.max(2, Math.min(100, row.share ?? 0));
        const rate = row.perSecond === null ? '—' : `${formatKMB(Math.round(row.perSecond))}/s`;

        return (
            `<div style="position:relative; margin:3px 0; padding:3px 6px; border-radius:3px;` +
            `background:linear-gradient(to right, ${color}44 ${width}%, rgba(255,255,255,0.04) ${width}%);">` +
            `<div style="display:flex; gap:6px; align-items:baseline;">` +
            `<span style="color:${DIM}; width:14px;">${row.rank}</span>` +
            `<span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${row.name}</span>` +
            `<span style="margin-left:auto; color:${color}; font-weight:600;">${formatKMB(Math.round(row.value))}</span>` +
            `</div>` +
            `<div style="display:flex; gap:6px; color:${DIM}; font-size:10px;">` +
            `<span>${rate}</span>` +
            `<span style="margin-left:auto;">${row.share === null ? '—' : `${row.share.toFixed(1)}%`}</span>` +
            `</div></div>`
        );
    }
}

const guildTrialScoreboard = new GuildTrialScoreboard();

export default guildTrialScoreboard;
export { guildTrialScoreboard };
