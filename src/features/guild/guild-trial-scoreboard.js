/**
 * Who is carrying the trial, as a panel rather than four lines under a card.
 *
 * The per-player split already exists (`guild-trial-damage.js`) and is drawn as
 * a short list under the combat trial's card. That is the right size for a
 * glance and the wrong size for the question a guild actually argues about after
 * a tier fails, which wants ranks, shares, bars, and the healing beside the
 * damage. So the same numbers get a panel.
 *
 * ## Two tabs, three sources, and every figure says which one it is
 *
 * A trial fight is real and server-run, and opening the In Progress **fight
 * view** streams it here as `guild_battle_updated` — so these tabs can be
 * measured after all, for the stretch somebody was watching. Three things can
 * therefore be on screen, and they are never mixed:
 *
 * 1. **Measured** — folded from spectated ticks. Preferred whenever it exists.
 * 2. **Estimated** — each member's captured build worth per second, shared out.
 *    The fallback when nothing has been watched, labelled at the top rather than
 *    footnoted. Members with no captured build are named, not dropped.
 * 3. **Nothing** — with a reason that says what to do about it, which is now
 *    "open the fight view" rather than an apology.
 *
 * **Healing** has no estimate to fall back on: a build says nothing about how
 * much healing a fight will call for. Watched, it fills from the same ticks the
 * damage does — health rising, attributed to a lone healer on the tick and kept
 * unattributed otherwise (`guild-trial-support.js`).
 *
 * The party-wide rate on the trial card stays where it is and stays measured;
 * this panel never competes with it.
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
import guildTrialDamage, { estimateDamageSplit, SPECTATED_TRIAL_NOTE } from './guild-trial-damage.js';
import { guildLoadoutCapture } from './guild-loadout-capture.js';
import { guildTrialRecorder } from './guild-trial-recorder.js';
import { buildGuildReport } from './guild-trial-report.js';

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

    const measuredBy = new Map((breakdown?.players || []).map((row) => [row.index, row.measured]));
    const rows = raw.filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
    const total = rows.reduce((sum, row) => sum + row.value, 0);

    return {
        rows: rows.map((row, position) => ({
            ...row,
            // Per row, not per table: the game streams action counters for one
            // unit — yours — so one row can be measured while the rest are not
            measured: measuredBy.get(row.index) ?? null,
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
export function scoreboardText(breakdown, tab = 'damage', estimate = null) {
    const { rows, total, perSecond } = scoreboardRows(breakdown, tab);
    const label = tab === 'healing' ? 'healing' : 'damage';

    if (!rows.length && tab === 'damage' && estimate?.players?.length) {
        const head =
            `Trial damage, ESTIMATED FROM BUILDS — the game does not expose real per-player trial figures. ` +
            `${estimate.covered} of ${estimate.of} builds captured.`;
        const lines = estimate.players.map(
            (row, position) =>
                `${position + 1}. ${row.name} — ~${formatWithSeparator(Math.round(row.dps))}/s` +
                (row.share === null ? '' : ` (${row.share.toFixed(1)}%)`)
        );
        if (estimate.unestimated.length) {
            lines.push(`Unestimated (no build captured): ${estimate.unestimated.join(', ')}`);
        }
        return [head, ...lines].join('\n');
    }

    if (!rows.length) return `Trial ${label}: nothing measured — ${breakdown?.reason || SPECTATED_TRIAL_NOTE}`;

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
        /** The trials feature's expected-tier forecast, pushed in rather than imported */
        this.forecast = null;
        /** The trial's name, tier and shortfall, likewise pushed in */
        this.context = null;
    }

    /**
     * Take the expected-tier forecast from the trials feature.
     *
     * Pushed rather than pulled, the same way the damage gate is told which
     * encounters this week's trials are: the trials feature imports this panel,
     * so this panel must not import it back.
     *
     * @param {Object|null} forecast - From `guild-trial-forecast.js`
     */
    noteForecast(forecast) {
        this.forecast = forecast || null;
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
            this._copy(scoreboardText(breakdown, this.tab, this._estimate()));
        });
        body.querySelector('[data-action="report"]')?.addEventListener('click', () => {
            this._copy(this.reportText(breakdown));
        });
        body.querySelector('[data-action="restart"]')?.addEventListener('click', () => {
            guildTrialRecorder.restart();
            this.render();
        });
    }

    /**
     * Put something on the clipboard.
     * @param {string} text - What to copy
     */
    _copy(text) {
        navigator.clipboard?.writeText?.(text)?.catch?.(() => {});
    }

    /**
     * The guild-shareable report, with whatever context the panel has.
     *
     * The trial's name, the tiers it banked and how close it came all live with
     * the trials feature, which pushes them here the same way it pushes the
     * forecast — this panel imports neither.
     *
     * @param {Object} [breakdown] - From `guildTrialDamage.breakdown()`
     * @returns {string} The report
     */
    reportText(breakdown = guildTrialDamage.breakdown?.()) {
        return buildGuildReport({ ...(this.context || {}), breakdown, estimate: this._estimate() });
    }

    /**
     * Whose damage is actually measured, when only some of it is.
     *
     * The game streams action counters for **one** unit — the viewer's own
     * character — so a watched trial produces a real, attributed figure for you
     * and nothing attributable for anybody else. Saying "measured" over a table
     * where that is true of one row would be claiming the other twenty-nine.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _ownRowNote(breakdown) {
        const named = breakdown?.countedNames || [];
        if (!named.length) return '';

        return (
            ` Each row is attributed off the ticks the server groups by actor;` +
            ` ${named.slice(0, 2).join(' and ')}${named.length > 2 ? ` and ${named.length - 2} more` : ''}` +
            ` ${named.length === 1 ? 'carries' : 'carry'} own attack counters that confirm it directly.`
        );
    }

    /**
     * How the units in a watched fight were identified, when it is worth saying.
     *
     * A spectated tick names its units by index only, so a row headed "Player 3"
     * has to be legible as a placeholder rather than as somebody's name.
     *
     * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
     * @returns {string} A sentence, or an empty string
     */
    _namingNote(breakdown) {
        const coverage = breakdown?.nameCoverage;
        if (!coverage?.of) return '';
        if (!coverage.placeholders.length) return '';

        const listed = coverage.placeholders.slice(0, 4).join(', ');
        return (
            ` ${coverage.named} of ${coverage.of} units could be named from the fight view or a captured ` +
            `build; ${listed} ${coverage.placeholders.length === 1 ? 'is a placeholder' : 'are placeholders'}.`
        );
    }

    /**
     * The per-player split as the builds predict it.
     *
     * Rebuilt on every draw rather than cached: a build captured mid-trial has to
     * appear without the panel being closed and reopened.
     *
     * @returns {Object} From `estimateDamageSplit`
     */
    _estimate() {
        return estimateDamageSplit({
            loadouts: guildLoadoutCapture.seen?.() || [],
            members: this.context?.members || [],
        });
    }

    /**
     * Take the trial's own context from the trials feature.
     * @param {Object} context - `{trialName, tier, tiersCleared, shortfall, pastWeeks}`
     */
    noteContext(context) {
        this.context = context || null;
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

        // Measurement is impossible for a trial (see the module note), so the
        // damage tab falls through to the estimate rather than to an apology
        const estimate = !rows.length && !healing ? this._estimate() : null;
        const estimated = Boolean(estimate?.players?.length);

        const head = estimated
            ? `<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:2px;">` +
              `<span style="font-size:20px; font-weight:700; color:${WARN};">` +
              `~${formatKMB(Math.round(estimate.total))}</span>` +
              `<span style="color:${DIM};">est. party dps</span>` +
              `<span style="margin-left:auto; color:${DIM}; font-weight:600;">` +
              `${estimate.covered}/${estimate.of} builds</span>` +
              `</div>`
            : `<div style="display:flex; align-items:baseline; gap:10px; margin-bottom:2px;">` +
              `<span style="font-size:20px; font-weight:700; color:${ACCENT};">` +
              `${perSecond === null ? '—' : formatKMB(Math.round(perSecond))}</span>` +
              `<span style="color:${DIM};">party ${unit}</span>` +
              `<span style="margin-left:auto; color:${GOOD}; font-weight:600;">` +
              `${formatKMB(Math.round(total))}</span>` +
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

        // The headline of the section, not a caveat under it: a reader who takes
        // an estimate for the game's own figures has been misled by the panel,
        // and one who takes a measurement for a guess distrusts a real number
        const spectated = breakdown?.source === 'spectated';
        const disclaimer = estimated
            ? `<div style="color:${WARN}; font-size:11px; font-weight:600; line-height:1.5;">` +
              'Estimated from builds — nothing has been watched yet.</div>' +
              `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
              'A trial fight runs on the game’s own server and streams here only while the In Progress ' +
              'fight view is open — open it and these become measured. Until then this is each captured ' +
              'sheet’s auto-attack worth per second, shared out: abilities are not modelled, and a build is ' +
              'only as current as the last time it was seen.</div>'
            : spectated
              ? `<div style="color:${GOOD}; font-size:11px; font-weight:600; line-height:1.5;">` +
                `Measured from the trial fight — ${Math.round(breakdown?.seconds || 0)}s watched.</div>` +
                `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
                'Folded from the stream the In Progress fight view subscribes to. Once started, the stream ' +
                'often keeps flowing while other tabs are open — every tick received is counted, and a gap ' +
                'in the stream pauses these rather than ending them.' +
                this._ownRowNote(breakdown) +
                this._namingNote(breakdown) +
                '</div>'
              : `<div style="color:${DIM}; font-size:10px; line-height:1.5; margin-bottom:6px;">` +
                'Attributed off this client’s own battle feed.</div>';

        const unestimated =
            estimated && estimate.unestimated.length
                ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">No build captured, so not ` +
                  `estimated: ${estimate.unestimated.slice(0, 8).join(', ')}` +
                  `${estimate.unestimated.length > 8 ? `, +${estimate.unestimated.length - 8} more` : ''}.</div>`
                : '';

        // A watched fight with nothing attributed yet: between fights, or a
        // view opened moments ago — the next boss hit fills the table in
        const unsplit =
            !rows.length && !estimated && spectated
                ? `<div style="color:${DIM}; padding:6px 0; line-height:1.5;">` +
                  'Watched, but no damage has been attributed yet — the split fills in as hits land on the ' +
                  'boss. The tank-and-healer figures on the Healing tab come from the same ticks.</div>'
                : '';

        const nothing =
            `<div style="color:${DIM}; padding:6px 0; line-height:1.5;">` +
            (healing
                ? spectated
                    ? 'Watched, but no heal could be attributed: a rise in health is only credited when exactly ' +
                      'one player cast a heal on that tick. Anything else is kept as unattributed rather than ' +
                      'assigned to whoever looked likely.'
                    : `No healing has been watched — ${SPECTATED_TRIAL_NOTE}. ` +
                      'Open it during a trial and this fills from the same ticks the damage does; a build ' +
                      'cannot be used to guess healing, so there is no estimate to show meanwhile.'
                : `Nothing to show yet — ${breakdown?.reason || SPECTATED_TRIAL_NOTE}. ` +
                  'No member builds have been captured either, so there is nothing to estimate from.') +
            '</div>';

        const list = rows.length
            ? rows.map((row) => this._rowHTML(row)).join('')
            : estimated
              ? estimate.players
                    .map((row, position) =>
                        this._rowHTML({
                            name: row.name,
                            rank: position + 1,
                            value: null,
                            perSecond: row.dps,
                            share: row.share,
                        })
                    )
                    .join('') + unestimated
              : unsplit || nothing;

        const unattributed = breakdown?.support?.unattributedHealing || 0;
        const footnote =
            healing && unattributed > 0
                ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">` +
                  `${formatKMB(Math.round(unattributed))} unattributed — regeneration, or two healers on one tick.</div>`
                : '';

        const forecast = this.forecast;
        const expected =
            forecast && forecast.tier !== null
                ? `<div style="color:${DIM}; font-size:10px; margin-top:6px;">` +
                  `Expected to reach <span style="color:${GOOD}; font-weight:600;">T${forecast.tier}</span> ` +
                  `in the hour — ${forecast.source === 'measured' ? 'from the party\u2019s measured rate' : 'estimated from captured loadouts'}` +
                  `${Number.isFinite(forecast.enragedFrom) ? ', with the boss fully enraged by then' : ''}.</div>`
                : '';

        // One line rather than a tab of its own: running dry is worth knowing
        // and is not worth a page
        const dry = (breakdown?.support?.players || []).filter((row) => row.manaOuts > 0);
        const manaLine = dry.length
            ? `<div style="color:${DIM}; font-size:10px; margin-top:4px;">Ran out of mana: ` +
              dry
                  .map((row) => `${row.name} ${row.manaOuts}×`)
                  .slice(0, 4)
                  .join(', ') +
              '</div>'
            : '';

        const buttons =
            `<div style="display:flex; gap:6px; margin-top:8px;">` +
            `<button data-action="copy" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(255,255,255,0.15); background:transparent; color:${DIM}; font-size:11px;">` +
            'Copy stats</button>' +
            `<button data-action="report" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid ${ACCENT}66; background:transparent; color:${ACCENT}; font-size:11px;">` +
            'Copy guild report</button>' +
            `<button data-action="restart" style="flex:1; cursor:pointer; padding:4px 0; border-radius:4px;` +
            `border:1px solid rgba(240,168,48,0.5); background:transparent; color:${WARN}; font-size:11px;">` +
            'End &amp; start new</button></div>';

        return head + tabs + disclaimer + list + footnote + manaLine + expected + buttons;
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
        const rate = row.perSecond === null || row.perSecond === undefined ? '—' : formatKMB(Math.round(row.perSecond));

        // An estimated row has no total to show, because there is no elapsed
        // fight to have accumulated one — the rate is the whole figure, and it
        // carries a tilde so it cannot be read as a measurement
        const estimated = row.value === null || row.value === undefined;
        const figure = estimated ? `~${rate}/s` : formatKMB(Math.round(row.value));
        // A row the game streamed counters for is measured; one folded in
        // beside it is not, and a table that does not say so is claiming both
        const label = estimated ? 'estimated' : row.measured === false ? `${rate}/s · partial` : `${rate}/s`;

        return (
            `<div style="position:relative; margin:3px 0; padding:3px 6px; border-radius:3px;` +
            `background:linear-gradient(to right, ${color}44 ${width}%, rgba(255,255,255,0.04) ${width}%);">` +
            `<div style="display:flex; gap:6px; align-items:baseline;">` +
            `<span style="color:${DIM}; width:14px;">${row.rank}</span>` +
            `<span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${row.name}</span>` +
            `<span style="margin-left:auto; color:${color}; font-weight:600;">${figure}</span>` +
            `</div>` +
            `<div style="display:flex; gap:6px; color:${DIM}; font-size:10px;">` +
            `<span>${label}</span>` +
            `<span style="margin-left:auto;">${row.share === null ? '—' : `${row.share.toFixed(1)}%`}</span>` +
            `</div></div>`
        );
    }
}

const guildTrialScoreboard = new GuildTrialScoreboard();

export default guildTrialScoreboard;
export { guildTrialScoreboard };
