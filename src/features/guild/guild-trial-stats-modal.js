/**
 * Post-trial Combat Trial Stats modal — the game's own per-member totals.
 *
 * A test-server feature: when a combat trial ends the game offers a "Combat
 * Trial - Stats" modal listing each member's Damage, Healing and Damage Taken.
 * It is authoritative where the live damage stream is not — the stream reads
 * damage taken from health falling per tick and sees only a fraction of the real
 * total (healing masks it, stream gaps drop it), and it splits shared ticks by
 * actor, which under-credits the local player. This captures the modal so the
 * panel can show it beside the measured figures and prefer it where it settles.
 *
 * The modal is scraped, never depended on: on the live server (where the feature
 * does not yet exist) the observer simply never fires, and the panel falls back
 * to the streamed figures exactly as before.
 */

import domObserver from '../../core/dom-observer.js';
import { parseItemCount } from '../../utils/number-parser.js';

/** The stats table the game draws inside the modal — the tab-switch also redraws it */
const TABLE_CLASS = 'GuildPanel_trialStatsTable';
/** The draggable modal wrapper, reached from the table via closest() */
const MODAL_SELECTOR = '[class*="GuildPanel_trialStatsModal"]';
/** The selected tab's own label carries the trial name */
const ACTIVE_TAB_SELECTOR = '[role="tab"][aria-selected="true"] [class*="TabsComponent_badge"]';
const TABLE_SELECTOR = `table[class*="${TABLE_CLASS}"]`;

/**
 * Read the Combat Trial Stats modal into per-member totals for its active tab.
 *
 * The value columns follow the header order — Damage, Healing, Damage Taken —
 * and the figures are abbreviated ("1213K"), so each is parsed the same way the
 * rest of the script reads the game's numbers. The member name is taken from the
 * `data-name` attribute, which is exact where the visible text can be truncated.
 *
 * @param {Element} modal - The `[class*="GuildPanel_trialStatsModal"]` element
 * @returns {{trialName: string|null, members: Array<{name: string, damage: number|null,
 *   healing: number|null, damageTaken: number|null}>}|null} The active tab's stats, or null
 */
export function parseTrialStatsModal(modal) {
    if (!modal || typeof modal.querySelector !== 'function') return null;

    const tab = modal.querySelector(ACTIVE_TAB_SELECTOR);
    const trialName = tab ? tab.textContent.trim() : null;

    // The active tab's panel is the one not marked hidden; the whole modal is a
    // safe fallback when the panel markup is not where it is expected.
    const panels = [...modal.querySelectorAll('[class*="TabPanel_tabPanel"]')];
    const visible = panels.find((panel) => !String(panel.className).includes('TabPanel_hidden')) || modal;
    const table = visible.querySelector(TABLE_SELECTOR);
    if (!table) return null;

    const members = [];
    for (const row of table.querySelectorAll('tbody tr')) {
        const nameEl = row.querySelector('[class*="CharacterName_name"]');
        const name = (nameEl?.getAttribute('data-name') || nameEl?.textContent || '').trim();
        if (!name) continue;

        // Cell 0 is the member; the three value cells follow in header order.
        const cells = [...row.querySelectorAll('td')];
        const num = (cell) => (cell ? parseItemCount(String(cell.textContent).trim(), null) : null);
        members.push({
            name,
            damage: num(cells[1]),
            healing: num(cells[2]),
            damageTaken: num(cells[3]),
        });
    }

    if (!members.length) return null;
    return { trialName, members };
}

class GuildTrialStatsModal {
    constructor() {
        this.initialized = false;
        this.unregister = null;
        /** trialName → { members, at } — the last reading of each trial's stats */
        this.statsByTrial = new Map();
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        // Watch the table rather than the modal wrapper: the wrapper is inserted
        // once, but the table is redrawn on every tab switch, so watching it
        // captures Trial Swarm's stats when the player switches to that tab too.
        this.unregister = domObserver.onClass('GuildTrialStatsModal', TABLE_CLASS, (table) => {
            const modal = table.closest?.(MODAL_SELECTOR) || table.parentElement;
            this.capture(modal || table);
        });
    }

    /**
     * Parse a modal element and store the active tab's stats under its trial name.
     * @param {Element} modal - The stats modal (or a node it can be reached from)
     */
    capture(modal) {
        try {
            const parsed = parseTrialStatsModal(modal);
            if (!parsed?.trialName || !parsed.members.length) return;
            this.statsByTrial.set(parsed.trialName, { members: parsed.members, at: Date.now() });
        } catch (error) {
            console.error('[GuildTrialStatsModal] Failed to read the stats modal:', error);
        }
    }

    /**
     * The captured stats for a trial, if the modal has been opened this session.
     * @param {string} trialName - e.g. "Trial Jellyfish"
     * @returns {{members: Array, at: number}|null} The reading, or null
     */
    getStats(trialName) {
        return this.statsByTrial.get(trialName) || null;
    }

    /**
     * Everything captured this session, keyed by trial name — for the export.
     * @returns {Object<string, {members: Array, at: number}>}
     */
    snapshot() {
        const out = {};
        for (const [name, value] of this.statsByTrial) out[name] = value;
        return out;
    }

    cleanup() {
        this.unregister?.();
        this.unregister = null;
        this.statsByTrial.clear();
        this.initialized = false;
    }
}

const guildTrialStatsModal = new GuildTrialStatsModal();
export default guildTrialStatsModal;
export { guildTrialStatsModal };
