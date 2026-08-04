/**
 * Combat session history
 *
 * The runs before this one, so the loot panel can be asked about them.
 *
 * The collector keeps exactly one snapshot — the run in progress — which is
 * everything the overlay needs and nothing the question "what did last night
 * actually earn" needs. FLoot answers that from a session list, and this is the
 * list.
 *
 * ## What counts as a session
 *
 * The same thing the damage tally counts: the roster and the server's
 * `combatStartTime` together. Either half alone is not enough — the same party
 * in a new zone is a new run, and the same zone with somebody gone is a
 * different run measuring different people.
 *
 * ## Archived on the way out, not on the way in
 *
 * A session is written to history when a *different* one starts, because that is
 * the first moment it is known to be over — nothing in the payload says "this
 * run has ended", and a timer would guess. The consequence is that the newest
 * finished run appears the moment the next one begins, and a run still under way
 * is never in the list. It does not need to be: it is the live session.
 *
 * The snapshot stored is the last one seen of that session, which is its final
 * state, since the loot totals only ever grow.
 */

import { readScoped, writeScoped } from '../../utils/character-key.js';

/**
 * Where the list lives.
 *
 * Scoped per character, and resolved at every read and write rather than once:
 * a run is one character's run, and the user switches characters without
 * reloading the page. The pre-scoping global list is adopted by the main
 * character the first time it is read.
 */
const STORE_KEY = 'combatSessionHistory';
const STORE_NAME = 'combatStats';

/**
 * How many runs to keep.
 *
 * Each carries a loot map and a consumable list, so this is kilobytes rather
 * than bytes per entry. Twenty is more sessions than anybody scrolls back
 * through and small enough not to be a thing that grows forever.
 */
export const MAX_SESSIONS = 20;

/**
 * Which run a snapshot belongs to.
 *
 * @param {Object} data - A collector snapshot, or a `new_battle` payload
 * @returns {string|null} A key, or null when it cannot say
 */
export function sessionKey(data) {
    const players = data?.players || [];
    if (!players.length || !data?.combatStartTime) return null;

    const roster = players.map((player) => player?.name || player?.character?.name || '?').join(',');
    return `${roster}|${data.combatStartTime}`;
}

/**
 * Fold a snapshot into a list, newest first.
 *
 * Pure, so the decisions worth arguing about are testable: a session already in
 * the list is replaced rather than repeated, because the later snapshot is the
 * more complete one — its loot totals include everything the earlier one had.
 *
 * @param {Array<Object>} history - The list as it stands
 * @param {Object} snapshot - A finished session
 * @returns {Array<Object>} A new list
 */
export function withSession(history, snapshot) {
    const key = sessionKey(snapshot);
    if (!key) return history || [];

    const rest = (history || []).filter((entry) => entry.key !== key);
    return [{ ...snapshot, key }, ...rest].slice(0, MAX_SESSIONS);
}

/**
 * Every finished run, newest first.
 * @returns {Promise<Array<Object>>}
 */
export async function loadSessions() {
    try {
        const saved = await readScoped(STORE_KEY, STORE_NAME, [], { migrate: 'adopt' });
        return Array.isArray(saved) ? saved : [];
    } catch (error) {
        console.error('[CombatSessionHistory] Reading the session list failed:', error);
        return [];
    }
}

/**
 * Add a finished run to the list.
 *
 * @param {Object} snapshot - The last state of the session that ended
 * @returns {Promise<Array<Object>>} The list as it now stands
 */
export async function archiveSession(snapshot) {
    try {
        const history = withSession(await loadSessions(), snapshot);
        await writeScoped(STORE_KEY, history, STORE_NAME, true);
        return history;
    } catch (error) {
        console.error('[CombatSessionHistory] Archiving a session failed:', error);
        return [];
    }
}

/** Forget every archived run. @returns {Promise<void>} */
export async function clearSessions() {
    try {
        await writeScoped(STORE_KEY, [], STORE_NAME, true);
    } catch (error) {
        console.error('[CombatSessionHistory] Clearing the session list failed:', error);
    }
}

/**
 * Several sessions added together, as one.
 *
 * Loot is summed per item and durations are added, which is what makes a
 * combined view answer "what has this zone paid me all week" rather than "what
 * did the best hour of it look like".
 *
 * The players are keyed by name rather than by position: across sessions a
 * position means nothing at all, and the same character appears in several.
 *
 * @param {Array<Object>} sessions - Snapshots
 * @returns {Object|null} One snapshot shaped like the others, or null for none
 */
export function combineSessions(sessions) {
    const usable = (sessions || []).filter((session) => session?.players?.length);
    if (!usable.length) return null;

    const byName = new Map();
    let durationSeconds = 0;

    for (const session of usable) {
        durationSeconds += session.durationSeconds || 0;

        for (const player of session.players) {
            const name = player?.name;
            if (!name) continue;

            if (!byName.has(name)) {
                byName.set(name, { ...player, loot: {}, experience: {}, deathCount: 0 });
            }
            const combined = byName.get(name);
            combined.deathCount += player.deathCount || 0;

            // Keyed by item rather than by the game's slot key: two sessions
            // number their slots independently, so merging on the raw key would
            // put the same item in two rows
            for (const entry of Object.values(player.loot || {})) {
                if (!entry?.itemHrid) continue;
                const held = combined.loot[entry.itemHrid] || { itemHrid: entry.itemHrid, count: 0 };
                held.count += entry.count || 0;
                combined.loot[entry.itemHrid] = held;
            }
        }
    }

    return {
        combatStartTime: usable[usable.length - 1].combatStartTime,
        durationSeconds,
        combined: true,
        sessionCount: usable.length,
        players: [...byName.values()],
    };
}

/**
 * A session as a line in a picker.
 *
 * @param {Object} session - A snapshot
 * @param {Function} [formatDuration] - Seconds to something readable
 * @returns {string}
 */
export function describeSession(session, formatDuration = (s) => `${Math.round(s / 60)}m`) {
    const started = session?.combatStartTime ? new Date(session.combatStartTime) : null;
    const when = started
        ? started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : 'Unknown time';

    return `${when} (${formatDuration(session?.durationSeconds || 0)})`;
}
