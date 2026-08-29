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
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';

/** The stats table the game draws inside the modal — the tab-switch also redraws it */
const TABLE_CLASS = 'GuildPanel_trialStatsTable';
/** The draggable modal wrapper, reached from the table via closest() */
const MODAL_SELECTOR = '[class*="GuildPanel_trialStatsModal"]';
/** The selected tab's own label carries the trial name */
const ACTIVE_TAB_SELECTOR = '[role="tab"][aria-selected="true"] [class*="TabsComponent_badge"]';
const TABLE_SELECTOR = `table[class*="${TABLE_CLASS}"]`;
/** The member cell's name element, the one carrying the exact `data-name` */
const NAME_SELECTOR = '[class*="CharacterName_name"]';
/** dataset flag marking a name already wired, so a redraw never double-binds */
const LINKED_FLAG = 'mwiTrialProfileLink';

/**
 * Normalise a column header to a stable key.
 *
 * The combat modal draws Damage / Healing / Damage Taken; the skilling modal
 * draws its own (a contribution column), so the scraper reads whatever headers
 * are there rather than assuming the combat layout — otherwise a skilling
 * trial's single column would be mislabelled "damage".
 *
 * @param {string} label - The header cell's text
 * @returns {string} A camelCase key: 'damageTaken', 'healing', 'damage', or a slug
 */
export function headerKey(label) {
    const text = String(label || '')
        .trim()
        .toLowerCase();
    if (text.includes('damage taken')) return 'damageTaken';
    if (text.includes('healing')) return 'healing';
    if (text === 'damage') return 'damage';
    const words = text
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);
    if (!words.length) return '';
    return words.map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1))).join('');
}

/**
 * Read a Trial Stats modal into per-member values for its active tab.
 *
 * Header-driven: the value columns are keyed by their own headers, so the combat
 * modal yields `damage`/`healing`/`damageTaken` and the skilling modal yields its
 * own column, each correct. The figures are abbreviated ("1213K"), parsed the
 * same way the rest of the script reads the game's numbers. The member name is
 * taken from `data-name`, which is exact where the visible text can be truncated.
 *
 * @param {Element} modal - The `[class*="GuildPanel_trialStatsModal"]` element
 * @returns {{trialName: string|null, kind: 'combat'|'skilling', columns: string[],
 *   members: Array<{name: string, values: Object<string, number|null>}>}|null} The active tab's
 *   stats, or null
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

    // The header row minus the leading Member column gives the value columns.
    const headers = [...table.querySelectorAll('thead th')].map((th) => headerKey(th.textContent));
    const columns = headers.slice(1).filter(Boolean);
    if (!columns.length) return null;

    const members = [];
    for (const row of table.querySelectorAll('tbody tr')) {
        const nameEl = row.querySelector('[class*="CharacterName_name"]');
        const name = (nameEl?.getAttribute('data-name') || nameEl?.textContent || '').trim();
        if (!name) continue;

        // Cell 0 is the member; the value cells follow, one per header column.
        const cells = [...row.querySelectorAll('td')].slice(1);
        const values = {};
        columns.forEach((key, i) => {
            values[key] = cells[i] ? parseItemCount(String(cells[i].textContent).trim(), null) : null;
        });
        members.push({ name, values });
    }

    if (!members.length) return null;
    const kind = columns.includes('damageTaken') ? 'combat' : 'skilling';
    return { trialName, kind, columns, members };
}

/**
 * Make the stats table's member names open their profile on click.
 *
 * The modal names the whole guild's trial participants and gives no way to look
 * any of them up — the same gap the party popup had, and it is closed the same
 * way: `openPlayerProfile` from `utils/profile-command.js`, which calls the
 * game's own `handleViewProfile(name)` on the React core and falls back to the
 * `/profile <name>` chat command on builds without it. One click is exactly one
 * game action — the profile open — and nothing else.
 *
 * The game's own cell is decorated in place rather than replaced: only
 * `cursor`, `title` and a hover underline are added, so the name keeps whatever
 * colour and truncation the game gave it. Names are taken from `data-name`,
 * which is exact where the visible text can be cut off, and a name that is not
 * a single MWI name token is left alone.
 *
 * Idempotent: the table is redrawn on every tab switch, and each redraw brings
 * fresh cells, so this is safe to run on every observer fire.
 *
 * @param {Element} root - The modal, or any node containing the stats table
 * @returns {number} How many names were newly wired
 */
export function linkMemberNames(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;

    // The observer hands over the modal when it can reach one and the bare
    // table when it cannot, so both shapes have to resolve to the same tables.
    const tables = root.matches?.(TABLE_SELECTOR) ? [root] : [...root.querySelectorAll(TABLE_SELECTOR)];

    let linked = 0;
    for (const el of tables.flatMap((table) => [...table.querySelectorAll(NAME_SELECTOR)])) {
        if (el.dataset?.[LINKED_FLAG]) continue;
        const name = (el.getAttribute('data-name') || el.textContent || '').trim();
        if (!name || !VALID_PLAYER_NAME_RE.test(name)) continue;

        if (el.dataset) el.dataset[LINKED_FLAG] = '1';
        el.style.cursor = 'pointer';
        if (!el.title) el.title = `Open ${name}'s profile`;
        // Hover underline, the same affordance chat's profile links use — but
        // inline, because the colour here belongs to the game's own cell.
        el.addEventListener('mouseenter', () => {
            el.style.textDecoration = 'underline';
        });
        el.addEventListener('mouseleave', () => {
            el.style.textDecoration = '';
        });
        el.addEventListener('click', (event) => {
            event.stopPropagation();
            openPlayerProfile(name, { logPrefix: 'GuildTrialStatsModal' });
        });
        linked += 1;
    }
    return linked;
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
            // After the capture, because the reading is of the game's own markup
            // and this adds decoration to it. Runs whether or not the capture
            // found anything: a name is worth linking even on a tab whose
            // figures this module cannot use.
            try {
                linkMemberNames(modal || table);
            } catch (error) {
                console.error('[GuildTrialStatsModal] Failed to link member names:', error);
            }
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
            this.statsByTrial.set(parsed.trialName, {
                kind: parsed.kind,
                columns: parsed.columns,
                members: parsed.members,
                at: Date.now(),
            });
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
     * A combat trial's per-member totals, flattened for reconciliation.
     *
     * Returns null unless the captured modal was a combat one (the skilling modal
     * carries no damage/healing/taken columns), so callers can fall back to the
     * streamed figures unchanged.
     *
     * @param {string} trialName - e.g. "Trial Jellyfish"
     * @returns {Array<{name: string, damage: number|null, healing: number|null,
     *   damageTaken: number|null}>|null} Per-member totals, or null
     */
    getCombatStats(trialName) {
        const stats = this.statsByTrial.get(trialName);
        if (!stats || stats.kind !== 'combat') return null;
        return stats.members.map((member) => ({
            name: member.name,
            damage: member.values.damage ?? null,
            healing: member.values.healing ?? null,
            damageTaken: member.values.damageTaken ?? null,
        }));
    }

    /**
     * Forget every captured reading, for a character or guild switch.
     *
     * Captures are keyed by trial NAME alone — no guild or character scoping —
     * because the modal itself carries none. Two guilds routinely run the same
     * combat trial in the same week, and the scoreboard's reconciliation
     * (`guild-trial-scoreboard.js`) reads straight off this cache by trial name,
     * so leaving it standing across a switch hands the arriving guild's card the
     * departing guild's captured member totals under names that mean nothing
     * there — the same shape of leak `guild-trial-skilling.js`'s socket cache
     * had. The listener itself stays wired; only the readings are dropped.
     */
    reset() {
        this.statsByTrial.clear();
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
