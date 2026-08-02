/**
 * Combat events
 *
 * What changed between two ticks of a fight, as a list of things that happened.
 *
 * The game does not send events. It sends the current state of every unit, every
 * tick, and "Bob hit the rat for 412" is the difference between two of those
 * states. Deriving it is small arithmetic with three ways to be wrong, which is
 * why it lives here with tests rather than inside the thing that draws it.
 *
 * ## The three wrong answers
 *
 * **Health going up is a heal, not negative damage.** Counting it as damage of
 * the other sign lets a healer cancel the party's output.
 *
 * **A unit that was not there last tick has not taken damage.** Its full health
 * is not a hit; it is a monster that has just spawned, and reporting it as a hit
 * for its entire health bar is the single most visible way to get this wrong.
 *
 * **A unit that has gone is not at zero health.** It died or the wave ended, and
 * the difference between those is not knowable from the state, so neither is
 * claimed — the unit simply stops producing events.
 *
 * The model is the Floating and Scrolling Combat Text tools' from MWI Combat
 * Suite by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

/**
 * Health changes between two snapshots of one side.
 *
 * @param {Object} current - This tick's unit map, `{id: {currentHitpoints}}`
 * @param {Map} previous - Last tick's health by id, **updated in place**
 * @param {string} side - `enemy` or `ally`, carried onto each event
 * @returns {Array<{id: string, side: string, amount: number, kind: string}>}
 *   `kind` is `damage` or `heal`; `amount` is always positive
 */
export function healthDeltas(current, previous, side = 'enemy') {
    const events = [];
    const seen = new Set();

    for (const [id, unit] of Object.entries(current || {})) {
        const health = Number(unit?.currentHitpoints);
        if (!Number.isFinite(health)) continue;

        seen.add(id);
        const before = previous.get(id);
        previous.set(id, health);

        // First sighting: a unit that has just spawned has not been hit for its
        // whole health bar, which is what comparing against nothing would say
        if (before === undefined) continue;

        const change = before - health;
        if (change === 0) continue;

        events.push({
            id,
            side,
            amount: Math.abs(change),
            kind: change > 0 ? 'damage' : 'heal',
        });
    }

    // A unit that has gone did not take its remaining health as damage — it died
    // or the wave ended, and the state cannot tell those apart
    for (const id of [...previous.keys()]) {
        if (!seen.has(id)) previous.delete(id);
    }
    return events;
}

/**
 * A bounded log, newest first.
 *
 * Bounded because a fight is a few events a second for as long as you leave it
 * running, and an unbounded list of them is a memory leak with a scrollbar.
 *
 * @param {number} [limit] - How many to keep
 * @returns {{add: Function, entries: Function, clear: Function}}
 */
export function createCombatLog(limit = 200) {
    let entries = [];

    return {
        /**
         * @param {Array<Object>} events - From `healthDeltas`
         * @param {number} at - Milliseconds since the epoch
         */
        add(events, at) {
            if (!events?.length) return;
            entries = [...events.map((event) => ({ ...event, at })), ...entries].slice(0, limit);
        },
        /** @returns {Array<Object>} Newest first */
        entries: () => entries,
        clear() {
            entries = [];
        },
    };
}
