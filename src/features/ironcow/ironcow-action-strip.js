/**
 * The Iron Bell cycle on the action bar.
 *
 * While a leg of the Iron Bell loop is the running action (the Star Fruit forage, its decompose,
 * or the essence's coinify), a few lines under the game's action bar say what the panel would:
 * how many bells the coins on hand buy without starving the queue, what is left of the queued
 * cycle and when it ends, what it earns by then, and where the gold runs out if it does.
 *
 * Shown only to an Iron Cow character, only while Iron Bell Farming is on (this is started and
 * stopped by the panel's own feature lifetime), and only while a loop leg is running. Every number
 * is `bellBudget` and `summarizeCycle` over one `walkQueueCoins` walk — the panel's own reserve,
 * not a second copy of it.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { formatDateTime, formatKMB, formatWithSeparator, timeReadable } from '../../utils/formatters.js';
import { runningAction } from '../../utils/combat-actions.js';
import { actionTimeDisplay } from '../../utils/bundle-bridge.js';
import { isIronCowMode, readCharacterState } from './ironcow-plan.js';
import { resolveLoopItems } from './loop-items.js';
import { cowbellPricing } from './starfruit-loop.js';
import { bellBudget, walkQueueCoins } from './coin-reserve.js';
import {
    ESTIMATE_NOTE,
    LIVE_EVENTS,
    UNQUOTED_NOTE,
    UNREADABLE_NOTE,
    keptNote,
    loopLegOf,
    stoppedNote,
    summarizeCycle,
} from './ironbell-cycle.js';

const STRIP_ATTR = 'data-mwi-ironbell-strip';
/** How long a burst of coin or queue updates settles before the strip redraws */
const REDRAW_MS = 300;
/** The "ends in" clock and a remounted bar are picked up this often even with nothing else moving */
const TICK_MS = 30_000;

const COLORS = { dim: '#9aa3b5', good: '#7fd6a3', warn: '#ffb020' };

/** @param {number} value - Coins @returns {string} */
const coins = (value) => (Number.isFinite(value) ? formatKMB(Math.round(value)) : '—');

/** @param {number} n - A count @param {string} word - Singular @returns {string} */
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;

/**
 * A clock time `seconds` from now, with the date when it is not today.
 * @param {number} seconds - From now
 * @returns {string} e.g. "11-04 3:05 PM"
 */
function clockAfter(seconds) {
    const at = new Date(Date.now() + seconds * 1000);
    const today = at.toDateString() === new Date().toDateString();
    return formatDateTime(at, { includeDate: !today, includeSeconds: false });
}

/**
 * What the strip says, as plain data: lines of `{text, color, title}`.
 *
 * Kept apart from the DOM so every ending can be tested by what it says.
 *
 * @returns {Array<{text: string, color: string, title: string}>} Empty when the strip does not apply
 */
export function stripLines() {
    // Cheap gate first: Iron Bell Farming is on by default for every character, and reading the
    // character (a full inventory pass) on every redraw is only worth it for an Iron Cow
    if (!isIronCowMode(dataManager.getCurrentCharacterGameMode?.())) return [];
    let state;
    try {
        state = readCharacterState();
    } catch (error) {
        console.error('[IronCow] Reading the character for the action-bar strip failed:', error);
        return [];
    }
    if (!state || !isIronCowMode(state.gameMode)) return [];

    const loopItems = resolveLoopItems();
    const running = runningAction(dataManager.getCurrentActions?.() || []);
    if (!loopLegOf(running, loopItems)) return [];

    // The actions bundle not loaded yet: say nothing rather than "could not be read"
    const engine = actionTimeDisplay();
    if (!engine) return [];
    const walked = walkQueueCoins(engine);
    if (!walked) {
        return [{ text: 'Iron Bell: the queue could not be read in full', color: COLORS.dim, title: UNREADABLE_NOTE }];
    }

    const pricing = cowbellPricing({ buyNow: true });
    const budget = bellBudget(walked, state.coins, pricing);
    const bellPrice = budget.status === 'ok' ? pricing.price : null;
    const cap = dataManager.getOfflineHourCap?.();
    const cycle = summarizeCycle(walked, { coins: state.coins, loopItems, bellPrice, offlineCapHours: cap });
    const lines = [];

    // (a) Spendable on Iron Bells now
    if (budget.status === 'ok') {
        const { reserve, spenders, estimated, can } = budget;
        const approx = estimated ? '~' : '';
        const kept = keptNote(reserve, spenders, coins);
        lines.push({
            text:
                `Iron Bell: spend now ${approx}${formatWithSeparator(can.bells)} bells ` +
                `(${can.bags} ${plural(can.bags, 'bag')}) · keeps ${approx}${coins(reserve)} for the queue`,
            color: can.bells > 0 ? COLORS.good : COLORS.dim,
            title:
                `Out of your ${coins(state.coins)}. ${kept}${estimated ? ESTIMATE_NOTE : ''}` +
                `${stoppedNote(budget.stoppedAt)} Whole bags of ten, rounded down, all at the cheapest listing ` +
                `(${coins(pricing.price * 10)} a bag). Same figure as the Iron Bell Farming panel.`,
        });
    } else {
        lines.push({
            text: 'Iron Bell: no cowbell price to buy at',
            color: COLORS.dim,
            title: budget.status === 'unquoted' ? UNQUOTED_NOTE : 'The bag of ten cowbells has no price.',
        });
    }

    // (b) + (e) The whole cycle left, and what it earns
    const { legs } = cycle;
    const counts =
        `${formatWithSeparator(legs.forage)} forage · ${formatWithSeparator(legs.decompose)} decompose · ` +
        `${formatWithSeparator(legs.coinify)} coinify left`;
    let when;
    if (cycle.endless) when = `${cycle.endless} repeats forever, so the cycle has no end`;
    else if (cycle.seconds === null) when = 'end time unknown (a fight in the queue cannot be timed)';
    else when = `ends ${clockAfter(cycle.seconds)} (in ${timeReadable(cycle.seconds)})`;
    const approx = cycle.estimated ? '~' : '';
    const sign = cycle.net >= 0 ? '+' : '−';
    const gold = `${approx}${sign}${coins(Math.abs(cycle.net))} gold`;
    const bellsBy =
        cycle.netBells === null
            ? ''
            : ` (${approx}${formatWithSeparator(Math.floor(cycle.netBells))} bells, ` +
              `${cycle.netBags} ${plural(cycle.netBags, 'bag')})`;
    const by = cycle.endless ? 'up to that row' : 'by then';
    const other = cycle.otherActions > 0 ? ` · ${formatWithSeparator(cycle.otherActions)} other actions` : '';
    lines.push({
        text: `Cycle: ${counts}${other} · ${when} · ${gold}${bellsBy} ${by}`,
        color: COLORS.dim,
        title:
            `The whole queue as it stands, the running action included: coinify pays ${approx}${coins(cycle.earned)}, ` +
            `fees take ${coins(cycle.fees)}. Coinify proceeds are an expectation (its rolls can fail). ` +
            'Bells are the net gold at the bag price you can buy at now. The horizon is the queue, not ' +
            'your offline window.',
    });

    // (c) The offline cap, when the cycle outlasts it
    if (cycle.outlastsCap) {
        lines.push({
            text: `Offline cap ${cycle.capHours}h: away from the game, the queue stops ${cycle.capHours}h after you leave`,
            color: COLORS.dim,
            title: 'The game runs actions offline only up to your offline hour cap; log in before it to keep the cycle going.',
        });
    }

    // (d) Where the gold runs out
    if (cycle.shortfall) {
        const { label, atSeconds, short } = cycle.shortfall;
        const at =
            atSeconds === null
                ? 'later in the queue'
                : atSeconds <= 0
                  ? 'now'
                  : `at ${clockAfter(atSeconds)} (in ${timeReadable(atSeconds)})`;
        lines.push({
            text: `⚠ Gold runs out on ${label} ${at}: ${coins(short)} short`,
            color: COLORS.warn,
            title:
                `The fees of every queued row, in order, against your ${coins(state.coins)}, with no coinify ` +
                `proceeds counted on. ${label} stalls once it can no longer pay its fee.`,
        });
    }
    return lines;
}

class IronBellStrip {
    constructor() {
        this.node = null;
        this.active = false;
        this._timer = null;
        this._tick = null;
        this._schedule = () => {
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this.render(), REDRAW_MS);
        };
        this._offs = [];
    }

    /** Begin watching. Called from the Iron Bell Farming feature's initialize(). */
    start() {
        if (this.active) return;
        this.active = true;
        for (const event of LIVE_EVENTS) dataManager.on(event, this._schedule);
        marketAPI.on?.(this._schedule);
        this._offs.push(() => {
            for (const event of LIVE_EVENTS) dataManager.off?.(event, this._schedule);
            marketAPI.off?.(this._schedule);
        });
        // The queue walk reads this setting, so flipping it moves the reserve
        const offSetting = config.onSettingChange?.('actionPanel_enhanceMatLimitProtections', this._schedule);
        if (offSetting) this._offs.push(offSetting);
        // The game remounts the header's action name; put the strip back under it
        const offDom = domObserver.onClass?.('IronBellStrip', 'Header_actionName', this._schedule, { debounce: true });
        if (offDom) this._offs.push(offDom);
        this._tick = setInterval(() => this.render(), TICK_MS);
        this.render();
    }

    /** Stop watching and take the strip off the page. Called from the feature's disable(). */
    stop() {
        this.active = false;
        for (const off of this._offs.splice(0)) {
            try {
                off();
            } catch (error) {
                console.error('[IronCow] Strip teardown failed:', error);
            }
        }
        clearTimeout(this._timer);
        clearInterval(this._tick);
        this._timer = null;
        this._tick = null;
        this._removeNode();
    }

    _removeNode() {
        this.node?.remove();
        this.node = null;
        // A copy the game's remount left behind
        document.querySelectorAll(`[${STRIP_ATTR}]`).forEach((el) => el.remove());
    }

    /** Draw the strip against the queue, coins and prices as they stand now */
    render() {
        if (!this.active) return;
        let lines = [];
        try {
            lines = stripLines();
        } catch (error) {
            console.error('[IronCow] Drawing the action-bar strip failed:', error);
            lines = [];
        }
        const anchor =
            document.querySelector('[data-mwi-action-bar-widget="run"]') ||
            document.querySelector('div[class*="Header_actionName"]');
        if (!lines.length || !anchor?.parentNode) {
            this._removeNode();
            return;
        }
        if (!this.node || !this.node.isConnected) {
            this._removeNode();
            this.node = document.createElement('div');
            this.node.setAttribute(STRIP_ATTR, '');
            this.node.style.cssText = 'font-size: 0.85em; line-height: 1.4; text-align: left; white-space: pre-wrap;';
        }
        if (anchor.nextSibling !== this.node) anchor.parentNode.insertBefore(this.node, anchor.nextSibling);
        this.node.replaceChildren(
            ...lines.map(({ text, color, title }) => {
                const row = document.createElement('div');
                row.textContent = text;
                row.style.color = color;
                if (title) row.title = title;
                return row;
            })
        );
    }
}

const ironBellStrip = new IronBellStrip();
export default ironBellStrip;
