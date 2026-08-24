/**
 * Combat text
 *
 * Damage numbers over the units taking them, and a scrolling log of the same
 * events for anything that went past too fast to read.
 *
 * The game shows health bars. A bar tells you the state and not the event, so
 * "did that hit for 400 or 4,000" is a question you answer by watching the bar
 * move, which is exactly what a number over the unit is for.
 *
 * ## Both, from one derivation
 *
 * Floating text and a scrolling log are two renderings of one list of events, so
 * they share `utils/combat-events.js` and cannot disagree about what happened.
 * Either can be turned off on its own; with both off nothing subscribes.
 *
 * ## Why it is throttled
 *
 * A tick can carry a dozen events and ticks come several a second. Drawing every
 * one is a floating number per frame per unit, which is a lot of DOM for
 * something nobody can read anyway. The floating text draws the largest event
 * per unit per tick, which is the one worth seeing.
 *
 * The model is the Floating and Scrolling Combat Text tools' from MWI Combat
 * Suite by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import domObserver from '../../core/dom-observer.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { row, ROW_COLORS, GLYPHS, glyph } from '../../utils/overlay-format.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { healthDeltas, createCombatLog } from '../../utils/combat-events.js';
import { newAttributionState, noteActions, attributeTick } from '../../utils/damage-attribution.js';

const FLOATING_SETTING = 'combatText_floating';
const SCROLLING_SETTING = 'combatText_scrolling';
const FLOAT_CLASS = 'toolasha-floating-combat-text';
const FLOAT_MS = 1100;

/**
 * The battle panel's own unit tiles, which is what the numbers sit over.
 *
 * The `:not(...)` halves are load-bearing. `BattlePanel_monstersArea__…` and
 * `BattlePanel_playersArea__…` both contain `BattlePanel_monster` /
 * `BattlePanel_player` as substrings, so the plain prefix match also selected
 * the two *containers*. A container outlives the tiles inside it, so the cache's
 * freshness check ("is the first thing I held still in the document?") stayed
 * true across a re-render and every number after that was drawn onto detached
 * nodes; and the containers sat at the front of the list, so the index the
 * payload gives was one or two units off.
 */
const MONSTER_SELECTOR = '[class*="BattlePanel_monster"]:not([class*="BattlePanel_monstersArea"])';
const PLAYER_SELECTOR = '[class*="BattlePanel_player"]:not([class*="BattlePanel_playersArea"])';

const log = createCombatLog(200);
const enemyHealth = new Map();
const allyHealth = new Map();
let battleId = null;
let handler = null;
let newBattleHandler = null;
let unregisterArea = null;

/**
 * The unit tiles, held between ticks.
 *
 * `battle_updated` arrives several times a second, and re-running a whole-document
 * `[class*=]` query for tiles that only change when the battle panel re-renders is
 * the most expensive thing this feature did. The list is dropped when the battle
 * panel is rebuilt (the class watcher below), when a new battle starts, and when
 * the tiles it holds have left the document.
 */
let tileCache = null;

/**
 * Tiles that have already been given `position: relative`.
 *
 * Asking `getComputedStyle` per unit per tick forces a style recalculation for an
 * answer that cannot change after the first write. A WeakSet lets the tiles be
 * collected with the panel they belong to.
 */
const madeRelative = new WeakSet();

/** Drop the held tiles; the next tick looks them up again. */
function invalidateTiles() {
    tileCache = null;
}

/**
 * The battle panel's unit tiles, one list a side.
 *
 * Two lists rather than one, because the payload numbers the two sides
 * separately: `mMap` key 0 is the first monster and `pMap` key 0 is the first
 * player, and a single concatenated list makes one of those two the other's
 * tile.
 *
 * @returns {{monsters: Array<HTMLElement>, players: Array<HTMLElement>}}
 */
function unitTiles() {
    // Freshness is judged on a real unit tile per side, never on a container:
    // the containers survive a unit re-render, so holding one of those would
    // keep a stale list alive forever. Both heads are checked because the game
    // can replace one side's units and leave the other's standing.
    const heads = [tileCache?.monsters[0], tileCache?.players[0]].filter(Boolean);
    if (heads.length && heads.every((tile) => tile.isConnected)) return tileCache;

    tileCache = {
        monsters: Array.from(document.querySelectorAll(MONSTER_SELECTOR)),
        players: Array.from(document.querySelectorAll(PLAYER_SELECTOR)),
    };
    return tileCache;
}

/**
 * The counters attribution is measured against.
 *
 * Its own rather than the Damage Tracker's, so turning that feature off does not
 * take the numbers with it — and so neither can consume the other's ticks.
 */
let attribution = newAttributionState();

/**
 * A colour per attacker, so a party's numbers are separable at a glance.
 *
 * Which is the point of attributing them at all: five people hitting the same
 * monster produce five numbers a tick, and undifferentiated they are noise.
 */
const ATTACKER_COLOURS = ['#ffd166', '#7fd6ff', '#c7a0ff', '#8fe388', '#ff9f6e'];

/** @returns {Array<Object>} The scrolling log, newest first */
export function combatLog() {
    return log.entries();
}

/** Forget every event so far */
export function clearCombatLog() {
    log.clear();
}

/**
 * Turn one tick into events, and draw them.
 * @param {Object} data - A `battle_updated` payload
 */
function onBattleUpdated(data) {
    try {
        // A new battle is a new set of units, so last tick's health belongs to
        // somebody else and comparing against it would invent enormous hits
        if (data?.battleId !== battleId) {
            battleId = data?.battleId;
            invalidateTiles();
            enemyHealth.clear();
            allyHealth.clear();
            attribution.monstersHP = {};
            attribution.monstersMaxHP = {};
            attribution.dmgCounter = {};
            attribution.critCounter = {};
        }

        // Attributed hits carry who swung, whether it landed and whether it
        // crit — none of which a health diff can express. The diff is still used
        // for incoming damage, which has no attacker to find.
        const attributed = attributeTick(data, attribution);
        const incoming = healthDeltas(data?.pMap, allyHealth, 'ally');
        // Keeps enemy health current for the diff path even while unused
        healthDeltas(data?.mMap, enemyHealth, 'enemy');

        const events = [
            ...attributed.map((hit) => ({
                id: hit.monsterIndex,
                side: 'enemy',
                amount: hit.amount,
                kind: hit.isHeal ? 'heal' : 'damage',
                attacker: hit.playerIndex,
                isCrit: hit.isCrit,
                isMiss: hit.isMiss,
            })),
            ...incoming.map((event) => ({ ...event, isCrit: false, isMiss: false })),
        ];
        if (!events.length) return;

        if (config.getSetting(SCROLLING_SETTING)) log.add(events, Date.now());
        if (config.getSetting(FLOATING_SETTING)) drawFloating(events);
    } catch (error) {
        console.error('[CombatText] Reading a combat tick failed:', error);
    }
}

/**
 * Put a number over each unit that changed.
 *
 * One per unit per tick — the largest — because a tick can carry a dozen events
 * and a number per event is a lot of DOM for something nobody can read.
 *
 * @param {Array<Object>} events - From `healthDeltas`
 */
function drawFloating(events) {
    // Nothing to see on a hidden tab, and the animation would not run anyway
    if (document.hidden) return;

    const tiles = unitTiles();
    const anyTile = tiles.monsters[0] || tiles.players[0];
    if (!anyTile) return;
    // A panel that is in the document but not laid out (another tab of the game
    // is open over it) gives every tile a zero-size box, so the numbers would
    // stack invisibly in a corner and still cost a node each
    if (!anyTile.getClientRects().length) return;

    // Keyed by side as well as index, because the two sides are numbered
    // independently: monster 0 and player 0 are two units, not one
    const biggest = new Map();
    for (const event of events) {
        const key = `${event.side}:${event.id}`;
        const seen = biggest.get(key);
        if (!seen || event.amount > seen.amount) biggest.set(key, event);
    }

    // The game's tiles are in order and the maps are keyed by index, which is
    // the only join the payload offers — an id that is not an index simply finds
    // no tile and draws nothing, rather than drawing over the wrong unit
    for (const event of biggest.values()) {
        const side = event.side === 'ally' ? tiles.players : tiles.monsters;
        const tile = side[Number(event.id)];
        if (!tile) continue;
        floatOver(tile, event);
    }
}

/**
 * What colour one number should be.
 *
 * Incoming damage and heals read by kind; outgoing damage reads by **attacker**,
 * so a party's numbers can be told apart. A miss is grey whoever threw it.
 *
 * @param {Object} event - One event
 * @returns {string}
 */
function colourFor(event) {
    if (event.isMiss) return '#9aa0ac';
    if (event.kind === 'heal') return '#7fd6a3';
    if (event.side === 'ally') return '#f87171';

    const attacker = Number(event.attacker);
    return ATTACKER_COLOURS[Number.isFinite(attacker) ? attacker % ATTACKER_COLOURS.length : 0];
}

/**
 * @param {HTMLElement} tile - A unit's tile
 * @param {Object} event - One event
 */
function floatOver(tile, event) {
    if (!madeRelative.has(tile)) {
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        madeRelative.add(tile);
    }

    const text = document.createElement('div');
    text.className = FLOAT_CLASS;
    // A miss is a swing that landed on nothing, which is worth seeing — the
    // game's own bar cannot show it at all
    text.textContent = event.isMiss
        ? 'miss'
        : `${event.kind === 'heal' ? '+' : ''}${formatWithSeparator(Math.round(event.amount))}`;
    Object.assign(text.style, {
        position: 'absolute',
        left: '50%',
        top: '30%',
        transform: 'translate(-50%, 0)',
        pointerEvents: 'none',
        fontWeight: 'bold',
        // A crit is the thing you want to notice without reading, so it is
        // bigger rather than merely a different colour
        fontSize: event.isCrit ? '20px' : '15px',
        textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
        color: colourFor(event),
        zIndex: String(config.Z_HUD),
        transition: `transform ${FLOAT_MS}ms ease-out, opacity ${FLOAT_MS}ms ease-out`,
    });
    tile.appendChild(text);

    // Started on the next frame, or the transition has nothing to move from
    requestAnimationFrame(() => {
        text.style.transform = 'translate(-50%, -34px)';
        text.style.opacity = '0';
    });
    setTimeout(() => text.remove(), FLOAT_MS + 60);
}

/** Subscribe only while something wants the events */
function applySettings() {
    const wanted = config.getSetting(FLOATING_SETTING) || config.getSetting(SCROLLING_SETTING);

    if (wanted && !handler) {
        handler = onBattleUpdated;
        // Ability names are only in `new_battle`, and without them every hit
        // would be attributed to nobody in particular
        newBattleHandler = (data) => noteActions(attribution, data?.players || {});
        webSocketHook.on('battle_updated', handler);
        webSocketHook.on('new_battle', newBattleHandler);
        // The only thing that changes which tiles exist is the battle panel being
        // rebuilt, so that is what drops the held list — not every tick
        unregisterArea = domObserver.onClass('CombatText', 'BattlePanel_playersArea', invalidateTiles);
    } else if (!wanted && handler) {
        webSocketHook.off('battle_updated', handler);
        webSocketHook.off('new_battle', newBattleHandler);
        unregisterArea?.();
        unregisterArea = null;
        invalidateTiles();
        handler = null;
        newBattleHandler = null;
        attribution = newAttributionState();
        document.querySelectorAll(`.${FLOAT_CLASS}`).forEach((text) => text.remove());
    }
}

export default {
    name: 'Combat Text',
    initialize: () => {
        applySettings();
        config.onSettingChange(FLOATING_SETTING, applySettings);
        config.onSettingChange(SCROLLING_SETTING, applySettings);
    },
    cleanup: () => {
        if (handler) webSocketHook.off('battle_updated', handler);
        if (newBattleHandler) webSocketHook.off('new_battle', newBattleHandler);
        unregisterArea?.();
        unregisterArea = null;
        invalidateTiles();
        handler = null;
        newBattleHandler = null;
        attribution = newAttributionState();
        document.querySelectorAll(`.${FLOAT_CLASS}`).forEach((text) => text.remove());
        log.clear();
    },
};

/**
 * The whole log, rather than the six lines a tile holds.
 *
 * Two hundred events are kept and the tile can show six of them, which is fine
 * for a glance and no use at all for "what actually killed me". The panel is the
 * same list without the ceiling.
 */
export const combatLogPanel = createPanel({
    id: 'combatLog',
    title: 'Combat Log',
    size: { width: 320, height: 420 },
    accent: '#ffd166',
    refreshMs: 1000,
    draw: (body) => {
        if (!config.getSetting(SCROLLING_SETTING)) {
            body.appendChild(panelNote('Scrolling Combat Text is off, so nothing is being logged.'));
            body.appendChild(panelNote('Settings › Combat › Scrolling Combat Text.'));
            return;
        }

        const entries = combatLog();
        if (!entries.length) {
            body.appendChild(panelNote('Nothing seen yet. Hits appear here as they happen.'));
            return;
        }

        const card = panelCard(body, `Last ${Math.min(entries.length, 80)} events`, '#ffd166');
        for (const event of entries.slice(0, 80)) {
            card.appendChild(
                panelLine(
                    event.side === 'ally' ? `${GLYPHS.taken} taken` : `${GLYPHS.dealt} dealt`,
                    event.isMiss
                        ? 'miss'
                        : `${event.kind === 'heal' ? '+' : ''}${formatWithSeparator(Math.round(event.amount))}`,
                    colourFor(event)
                )
            );
        }
    },
});

registerRow({
    key: 'combatText',
    empty: 'No combat text',
    name: 'Combat Log',
    defaultSize: { width: 240, height: 90 },
    defaultVisible: false,
    // Everything the render below reads: the setting, and the newest event. Out
    // of combat nothing moves, so the tile is not rebuilt once a second for the
    // six lines it already shows.
    version: () => {
        const entries = log.entries();
        return `${config.getSetting(SCROLLING_SETTING) ? 1 : 0}:${entries.length}:${entries[0]?.at ?? 0}`;
    },
    render: (container) => {
        // The tile is a window onto a log that nothing is writing unless the
        // setting is on. Blank reads as broken, so it says which switch it wants
        // rather than leaving you to find out that this tile has a prerequisite.
        if (!config.getSetting(SCROLLING_SETTING)) {
            row(container, [{ text: 'Scrolling Combat Text is off', color: ROW_COLORS.dim, ellipsis: true }]);
            container.title =
                'This tile shows the log that Scrolling Combat Text keeps.\n' +
                'Turn it on in Settings › Combat, under Scrolling Combat Text.';
            return;
        }

        const entries = combatLog();
        if (!entries.length) {
            row(container, [{ text: 'Waiting for a fight…', color: ROW_COLORS.dim, ellipsis: true }]);
            container.title = 'Hits appear here as they happen. Nothing has been seen yet this session.';
            return;
        }

        container.replaceChildren();
        // Only what fits: this row is glanced at, and a hundred lines in a tile
        // ninety pixels tall is a scrollbar nobody uses
        for (const event of entries.slice(0, 6)) {
            const line = document.createElement('div');
            row(line, [
                glyph(event.side === 'ally' ? 'taken' : 'dealt'),
                {
                    text: event.isMiss
                        ? 'miss'
                        : `${event.kind === 'heal' ? '+' : ''}${formatWithSeparator(Math.round(event.amount))}`,
                    color:
                        event.kind === 'heal'
                            ? ROW_COLORS.good
                            : event.side === 'ally'
                              ? ROW_COLORS.bad
                              : ROW_COLORS.gold,
                },
            ]);
            container.appendChild(line);
        }
        container.title =
            'The last few hits. Damage you dealt in gold, damage taken in red, heals in green.' +
            '\nDouble-click for the whole log.';
    },
    onOpen: () => combatLogPanel.toggle(),
});
