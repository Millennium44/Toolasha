/**
 * Server notices - the game's `error` and `info` WebSocket messages.
 *
 * The game shows these as toasts: `{type: 'error'|'info', message: <i18n key>, variables:
 * [{name, data}]}` (client handlers `handleMessageError` / `handleMessageInfo`, which translate
 * `message` with the variables folded into a name -> data map). A refused market order, a locked
 * item, spam protection and a loadout that cannot be equipped all arrive this way and in no other
 * message, so an automation that only watches for a state change cannot tell "refused" from "slow".
 *
 * Stateless on purpose: every subscription owns its own WebSocket handlers, so a copy of this
 * module in each bundle of the split build behaves the same as one shared copy.
 *
 * The fixture shape in the tests is built from the game's handler code, not from a live capture.
 */

import webSocketHook from '../core/websocket.js';
import dataManager from '../core/data-manager.js';

/** i18n keys of the refusals that follow a sale or listing press */
export const SALE_REFUSAL_KEYS = Object.freeze([
    'errorNotification.itemIsLocked',
    'errorNotification.orderNotFulfilled',
    'errorNotification.maxListingsPerItem',
    'errorNotification.requestSpamProtection',
]);

/** i18n keys of the refusals that follow a loadout equip */
export const LOADOUT_REFUSAL_KEYS = Object.freeze([
    'errorNotification.cannotEquipLoadoutForAction',
    'errorNotification.cannotEquipLoadoutInCombat',
    'errorNotification.requestSpamProtection',
]);

/**
 * Normalize one `error` / `info` message.
 * @param {Object} data - Parsed WebSocket message
 * @returns {{level: 'error'|'info', key: string, variables: Object<string, *>, at: number}|null}
 *   null when the message carries no usable key
 */
export function normalizeServerNotice(data) {
    if (!data || (data.type !== 'error' && data.type !== 'info')) return null;
    if (typeof data.message !== 'string' || data.message === '') return null;

    // The game keys a variable by its name, falling back to its position
    const variables = {};
    const list = Array.isArray(data.variables) ? data.variables : [];
    list.forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') return;
        variables[entry.name || index] = entry.data;
    });

    return { level: data.type, key: data.message, variables, at: Date.now() };
}

/**
 * Subscribe to the game's error and info notices from the active socket.
 * @param {(notice: {level: string, key: string, variables: Object, at: number}) => void} handler
 * @returns {() => void} Unsubscribe (idempotent)
 */
export function onServerNotice(handler) {
    const listen = (data, context) => {
        if (!dataManager.isFromActiveSocket(context)) return;
        const notice = normalizeServerNotice(data);
        if (!notice) return;
        try {
            handler(notice);
        } catch (error) {
            console.error('[ServerNotices] Handler failed:', error);
        }
    };
    webSocketHook.on('error', listen);
    webSocketHook.on('info', listen);

    let live = true;
    return () => {
        if (!live) return;
        live = false;
        webSocketHook.off('error', listen);
        webSocketHook.off('info', listen);
    };
}
