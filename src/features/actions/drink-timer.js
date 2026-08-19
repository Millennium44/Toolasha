/**
 * Drink Timer
 * Displays remaining drink time per slot inside each non-combat skill panel's
 * consumables section. Warns when any drink falls below the configured threshold
 * and highlights if the queued actions will outlast available drink supply.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import notificationService from '../notifications/notification-service.js';
import { thresholdCrossing } from '../notifications/notification-predicates.js';
import { calculateDrinkRemainingSeconds, calculateQueueTimeSeconds } from '../../utils/drink-calculator.js';

const SECONDS_PER_HOUR = 3600;

class DrinkTimer {
    constructor() {
        this.initialized = false;
        this.observers = [];
        /**
         * actionTypeHrid -> whether a dip below the threshold would be news.
         *
         * Per action type rather than one flag, because woodcutting and cooking
         * have different drinks and running low on one says nothing about the
         * other. An unseen type is armed, so the first sighting of a low supply
         * is announced.
         */
        this.drinkAlertArmed = new Map();
    }

    initialize() {
        if (this.initialized) return;

        const unregister = domObserver.onClass(
            'DrinkTimer',
            'GatheringProductionSkillPanel_consumablesContainer',
            (el) => this._updatePanel(el)
        );
        this.observers.push(unregister);

        const unregisterAlchemy = domObserver.onClass('DrinkTimer-Alchemy', 'AlchemyPanel_consumablesContainer', (el) =>
            this._updatePanel(el)
        );
        this.observers.push(unregisterAlchemy);

        const unregisterEnhancing = domObserver.onClass(
            'DrinkTimer-Enhancing',
            'EnhancingPanel_consumablesContainer',
            (el) => this._updatePanel(el)
        );
        this.observers.push(unregisterEnhancing);

        const onUpdate = () => {
            this._updateAllPanels();
            // The panels only cover what is on screen, and the whole point of a
            // notification is that you are not looking at the screen — so the
            // skill actually being performed is checked whether or not its panel
            // happens to be open
            this._checkCurrentActionDrinks();
        };
        dataManager.on('consumables_updated', onUpdate);
        dataManager.on('items_updated', onUpdate);
        this.observers.push(() => {
            dataManager.off('consumables_updated', onUpdate);
            dataManager.off('items_updated', onUpdate);
        });

        this._updateAllPanels();
        this.initialized = true;
    }

    _updateAllPanels() {
        document.querySelectorAll('[class*="GatheringProductionSkillPanel_consumablesContainer"]').forEach((el) => {
            this._updatePanel(el);
        });
        document.querySelectorAll('[class*="AlchemyPanel_consumablesContainer"]').forEach((el) => {
            this._updatePanel(el);
        });
        document.querySelectorAll('[class*="EnhancingPanel_consumablesContainer"]').forEach((el) => {
            this._updatePanel(el);
        });
    }

    _updatePanel(consumablesContainer) {
        consumablesContainer.querySelector('.mwi-drink-timer')?.remove();

        const slotsEl = consumablesContainer.querySelector(
            '[class*="ActionTypeConsumableSlots_actionTypeConsumableSlots"]'
        );
        if (!slotsEl) return;

        const actionTypeHrid = this._getActionTypeHrid(slotsEl);
        if (!actionTypeHrid || actionTypeHrid === '/action_types/combat') return;

        const drinks = calculateDrinkRemainingSeconds(actionTypeHrid);
        if (!drinks.length) return;

        const thresholdSeconds = config.getSettingValue('drinkTimer_warningThreshold', 24) * SECONDS_PER_HOUR;
        const queueSeconds = calculateQueueTimeSeconds(actionTypeHrid);

        this._checkDrinkThreshold(actionTypeHrid, drinks, thresholdSeconds);

        const wrapper = document.createElement('div');
        wrapper.className = 'mwi-drink-timer';
        wrapper.style.cssText = 'padding: 3px 8px 4px; font-size: 11px; line-height: 1.5;';

        // Per-drink time row
        const drinkParts = drinks.map(({ name, totalSeconds }) => {
            const color =
                totalSeconds < SECONDS_PER_HOUR ? '#ef4444' : totalSeconds < thresholdSeconds ? '#f0a830' : '#9ca3af';
            const prefix = totalSeconds < thresholdSeconds ? '⚠ ' : '';
            return `<span style="color:${color};">${prefix}${name}: ${this._formatTime(totalSeconds)}</span>`;
        });
        const drinkRow = document.createElement('div');
        drinkRow.innerHTML = drinkParts.join('<span style="color:#4b5563;"> · </span>');
        wrapper.appendChild(drinkRow);

        // Queue warning row
        if (queueSeconds > 0) {
            const minDrinkSeconds = Math.min(...drinks.map((d) => d.totalSeconds));
            const shortfall = queueSeconds - minDrinkSeconds;
            if (shortfall > 0) {
                const shortDrink = drinks.find((d) => d.totalSeconds === minDrinkSeconds);
                const queueRow = document.createElement('div');
                queueRow.style.color = '#f0a830';
                queueRow.textContent = `⚠ Queue (${this._formatTime(queueSeconds)}) outlasts ${shortDrink.name} by ${this._formatTime(shortfall)}`;
                wrapper.appendChild(queueRow);
            }
        }

        slotsEl.insertAdjacentElement('afterend', wrapper);
    }

    /**
     * The action type the character is actually working on, if any.
     *
     * The first queued action, because that is the one being performed — the
     * rest are waiting, and their drinks are not being drunk yet.
     *
     * @returns {string|null} An action type hrid, or null when idle
     */
    _currentActionTypeHrid() {
        const current = dataManager.getCurrentActions?.()?.[0];
        if (!current?.actionHrid) return null;
        return dataManager.getActionDetails(current.actionHrid)?.type ?? null;
    }

    /** Evaluate the running skill's drinks, whether or not its panel is open */
    _checkCurrentActionDrinks() {
        if (!config.getSetting('notifications_consumableLow')) return;

        const actionTypeHrid = this._currentActionTypeHrid();
        if (!actionTypeHrid || actionTypeHrid === '/action_types/combat') return;

        const thresholdSeconds = config.getSettingValue('drinkTimer_warningThreshold', 24) * SECONDS_PER_HOUR;
        this._checkDrinkThreshold(actionTypeHrid, calculateDrinkRemainingSeconds(actionTypeHrid), thresholdSeconds);
    }

    /**
     * Announce a drink supply that has just fallen under the warning threshold.
     *
     * The soonest one, because a skill stops when its first drink runs out and
     * not when its average one does. The crossing itself is decided by a pure
     * predicate; all this does is hold the per-skill bit that predicate needs
     * and turn its answer into a sentence.
     *
     * @param {string} actionTypeHrid - Which skill's drinks these are
     * @param {Array<{name: string, totalSeconds: number}>} drinks - Remaining time per drink
     * @param {number} thresholdSeconds - Where the warning starts
     */
    _checkDrinkThreshold(actionTypeHrid, drinks, thresholdSeconds) {
        if (!config.getSetting('notifications_consumableLow')) return;
        if (!drinks?.length) return;

        const soonest = drinks.reduce((min, drink) => (drink.totalSeconds < min.totalSeconds ? drink : min));
        const armed = this.drinkAlertArmed.get(actionTypeHrid) ?? true;
        const next = thresholdCrossing({ armed, secondsLeft: soonest.totalSeconds, thresholdSeconds });

        this.drinkAlertArmed.set(actionTypeHrid, next.armed);
        if (!next.fire) return;

        const skill = actionTypeHrid.split('/').pop().replace(/_/g, ' ');
        notificationService.notify(
            `consumable-low:${actionTypeHrid}`,
            `${soonest.name} runs out in ${this._formatTime(soonest.totalSeconds)} (${skill})`
        );
    }

    /**
     * Get actionTypeHrid from the ActionTypeConsumableSlots element via fiber.
     * The prop lives one level up in the return fiber.
     */
    _getActionTypeHrid(slotsEl) {
        const root = document.getElementById('root');
        const rootFiber = root?._reactRootContainer?.current || root?._reactRootContainer?._internalRoot?.current;
        if (!rootFiber) return null;

        function walk(f, target) {
            if (!f) return null;
            if (f.stateNode === target) return f;
            return walk(f.child, target) || walk(f.sibling, target);
        }

        const fiber = walk(rootFiber, slotsEl);
        return fiber?.return?.memoizedProps?.actionTypeHrid ?? null;
    }

    _formatTime(seconds) {
        if (seconds <= 0) return '0m';
        const h = Math.floor(seconds / SECONDS_PER_HOUR);
        const m = Math.floor((seconds % SECONDS_PER_HOUR) / 60);
        if (h >= 48) return `${Math.round(seconds / 86400)}d`;
        if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
        return `${m}m`;
    }

    cleanup() {
        this.observers.forEach((fn) => fn());
        this.observers = [];
        document.querySelectorAll('.mwi-drink-timer').forEach((el) => el.remove());
        this.drinkAlertArmed.clear();
        this.initialized = false;
    }
}

const drinkTimer = new DrinkTimer();

export default {
    name: 'Drink Timer',
    initialize: () => drinkTimer.initialize(),
    cleanup: () => {
        try {
            return drinkTimer.cleanup();
        } catch (error) {
            console.error('[Drink Timer] Disable failed part-way:', error);
        } finally {
            drinkTimer.initialized = false;
        }
    },
};
