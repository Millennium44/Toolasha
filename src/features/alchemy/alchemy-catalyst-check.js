/**
 * Alchemy Catalyst Check
 *
 * A soft check on the alchemy Start and Queue buttons: pressing one without the most profitable catalyst selected
 * does nothing the first time, and a message says which catalyst is best and what the current choice costs. One more
 * press goes ahead.
 *
 * Nothing is scripted. The first press is the player's own click, stopped on its way to the game; the second is the
 * player's own click, left alone. No click is ever re-fired, no catalyst selected, no action started. The game ignores
 * untrusted clicks on spend buttons, and this never makes one.
 *
 * It does not guess. Figures that are not ready, an unpriced option, a drop or tea with no price, a tie, a catalyst
 * slot that cannot be read: each lets the press through with nothing on screen. So does a difference below the margin
 * (`MARGIN_MIN_COINS`, `MARGIN_RATIO`), and a press of the setup that is already running.
 *
 * ## With the protected-category guard
 *
 * An item in a protected category belongs to that guard alone: this check holds nothing and draws nothing for it, in
 * either state of the guard's double-confirm. Taking turns would swallow presses in a loop: its confirming press would
 * be this check's first press, whose second press would be the guard's new first press. The answer comes from
 * asking the guard, so it does not depend on which of the two capture listeners was registered first.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import alchemyActionProtection from './alchemy-action-protection.js';
import { readAlchemyPanelSelection } from './alchemy-profit.js';
import { activeAlchemyAction } from './alchemy-item-selector.js';
import {
    TYPE_CATALYSTS,
    computeCatalystAnswer,
    iconHrid,
    rankCatalystOptions,
    requestExpectedValue,
    signed,
    ownedCatalystCount,
    catalystName,
} from './alchemy-catalyst-mark.js';
import { runningAction } from '../../utils/combat-actions.js';
import { parseItemHash } from '../../utils/item-hash.js';
import { MENU_SELECTOR, TILE_SELECTOR } from '../../utils/item-selector-dom.js';
import { isIronCowCharacter } from '../../utils/ironcow-valuation.js';
import { getItemPriceInfo } from '../../utils/market-data.js';
import { formatKMB } from '../../utils/formatters.js';
import { GAME_COLORS, GAME_FRAME, styleGameButton } from '../../utils/game-look.js';

const SETTING = 'alchemyCatalystCheck';
const MESSAGE_CLASS = 'mwi-alchemy-catalyst-check';
const BUTTONS_SELECTOR = '[class*="SkillActionDetail_buttonsContainer"]';
const ALCHEMY_PANEL_SELECTOR = '[class*="SkillActionDetail_alchemyComponent"]';
const CATALYST_SLOT_SELECTOR = '[class*="SkillActionDetail_catalystItemInputContainer"]';
const EMPTY_SLOT_SELECTOR = '[class*="ItemSelector_emptySlot"]';

/** A difference smaller than this many coins an hour is not worth stopping anybody for */
export const MARGIN_MIN_COINS = 10_000;
/** Nor is one smaller than this share of what the best option earns */
export const MARGIN_RATIO = 0.05;
/** How long the second press stays armed; long enough to read the message on a phone */
const CONFIRM_WINDOW_MS = 15_000;
/** A press this soon after the held one is the same double-click or double-tap, not a decision */
const SAME_GESTURE_MS = 350;
/**
 * A keyboard click this soon after the last held press is the key still down: auto-repeat fires its first click about
 * 500 ms in, past the double-click window, and keeps firing for as long as Enter is held
 */
const KEY_REPEAT_MS = 1000;
/** How long a setup the player went ahead with stays agreed to: queueing several runs is one decision */
const ACKNOWLEDGED_MS = 60_000;

/**
 * Whether pressing this button starts or queues the alchemy action. Every enabled button in the panel's strip, the same
 * rule the protected-category guard uses. Which buttons the real strip holds is not confirmed live: an exclusion by
 * sprite, class or position goes here, and nothing else needs to change.
 *
 * @param {Element} button - The button pressed
 * @returns {boolean} True when the check applies to it
 */
export function isActionButton(button) {
    return !button.disabled && !!button.closest(BUTTONS_SELECTOR) && !!button.closest(ALCHEMY_PANEL_SELECTOR);
}

/**
 * What is in the panel's catalyst slot, from the sprite it draws.
 *
 * Told apart from "cannot read it" on purpose: an empty slot is the game's dashed placeholder, and anything else
 * without a readable sprite is something this does not understand. A picker menu open inside the slot's container
 * draws tiles of its own, which are the choices and not the choice.
 *
 * @param {ParentNode} [root=document] - Where to look
 * @returns {string|null|undefined} The catalyst's hrid, null for an empty slot, undefined when it cannot be read
 */
export function readSlottedCatalyst(root = document) {
    const slot = root.querySelector(CATALYST_SLOT_SELECTOR);
    if (!slot) return undefined;
    const outsideMenu = (el) => !el.closest(MENU_SELECTOR);
    const tile = [...slot.querySelectorAll(TILE_SELECTOR)].find(outsideMenu);
    if (tile) return iconHrid(tile) || undefined;
    return [...slot.querySelectorAll(EMPTY_SLOT_SELECTOR)].some(outsideMenu) ? null : undefined;
}

/**
 * Whether a press should be held, from the priced options. Pure.
 *
 * @param {{options: Array, skipped: string[], missingOutput: boolean, missingTea: boolean}|null} answer - The figures
 * @param {string|null} currentHrid - The slotted catalyst, null for none
 * @returns {{hold: boolean, reason: string, best?: Object, current?: Object, gap?: number}} `reason` names why:
 *   `notReady`, `partial`, `tooFew`, `tie`, `unknownCurrent`, `alreadyBest`, `smallGap`, or `better`
 */
export function judgeCatalystPress(answer, currentHrid) {
    if (!answer || answer.options.length === 0) return { hold: false, reason: 'notReady' };
    // Any of these and "best" is not known: the unpriced catalyst could be it, or a figure could be off by a whole drop
    if (answer.skipped.length > 0 || answer.missingOutput || answer.missingTea) {
        return { hold: false, reason: 'partial' };
    }

    const { state, best } = rankCatalystOptions(answer.options);
    if (state === 'none') return { hold: false, reason: 'tooFew' };
    if (state !== 'best') return { hold: false, reason: 'tie' };

    const current = answer.options.find((option) => option.hrid === currentHrid);
    if (!current) return { hold: false, reason: 'unknownCurrent' };
    const top = best[0];
    if (current === top) return { hold: false, reason: 'alreadyBest' };

    const gap = top.profitPerHour - current.profitPerHour;
    if (gap < MARGIN_MIN_COINS || gap < Math.abs(top.profitPerHour) * MARGIN_RATIO) {
        return { hold: false, reason: 'smallGap' };
    }
    return { hold: true, reason: 'better', best: top, current, gap };
}

/**
 * Whether a message just placed on the page can actually be seen. A press is only worth holding if it can: the worst
 * thing this feature can do is swallow a press with nothing on screen, so anything doubtful answers false and the press
 * goes through.
 *
 * Measured after the scroll into view. It cannot see something drawn on top of the message, only a message with no box,
 * hidden by style, or clipped away by a scroller or by the window. A browser without the layout calls has no way to
 * say, and answers true.
 *
 * @param {Element} node - The message
 * @returns {boolean} True when it is on screen
 */
export function messageCanBeSeen(node) {
    if (!node.isConnected) return false;
    if (node.checkVisibility?.({ checkVisibilityCSS: true, visibilityProperty: true }) === false) return false;
    const rects = node.getClientRects?.();
    if (!rects) return true;
    if (!Array.from(rects).some((rect) => rect.width > 0 && rect.height > 0)) return false;

    let { left, top, right, bottom } = node.getBoundingClientRect();
    const clipTo = (edges) => {
        left = Math.max(left, edges.left);
        top = Math.max(top, edges.top);
        right = Math.min(right, edges.right);
        bottom = Math.min(bottom, edges.bottom);
        return right > left && bottom > top;
    };
    for (let el = node.parentElement; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (/hidden|clip|auto|scroll/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
            if (!clipTo(el.getBoundingClientRect())) return false;
        }
        // What is above a fixed element does not clip it
        if (style.position === 'fixed') break;
    }
    return clipTo({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });
}

class AlchemyCatalystCheck {
    constructor() {
        this.isInitialized = false;
        this.clickHandler = null;
        this.settingUnsubscribe = null;
        /** The held first press: what it was held for, and everything that keeps it armed */
        this.pending = null;
        /** "Skip until reload": kept in memory only, so a reload or a character switch ends it */
        this.skipped = false;
        /** The setup the player last went ahead with, and when. Compared on each press, so it needs no timer */
        this.acknowledged = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;
        this.isInitialized = true;

        this.clickHandler = (event) => this.onClick(event);
        document.addEventListener('click', this.clickHandler, true);
        this.settingUnsubscribe = config.onSettingChange(SETTING, (value) => {
            if (value) return;
            this.clearPending();
            this.acknowledged = null;
        });
        // Up before the first press, which would otherwise find the figures not ready and say nothing
        if (!expectedValueCalculator.isInitialized) requestExpectedValue();
    }

    disable() {
        try {
            if (this.clickHandler) document.removeEventListener('click', this.clickHandler, true);
            this.clickHandler = null;
            this.settingUnsubscribe?.();
            this.settingUnsubscribe = null;
            this.clearPending();
            document.querySelectorAll(`.${MESSAGE_CLASS}`).forEach((el) => el.remove());
            this.skipped = false;
            this.acknowledged = null;
        } catch (error) {
            console.error('[AlchemyCatalystCheck] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Every click on the page, on its way down. A failure of any kind lets the press through.
     * @param {MouseEvent} event - The click
     */
    onClick(event) {
        try {
            if (this.shouldHold(event)) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
            }
        } catch (error) {
            console.error('[AlchemyCatalystCheck] Could not check the press:', error);
            this.clearPending();
        }
    }

    /**
     * Decide about one click, drawing or clearing what that takes.
     * @param {MouseEvent} event - The click
     * @returns {boolean} True to stop it reaching the game
     */
    shouldHold(event) {
        // Turned off between the presses, from any UI: nothing may stay blocked
        if (!config.getSetting(SETTING)) {
            this.clearPending();
            return false;
        }

        const button = event.target?.closest?.('button');
        if (!button || !isActionButton(button)) return false;
        const buttons = button.closest(BUTTONS_SELECTOR);
        const panel = button.closest(ALCHEMY_PANEL_SELECTOR);
        if (this.skipped) return false;

        // The stronger guard's press, in whichever order the two listeners run
        if (alchemyActionProtection.protectedCategoryFor?.(button)) {
            this.clearPending();
            return false;
        }

        const context = this.readContext(panel);
        const pending = this.pending;
        if (pending) {
            if (this.stillArmed(pending, context, panel)) {
                if (this.isSameGesture(pending, event)) return true;
                this.acknowledged = { signature: pending.signature, at: Date.now() };
                this.clearPending();
                return false;
            }
            this.clearPending();
        }
        if (!context) return false;

        if (this.isAcknowledged(context)) return false;
        if (this.isAlreadyRunning(context)) return false;
        if (!expectedValueCalculator.isInitialized) {
            requestExpectedValue();
            return false;
        }

        const verdict = judgeCatalystPress(
            computeCatalystAnswer(context.action, context.selection),
            context.catalystHrid
        );
        if (!verdict.hold || this.cannotActOn(verdict)) return false;

        return this.hold(panel, buttons, context, verdict);
    }

    /**
     * What the panel is set to do now.
     * @param {Element} panel - The alchemy panel to read
     * @returns {{action: string, selection: Object, catalystHrid: string|null, signature: string}|null} Null on a tab
     *   with no catalyst, with no input, or with a slot that cannot be read
     */
    readContext(panel) {
        const action = activeAlchemyAction();
        if (!TYPE_CATALYSTS[action]) return null;
        const selection = readAlchemyPanelSelection(panel);
        if (!selection?.itemHrid) return null;
        const catalystHrid = readSlottedCatalyst(panel);
        if (catalystHrid === undefined) return null;
        const signature = [
            dataManager.getCurrentCharacterId?.() || '',
            action,
            selection.itemHrid,
            selection.enhancementLevel,
            catalystHrid || 'none',
        ].join('|');
        return { action, selection, catalystHrid, signature };
    }

    /**
     * Whether a press belongs to the gesture that was held, and so says nothing about the player's decision.
     * @param {Object} pending - The held press
     * @param {MouseEvent} event - The press; a keyboard's click has `detail` 0, a mouse's or a tap's its click count
     * @returns {boolean} True when it should be held too
     */
    isSameGesture(pending, event) {
        const now = Date.now();
        const sameGesture =
            now - pending.at < SAME_GESTURE_MS || (event.detail === 0 && now - pending.lastHeldAt < KEY_REPEAT_MS);
        // Measured from the last repeat, not the first: the key can stay down for as long as it likes
        if (sameGesture) pending.lastHeldAt = now;
        return sameGesture;
    }

    /**
     * Whether the held press still stands for what the panel shows. Its message would be wrong otherwise.
     * @param {Object} pending - The held press
     * @param {Object|null} context - The panel now
     * @param {Element} [panel] - The panel just pressed in, when there was a press
     * @returns {boolean} True when one more press may go ahead
     */
    stillArmed(pending, context, panel = pending.panel) {
        return (
            pending.panel === panel &&
            pending.panel.isConnected &&
            pending.node.isConnected &&
            context?.signature === pending.signature
        );
    }

    /**
     * Whether the player has just gone ahead with this setup. The signature is what they agreed to, and carries neither
     * the button nor the count, so Start and Queue and any number of runs are the same answer.
     * @param {{signature: string}} context - The panel now
     * @returns {boolean} True when it should not be asked again yet
     */
    isAcknowledged({ signature }) {
        const acknowledged = this.acknowledged;
        return acknowledged?.signature === signature && Date.now() - acknowledged.at < ACKNOWLEDGED_MS;
    }

    /**
     * The player is pressing for the setup the game is already running, so this press changes nothing the check could
     * speak to. Also the safe answer should the game draw a Stop button here for the running action.
     * @param {{action: string, selection: Object, catalystHrid: string|null}} context - The panel now
     * @returns {boolean} True when the running action is exactly this one
     */
    isAlreadyRunning({ action, selection, catalystHrid }) {
        const running = runningAction(
            dataManager.getCurrentActions?.(),
            (a) => a.actionHrid === `/actions/alchemy/${action}`
        );
        if (!running) return false;
        const input = parseItemHash(running.primaryItemHash);
        return (
            input.itemHrid === selection.itemHrid &&
            input.level === selection.enhancementLevel &&
            parseItemHash(running.secondaryItemHash).itemHrid === catalystHrid
        );
    }

    /**
     * What the figures alone do not say: whether this player could take the advice, and whether it rests on a quote.
     * An Iron Cow cannot buy a catalyst, so one it is not known to hold is out of reach. A catalyst with an empty order
     * book is priced from the official value map, which is an estimate, and the gap would be measured from it.
     * @param {{best: Object, current: Object}} verdict - From {@link judgeCatalystPress}
     * @returns {boolean} True when the press should not be stopped for this
     */
    cannotActOn({ best, current }) {
        if (best.hrid && isIronCowCharacter()) {
            if (!dataManager.getInventory?.() || ownedCatalystCount(best.hrid) === 0) return true;
        }
        return [best, current].some(
            ({ hrid }) => hrid && getItemPriceInfo(hrid, { context: 'profit', side: 'buy' }).estimated
        );
    }

    /**
     * Say why this press did nothing and arm the second one, if the player can see the saying.
     * @param {Element} panel - The alchemy panel
     * @param {Element} buttons - The panel's button strip
     * @param {{signature: string}} context - What was pressed for
     * @param {Object} verdict - From {@link judgeCatalystPress}
     * @returns {boolean} True when the press is held, false when the message could not be shown and it goes through
     */
    hold(panel, buttons, context, verdict) {
        const node = this.buildMessage(verdict);
        // After the strip, never in it: the protected-category guard takes every button in there for an action press
        buttons.insertAdjacentElement('afterend', node);
        let seen = false;
        try {
            // The strip can be pinned to the bottom of a scrolling panel, with whatever follows it out of sight.
            // Instant, since the measure below has to find it where it ends up.
            node.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
            seen = messageCanBeSeen(node);
        } catch (error) {
            console.error('[AlchemyCatalystCheck] Could not show the message:', error);
        }
        if (!seen) {
            node.remove();
            return false;
        }

        const at = Date.now();
        const pending = { panel, node, signature: context.signature, at, lastHeldAt: at, timer: null, observers: [] };
        this.pending = pending;
        pending.timer = setTimeout(() => this.clearPending(), CONFIRM_WINDOW_MS);

        const recheck = () => {
            if (this.pending === pending && !this.stillArmed(pending, this.readContext(panel))) this.clearPending();
        };
        // The panel holds the input and the slot, whose sprites change by attribute as well as by node
        const content = panel.closest('[class*="SkillActionDetail_skillActionDetail"]') || panel;
        const contentObserver = new MutationObserver(recheck);
        contentObserver.observe(content, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'xlink:href'],
        });
        pending.observers.push(contentObserver);
        // The tab strip sits outside it
        const tabs = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
        if (tabs) {
            const tabObserver = new MutationObserver(recheck);
            tabObserver.observe(tabs, { attributes: true, subtree: true, attributeFilter: ['aria-selected'] });
            pending.observers.push(tabObserver);
        }
        return true;
    }

    /** Disarm the held press: its timer, observers and message. */
    clearPending() {
        const pending = this.pending;
        if (!pending) return;
        this.pending = null;
        clearTimeout(pending.timer);
        for (const observer of pending.observers) observer.disconnect();
        pending.node.remove();
    }

    /**
     * The message under the buttons. Plain text and real buttons, so it needs no hover and wraps at phone width.
     * @param {{best: Object, current: Object, gap: number}} verdict - The figures
     * @returns {HTMLElement} The message
     */
    buildMessage({ best, current, gap }) {
        const node = document.createElement('div');
        node.className = MESSAGE_CLASS;
        node.setAttribute('role', 'status');
        Object.assign(node.style, {
            boxSizing: 'border-box',
            maxWidth: '100%',
            marginTop: '6px',
            padding: '6px 8px',
            border: GAME_FRAME.border,
            borderRadius: GAME_FRAME.borderRadius,
            background: GAME_FRAME.background,
            color: GAME_COLORS.text,
            fontSize: '0.8rem',
            lineHeight: '1.35',
            overflowWrap: 'anywhere',
        });

        const rate = (option) => `${signed(option.profitPerHour)}/hr`;
        const line = (text, color) => {
            const row = document.createElement('div');
            row.textContent = text;
            if (color) row.style.color = color;
            node.appendChild(row);
        };
        line(`Best: ${catalystName(best)}, ${rate(best)}.`, GAME_COLORS.good);
        line(
            `Your choice, ${catalystName(current)}: ${rate(current)}, which is ${formatKMB(Math.round(gap))}/hr less.`
        );
        // An inventory not loaded yet says nothing about what is owned
        if (best.hrid && dataManager.getInventory?.() && ownedCatalystCount(best.hrid) === 0) {
            line('You have none of the best one. Its figure counts buying it.', GAME_COLORS.textDim);
        }
        line(`Press again within ${CONFIRM_WINDOW_MS / 1000} s to go ahead.`);

        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' });
        const control = (text, onPress) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            styleGameButton(button, 'quiet');
            // A comfortable size for a thumb, whatever the game's button height is
            Object.assign(button.style, { minHeight: '36px', fontSize: '0.8rem' });
            button.addEventListener('click', () => {
                // The second half of a double-tap on Start can land here, once the message has moved things
                if (this.pending && Date.now() - this.pending.at < SAME_GESTURE_MS) return;
                onPress();
            });
            controls.appendChild(button);
        };
        control('Skip until reload', () => {
            this.skipped = true;
            this.clearPending();
        });
        control('Turn this check off', () => {
            this.clearPending();
            config.setSetting(SETTING, false);
        });
        node.appendChild(controls);
        return node;
    }
}

const alchemyCatalystCheck = new AlchemyCatalystCheck();
export default alchemyCatalystCheck;
