/**
 * Character Select Renderer
 *
 * Injects the two-line activity block into each populated slot on the native character-select
 * screen.
 *
 * Always-on, and wired in the entrypoint rather than through the feature registry: character
 * select can be the very first screen of a session, with no character initialized and therefore
 * no feature lifecycle running at all. Cheap when idle — the shared DOM observer does nothing
 * until character select actually appears.
 *
 * The native screen mounts its root before `loadCharacters()` resolves and inserts the slots
 * container into that already-mounted root afterwards, so watching only for the root's insertion
 * loses the race often enough to make the feature look absent. Both the root and the slots
 * container are watched, and a bounded catch-up scan covers the case where the script attached
 * after character select had already finished loading.
 */

import domObserver from '../../core/dom-observer.js';
import assetManifest from '../../utils/asset-manifest.js';
import { computeSlotDisplayState, COLOR_HEX } from './character-activity-display.js';
import { loadCharacterActivity, loadAccountPreferences } from './character-activity-storage.js';
import {
    resolveCharacterSelectSlots,
    CHARACTER_SELECT_ROOT_CLASS,
    CHARACTER_SLOTS_CLASS,
} from './character-select-resolver.js';

const BLOCK_CLASS = 'toolasha-character-activity-status';
const REFRESH_INTERVAL_MS = 60000;

class CharacterSelectRenderer {
    constructor() {
        this.isWatching = false;
        this.unregisterObserver = null;
        this.refreshTimer = null;
        this.trackedSlots = new Map(); // characterId -> {slotElement, character}
    }

    /**
     * Start watching for character select. Safe to call unconditionally on every page load,
     * before any character has ever initialized.
     */
    startWatching() {
        if (this.isWatching) return;
        this.isWatching = true;

        this.unregisterObserver = domObserver.onClass(
            'characterActivityStatus',
            [CHARACTER_SELECT_ROOT_CLASS, CHARACTER_SLOTS_CLASS],
            (node) => this.onCharacterSelectDomReady(node)
        );

        // Runs exactly once, guarded by the isWatching check above — not a poll. Later async
        // slot arrival is still handled by the observer.
        const existingRoot = document.querySelector(`[class*="${CHARACTER_SELECT_ROOT_CLASS}"]`);
        if (existingRoot) this.onCharacterSelectMounted(existingRoot);
    }

    /**
     * Resolve whichever character-select root owns a newly-observed node — the root itself, or
     * the later-inserted slots container nested inside it — and rescan from that root.
     * @param {Element} node
     * @returns {Promise<void>}
     */
    async onCharacterSelectDomReady(node) {
        if (!node?.isConnected) return;

        const rootElement =
            (typeof node.className === 'string' && node.className.includes(CHARACTER_SELECT_ROOT_CLASS) && node) ||
            node.closest?.(`[class*="${CHARACTER_SELECT_ROOT_CLASS}"]`);
        if (!rootElement) return;

        return this.onCharacterSelectMounted(rootElement);
    }

    /**
     * (Re)discover the slots under a character-select root and draw into them.
     * @param {Element} rootElement
     * @returns {Promise<void>}
     */
    async onCharacterSelectMounted(rootElement) {
        try {
            const { slots } = resolveCharacterSelectSlots(rootElement);
            if (slots.length === 0) return;

            this.trackedSlots.clear();
            for (const { slotElement, character } of slots) {
                this.trackedSlots.set(character.id, { slotElement, character });
            }

            await this.renderAllTrackedSlots();
            this.startRefreshTimer();
        } catch (error) {
            console.error('[CharacterActivity] Character select scan failed:', error);
        }
    }

    /**
     * Draw (or redraw) every tracked slot from storage.
     * @returns {Promise<void>}
     */
    async renderAllTrackedSlots() {
        const prefs = await loadAccountPreferences();
        if (!prefs.enabled) {
            this.clearAllInjectedBlocks();
            return;
        }

        const spriteUrl = await assetManifest.getSpriteUrl('skills');

        for (const { slotElement, character } of this.trackedSlots.values()) {
            if (!slotElement.isConnected) continue;
            const record = await loadCharacterActivity(character.id);
            const state = computeSlotDisplayState(record, character, prefs);
            this.renderSlotBlock(slotElement, state, spriteUrl);
        }
    }

    /**
     * Build or update one slot's block. Text goes in through `textContent`, never markup —
     * action names come from game data and the block sits inside the game's own DOM.
     * @param {Element} slotElement
     * @param {{firstLineText: string, limiterColor: string, limiterText: string, actionTypeHrid: string|null}} state
     * @param {string|null} spriteUrl
     */
    renderSlotBlock(slotElement, state, spriteUrl) {
        let block = slotElement.querySelector(`.${BLOCK_CLASS}`);
        if (!block) {
            block = document.createElement('div');
            block.className = BLOCK_CLASS;
            block.style.cssText = 'font-size:11px; line-height:1.3; margin-top:2px;';
            slotElement.appendChild(block);
        }
        block.textContent = '';

        const activityRow = document.createElement('div');
        activityRow.style.cssText = 'display:flex;align-items:center;overflow:hidden;';

        // Taken from the display state's currently-active segment, not the record's first queued
        // segment — a record persisted with several segments queued moves on to segment 2, 3, …
        // as time passes (that is what `firstLineText` already shows), and an icon pinned to
        // segment 0 would show the wrong skill for as long as the block is redrawn from the same
        // stored record.
        const iconSlug = skillSlugFromActionTypeHrid(state.actionTypeHrid);
        if (spriteUrl && iconSlug) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '16');
            svg.setAttribute('height', '16');
            svg.style.cssText = 'vertical-align:middle;margin-right:3px;flex-shrink:0;';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${spriteUrl}#${iconSlug}`);
            svg.appendChild(use);
            activityRow.appendChild(svg);
        }

        const activityText = document.createElement('span');
        activityText.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        activityText.textContent = state.firstLineText;
        activityRow.appendChild(activityText);

        const limiterRow = document.createElement('div');
        limiterRow.style.cssText = 'display:flex;align-items:center;gap:4px;opacity:0.85;';

        const dot = document.createElement('span');
        dot.style.cssText = `width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${
            COLOR_HEX[state.limiterColor] || COLOR_HEX.neutral
        };`;
        limiterRow.appendChild(dot);

        const limiterText = document.createElement('span');
        limiterText.style.cssText = 'white-space:nowrap;';
        limiterText.textContent = state.limiterText;
        limiterRow.appendChild(limiterText);

        block.appendChild(activityRow);
        block.appendChild(limiterRow);
    }

    /**
     * Redraw once a minute, so a deadline that passes while the screen is open turns red on its
     * own. Stops itself as soon as the slots leave the DOM.
     */
    startRefreshTimer() {
        if (this.refreshTimer) return;
        this.refreshTimer = setInterval(() => {
            if (this.trackedSlots.size === 0 || !this.anySlotStillConnected()) {
                this.stopRefreshTimer();
                return;
            }
            this.renderAllTrackedSlots();
        }, REFRESH_INTERVAL_MS);
    }

    /**
     * @returns {boolean} Whether any tracked slot is still in the document
     */
    anySlotStillConnected() {
        for (const { slotElement } of this.trackedSlots.values()) {
            if (slotElement.isConnected) return true;
        }
        return false;
    }

    stopRefreshTimer() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    clearAllInjectedBlocks() {
        for (const { slotElement } of this.trackedSlots.values()) {
            slotElement.querySelector(`.${BLOCK_CLASS}`)?.remove();
        }
    }

    /**
     * Stop watching and remove everything this module owns — observer, timer, injected nodes.
     */
    stopWatching() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this.stopRefreshTimer();
        this.clearAllInjectedBlocks();
        this.trackedSlots.clear();
        this.isWatching = false;
    }
}

/**
 * The sprite symbol id for an action type hrid, or null.
 * @param {string|null} actionTypeHrid
 * @returns {string|null}
 */
function skillSlugFromActionTypeHrid(actionTypeHrid) {
    if (typeof actionTypeHrid !== 'string' || !actionTypeHrid.startsWith('/action_types/')) return null;
    return actionTypeHrid.replace('/action_types/', '') || null;
}

const characterSelectRenderer = new CharacterSelectRenderer();

export default characterSelectRenderer;
export { BLOCK_CLASS, skillSlugFromActionTypeHrid };
