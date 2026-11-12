/**
 * Talisman window values
 *
 * Test server only. In the game's talisman window each modifier line shows its grade value ("+4.5%"). A worn
 * Talisman Belt scales that value (Talisman Power), so this adds the scaled figure beside it: "+4.5% → +5.66%".
 *
 * The window and its rows are found by the game's CSS module class names (TalismanModal_*), and a row's modifier
 * by the React key the game gives it (the modifier hrid), never by the translated label, so a player on the
 * Chinese client gets the same figures. The grade is read from the digits of the row's grade chip.
 *
 * Nothing here runs on a live server: `initialize` returns at once and nothing is registered.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { isTestServer } from '../../utils/game-server.js';
import { fiberFor } from '../../utils/react-click.js';
import { BELT_LOCATION, getTalismanPower, scaleTalismanModifier } from '../../utils/talisman-bonuses.js';

const MODAL_CLASS = 'TalismanModal_talismanModal';
const ROW_SELECTOR = '[class*="TalismanModal_modifierRow"]';
const VALUE_SELECTOR = '[class*="TalismanModal_value"]';
const GRADE_SELECTOR = '[class*="TalismanModal_grade"]';
const SPECIAL_SELECTOR = '[class*="TalismanModal_specialMark"]';
const SCALED_CLASS = 'toolasha-talisman-scaled';
const RENDER_DEBOUNCE_MS = 60;

/** Number of decimals shown, trailing zeros trimmed */
function trimmed(value) {
    return String(Number(value.toFixed(2)));
}

/**
 * The scaled value as the window would print it: percent lines as percent, flat lines as numbers, signed.
 * @param {number} value - Scaled value (a fraction for a percent line)
 * @param {boolean} isPercent - The modifier's `isPercent`
 * @returns {string} e.g. "+5.66%" or "+2.52"
 */
export function formatScaledValue(value, isPercent) {
    const shown = isPercent ? value * 100 : value;
    const text = trimmed(Math.abs(shown));
    const sign = shown < 0 ? '-' : '+';
    return `${sign}${text}${isPercent ? '%' : ''}`;
}

/**
 * The text to add beside one modifier line.
 * @param {string} hrid - Modifier hrid (the row's React key)
 * @param {number} grade - Grade 1..6
 * @param {number} power - Talisman Power of the worn belt
 * @param {Object} modifierDetailMap - `talismanModifierDetailMap`
 * @returns {string|null} "→ +5.66%", or null for no belt, an unknown line, or nothing to show
 */
export function scaledLineText(hrid, grade, power, modifierDetailMap) {
    if (!(power > 0)) return null;
    const scaled = scaleTalismanModifier({ hrid, grade }, modifierDetailMap, power);
    if (!scaled) return null;
    return `→ ${formatScaledValue(scaled.value, scaled.detail.isPercent === true)}`;
}

/**
 * The React key of a row: its own fiber's, else the nearest keyed fiber above it, so a key that sits on a wrapping
 * component (the row rendered by a child component keyed by the map) still counts. The climb stops at the list
 * container, so a key from outside the list is never taken for a row's.
 * @param {Object} fiber - The row's fiber
 * @returns {string|null}
 */
function keyOf(fiber) {
    let current = fiber;
    for (let hops = 0; current && hops < 4; hops++, current = current.return) {
        if (current.key !== null && current.key !== undefined) return String(current.key);
        const node = current.stateNode;
        if (
            current !== fiber &&
            node &&
            node.nodeType === 1 &&
            typeof node.className === 'string' &&
            node.className.includes('TalismanModal_modifiers')
        ) {
            return null;
        }
    }
    return null;
}

/**
 * The React keys (modifier hrids) of the rows under a window, by DOM element.
 * @param {Element} modal - The window element
 * @returns {Map<Element, string>}
 */
function rowKeys(modal) {
    const keys = new Map();
    const root = fiberFor(modal);
    if (!root) return keys;
    const stack = [root.child];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const node = fiber.stateNode;
        if (
            node &&
            node.nodeType === 1 &&
            typeof node.className === 'string' &&
            node.className.includes('TalismanModal_modifierRow')
        ) {
            const key = keyOf(fiber);
            if (key !== null) keys.set(node, key);
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    return keys;
}

class TalismanWindowValues {
    constructor() {
        this.initialized = false;
        this.unregisterObserver = null;
        this.modalObserver = null;
        this.watchedModal = null;
        this.renderTimer = null;
        this.rowHrids = new WeakMap();
        this._handlers = {};
        this.writing = false;
    }

    initialize() {
        if (this.initialized) return;
        if (!isTestServer()) return;
        if (!config.getSetting('talismanWindowValues')) return;

        this._handlers = {
            talismans_updated: () => this.schedule(),
            items_updated: () => this.schedule(),
            character_switching: () => this.clear(),
        };
        for (const [event, handler] of Object.entries(this._handlers)) {
            dataManager.on(event, handler);
        }
        this.unregisterObserver = domObserver.onClass('TalismanWindowValues', MODAL_CLASS, (node) => this.watch(node));
        this.initialized = true;

        // A window already open when the feature starts
        const open = document.querySelector(`[class*="${MODAL_CLASS}"]`);
        if (open) this.watch(open);
    }

    /**
     * Follow a window until it closes: rows are redrawn by React on every reroll, lock and character change.
     * @param {Element} modal
     */
    watch(modal) {
        if (!this.initialized || !modal) return;
        if (this.watchedModal === modal) {
            this.schedule();
            return;
        }
        this.unwatch();
        this.watchedModal = modal;
        this.modalObserver = new MutationObserver(() => {
            // Our own writes are not a reason to draw again
            if (!this.writing) this.schedule();
        });
        this.modalObserver.observe(modal, { childList: true, subtree: true, characterData: true });
        this.schedule();
    }

    unwatch() {
        if (this.modalObserver) {
            this.modalObserver.disconnect();
            this.modalObserver = null;
        }
        this.watchedModal = null;
    }

    schedule() {
        if (!this.initialized) return;
        if (this.renderTimer) clearTimeout(this.renderTimer);
        const characterId = dataManager.getCurrentCharacterId?.();
        this.renderTimer = setTimeout(() => {
            this.renderTimer = null;
            if (dataManager.getCurrentCharacterId?.() !== characterId) return;
            this.render();
        }, RENDER_DEBOUNCE_MS);
    }

    /** The worn belt's Talisman Power right now (0 without a belt) */
    currentPower() {
        const initData = dataManager.getInitClientData?.();
        const belt = dataManager.getEquipment?.()?.get(BELT_LOCATION) || null;
        return getTalismanPower(belt, initData?.itemDetailMap, initData?.enhancementLevelTotalBonusMultiplierTable);
    }

    render() {
        if (!this.initialized) return;
        const modal = this.watchedModal;
        if (!modal || !modal.isConnected) {
            this.unwatch();
            return;
        }
        const modifierDetailMap = dataManager.getInitClientData?.()?.talismanModifierDetailMap;
        const power = this.currentPower();
        const rows = Array.from(modal.querySelectorAll(ROW_SELECTOR));

        let keys = null;
        this.writing = true;
        try {
            for (const row of rows) {
                const valueEl = row.querySelector(VALUE_SELECTOR);
                if (!valueEl) continue;
                let line = row.querySelector(`.${SCALED_CLASS}`);

                let hrid = this.rowHrids.get(row);
                if (!hrid && modifierDetailMap && power > 0) {
                    keys ??= rowKeys(modal);
                    hrid = keys.get(row);
                    if (hrid) this.rowHrids.set(row, hrid);
                }
                const gradeDigits = /\d+/.exec(row.querySelector(GRADE_SELECTOR)?.textContent || '');
                const text =
                    hrid && gradeDigits && !row.querySelector(SPECIAL_SELECTOR)
                        ? scaledLineText(hrid, Number(gradeDigits[0]), power, modifierDetailMap)
                        : null;

                if (!text) {
                    line?.remove();
                    continue;
                }
                if (!line) {
                    line = document.createElement('span');
                    line.className = SCALED_CLASS;
                    line.style.whiteSpace = 'nowrap';
                    valueEl.insertAdjacentElement('afterend', line);
                }
                if (line.textContent !== text) line.textContent = text;
            }
        } catch (error) {
            console.error('[TalismanWindowValues] Drawing the scaled values failed:', error);
        } finally {
            // The observer's callback is a microtask; lift the flag after it has run
            Promise.resolve().then(() => {
                this.writing = false;
            });
        }
    }

    /** Take every line this feature drew out of the document */
    clear() {
        if (this.renderTimer) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
        for (const el of document.querySelectorAll(`.${SCALED_CLASS}`)) el.remove();
    }

    disable() {
        if (this.renderTimer) {
            clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
        try {
            for (const [event, handler] of Object.entries(this._handlers)) {
                dataManager.off(event, handler);
            }
            this._handlers = {};
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this.unwatch();
            this.clear();
        } catch (error) {
            console.error('[TalismanWindowValues] Disable failed part-way:', error);
        } finally {
            this.rowHrids = new WeakMap();
            this.initialized = false;
        }
    }
}

const talismanWindowValues = new TalismanWindowValues();

export default talismanWindowValues;
