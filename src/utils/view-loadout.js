/**
 * View Loadout
 *
 * The game's "View Loadout" (party member menu, guild trial roster), in one place.
 *
 * ## What the game does
 *
 * The game core — the fiber object that also carries `handleViewProfile` — has
 * `handleViewLoadout(characterId, context, kind = '')`. It sends
 * `{type: 'view_loadout', viewLoadoutData: {characterId, context, kind}}`, the
 * server answers `{type: 'loadout_shared', loadout}` and the game opens a
 * "<Name>'s Loadout" modal. The reply does not echo the character id or the
 * context: the item and ability rows carry `characterID`, and
 * `sharableCharacter.name` names the player, so a reply is matched to the request
 * in flight by those.
 *
 * `loadout` carries `sharableCharacter`, `hasLoadout`, `wearableItemMap` (keyed
 * `/item_locations/<slot>`), `equippedAbilities`, `combatConsumables`,
 * `abilityCombatTriggersMap` and `consumableCombatTriggersMap` — no skill levels,
 * house rooms or buffs; those still come from a shared profile.
 *
 * ## Rules this module keeps
 *
 * - Nothing is ever requested without a user click: {@link fetchLoadouts} is for a
 *   click handler, and it goes through the game's own `handleViewLoadout`, never a
 *   raw socket send.
 * - Feature-detected: a game build without `handleViewLoadout` (the live server,
 *   until it gets the update) answers `false` from {@link isViewLoadoutAvailable},
 *   {@link fetchLoadouts} requests nothing, and the passive capture never fires
 *   because no `loadout_shared` ever arrives.
 * - Every `loadout_shared` is remembered, whoever asked for it — the user's own
 *   clicks in game included.
 *
 * ## Why in memory only
 *
 * A loadout is a snapshot of gear the player can change at any moment, and one
 * click fetches it again. Persisting it would hand the sim a build from days ago
 * that nothing refreshes, where a reload falling back to the shared profile says
 * plainly which source it used. Captures are kept per current character: a
 * character switch hides the previous character's captures, and the next capture
 * drops them.
 *
 * Shared across bundles as `Toolasha.Utils.viewLoadout` (see rollup.config.js), so
 * the capture the entrypoint starts is the store every feature reads.
 */

import dataManager from '../core/data-manager.js';
import webSocketHook from '../core/websocket.js';
import { getGameCore } from './profile-command.js';

/** The game's context enum for `handleViewLoadout` */
export const VIEW_LOADOUT_CONTEXT = Object.freeze({ Party: 'party', GuildTrial: 'guild_trial' });

/** How long {@link fetchLoadouts} waits for one member's reply before skipping them */
export const FETCH_TIMEOUT_MS = 5000;

/** How long {@link fetchLoadouts} waits for the game's modal to appear so it can close it */
export const MODAL_WAIT_MS = 1500;

/** Poll step while waiting for the modal */
const MODAL_POLL_MS = 50;

/** A user's "View Loadout" click lends its context to a reply arriving within this window */
const USER_CLICK_WINDOW_MS = 5000;

/** Captures kept; the oldest go first. A guild roster is ~50, several times over. */
const MAX_ENTRIES = 300;

/** The game's modal title: "<Name>'s Loadout" */
const LOADOUT_TITLE_RE = /^(.+?)['’]s\s+Loadout$/i;

/** How long an availability answer is reused; renders ask on every redraw and the fiber walk is not free */
const AVAILABILITY_TTL_MS = 5000;

/**
 * @typedef {Object} CapturedLoadout
 * @property {string|null} characterId - The player's character id as a string; null when neither
 *   the request nor the reply said (a `hasLoadout:false` reply to nobody's request)
 * @property {string|null} name - `sharableCharacter.name`
 * @property {string|null} context - 'party', 'guild_trial', or null when not known
 * @property {string|null} kind - The request's kind, or null when not known
 * @property {boolean} hasLoadout - The server's own flag; false means there is no loadout to use
 * @property {boolean} requested - True when {@link fetchLoadouts} asked for it
 * @property {number} capturedAt - Epoch ms
 * @property {string|null} ownerCharacterId - The character that was logged in when it arrived
 * @property {Object} loadout - The raw `loadout` payload; treat as read-only
 */

/** key → CapturedLoadout; insertion order is age order */
const store = new Map();
/** Subscribers to {@link onLoadoutCaptured} */
const listeners = new Set();

let captureStarted = false;
/** The request {@link fetchLoadouts} is waiting on: `{characterId, name, context, kind, owner, resolve}` */
let inFlight = null;
/** True while a {@link fetchLoadouts} run is going */
let running = false;
/** `{at, context}` of the user's last "View Loadout" click */
let lastUserClick = null;
/** `{at, core}` of the last availability answer */
let availabilityCache = null;

/**
 * Normalize a character id for comparison.
 * @param {*} value
 * @returns {string|null}
 */
function idKey(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
}

/**
 * Normalize a name for comparison.
 * @param {*} value
 * @returns {string}
 */
function nameKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase();
}

/** @returns {string|null} The logged-in character's id */
function currentOwner() {
    return idKey(dataManager.getCurrentCharacterId?.());
}

/**
 * The character a reply belongs to, read off its own rows.
 * @param {Object} loadout - The `loadout` payload
 * @returns {string|null}
 */
export function characterIdFromLoadout(loadout) {
    if (!loadout || typeof loadout !== 'object') return null;
    for (const row of Object.values(loadout.wearableItemMap || {})) {
        const id = idKey(row?.characterID);
        if (id) return id;
    }
    for (const row of Array.isArray(loadout.equippedAbilities) ? loadout.equippedAbilities : []) {
        const id = idKey(row?.characterID);
        if (id) return id;
    }
    return idKey(loadout.sharableCharacter?.id);
}

/**
 * The game core, when it can view loadouts.
 * @returns {Object|null}
 */
function viewLoadoutCore() {
    const now = Date.now();
    if (availabilityCache && now - availabilityCache.at < AVAILABILITY_TTL_MS) {
        const cached = availabilityCache.core;
        if (!cached || typeof cached.handleViewLoadout === 'function') return cached;
    }
    let core = null;
    try {
        const found = getGameCore();
        core = typeof found?.handleViewLoadout === 'function' ? found : null;
    } catch (error) {
        console.error('[ViewLoadout] Looking up the game core failed:', error);
    }
    availabilityCache = { at: now, core };
    return core;
}

/**
 * Whether this game build has View Loadout. False on a build without it (the live
 * server before the update) and before the game has mounted.
 * @returns {boolean}
 */
export function isViewLoadoutAvailable() {
    return viewLoadoutCore() !== null;
}

/**
 * The context of a user's "View Loadout" click, from where it was clicked.
 *
 * The game's menu may render in a portal with no panel around it, which answers
 * null — a capture with an unknown context, which the sim does not use as a party
 * loadout.
 * @param {Element} element
 * @returns {string|null}
 */
function contextOfClick(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
        const className = typeof node.className === 'string' ? node.className : '';
        if (/Guild/.test(className)) return VIEW_LOADOUT_CONTEXT.GuildTrial;
        if (/Party/.test(className)) return VIEW_LOADOUT_CONTEXT.Party;
    }
    return null;
}

/**
 * Remember a user's own "View Loadout" click, so the reply can carry its context.
 * @param {MouseEvent} event
 */
function noteUserClick(event) {
    if (!event?.isTrusted) return;
    let node = event.target instanceof Element ? event.target : null;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
        if ((node.textContent || '').trim() === 'View Loadout') {
            lastUserClick = { at: Date.now(), context: contextOfClick(node) };
            return;
        }
    }
}

/**
 * Store a capture, dropping the previous character's and the oldest past the cap.
 * @param {CapturedLoadout} entry
 */
function remember(entry) {
    for (const [key, existing] of store) {
        if (existing.ownerCharacterId !== entry.ownerCharacterId) store.delete(key);
    }
    const who = entry.characterId ? `id:${entry.characterId}` : `name:${nameKey(entry.name)}`;
    const key = `${entry.context ?? ''}|${who}`;
    store.delete(key);
    store.set(key, entry);
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value);
}

/**
 * Whether a reply answers the request in flight. A reply whose rows name another
 * character, or whose player has another name, belongs to someone else — a late
 * reply to a timed-out request, or the user's own click.
 * @param {Object} request
 * @param {string|null} rowId
 * @param {string|null} name
 * @returns {boolean}
 */
function answers(request, rowId, name) {
    if (!request) return false;
    if (rowId) return rowId === request.characterId;
    if (request.name && name) return nameKey(request.name) === nameKey(name);
    return true;
}

/**
 * The `loadout_shared` handler.
 * @param {Object} data - The parsed message
 */
export function handleLoadoutShared(data) {
    const loadout = data?.loadout;
    if (!loadout || typeof loadout !== 'object') return;

    const name = loadout.sharableCharacter?.name || null;
    const rowId = characterIdFromLoadout(loadout);
    const request = answers(inFlight, rowId, name) ? inFlight : null;
    const now = Date.now();
    const click = !request && lastUserClick && now - lastUserClick.at <= USER_CLICK_WINDOW_MS ? lastUserClick : null;

    /** @type {CapturedLoadout} */
    const entry = {
        characterId: request ? request.characterId : rowId,
        name: name || request?.name || null,
        context: request ? request.context : (click?.context ?? null),
        kind: request ? request.kind : null,
        hasLoadout: loadout.hasLoadout !== false,
        requested: Boolean(request),
        capturedAt: now,
        ownerCharacterId: request ? request.owner : currentOwner(),
        loadout,
    };

    // A reply to a request made before a character switch belongs to nobody logged in now
    if (entry.ownerCharacterId === currentOwner()) {
        remember(entry);
        for (const listener of [...listeners]) {
            try {
                listener(entry);
            } catch (error) {
                console.error('[ViewLoadout] Capture listener failed:', error);
            }
        }
    }

    if (request) {
        inFlight = null;
        request.resolve(entry);
    }
}

/**
 * Start remembering every `loadout_shared`. Idempotent; the entrypoint calls it at
 * startup, and {@link fetchLoadouts} makes sure of it.
 */
export function startLoadoutCapture() {
    if (captureStarted) return;
    captureStarted = true;
    webSocketHook.on('loadout_shared', handleLoadoutShared);
    if (typeof document !== 'undefined') document.addEventListener('click', noteUserClick, true);
}

/**
 * Stop the capture. The store is kept.
 */
export function stopLoadoutCapture() {
    if (!captureStarted) return;
    captureStarted = false;
    webSocketHook.off('loadout_shared', handleLoadoutShared);
    if (typeof document !== 'undefined') document.removeEventListener('click', noteUserClick, true);
}

/**
 * Hear about every capture as it lands.
 * @param {(entry: CapturedLoadout) => void} listener
 * @returns {() => void} Unsubscribe
 */
export function onLoadoutCaptured(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * Every capture made under the current character, newest last.
 * @returns {CapturedLoadout[]}
 */
export function getLoadouts() {
    const owner = currentOwner();
    return [...store.values()].filter((entry) => entry.ownerCharacterId === owner).map((entry) => ({ ...entry }));
}

/**
 * The newest captured loadout for a player.
 *
 * A player can hold a different loadout per context (a party build, a trial
 * build), so pass the context you mean. Omitting it answers the newest of any
 * context, including captures whose context is unknown.
 *
 * @param {string|number} characterIdOrName - Character id, or the player's name (case-insensitive)
 * @param {string|null} [context] - 'party', 'guild_trial', or null for unknown-context captures only
 * @returns {CapturedLoadout|null} A copy of the entry; its `loadout` is shared and read-only
 */
export function getLoadout(characterIdOrName, context) {
    const id = idKey(characterIdOrName);
    const name = nameKey(characterIdOrName);
    if (!id && !name) return null;
    const all = getLoadouts().filter((entry) => context === undefined || entry.context === context);
    const byId = all.filter((entry) => entry.characterId && entry.characterId === id);
    const pool = byId.length ? byId : all.filter((entry) => entry.name && nameKey(entry.name) === name);
    if (!pool.length) return null;
    return pool.reduce((newest, entry) => (entry.capturedAt >= newest.capturedAt ? entry : newest));
}

/**
 * The game's open loadout modals.
 * @param {ParentNode} [root=document]
 * @returns {Array<{container: Element, title: Element, name: string}>}
 */
export function findLoadoutModals(root = document) {
    if (!root?.querySelectorAll) return [];
    const found = [];
    for (const container of root.querySelectorAll('[class*="Modal_modalContainer"]')) {
        const title = findLoadoutTitle(container);
        if (title) found.push({ container, ...title });
    }
    return found;
}

/**
 * A modal's "<Name>'s Loadout" title, matched on the whole text of a small element
 * so a paragraph mentioning a loadout is not mistaken for one.
 * @param {Element} container
 * @returns {{title: Element, name: string}|null}
 */
export function findLoadoutTitle(container) {
    for (const element of container.querySelectorAll('*')) {
        if (element.childElementCount > 3) continue;
        const text = (element.textContent || '').trim();
        if (!text || text.length > 64) continue;
        const match = text.match(LOADOUT_TITLE_RE);
        if (match) return { title: element, name: match[1].trim() };
    }
    return null;
}

/**
 * Close one of the game's loadout modals.
 * @param {{container: Element}} modal
 * @returns {boolean} True when a close button was clicked
 */
function closeModal(modal) {
    const button =
        modal.container.querySelector('[class*="Modal_closeButton"]') ||
        modal.container.querySelector('button[aria-label*="lose"]');
    if (!button) return false;
    button.click();
    return true;
}

/**
 * Wait for the loadout modal a request opened, then close it.
 * @param {string|null} name - The player's name; any loadout modal when null
 * @param {number} waitMs
 * @returns {Promise<boolean>} True when a modal was closed
 */
async function closeLoadoutModalFor(name, waitMs) {
    const wanted = nameKey(name);
    for (let waited = 0; ; waited += MODAL_POLL_MS) {
        const modals = findLoadoutModals();
        const modal = wanted ? modals.find((entry) => nameKey(entry.name) === wanted) : modals[modals.length - 1];
        if (modal) return closeModal(modal);
        if (waited >= waitMs) return false;
        await new Promise((resolve) => setTimeout(resolve, MODAL_POLL_MS));
    }
}

/**
 * Ask the game for one member's loadout and wait for the reply.
 * @param {Object} core - The game core
 * @param {{characterId: string, rawId: *, name: string|null}} member
 * @param {string} context
 * @param {string} kind
 * @param {number} timeoutMs
 * @returns {Promise<CapturedLoadout|null>} Null on timeout or a failed call
 */
function requestOne(core, member, context, kind, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (inFlight === request) inFlight = null;
            resolve(null);
        }, timeoutMs);
        const request = {
            characterId: member.characterId,
            name: member.name,
            context,
            kind,
            owner: currentOwner(),
            resolve: (entry) => {
                clearTimeout(timer);
                resolve(entry);
            },
        };
        inFlight = request;
        try {
            core.handleViewLoadout(member.rawId, context, kind);
        } catch (error) {
            console.error('[ViewLoadout] handleViewLoadout failed:', error);
            clearTimeout(timer);
            if (inFlight === request) inFlight = null;
            resolve(null);
        }
    });
}

/**
 * @typedef {Object} FetchResult
 * @property {'done'|'unavailable'|'busy'|'character_switched'} status
 * @property {CapturedLoadout[]} loadouts - What arrived, in request order
 * @property {Array<{characterId: string, name: string|null}>} missed - Members with no reply
 *   (timed out, the call failed, or the run stopped before them)
 */

/**
 * Fetch several players' loadouts through the game's own View Loadout — for a user
 * click only.
 *
 * One member at a time: request, wait for the reply (up to `timeoutMs`, then that
 * member is skipped), close the modal the game opened for it, move on. Replies are
 * matched to the member asked for by the rows' `characterID` (or the name when the
 * reply has no rows); anything else that arrives meanwhile is still captured, under
 * its own character. Refuses a second run while one is going, and stops if the
 * logged-in character changes.
 *
 * @param {Array<{characterId?: *, characterID?: *, name?: string, characterName?: string}>} members
 * @param {string} [context='party'] - One of {@link VIEW_LOADOUT_CONTEXT}
 * @param {string} [kind=''] - '' for party
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=FETCH_TIMEOUT_MS]
 * @param {number} [options.modalWaitMs=MODAL_WAIT_MS]
 * @param {(progress: {index: number, total: number, member: Object, entry: CapturedLoadout|null}) => void}
 *   [options.onProgress] - Called after each member
 * @returns {Promise<FetchResult>}
 */
export async function fetchLoadouts(members, context = VIEW_LOADOUT_CONTEXT.Party, kind = '', options = {}) {
    const { timeoutMs = FETCH_TIMEOUT_MS, modalWaitMs = MODAL_WAIT_MS, onProgress = null } = options;
    const list = (Array.isArray(members) ? members : [])
        .map((member) => {
            const rawId = member?.characterId ?? member?.characterID;
            return { characterId: idKey(rawId), rawId, name: member?.name ?? member?.characterName ?? null };
        })
        .filter((member) => member.characterId);
    const result = (status, loadouts = [], missed = []) => ({
        status,
        loadouts,
        missed: missed.map(({ characterId, name }) => ({ characterId, name })),
    });

    if (running) return result('busy', [], list);
    const core = viewLoadoutCore();
    if (!core) return result('unavailable', [], list);

    startLoadoutCapture();
    running = true;
    const owner = currentOwner();
    const loadouts = [];
    const missed = [];
    try {
        for (let index = 0; index < list.length; index++) {
            const member = list[index];
            if (currentOwner() !== owner)
                return result('character_switched', loadouts, [...missed, ...list.slice(index)]);

            const entry = await requestOne(core, member, context, kind, timeoutMs);
            if (currentOwner() !== owner) {
                return result('character_switched', loadouts, [...missed, ...list.slice(index)]);
            }
            if (entry) loadouts.push(entry);
            else missed.push(member);

            await closeLoadoutModalFor(entry?.name || member.name, entry ? modalWaitMs : 0);
            onProgress?.({ index, total: list.length, member: { ...member }, entry });
        }
        return result('done', loadouts, missed);
    } finally {
        running = false;
        inFlight = null;
    }
}

/**
 * Whether a {@link fetchLoadouts} run is going.
 * @returns {boolean}
 */
export function isFetchingLoadouts() {
    return running;
}

/** Forget everything and stop listening — for tests */
export function _resetViewLoadout() {
    stopLoadoutCapture();
    store.clear();
    listeners.clear();
    inFlight = null;
    running = false;
    lastUserClick = null;
    availabilityCache = null;
}
