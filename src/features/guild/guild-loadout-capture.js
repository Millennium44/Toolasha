/**
 * Catching a loadout as it goes past.
 *
 * `guild-loadouts.js` knows what a snapshot is and where it is kept. This knows
 * *when* one happens: a unit popup opening, a party assembling for a trial, a
 * combat session ending. It listens, it extracts, it writes, and it does nothing
 * else — so the shapes it reads are testable without a socket and the timing is
 * testable without a stat sheet.
 *
 * ## The popup, twice over
 *
 * The popup is expected to be websocket-fed: `battle_unit_fetched` is the
 * message the client already treats as un-deduplicable because consecutive
 * fetches of *different units* look identical in the first hundred characters,
 * which is only a problem if the thing being fetched is a unit somebody is
 * looking at. When that message arrives with a stat sheet on it, that is the
 * popup's own data and nothing needs reading off the screen.
 *
 * It has not been possible to verify that from a live client, so the modal is
 * read as well — and the two do not fight, because the scrape stands down when a
 * socket snapshot has just landed ({@link POPUP_SOCKET_WINDOW_MS}). If the
 * message does feed the popup, the scrape never runs. If it does not, the scrape
 * is the only thing that produces a snapshot and the feature still works. The
 * cost of being wrong in either direction is nothing.
 *
 * The scrape itself is deliberately structural, in the same discipline the
 * trials scrape uses: no class name is trusted beyond `Modal_`, which is already
 * load-bearing elsewhere in the codebase. A unit popup is *whatever modal shows
 * a name with a level beside it and a column of labelled numbers* — see
 * {@link readUnitPopup}.
 */

import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { textLines } from './guild-trials-scrape.js';
import {
    extractLoadout,
    extractPartyLoadouts,
    foldLoadout,
    loadLoadouts,
    loadoutList,
    saveLoadouts,
} from './guild-loadouts.js';

/**
 * How recently a socket snapshot has to have arrived for the modal scrape to
 * stand down. A popup and the message that filled it are the same gesture, and
 * a few seconds is generous for a round trip.
 */
export const POPUP_SOCKET_WINDOW_MS = 5000;

/** Fewer labelled numbers than this and the modal is not a stat sheet */
export const MIN_POPUP_ROWS = 4;

/** Writes are batched: a party of five arrives as five messages in one frame */
const SAVE_DEBOUNCE_MS = 1000;

/** A value as the sheet writes one: `1,240`, `12.5%`, `+3` */
const VALUE_PATTERN = /^[+-]?[\d,]+(?:\.\d+)?\s*%?$/;

/** A name with its level beside it: `Tib - Lv.150`, or `Lv.150` under a name */
const HEADER_PATTERN = /^(.*?)[\s-–—]*Lv\.?\s*(\d+)\s*$/i;

/**
 * A loadout snapshot read off an open modal, or null when the modal is not one.
 *
 * Found rather than named. A unit popup is a modal that carries a name with a
 * level after it and at least {@link MIN_POPUP_ROWS} label/number pairs beneath
 * it; a settings dialog has neither, and an item tooltip has the numbers without
 * the header. Both halves are required, so neither on its own can produce a
 * player who does not exist.
 *
 * Text runs rather than `textContent`, for the reason the trials scrape spells
 * out at length: welding siblings together invents digit runs nobody displayed.
 *
 * The abilities are not read here. The popup draws them as icons with a level
 * badge and there is no text pairing that survives being wrong, so a snapshot
 * scraped from the screen carries the stat sheet and says nothing about the kit
 * — which is better than a kit assembled out of whichever numbers happened to
 * sit near an image.
 *
 * @param {Element} root - The modal
 * @param {number} [at] - When it was read
 * @returns {Object|null} A snapshot in the {@link extractLoadout} shape, or null
 */
export function readUnitPopup(root, at = Date.now()) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const lines = textLines(root);
    if (lines.length < MIN_POPUP_ROWS) return null;

    let name = null;
    let level = null;
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(HEADER_PATTERN);
        if (!match) continue;

        const parsed = Number(match[2]);
        if (!Number.isFinite(parsed)) continue;

        // The name is usually on the same run as the level and sometimes the run
        // before it, because the game styles the two differently
        const inline = match[1].trim();
        const previous = index > 0 ? lines[index - 1].replace(/[-–—]\s*$/, '').trim() : '';
        const candidate = inline || previous;
        if (!candidate || !/[a-z]/i.test(candidate)) continue;

        name = candidate;
        level = parsed;
        break;
    }
    if (!name) return null;

    const rows = [];
    for (let index = 0; index < lines.length - 1; index += 1) {
        const label = lines[index];
        const value = lines[index + 1];
        if (!VALUE_PATTERN.test(value)) continue;
        if (VALUE_PATTERN.test(label) || !/[a-z]/i.test(label)) continue;

        rows.push({ label: label.replace(/[:\s]+$/, ''), value });
        index += 1;
    }
    if (rows.length < MIN_POPUP_ROWS) return null;

    return { name, characterId: null, level, rows, abilities: [], stats: {}, source: 'popup', at };
}

class GuildLoadoutCapture {
    constructor() {
        this.initialized = false;
        this.record = { players: {}, updatedAt: 0 };
        this.characterId = null;
        this.unregister = [];
        this.timers = createTimerRegistry();
        this.lastSocketAt = 0;
        this.saveQueued = false;
        /** How many features are currently relying on this; see {@link cleanup} */
        this.owners = 0;
    }

    /**
     * Start listening.
     *
     * Idempotent, and called from both the trials feature and the roster view —
     * either of them being switched on is reason enough to be recording, and
     * neither should have to know whether the other already is. Counted rather
     * than merely guarded, so one of the two being cleaned up does not take the
     * listeners away from the other.
     *
     * @returns {Promise<void>}
     */
    async initialize() {
        this.owners += 1;
        if (this.initialized) return;
        this.initialized = true;

        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;
        this.record = await loadLoadouts(this.characterId);

        this.onUnitFetched = (message) => this._onUnitFetched(message);
        this.onNewBattle = (message) => this._onNewBattle(message);
        webSocketHook.on('battle_unit_fetched', this.onUnitFetched);
        webSocketHook.on('new_battle', this.onNewBattle);
        this.unregister.push(() => {
            webSocketHook.off('battle_unit_fetched', this.onUnitFetched);
            webSocketHook.off('new_battle', this.onNewBattle);
        });

        this.unregister.push(
            domObserver.onClass('GuildLoadoutPopup', ['Modal_modalContent', 'Modal_modalContainer'], (node) =>
                this._onModal(node)
            )
        );
    }

    /** Stop listening, once nothing is relying on it any more */
    cleanup() {
        this.owners = Math.max(0, this.owners - 1);
        if (this.owners > 0) return;

        for (const unregister of this.unregister) unregister();
        this.unregister = [];
        this.timers.clearAll();
        this.saveQueued = false;
        this.initialized = false;
    }

    /** @returns {Array<Object>} Every snapshot held, most recently seen first */
    seen() {
        return loadoutList(this.record);
    }

    /**
     * @param {string} name - A player name
     * @returns {Object|null} Their most recent snapshot
     */
    forPlayer(name) {
        return this.seen().find((entry) => entry.name?.toLowerCase() === String(name || '').toLowerCase()) || null;
    }

    /**
     * @param {Object} message - `battle_unit_fetched`
     */
    _onUnitFetched(message) {
        try {
            const loadout = extractLoadout(message);
            // The end-of-session variant carries loot and no sheet, and
            // `extractLoadout` returns null for it — the clock is only stamped
            // when a real sheet arrived, so the modal scrape is not stood down
            // by a message that could not have filled a popup
            if (!loadout) return;
            this.lastSocketAt = Date.now();
            this._note(loadout);
        } catch (error) {
            console.error('[GuildLoadouts] Reading a fetched unit failed:', error);
        }
    }

    /**
     * @param {Object} message - `new_battle`
     */
    _onNewBattle(message) {
        try {
            for (const loadout of extractPartyLoadouts(message)) this._note(loadout);
        } catch (error) {
            console.error('[GuildLoadouts] Reading a party roster failed:', error);
        }
    }

    /**
     * @param {Element} node - A modal that has just appeared
     */
    _onModal(node) {
        try {
            if (Date.now() - this.lastSocketAt < POPUP_SOCKET_WINDOW_MS) return;
            const loadout = readUnitPopup(node);
            if (loadout) this._note(loadout);
        } catch (error) {
            console.error('[GuildLoadouts] Reading a unit popup failed:', error);
        }
    }

    /**
     * Keep a snapshot, and schedule a write.
     * @param {Object} loadout - From `extractLoadout` or `readUnitPopup`
     */
    _note(loadout) {
        // Asked at each write rather than cached: the user switches characters
        // without reloading, and an alt's sightings must not land in this one's
        // record
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (characterId !== this.characterId) {
            this.characterId = characterId;
            this.record = { players: {}, updatedAt: 0 };
            this._adopt(characterId, loadout);
            return;
        }

        this.record = foldLoadout(this.record, loadout);
        this._queueSave();
    }

    /**
     * Bring in the arriving character's own record before folding into it.
     * @param {string|number|null} characterId - The character now current
     * @param {Object} loadout - The snapshot that noticed the switch
     * @returns {Promise<void>}
     */
    async _adopt(characterId, loadout) {
        try {
            const record = await loadLoadouts(characterId);
            // Another switch may have happened while the read was in flight
            if (characterId !== this.characterId) return;
            this.record = foldLoadout(record, loadout);
            this._queueSave();
        } catch (error) {
            console.error('[GuildLoadouts] Reloading after a character switch failed:', error);
        }
    }

    /** Batch the writes: a party of five arrives as five snapshots in one frame */
    _queueSave() {
        if (this.saveQueued) return;
        this.saveQueued = true;

        this.timers.registerTimeout(
            setTimeout(async () => {
                this.saveQueued = false;
                await saveLoadouts(this.characterId, this.record);
            }, SAVE_DEBOUNCE_MS)
        );
    }
}

const guildLoadoutCapture = new GuildLoadoutCapture();

export default guildLoadoutCapture;
export { guildLoadoutCapture };
