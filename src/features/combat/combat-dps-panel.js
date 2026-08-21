/**
 * Who is carrying a normal fight, on the same board a guild trial gets.
 *
 * `guild-trial-scoreboard.js` answers "who did what" for a guild trial — ranks,
 * shares, bars, a rate per player and a tab per quantity. A party farming a
 * zone asks exactly the same question and had nowhere to ask it: the numbers
 * were already being collected (`damage-tracker.js` per player, and
 * `damage-taken-tracker.js` for what comes back), and the only place any of it
 * surfaced per player was the DPS panel's flat list and, since recently, a
 * badge on a portrait.
 *
 * So this is that panel, pointed at the run-side trackers. Everything about
 * *drawing* a ranked board — the headline, the tab strip, the row with its
 * share bar, the copy text — comes from `utils/damage-board.js`, which the
 * trial panel now draws with too. What is written here is the part that is
 * genuinely different: which tracker feeds which tab, and what each figure
 * honestly is.
 *
 * ## Three tabs, and the third one is not "healing done"
 *
 * - **Damage** — `damageBreakdown()`. Per player, including damage-over-time
 *   and reflect, which move a monster's health with no swing behind them.
 * - **Taken** — `takenBreakdown()`. Health actually lost, after mitigation, and
 *   a floor at that: damage healed on the same tick was never visible.
 * - **Healed** — the same tracker's `regen`, which is health *restored*: a
 *   heal, a life-steal and the game's own regeneration are one number here
 *   because nothing on the wire separates them. It is therefore healing
 *   **received**, not healing done, and it is labelled that way rather than
 *   being quietly ranked as if it credited a healer. The run side exposes no
 *   per-caster healing at all — that only exists for a spectated trial, where
 *   the stream carries a lone caster to attribute a rise to.
 *
 * ## Everything is the party's, and in a party nothing says who struck
 *
 * The attribution is `utils/damage-attribution.js`' and its limits are its own:
 * a tick where two players hit the same monster is split between them, and a
 * split is not a measurement. The panel says so once, at the top, rather than
 * footnoting each row — a reader who takes a shared-out estimate for a measured
 * figure has been misled by the panel.
 *
 * Off by default (`combatDpsPanel`), like every panel that has to be asked for.
 * Position, size, collapsed state and whether it was left open all live in
 * `panel-geometry` through `createPanel`, the same as the rest.
 *
 * The idea of a per-player meter for a normal fight is DPs', from MWI Combat
 * Suite by Frotty (MIT), and the board's shape is KikiMeter's by ZhuLiMoon
 * (MIT) — see `third-party/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { damageBreakdown } from './damage-tracker.js';
import { takenBreakdown } from './damage-taken-tracker.js';
import { createPanel } from '../../utils/simple-panel.js';
import {
    BOARD_COLORS,
    boardButtonsHTML,
    boardHeadHTML,
    boardNoteHTML,
    boardRowHTML,
    boardTabsHTML,
    boardLines,
    rankRows,
} from '../../utils/damage-board.js';
import { classTagIconHTML } from '../../utils/class-weapon.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/**
 * How often the opener is re-offered when the observer missed the panel.
 *
 * The observer is the primary signal, but a battle panel that existed before
 * initialize ran — or that React rebuilt in a way the observer's descendant
 * scan did not see — left the button missing until a manual re-init. Every
 * couple of seconds `inject` is asked again; it is a no-op while the button
 * stands, so the cost is one getElementById.
 */
const REINJECT_MS = 2000;

/** Geometry key and DOM id stem — `toolasha-combatDpsPanel-panel` */
export const PANEL_ID = 'combatDpsPanel';

/** The opener injected into the battle panel */
export const BUTTON_ID = 'toolasha-combat-dps-panel-button';

/** Where the party's tiles live, which is what the opener sits above */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/** The tabs, in the order the trial board puts its own */
export const TABS = [
    { key: 'damage', label: 'Damage' },
    { key: 'taken', label: 'Taken' },
    { key: 'healed', label: 'Healed' },
];

/** Which tab is showing. Remembered between openings, the way a panel should */
let tab = 'damage';

/**
 * The rows one tab shows, ranked, with shares.
 *
 * Pure over its inputs, so the arithmetic is tested without a DOM or a live
 * fight. Each tab keeps the tracker's own per-second figure rather than
 * re-deriving one: a tracker that returns null is saying "not enough of a run
 * to divide by", which is a different statement from a rate of nothing and
 * must not be overwritten with one.
 *
 * @param {string} which - A key of {@link TABS}
 * @param {Object} [sources] - Injectable for tests
 * @param {Function} [sources.dealt] - `damageBreakdown`
 * @param {Function} [sources.taken] - `takenBreakdown`
 * @returns {{rows: Array<Object>, total: number, perSecond: number|null, seconds: number}}
 */
export function panelRows(which, { dealt = damageBreakdown, taken = takenBreakdown } = {}) {
    const dealtRun = dealt() || {};
    if (which === 'damage') {
        return rankRows(
            (dealtRun.players || []).map((row) => ({
                name: row.name,
                value: row.damage || 0,
                perSecond: row.dps ?? null,
                classTag: row.classTag || null,
            })),
            dealtRun.seconds || 0
        );
    }

    // The taken tracker knows nothing about casts, so the class comes from the
    // dealt side by name — the same party, keyed differently
    const classByName = {};
    for (const row of dealtRun.players || []) {
        if (row?.name && row.classTag) classByName[row.name] = row.classTag;
    }

    const run = taken() || {};
    const rows = (run.players || []).map((row) => ({
        name: row.name,
        value: (which === 'healed' ? row.regen : row.damage) || 0,
        perSecond: (which === 'healed' ? row.hps : row.dps) ?? null,
        classTag: classByName[row.name] || null,
    }));
    return rankRows(rows, run.seconds || 0);
}

/**
 * The class chip for one row: the T95 weapon of the inferred role, or a dim
 * text chip when the icon cannot be resolved, or nothing when there is no
 * verdict yet.
 * @param {Object|null} verdict - A row's `classTag`, from `inferClass`
 * @returns {string} HTML, possibly empty
 */
export function classTagHTML(verdict) {
    const label = String(verdict?.short || '').replace(/[^A-Z]/g, '');
    if (!label) return '';

    const title = `${label} — inferred from what this player was seen casting this run.`;
    const icon = classTagIconHTML(verdict, { title, size: 13 });
    if (icon) return icon;

    const { dim } = BOARD_COLORS;
    return (
        `<span title="${title}" style="color:${dim}; font-size:9px; letter-spacing:0.5px; ` +
        `border:1px solid ${dim}; border-radius:3px; padding:0 3px;">${label}</span>`
    );
}

/** What each tab's figures are, said once at the top rather than per row */
const NOTES = {
    damage: {
        strong: 'Attributed off this client’s own battle feed.',
        color: BOARD_COLORS.good,
        detail:
            'Damage is inferred from health lost between combat ticks — the game sends no damage figure — so ' +
            'overkill is not counted and a tick two players both hit on is shared between them. Includes ' +
            'damage-over-time and reflect, which move health with no swing behind them.',
    },
    taken: {
        strong: 'Health actually lost, after mitigation.',
        color: BOARD_COLORS.warn,
        detail:
            'A floor rather than a total: damage healed back on the same tick was never visible. This is not the ' +
            'game’s pre-mitigation figure and the two do not match by design.',
    },
    healed: {
        strong: 'Health restored — received, not healing done.',
        color: BOARD_COLORS.accent,
        detail:
            'A heal, a life-steal and the zone’s own regeneration are one number here, because nothing on the ' +
            'wire separates them. Ranking this does not say who healed: the run feed carries no caster to credit ' +
            'a rise to, and inventing one would be worse than saying so.',
    },
};

/**
 * The panel's contents as plain text, for the clipboard.
 * @param {string} which - A key of {@link TABS}
 * @param {Object} [sources] - As {@link panelRows}
 * @returns {string}
 */
export function panelText(which, sources) {
    const { rows, total, perSecond, seconds } = panelRows(which, sources);
    const label = which === 'healed' ? 'health restored' : which === 'taken' ? 'damage taken' : 'damage';

    if (!rows.length) return `Party ${label}: nothing measured yet.`;

    const heading =
        `Party ${label} — ${formatWithSeparator(Math.round(total))} total` +
        (perSecond === null ? '' : `, ${formatWithSeparator(Math.round(perSecond))}/s`) +
        ` over ${Math.round(seconds)}s (attributed from this client’s battle feed)`;
    return boardLines(heading, rows);
}

/**
 * Draw the board into a panel body.
 *
 * Takes the body rather than reaching for it, so a test can hand it a bare
 * `<div>` and read what came out.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} [sources] - As {@link panelRows}
 */
export function drawBoard(body, sources) {
    const { rows, total, perSecond } = panelRows(tab, sources);
    const note = NOTES[tab] || NOTES.damage;
    const unit = tab === 'healed' ? 'hps' : 'dps';

    const list = rows.length
        ? rows.map((row) => boardRowHTML(row, { tagHTML: classTagHTML(row.classTag) })).join('')
        : `<div style="color:${BOARD_COLORS.dim}; padding:6px 0; line-height:1.5;">` +
          'Nothing measured yet — the table fills in as the fight goes on. A run that has only just started has ' +
          'no seconds to divide by, which is why a rate can be dashed while a total is not.</div>';

    body.innerHTML =
        boardHeadHTML({
            value: perSecond,
            label: `party ${unit}`,
            right: total,
            color: BOARD_COLORS.accent,
        }) +
        boardTabsHTML(TABS, tab) +
        boardNoteHTML(note.strong, { color: note.color, strong: true }) +
        boardNoteHTML(note.detail) +
        list +
        boardButtonsHTML([{ key: 'copy', label: 'Copy stats' }]);

    body.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            tab = button.dataset.tab;
            drawBoard(body, sources);
        });
    });
    body.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
        navigator.clipboard?.writeText?.(panelText(tab, sources))?.catch?.(() => {});
    });
}

/** The panel shell, built the first time the feature is switched on */
let panel = null;

/**
 * The panel, created on demand.
 *
 * Built lazily rather than at import, because `createPanel` reopens a panel
 * that was left open when the page was last closed — and a panel whose setting
 * is off must not come back on its own. Creating it inside `initialize` puts
 * that behind the setting without a second switch to keep in step.
 *
 * @returns {Object} The shell, with `show`, `hide` and `toggle`
 */
export function getPanel() {
    if (panel) return panel;

    panel = createPanel({
        id: PANEL_ID,
        title: 'Party damage',
        size: { width: 320, height: 360 },
        accent: BOARD_COLORS.accent,
        draw: (body) => {
            // The shell's body is a flex column with a gap; the board is one
            // block that manages its own spacing, as it does in the trial panel
            body.style.display = 'block';
            body.style.padding = '8px 10px';
            drawBoard(body);
        },
    });
    return panel;
}

let unregister = null;

/** The re-inject timer; cleared in cleanup */
const timers = createTimerRegistry();

/**
 * Put the opener on the battle panel, beside the party's tiles.
 *
 * The trial side lives its equivalent in the In Progress header, which is where
 * somebody watching a trial already is. The equivalent place for a normal fight
 * is the fight itself — a control on the combat page rather than a settings
 * round-trip. Re-injected on a DOM observer for the same reason the badges are:
 * React throws the battle panel away whenever the Combat tab is left and
 * returned to, and an anchor captured once is stale with nothing to notice it.
 */
/** Whether an element sits inside the guild panel — a trial's battle, not the party's */
function inGuildPanel(element) {
    return Boolean(element?.closest?.('[class*="GuildPanel"]'));
}

function inject() {
    if (typeof document === 'undefined') return;
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
        // A button that landed in the trial's battle panel (In Progress tab)
        // comes back out: the trial has its own per-player board
        if (inGuildPanel(existing)) existing.remove();
        else return;
    }

    // The party's own battle, never the guild trial's: that panel renders the
    // same players area inside the Guild tab and has a scoreboard of its own
    const area =
        Array.from(document.querySelectorAll(PLAYERS_AREA)).find((el) => !inGuildPanel(el)) ||
        Array.from(document.querySelectorAll(GAME.BATTLE_PANEL)).find((el) => !inGuildPanel(el));
    if (!area) return;

    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.textContent = 'Per-player';
    button.title = 'Damage, damage taken and health restored per party member, ranked.';
    button.style.cssText =
        'position:absolute; top:2px; right:2px; z-index:5; padding:1px 6px; border-radius:4px;' +
        `border:1px solid ${BOARD_COLORS.accent}66; background:rgba(18,20,28,0.85); color:${BOARD_COLORS.accent};` +
        'font-size:10px; line-height:1.4; cursor:pointer;';
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        getPanel().toggle();
    });

    // Absolute to the tile area, or it escapes to whatever the nearest
    // positioned ancestor happens to be
    if (!area.style.position) area.style.position = 'relative';
    area.appendChild(button);
}

export default {
    name: 'Combat DPS Panel',
    initialize: () => {
        if (!config.getSetting('combatDpsPanel')) return;
        if (unregister) return;
        // Building the shell here is also what lets it reopen where it was
        // left, since that is `createPanel`'s doing
        getPanel();
        unregister = domObserver.onClass('CombatDpsPanel', ['BattlePanel_playersArea'], inject, {
            debounce: true,
            debounceDelay: 200,
            debounceMaxWait: 1000,
        });
        inject();
        timers.registerInterval(setInterval(inject, REINJECT_MS));
    },
    cleanup: () => {
        try {
            unregister?.();
            unregister = null;
            timers.clearAll();
            const button = typeof document === 'undefined' ? null : document.getElementById(BUTTON_ID);
            // The tile area was made a positioning context for the button's
            // sake; a game-owned element should not keep that once it is gone
            const area = button?.parentElement;
            button?.remove();
            if (area?.style?.position === 'relative') area.style.position = '';
            // Not remembered: switching the feature off is not the same as
            // closing the panel, and it must not be recorded as one
            panel?.hide({ remember: false });
            panel = null;
        } catch (error) {
            console.error('[Combat DPS Panel] Disable failed part-way:', error);
        }
    },
    /** For tests, and for a settings change that wants the board now */
    getPanel,
    /** Reset the remembered tab — for tests, which must not inherit one */
    _resetTab: () => {
        tab = 'damage';
    },
};
