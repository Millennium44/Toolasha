/**
 * One live subscription for everything Iron Bell draws.
 *
 * The farming panel and the action-bar strip both redraw when the queue, the coins, the prices or a
 * setting behind the queue walk change. Each used to register its own listener on every one of those
 * sources, so each event reached two handlers. They now share this single set of listeners, attached
 * when the first of them subscribes and dropped when the last one leaves; each still debounces and
 * redraws on its own.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { LIVE_EVENTS } from './ironbell-cycle.js';

/** The queue walk behind the reserve reads this setting, so flipping it moves the reserve */
const PROTECTION_SETTING = 'actionPanel_enhanceMatLimitProtections';

/** @type {Set<function(): void>} */
const subscribers = new Set();
/** Detaches the shared listeners; null while none are attached */
let detach = null;

/** Tell every subscriber that something moved. One failing never stops the others. */
function fire() {
    for (const callback of [...subscribers]) {
        try {
            callback();
        } catch (error) {
            console.error('[IronCow] Live redraw handler failed:', error);
        }
    }
}

/** Attach the shared listeners to the data manager, the market feed and the protection setting */
function attach() {
    for (const event of LIVE_EVENTS) dataManager.on(event, fire);
    marketAPI.on?.(fire);
    const offSetting = config.onSettingChange?.(PROTECTION_SETTING, fire);
    detach = () => {
        for (const event of LIVE_EVENTS) dataManager.off?.(event, fire);
        marketAPI.off?.(fire);
        if (typeof offSetting === 'function') offSetting();
    };
}

/**
 * Be told when the queue, the coins, the prices or the protection setting change.
 * @param {function(): void} callback - Called with no arguments, on every change (not debounced)
 * @returns {function(): void} Unsubscribe (idempotent); the last one out detaches the shared listeners
 */
export function onIronBellLive(callback) {
    subscribers.add(callback);
    if (!detach) attach();

    let live = true;
    return () => {
        if (!live) return;
        live = false;
        subscribers.delete(callback);
        if (subscribers.size === 0 && detach) {
            const release = detach;
            detach = null;
            release();
        }
    };
}
