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
 * ## Three tabs, and healing is on two of them as different things
 *
 * - **Damage** — `damageBreakdown()`. Per player, including damage-over-time
 *   and reflect, which move a monster's health with no swing behind them.
 * - **Taken** — `takenBreakdown()`. Health actually lost, after mitigation, and
 *   a floor at that: damage healed on the same tick was never visible. Each row
 *   also carries the taken tracker's `regen` — every rise on that player's own
 *   bar, whatever caused it: healing **received** — and the net of the two.
 * - **Healing done** — `damageBreakdown().healing`: only the rises a heal cast,
 *   a life-steal or a Bloom proc accounts for, on the player who did it
 *   (`utils/healing-done.js`). Everything else is one team line.
 *
 * A separate Healed tab once ranked healing received on its own; `healed` is
 * still read as Taken wherever a caller names it.
 *
 * ## And a tab that is not about the party at all
 *
 * - **Rotation** — your own abilities, from `rotation-tracker.js`. Three tabs of
 *   "who is carrying this" answer nothing you can act on mid-fight; the one
 *   thing you can change is your own bar, and the question there is per ability
 *   rather than per player: which of them fire, which are ready and cannot be
 *   paid for, and what each one buys per cast, per point of mana and per second
 *   of the cooldown it occupies. The starvation arithmetic is the guild trial
 *   support module's, generalised in `utils/rotation-audit.js` rather than
 *   written twice. Its third scope, History, is the tracker's ring of finished
 *   fights: a session average hides the wave the bar ran dry on, and the fight
 *   scope has already been cleared by the time you look at it.
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
import { damageBreakdown, actionLabel } from './damage-tracker.js';
import { takenBreakdown } from './damage-taken-tracker.js';
import { rotationAudit, startRotationTracker, stopRotationTracker } from './rotation-tracker.js';
import { dpsGraphHTML, startDpsSampler, stopDpsSampler, wireDpsGraph } from './dps-graph.js';
import { savedCombatGraphHTML, startCombatHistory, stopCombatHistory, wireSavedCombatGraph } from './combat-history.js';
import {
    cachedHistoryIndex,
    ensureHistoryLoaded,
    entryHeading,
    historyEnabled,
    historyListHTML,
    historyUiState,
    savedBannerHTML,
    wireHistoryList,
} from './meter-history.js';
import { createPanel } from '../../utils/simple-panel.js';
import { BLOOM_HEAL_PREFIX, LIFESTEAL_HEAL } from '../../utils/healing-done.js';
import {
    BOARD_COLORS,
    boardButtonsHTML,
    boardHeadHTML,
    boardNoteHTML,
    boardRowHTML,
    boardTabsHTML,
    boardLines,
    escapeText,
    rankRows,
} from '../../utils/damage-board.js';
import { classTagIconHTML } from '../../utils/class-weapon.js';
import { MIN_SECONDS } from '../../utils/rotation-audit.js';
import { closePlayerMenu, playerMarkersHTML, playerRowColor, wirePlayerMenu } from '../../utils/player-menu.js';
import { resolveRosterColors } from '../../utils/player-colors.js';
import { formatKMB, formatWithSeparator, formatDateTime } from '../../utils/formatters.js';
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
/** How often the timer may scan the document for a battle panel nothing told it about */
const DISCOVERY_MS = 10000;

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
    { key: 'healing', label: 'Healing done' },
    { key: 'rotation', label: 'Rotation' },
];

/** Which tab is showing. Remembered between openings, the way a panel should */
let tab = 'damage';

/**
 * Which scope the Rotation tab shows: the fight on screen, or the whole run.
 * The run by default — a fight can be two seconds long, and a tab that empties
 * itself every two seconds reads as a tab that keeps resetting
 */
let scope = 'session';

/**
 * The Rotation tab's scopes, in display order.
 *
 * `history` is not a summary like the other two: it draws the tracker's ring of
 * finished fights, one row each, and answers *which* fight rather than what the
 * run averages to.
 */
export const ROTATION_SCOPES = [
    { key: 'fight', label: 'This fight' },
    { key: 'session', label: 'Session' },
    { key: 'history', label: 'History' },
];

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
    // The Rotation tab is not a ranked board of players: its rows are your own
    // abilities and it builds them itself
    if (which === 'rotation') return rankRows([], 0);
    if (which === 'healed') return panelRows('taken', { dealt, taken });

    const dealtRun = dealt() || {};
    if (which === 'damage') {
        const board = rankRows(
            (dealtRun.players || []).map((row) => ({
                name: row.name,
                value: row.damage || 0,
                perSecond: row.dps ?? null,
                classTag: row.classTag || null,
                kills: row.kills ?? null,
                detail:
                    row.kills > 0 ? `${formatWithSeparator(row.kills)} ${row.kills === 1 ? 'kill' : 'kills'}` : null,
                breakdown: breakdownLines(
                    (row.abilities || []).map((ability) => {
                        const swings = (ability.hits || 0) + (ability.misses || 0);
                        return {
                            label: breakdownLabel(ability.action),
                            value: ability.damage,
                            // Damage-over-time and a reflect have no swing behind them
                            detail:
                                swings > 0
                                    ? `${formatWithSeparator(Math.round(ability.hits || 0))} hits · ` +
                                      `${percent(ability.hits > 0 ? (ability.crits || 0) / ability.hits : null)} crit · ` +
                                      `${percent((ability.hits || 0) / swings)} accuracy`
                                    : 'no swing behind it',
                        };
                    }),
                    row.damage,
                    dealtRun.seconds
                ),
            })),
            dealtRun.seconds || 0
        );
        // Everything the monsters lost, which the rows fall short of by what
        // nobody could be credited with and what the non-damaging filter keeps
        // out — both named, so the headline and the rows reconcile
        const team = dealtRun.team;
        if (team?.damage > 0) {
            board.team = team.damage;
            board.teamPerSecond = board.seconds > 0 ? team.damage / board.seconds : null;
            board.unattributed = team.unattributed || 0;
            board.filtered = team.filtered || 0;
        }
        return board;
    }

    // The taken tracker knows nothing about casts, so the class comes from the
    // dealt side by name — the same party, keyed differently
    const classByName = {};
    for (const row of dealtRun.players || []) {
        if (row?.name && row.classTag) classByName[row.name] = row.classTag;
    }

    if (which === 'healing') {
        const healing = dealtRun.healing || {};
        const board = rankRows(
            (healing.players || []).map((row) => ({
                name: row.name,
                value: row.healing || 0,
                perSecond: row.hps ?? null,
                classTag: row.classTag || classByName[row.name] || null,
                breakdown: breakdownLines(
                    (row.abilities || []).map((ability) => ({
                        label: breakdownLabel(ability.action),
                        value: ability.healing,
                    })),
                    row.healing,
                    dealtRun.seconds
                ),
            })),
            dealtRun.seconds || 0
        );
        board.regen = healing.regen || 0;
        // Absent from a session saved before healing was credited strictly
        board.uncredited = healing.uncredited || 0;
        board.revived = healing.revived || 0;
        board.shared = healing.shared || 0;
        return board;
    }

    const run = taken() || {};
    const rows = (run.players || []).map((row) => {
        const received = Number(row.regen) || 0;
        const net = received - (Number(row.damage) || 0);
        return {
            name: row.name,
            value: row.damage || 0,
            perSecond: row.dps ?? null,
            classTag: classByName[row.name] || null,
            received,
            net,
            detail: `received ${formatKMB(Math.round(received))} · net ${signedFigure(net, formatKMB)}`,
            // What hit them, from the taken tracker's per-monster split
            breakdown: breakdownLines(
                (run.enemies || []).flatMap((enemy) =>
                    (enemy.players || [])
                        .filter((hit) => hit.name === row.name)
                        .map((hit) => ({
                            label: enemy.name,
                            value: hit.damage,
                            detail:
                                `${formatWithSeparator(hit.hits || 0)} hits` +
                                (hit.min === null || hit.min === undefined
                                    ? ''
                                    : ` · ${formatWithSeparator(hit.min)}–${formatWithSeparator(hit.max)} a hit`),
                        }))
                ),
                row.damage,
                run.seconds
            ),
        };
    });
    const board = rankRows(rows, run.seconds || 0);
    // The party's, including anyone who received healing and took nothing
    board.received = (run.players || []).reduce((sum, row) => sum + (Number(row.regen) || 0), 0);
    board.net = board.received - (run.players || []).reduce((sum, row) => sum + (Number(row.damage) || 0), 0);
    return board;
}

/**
 * A figure with its sign, for a net.
 * @param {number} value - The figure
 * @param {Function} format - How to draw its size
 * @returns {string} `+1.2K`, `−300`, or `0`
 */
function signedFigure(value, format) {
    const rounded = Math.round(Number(value) || 0);
    if (rounded === 0) return '0';
    return `${rounded > 0 ? '+' : '−'}${format(Math.abs(rounded))}`;
}

/** The healing done tab's team line: everything no heal, life-steal or Bloom accounts for */
const NOT_FROM_A_CAST = 'Not from a cast — regeneration, food, unexplained';

/**
 * The lines under a healing done or taken board that are the party's rather than any row's.
 * @param {string} which - A key of {@link TABS}
 * @param {Object} board - From {@link panelRows}
 * @returns {Array<[string, string]>} Name and the figure as printed
 */
function partyLines(which, board) {
    if (which === 'healing') {
        const outside = (board?.regen || 0) + (board?.uncredited || 0);
        return outside >= 1 ? [[NOT_FROM_A_CAST, formatWithSeparator(Math.round(outside))]] : [];
    }
    if ((which === 'taken' || which === 'healed') && board?.rows?.length) {
        return [
            ['Healing received', formatWithSeparator(Math.round(board.received || 0))],
            ['Net', signedFigure(board.net, formatWithSeparator)],
        ];
    }
    return [];
}

/**
 * Which rows are open, as `tab:name`. Kept across redraws — the panel repaints
 * every couple of seconds, and a row that shuts itself while it is being read
 * is worse than one that never opened.
 */
const expanded = new Set();

/** Words for the action keys that are this codebase's markers rather than hrids */
const BREAKDOWN_LABELS = {
    dot: 'Damage over time',
    reflect: 'Reflect',
    [LIFESTEAL_HEAL]: 'Life steal (auto-attacks)',
    // No longer written; still in sessions saved before healing was credited strictly
    shared: 'Split — no caster on the tick',
    other: 'No cast on the tick',
};

/**
 * @param {string} action - An ability hrid or one of the markers
 * @returns {string} Something readable
 */
function breakdownLabel(action) {
    const text = String(action);
    if (text.startsWith(BLOOM_HEAL_PREFIX)) return `Bloom (via ${actionLabel(text.slice(BLOOM_HEAL_PREFIX.length))})`;
    return BREAKDOWN_LABELS[action] || actionLabel(action);
}

/**
 * One row's breakdown, biggest first, each line's share of the row's own total.
 *
 * @param {Array<{label: string, value: number, detail?: string}>} entries - Unranked lines
 * @param {number} total - The row's own figure
 * @param {number} seconds - The measurement window
 * @returns {Array<{label: string, value: number, detail: string|null, perSecond: number|null, share: number|null}>}
 */
export function breakdownLines(entries, total, seconds) {
    return (entries || [])
        .filter((entry) => Number(entry?.value) > 0 || entry?.detail)
        .map((entry) => ({
            label: entry.label,
            value: Number(entry.value) || 0,
            detail: entry.detail || null,
            perSecond: seconds > 0 ? (Number(entry.value) || 0) / seconds : null,
            share: total > 0 ? ((Number(entry.value) || 0) / total) * 100 : null,
        }))
        .sort((a, b) => b.value - a.value);
}

/**
 * A board row that opens into its breakdown, or the plain row when there is
 * nothing to break it into.
 *
 * @param {Object} row - From {@link panelRows}
 * @param {string} which - The tab it is drawn on
 * @returns {string} HTML
 */
function expandableRowHTML(row, which) {
    // Player colours and class overrides — utils/player-menu.js
    const tagHTML = playerMarkersHTML(row.name, row.classTag, classTagHTML);
    const color = playerRowColor(row.name, BOARD_COLORS.accent);
    if (!row.breakdown?.length) return boardRowHTML(row, { tagHTML, color });

    const key = `${which}:${row.name}`;
    const open = expanded.has(key);
    const { accent, dim } = BOARD_COLORS;
    const chevron = `<span aria-hidden="true" style="color:${dim}; font-size:9px;">${open ? '▾' : '▸'}</span>`;
    const what = which === 'taken' ? 'monster' : 'ability';

    const lines = open
        ? `<div data-breakdown="${escapeText(key)}" style="margin:0 0 6px 14px; padding:1px 6px; ` +
          `border-left:2px solid ${accent}66;">` +
          row.breakdown
              .map(
                  (line) =>
                      `<div style="padding:2px 0;">` +
                      `<div style="display:flex; gap:6px; align-items:baseline; font-size:10.5px;">` +
                      `<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
                      `${escapeText(line.label)}</span>` +
                      `<span style="margin-left:auto; white-space:nowrap;">${formatKMB(Math.round(line.value))}` +
                      ` · ${line.perSecond === null ? '—' : formatKMB(Math.round(line.perSecond))}/s` +
                      ` · ${line.share === null ? '—' : `${line.share.toFixed(1)}%`}</span></div>` +
                      (line.detail
                          ? `<div style="color:${dim}; font-size:9.5px;">${escapeText(line.detail)}</div>`
                          : '') +
                      `</div>`
              )
              .join('') +
          `</div>`
        : '';

    return (
        `<div data-expand="${escapeText(key)}" role="button" tabindex="0" aria-expanded="${open}" ` +
        `title="Click for the per-${what} breakdown" style="cursor:pointer;">` +
        boardRowHTML(row, { tagHTML: tagHTML + chevron, color }) +
        `</div>` +
        lines
    );
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
            'Damage is inferred from health lost between combat ticks — the game sends no damage figure. The ' +
            'hit goes to whoever’s attack counter rose, then whoever is alone on the tick, then whoever’s mana ' +
            'fell; overkill is not counted, and a tick nothing else can separate is split evenly only in a ' +
            'crowd. Includes damage-over-time and reflect, which move health with no swing behind them.',
    },
    taken: {
        strong: 'Health lost after mitigation, beside the healing each player received.',
        color: BOARD_COLORS.warn,
        detail:
            'Taken is a floor: damage healed back on the same tick was never visible, and it is not the game’s ' +
            'pre-mitigation figure. Received is every rise on that player’s own bar — heals, life-steal, ' +
            'regeneration, food — except revives; net is received minus taken. A tick with no attacker of its ' +
            'own is listed as damage over time. Healing done says who healed.',
    },
    healing: {
        strong: 'Healing done — credited only where the feed shows who did it.',
        color: BOARD_COLORS.good,
        detail:
            'A rise goes to a healing ability cast on that tick, to life-steal on the hitter’s own bar (auto-attacks ' +
            'with Life Steal on the sheet, or a draining ability like Life Drain), or to a Bloom proc on the ' +
            'lowest-health ally when a Bloom wearer cast an ability. Regeneration, food and anything unexplained ' +
            'go on one team line below, on nobody’s row; revives are left out.',
    },
};

/** The ink each verdict is drawn in — the two that want acting on stand out */
const VERDICT_COLORS = {
    starved: BOARD_COLORS.warn,
    pinched: BOARD_COLORS.warn,
    idle: BOARD_COLORS.dim,
    fine: BOARD_COLORS.good,
    unknown: BOARD_COLORS.dim,
    measuring: BOARD_COLORS.dim,
};

/**
 * A figure or an em dash — never a zero standing in for "nothing to divide by".
 * @param {number|null} value - The figure
 * @param {Function} [format] - How to draw it
 * @returns {string}
 */
function figure(value, format = (n) => formatKMB(Math.round(n))) {
    return value === null || value === undefined || !Number.isFinite(value) ? '—' : format(value);
}

/** @param {number|null} share - 0..1 @returns {string} A percentage or a dash */
function percent(share) {
    return share === null || share === undefined || !Number.isFinite(share) ? '—' : `${Math.round(share * 100)}%`;
}

/**
 * One ability's row: what it produced, what it cost, and whether it fires.
 *
 * The bar behind it is **uptime**, not a share of damage — this tab ranks by
 * whether an ability is in the rotation at all, and a heavy ability cast twice
 * would otherwise draw a longer bar than the one holding the fight together.
 *
 * @param {Object} row - From `summariseRotation`
 * @returns {string} HTML
 */
export function rotationRowHTML(row) {
    const { dim } = BOARD_COLORS;
    const color = VERDICT_COLORS[row?.verdict?.kind] || BOARD_COLORS.accent;
    const width = Math.max(2, Math.min(100, (row?.uptime ?? 0) * 100));

    const perMana = row.damagePerMana === null ? '—' : formatKMB(Math.round(row.damagePerMana * 10) / 10);
    const perCooldown = figure(row.damagePerCooldownSecond);
    const detail =
        `${formatWithSeparator(row.casts)} casts · ${figure(row.outputPerCast)}/cast · ${perMana}/mana · ` +
        `${perCooldown}/cd-s · starved ${percent(row.starvedShare)} of ready`;

    return (
        `<div style="position:relative; margin:3px 0; padding:3px 6px; border-radius:3px;` +
        `background:linear-gradient(to right, ${color}44 ${width}%, rgba(255,255,255,0.04) ${width}%);">` +
        `<div style="display:flex; gap:6px; align-items:baseline;">` +
        `<span style="font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
        `${escapeText(actionLabel(row.hrid))}</span>` +
        (row.equipped && row.casts === 0
            ? `<span style="color:${dim}; font-size:9px; border:1px solid ${dim}; border-radius:3px; padding:0 3px;"` +
              ` title="On the bar and never seen firing this scope.">slotted</span>`
            : '') +
        `<span style="margin-left:auto; color:${color}; font-weight:600;">${percent(row.uptime)}</span>` +
        `</div>` +
        `<div style="color:${dim}; font-size:10px;">${escapeText(detail)}</div>` +
        `<div style="color:${color}; font-size:10px; line-height:1.4;">${escapeText(row.verdict.text)}</div>` +
        `</div>`
    );
}

/**
 * The lines under the rows: what mana did over the scope, and the one change
 * the numbers point at.
 *
 * @param {Object} summary - From `summariseRotation`
 * @returns {string} HTML
 */
export function rotationSummaryHTML(summary) {
    const { dim, warn, good } = BOARD_COLORS;
    const balance = summary.manaBalance;
    const balanceColor = balance === null ? dim : balance < 0 ? warn : good;

    const lines = [
        [
            'Mana',
            `${figure(summary.manaPerMinute)}/min spent · ${figure(summary.regenPerMinute)}/min restored`,
            balanceColor,
        ],
        [
            'Starved',
            summary.starvedSeconds === null
                ? '—'
                : `${summary.starvedSeconds.toFixed(1)}s per fight under the cheapest cast` +
                  (summary.castFloor === null ? '' : ` (${formatWithSeparator(summary.castFloor)} mana)`),
            summary.starvedSeconds > 0 ? warn : dim,
        ],
        [
            'Measured',
            `${summary.seconds.toFixed(0)}s of fighting over ${formatWithSeparator(summary.fights)} fights`,
            dim,
        ],
    ];

    const rows = lines
        .map(
            ([label, value, color]) =>
                `<div style="display:flex; gap:8px; font-size:11px; line-height:1.6;">` +
                `<span style="color:${dim};">${escapeText(label)}</span>` +
                `<span style="margin-left:auto; color:${color}; text-align:right;">${escapeText(value)}</span></div>`
        )
        .join('');

    const suggestion = summary.suggestion
        ? `<div style="margin-top:6px; padding:4px 6px; border-left:2px solid ${BOARD_COLORS.accent};` +
          ` color:${BOARD_COLORS.accent}; font-size:10px; line-height:1.5;">${escapeText(summary.suggestion.text)}</div>`
        : '';

    return `<div style="margin-top:8px;">${rows}${suggestion}</div>`;
}

/**
 * The summary a scope key names.
 *
 * `history` has none of its own — it is a list of fights, not an audit — so the
 * things that need a summary while it is showing (the variance copy, and the
 * head) read the session's, which is the scope the history is a slice of.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {Object|undefined} The summary
 */
function scopeSummary(audit, which) {
    if (which === 'history') return audit?.session || audit?.fight;
    return audit?.[which] || audit?.fight;
}

/**
 * One finished fight, as a history row.
 *
 * Two lines rather than an expander: the per-ability casts are the reason to
 * look at a history at all — "which fight was the one it stopped firing in" —
 * and a count behind a click is a count nobody reads.
 *
 * @param {Object} record - From `fightRecord`
 * @param {number} index - Its place in the buffer, newest first
 * @returns {string} HTML
 */
export function rotationHistoryRowHTML(record, index) {
    const { dim, warn } = BOARD_COLORS;
    const manaPerMinute = record.seconds > 0 ? (record.manaSpent / record.seconds) * 60 : null;
    const casts = record.abilities.length
        ? record.abilities.map((row) => `${actionLabel(row.hrid)} ${row.casts}`).join(' · ')
        : 'no casts seen';

    return (
        `<div style="margin:3px 0; padding:3px 6px; border-radius:3px; background:rgba(255,255,255,0.04);">` +
        `<div style="display:flex; gap:6px; align-items:baseline; font-size:11px;">` +
        `<span style="color:${dim}; width:22px;">#${index + 1}</span>` +
        `<span style="font-weight:600;">${record.seconds.toFixed(0)}s</span>` +
        `<span style="color:${dim};">${formatWithSeparator(record.casts)} casts</span>` +
        `<span style="margin-left:auto; color:${dim};">${figure(manaPerMinute)} mana/min</span>` +
        `<span style="color:${record.starvedSeconds > 0 ? warn : dim}; width:56px; text-align:right;">` +
        `starved ${record.starvedSeconds.toFixed(1)}s</span>` +
        `</div>` +
        `<div style="color:${dim}; font-size:10px; line-height:1.4;">${escapeText(casts)}</div>` +
        `</div>`
    );
}

/**
 * The History scope's body: the finished fights, newest first.
 *
 * @param {Array<Object>} history - From `rotationAudit`
 * @returns {string} HTML
 */
export function rotationHistoryHTML(history) {
    const fights = Array.isArray(history) ? history : [];

    return (
        boardNoteHTML('The last fights, newest first — one row each.', {
            color: BOARD_COLORS.good,
            strong: true,
        }) +
        boardNoteHTML(
            `Kept in memory only, for this character and this session: switching character or resetting the run ` +
                `empties it. A fight shorter than ${MIN_SECONDS}s is left out, because every figure over it is one ` +
                'lucky swing rather than a measurement. The second line is what fired, and how often.'
        ) +
        (fights.length
            ? fights.map(rotationHistoryRowHTML).join('')
            : boardNoteHTML('No finished fights yet — a fight is recorded when the next one begins.'))
    );
}

/**
 * The history as plain text, one line per fight.
 * @param {Array<Object>} history - From `rotationAudit`
 * @returns {string}
 */
export function rotationHistoryText(history) {
    const fights = Array.isArray(history) ? history : [];
    const head = `Rotation history — the last ${fights.length} fights, newest first`;
    if (!fights.length) return `${head}\nNo finished fights recorded yet.`;

    const lines = fights.map((record, index) => {
        const manaPerMinute = record.seconds > 0 ? (record.manaSpent / record.seconds) * 60 : null;
        const casts = record.abilities.map((row) => `${actionLabel(row.hrid)} ${row.casts}`).join(', ') || 'none';
        return (
            `#${index + 1}: ${record.seconds.toFixed(0)}s, ${record.casts} casts, ` +
            `${figure(manaPerMinute)} mana/min spent, starved ${record.starvedSeconds.toFixed(1)}s — ${casts}`
        );
    });

    return [head, ...lines].join('\n');
}

/**
 * The Rotation tab's whole body.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string} HTML
 */
export function rotationHTML(audit, which) {
    const summary = scopeSummary(audit, which);
    const { dim } = BOARD_COLORS;

    const scopes =
        `<div style="display:flex; gap:6px; margin:6px 0;">` +
        ROTATION_SCOPES.map((entry) => {
            const on = entry.key === which;
            const color = on ? BOARD_COLORS.accent : dim;
            return (
                `<button data-scope="${entry.key}" style="flex:1; cursor:pointer; padding:2px 0; border-radius:4px;` +
                ` border:1px solid ${color}66; background:${on ? `${color}22` : 'transparent'}; color:${color};` +
                ` font-size:10px;">${entry.label}</button>`
            );
        }).join('') +
        `</div>`;

    // The history stands on its own: it needs no slot to have been named — a
    // fight it recorded already had one — and it has no verdicts to draw
    if (which === 'history') return scopes + rotationHistoryHTML(audit?.history);

    if (!audit?.tracking) {
        // Rows can exist before a battle names the slot — a previous session's
        // kit, or a loadout read ahead of the first fight. Throwing them away
        // and showing only the notice loses the one thing worth reading, so the
        // notice goes *above* whatever has been seeded rather than instead of it
        const seeded = summary?.abilities?.length
            ? summary.abilities.map(rotationRowHTML).join('')
            : boardNoteHTML('Nothing on the bar yet.');

        return (
            scopes +
            boardNoteHTML('Waiting for a battle to name your slot.', { color: dim, strong: true }) +
            boardNoteHTML(
                'Your abilities are read from the loadout the game states for your own character at the start of a ' +
                    'battle, so nothing is measured until one begins. Nobody else’s row appears here — this tab is ' +
                    'about the bar you can change.'
            ) +
            seeded
        );
    }

    const rows = summary.abilities.length
        ? summary.abilities.map(rotationRowHTML).join('')
        : `<div style="color:${dim}; padding:6px 0; line-height:1.5;">Nothing on the bar yet.</div>`;

    return (
        boardHeadHTML({
            value: summary.manaPerMinute,
            label: 'mana/min spent',
            right: summary.measurable ? `${percent(summary.starvedShare)} starved` : '—',
            color: BOARD_COLORS.accent,
        }) +
        scopes +
        boardNoteHTML('Your own abilities: whether each one fires, and what it buys.', {
            color: BOARD_COLORS.good,
            strong: true,
        }) +
        boardNoteHTML(
            'Uptime is the share of the fight an ability spent on cooldown, against the cooldown the game states — ' +
                'haste is not on the wire, so a hasted ability reads low rather than being guessed at. “Starved” is ' +
                'time it was off cooldown with the bar below its cost: the ability could not fire, which is a ' +
                'different problem from the rotation never reaching it. Mana spent and restored are measured off ' +
                'the bar; per-ability mana is the stated cost times casts.'
        ) +
        rows +
        rotationSummaryHTML(summary) +
        (summary.incomplete
            ? boardNoteHTML('Some abilities state no mana cost, so the per-mana figures are a lower bound.')
            : '')
    );
}

/**
 * The Rotation tab as plain text, for the clipboard.
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string}
 */
export function rotationText(audit, which) {
    // The history is a record of fights that already happened, so it copies
    // whether or not a slot is named right now
    if (which === 'history') return rotationHistoryText(audit?.history);
    if (!audit?.tracking) return 'Rotation: waiting for a battle to name your slot.';

    const summary = audit[which] || audit.fight;
    const label = which === 'session' ? 'session' : 'this fight';
    const head =
        `Rotation (${label}) — ${summary.seconds.toFixed(0)}s over ${summary.fights} fights, ` +
        `${figure(summary.manaPerMinute)} mana/min spent against ${figure(summary.regenPerMinute)}/min restored, ` +
        `${summary.starvedSeconds === null ? '—' : `${summary.starvedSeconds.toFixed(1)}s`} per fight starved`;

    const rows = summary.abilities.map(
        (row) =>
            `${actionLabel(row.hrid)}: ${percent(row.uptime)} uptime, ${row.casts} casts, ` +
            `${figure(row.outputPerCast)}/cast, starved ${percent(row.starvedShare)} of ready — ${row.verdict.text}`
    );

    return [head, ...rows, summary.suggestion ? summary.suggestion.text : ''].filter(Boolean).join('\n');
}

/**
 * The gap between the bar the game states and what actually fired, as plain
 * text for the clipboard.
 *
 * Only the deviating rows are listed — the point of this copy is the variance,
 * not another full table. Three shapes qualify: an ability stated on the bar
 * that never fired, one seen firing that the game never stated, and one whose
 * own verdict already says it fires short of what it should (starved, idle,
 * pinched, or uncomputable). A row doing what its numbers promise is left off,
 * and an aura is skipped on the audit's own reasoning — cast once and kept up,
 * it has no cadence to vary from.
 *
 * @param {Object} audit - From `rotationAudit`
 * @param {string} which - A key of {@link ROTATION_SCOPES}
 * @returns {string}
 */
export function rotationVarianceText(audit, which) {
    if (!audit?.tracking) return 'Rotation variances: waiting for a battle to name your slot.';

    const summary = scopeSummary(audit, which);
    const label = which === 'fight' ? 'this fight' : 'session';
    const head =
        `Rotation variances (${label}) — the stated bar against what fired, ` +
        `over ${summary.seconds.toFixed(0)}s and ${summary.fights} fights`;

    const lines = [];
    for (const row of summary.abilities) {
        if (row.verdict.kind === 'aura') continue;
        const name = actionLabel(row.hrid);

        if (!row.equipped && row.casts > 0) {
            lines.push(`${name}: fired ${row.casts}x, but the game never stated it on the bar.`);
            continue;
        }
        if (row.equipped && row.casts === 0) {
            lines.push(`${name}: stated on the bar and never fired — ${row.verdict.text}`);
            continue;
        }
        if (row.verdict.kind === 'starved' || row.verdict.kind === 'idle' || row.verdict.kind === 'pinched') {
            // The casts its stated cooldown allowed, so the shortfall is a figure
            // rather than only a verdict
            const possible =
                row.cooldownSeconds > 0 && summary.seconds > 0
                    ? Math.floor(summary.seconds / row.cooldownSeconds)
                    : null;
            const cadence = possible !== null && possible > row.casts ? ` (≈${possible} allowed by cooldown)` : '';
            lines.push(`${name}: ${row.casts} casts${cadence} — ${row.verdict.text}`);
            continue;
        }
        if (row.verdict.kind === 'unknown' && row.casts > 0) {
            lines.push(`${name}: ${row.casts} casts — ${row.verdict.text}`);
        }
    }

    if (!lines.length) {
        return `${head}\nNo variances: everything the game states on the bar fired, at a cadence its cooldown allows.`;
    }
    return [head, ...lines].join('\n');
}

/**
 * The panel's contents as plain text, for the clipboard.
 * @param {string} which - A key of {@link TABS}
 * @param {Object} [sources] - As {@link panelRows}
 * @returns {string}
 */
export function panelText(which, sources) {
    if (which === 'rotation') return rotationText((sources?.audit || rotationAudit)(), scope);

    const board = panelRows(which, sources);
    const { rows, seconds } = board;
    const label =
        {
            healed: 'damage taken',
            healing: 'healing done',
            taken: 'damage taken',
        }[which] || 'damage';

    const party = partyLines(which, board);
    if (!rows.length) {
        const empty = `Party ${label}: nothing measured yet.`;
        return party.length ? [empty, ...party.map(([name, value]) => `${name}: ${value}`)].join('\n') : empty;
    }

    const total = board.team ?? board.total;
    const perSecond = board.team === undefined ? board.perSecond : board.teamPerSecond;
    const heading =
        `Party ${label} — ${formatWithSeparator(Math.round(total))} total` +
        (perSecond === null ? '' : `, ${formatWithSeparator(Math.round(perSecond))}/s`) +
        ` over ${Math.round(seconds)}s (attributed from this client’s battle feed)`;
    const reconcile = [
        ...reconcileParts(board).map(([name, value]) => `${name}: ${formatWithSeparator(Math.round(value))}`),
        ...party.map(([name, value]) => `${name}: ${value}`),
    ].join('\n');
    return boardLines(heading, rows) + (reconcile ? `\n${reconcile}` : '');
}

/**
 * A one-line note when the live run was carried over a page refresh.
 *
 * `damageBreakdown().restored` is set once, at the reload that adopted a saved
 * session (`damage-tracker.js`'s `adoptPendingRestore`), and never again until
 * the next refresh — so a reader watching the board fill back in after a
 * reload has something on screen saying *why* the numbers did not start at
 * zero, rather than wondering whether the run before the refresh is still
 * being counted. Never drawn for a saved History session: `savedSources`
 * marks those `saved: true`, and a saved board is a fixed snapshot that no
 * refresh of *this* page could have interrupted.
 *
 * @param {Object|null} dealtRun - From `damageBreakdown`
 * @returns {string} HTML, or '' when the run was not restored
 */
function restoredNoteHTML(dealtRun) {
    const at = dealtRun?.restored?.at;
    if (!Number.isFinite(at)) return '';
    // The house clock — whichever 12/24-hour reading the user's own settings
    // (or their device's own locale, on Automatic) say to draw
    const time = formatDateTime(new Date(at), { includeDate: false, includeSeconds: false });
    return boardNoteHTML(`Continued after a page refresh at ${escapeText(time)}.`, { color: BOARD_COLORS.dim });
}

/**
 * The parts of a damage board's team total that are not in its rows.
 * @param {Object} board - From {@link panelRows}
 * @returns {Array<[string, number]>} Name and amount, only the ones of a point or more
 */
function reconcileParts(board) {
    return [
        ['Unattributed', board?.unattributed],
        ['Filtered', board?.filtered],
    ].filter(([, value]) => value >= 1);
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
    // The Healed tab folded into Taken
    if (tab === 'healed') tab = 'taken';
    // Saved-session history — meter-history.js. A saved board carries its own
    // banner and graph; a live one offers the list
    const banner = sources?.bannerHTML || '';
    const historyButton = sources?.saved
        ? [{ key: 'history', label: 'History' }]
        : historyEnabled()
          ? [{ key: 'history', label: 'History' }]
          : [];
    // Live only — a saved session is a fixed snapshot no refresh interrupted
    const restored = sources?.saved ? '' : restoredNoteHTML((sources?.dealt || damageBreakdown)());

    if (tab === 'rotation') {
        body.innerHTML =
            banner +
            restored +
            boardTabsHTML(TABS, tab) +
            rotationHTML((sources?.audit || rotationAudit)(), scope) +
            boardButtonsHTML([
                { key: 'copy', label: 'Copy stats' },
                { key: 'copy-variance', label: 'Copy variances' },
                ...historyButton,
            ]);
        wireBoard(body, sources);
        return;
    }

    const board = panelRows(tab, sources);
    const { rows } = board;
    const total = board.team ?? board.total;
    const perSecond = board.team === undefined ? board.perSecond : board.teamPerSecond;
    const note = NOTES[tab] || NOTES.damage;
    const unit = tab === 'healing' ? 'hps' : 'dps';

    // Player colours and class overrides — utils/player-menu.js
    resolveRosterColors(rows.map((row) => row.name));

    // The headline is the team's; when the rows fall short of it, say by what
    const parts = reconcileParts(board);
    const reconcile = parts.length
        ? boardNoteHTML(
              `Team total ${formatWithSeparator(Math.round(total))} = the rows ` +
                  `${formatWithSeparator(Math.round(board.total))} + ` +
                  parts
                      .map(([name, value]) => `${name.toLowerCase()} ${formatWithSeparator(Math.round(value))}`)
                      .join(' + ') +
                  '. Unattributed is health lost on ticks no player could be credited with; filtered is credited ' +
                  'damage the DPs panel’s Filter Nondamage keeps out of the rows.',
              { color: BOARD_COLORS.warn }
          )
        : '';

    // What belongs to the party and no row: the uncredited healing, or what came back against what was lost
    const party = partyLines(tab, board);
    const partyNote = party.length
        ? boardNoteHTML(escapeText(party.map(([name, value]) => `${name}: ${value}`).join(' · ')), {
              color: tab === 'healing' ? BOARD_COLORS.warn : BOARD_COLORS.dim,
          })
        : '';

    const list = rows.length
        ? rows.map((row) => expandableRowHTML(row, tab)).join('')
        : `<div style="color:${BOARD_COLORS.dim}; padding:6px 0; line-height:1.5;">` +
          'Nothing measured yet — the table fills in as the fight goes on. A run that has only just started has ' +
          'no seconds to divide by, which is why a rate can be dashed while a total is not.</div>';

    body.innerHTML =
        banner +
        restored +
        boardHeadHTML({
            value: perSecond,
            label: `party ${unit}`,
            right: total,
            color: BOARD_COLORS.accent,
        }) +
        boardTabsHTML(TABS, tab) +
        // DPS-over-time graph — dps-graph.js, or the saved session's own
        (tab === 'damage' ? (sources?.graphHTML ? sources.graphHTML() : dpsGraphHTML()) : '') +
        boardNoteHTML(note.strong, { color: note.color, strong: true }) +
        boardNoteHTML(note.detail) +
        reconcile +
        partyNote +
        list +
        boardButtonsHTML([{ key: 'copy', label: 'Copy stats' }, ...historyButton]);

    wireBoard(body, sources);
}

/** Whether the panel is showing the saved-sessions list rather than a board */
let historyOpen = false;

/** The saved session drawn instead of the live board: `{entry, summary}`, or null */
let viewing = null;

/**
 * The sources a saved session redraws the board from, in place of the trackers.
 *
 * @param {Object} entry - A combat body from `combat-history.js`
 * @param {Object|null} [summary] - Its list summary, for the user's name
 * @returns {Object} Sources for {@link drawBoard} and {@link panelRows}
 */
export function savedSources(entry, summary = null) {
    const audit = entry?.audit || { tracking: false, fight: null, session: null, history: [] };
    return {
        saved: true,
        dealt: () => entry?.dealt || { seconds: 0, players: [] },
        taken: () => entry?.taken || { seconds: 0, players: [] },
        audit: () => audit,
        graphHTML: () => savedCombatGraphHTML(entry?.graph),
        bannerHTML: savedBannerHTML(entry, summary),
        wire: wireSavedCombatGraph,
    };
}

/**
 * A saved session as plain text: its heading, then damage, healing done and taken.
 * @param {Object} entry - A combat body
 * @param {Object|null} [summary] - Its list summary
 * @returns {string}
 */
export function savedEntryText(entry, summary = null) {
    const sources = savedSources(entry, summary);
    return [
        entryHeading(entry, summary),
        panelText('damage', sources),
        panelText('healing', sources),
        panelText('taken', sources),
    ].join('\n\n');
}

/**
 * The saved-sessions list, drawn into the panel body.
 * @param {HTMLElement} body - The panel body
 */
function drawHistoryList(body) {
    const redraw = () => {
        if (body.isConnected) drawPanel(body);
    };
    const index = cachedHistoryIndex('combat');
    if (index === null) ensureHistoryLoaded('combat', redraw);

    body.innerHTML =
        historyListHTML(index, { type: 'combat', ...historyUiState('combat') }) +
        boardButtonsHTML([{ key: 'live', label: 'Back to live', color: BOARD_COLORS.accent }]);

    wireHistoryList(body, {
        type: 'combat',
        redraw,
        onOpen: (entry, summary) => {
            if (!historyOpen) return;
            historyOpen = false;
            viewing = { entry, summary };
            expanded.clear();
            redraw();
        },
        copyText: savedEntryText,
    });
    body.querySelectorAll('[data-action="live"]').forEach((button) => {
        button.addEventListener('click', () => {
            historyOpen = false;
            viewing = null;
            drawPanel(body);
        });
    });
}

/**
 * Draw whatever the panel is showing: the live board, a saved session, or the list.
 * @param {HTMLElement} body - The panel body
 */
export function drawPanel(body) {
    if (historyOpen) {
        drawHistoryList(body);
        return;
    }
    if (viewing) {
        drawBoard(body, savedSources(viewing.entry, viewing.summary));
        return;
    }
    drawBoard(body);
}

/**
 * Attach the tab strip, the Rotation tab's scope switch and the copy button.
 *
 * One function for both branches of {@link drawBoard}: a tab that wired its own
 * buttons is a tab that can forget one, and the Rotation tab did not exist when
 * the wiring lived inline.
 *
 * @param {HTMLElement} body - The board's container
 * @param {Object} [sources] - As {@link panelRows}
 */
function wireBoard(body, sources) {
    // Player colour and class menu — utils/player-menu.js
    wirePlayerMenu(body, () => drawBoard(body, sources));
    if (sources?.wire) sources.wire(body, () => drawBoard(body, sources));
    else wireDpsGraph(body, () => drawBoard(body, sources));
    // Saved-session history — meter-history.js
    body.querySelector('[data-action="history"]')?.addEventListener('click', () => {
        historyOpen = true;
        viewing = null;
        expanded.clear();
        drawPanel(body);
    });
    body.querySelectorAll('[data-action="live"]').forEach((button) => {
        button.addEventListener('click', () => {
            historyOpen = false;
            viewing = null;
            expanded.clear();
            drawPanel(body);
        });
    });
    body.querySelectorAll('[data-tab]').forEach((button) => {
        button.addEventListener('click', () => {
            tab = button.dataset.tab;
            drawBoard(body, sources);
        });
    });
    body.querySelectorAll('[data-scope]').forEach((button) => {
        button.addEventListener('click', () => {
            scope = button.dataset.scope;
            drawBoard(body, sources);
        });
    });
    body.querySelectorAll('[data-expand]').forEach((element) => {
        const toggle = () => {
            const key = element.dataset.expand;
            if (expanded.has(key)) expanded.delete(key);
            else expanded.add(key);
            drawBoard(body, sources);
        };
        element.addEventListener('click', toggle);
        element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
        });
    });
    body.querySelector('[data-action="copy"]')?.addEventListener('click', () => {
        navigator.clipboard?.writeText?.(panelText(tab, sources))?.catch?.(() => {});
    });
    body.querySelector('[data-action="copy-variance"]')?.addEventListener('click', () => {
        navigator.clipboard
            ?.writeText?.(rotationVarianceText((sources?.audit || rotationAudit)(), scope))
            ?.catch?.(() => {});
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
            drawPanel(body);
        },
    });
    return panel;
}

let unregister = null;
let unregisterReady = null;

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

/** The button last injected, so the re-inject timer can tell "still there" cheaply */
let injected = null;

/**
 * The battle-panel area the button was last hung on.
 *
 * Out of combat there is no battle panel, and the timer below used to prove that
 * with two whole-document `[class*=]` scans every two seconds. Holding the area
 * the class watcher handed us turns "am I in a fight" into an `isConnected` read.
 */
let lastArea = null;

function inject() {
    if (typeof document === 'undefined') return;
    // The button already placed is the common case for the slow timer below;
    // it is answered off the cached element before any document query
    if (injected?.isConnected && !inGuildPanel(injected)) return;
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
    button.title = 'Damage, damage taken with healing received, and healing done per party member, ranked.';
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
    injected = button;
    lastArea = area;
}

/** When the last speculative scan for a missed battle panel was made */
let lastDiscoveryAt = 0;

/**
 * The timer's inject: nothing to do for a hidden tab.
 *
 * With a battle panel in hand this is the cheap path — `inject()` answers off the
 * cached button without touching the document. With nothing in hand the only way
 * to find a panel the class watcher missed is a pair of whole-document scans, and
 * that is the case that holds for hours at a time while nobody is fighting. So it
 * stays a safety net and drops to once every ten seconds.
 */
function reinject() {
    if (typeof document === 'undefined' || document.hidden) return;

    if (injected?.isConnected || lastArea?.isConnected) {
        inject();
        return;
    }

    const now = Date.now();
    if (now - lastDiscoveryAt < DISCOVERY_MS) return;
    lastDiscoveryAt = now;
    inject();
}

export default {
    name: 'Combat DPS Panel',
    initialize: () => {
        if (!config.getSetting('combatDpsPanel')) return;
        if (unregister) return;
        // Building the shell here is also what lets it reopen where it was
        // left, since that is `createPanel`'s doing
        getPanel();
        // The Rotation tab is the only reader of this, so it starts and stops
        // with the panel rather than carrying a setting of its own
        startRotationTracker();
        startDpsSampler();
        // Saved-session history — combat-history.js reads the trackers from outside
        startCombatHistory();
        const onArea = (el) => {
            if (el && !inGuildPanel(el)) lastArea = el;
            inject();
        };
        unregister = domObserver.onClass('CombatDpsPanel', ['BattlePanel_playersArea'], onArea, {
            debounce: true,
            debounceDelay: 200,
            debounceMaxWait: 1000,
        });
        // @run-at document-start: a battle panel rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up scan waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        unregisterReady = domObserver.onReady('CombatDpsPanelCatchUp', () => {
            inject();
            lastDiscoveryAt = Date.now();
        });
        timers.registerInterval(setInterval(reinject, REINJECT_MS));
    },
    cleanup: () => {
        try {
            unregister?.();
            unregister = null;
            unregisterReady?.();
            unregisterReady = null;
            // Before the rotation tracker stops: the run in hand is saved off
            // the last reading, which is the character's that is leaving
            stopCombatHistory();
            historyOpen = false;
            viewing = null;
            stopRotationTracker();
            stopDpsSampler();
            closePlayerMenu();
            timers.clearAll();
            const button = typeof document === 'undefined' ? null : document.getElementById(BUTTON_ID);
            injected = null;
            lastArea = null;
            // The tile area was made a positioning context for the button's
            // sake; a game-owned element should not keep that once it is gone
            const area = button?.parentElement;
            button?.remove();
            if (area?.style?.position === 'relative') area.style.position = '';
            // Released rather than hidden, because the handle goes with it and
            // `initialize()` builds a fresh shell. `hide()` leaves the shell's
            // `character_switched` subscription in place — which is right for a
            // panel that will be shown again through the same handle, and a leak
            // here: a character switch runs this teardown and then that init, so
            // every switch left another shell's listener on the bus with nothing
            // holding its handle. Not remembered, for the same reason as before:
            // switching the feature off is not the user closing the panel.
            panel?.destroy();
            panel = null;
        } catch (error) {
            console.error('[Combat DPS Panel] Disable failed part-way:', error);
        }
    },
    /** For tests, and for a settings change that wants the board now */
    getPanel,
    /** Reset the remembered tab and scope — for tests, which must not inherit either */
    _resetTab: () => {
        tab = 'damage';
        scope = 'session';
        expanded.clear();
        historyOpen = false;
        viewing = null;
    },
    /** Show a tab directly — for tests, which cannot click one */
    _setTab: (which, which2) => {
        tab = which;
        if (which2) scope = which2;
    },
};
