/**
 * What changed between the build you had and the build you have.
 *
 * The interesting decision is what counts as "new". Version numbers cannot be
 * trusted for it: this is a fork, forks share numbering with upstream, and two
 * scripts both calling themselves 2.88.0 can be entirely different code. So the
 * version string only decides *whether* to speak; **the settings schema itself
 * decides what to say**. The stored list of setting IDs the user has already
 * been shown is diffed against the schema that just loaded, and whatever was
 * never shown before is new — whichever fork it arrived from, whatever number
 * it wore.
 *
 * Pure functions, because the popup is the least interesting part of this and
 * the diff is the part that must be right.
 */

/**
 * Which fork+version this build is, as one comparable identity.
 *
 * The pair rather than the version alone: upstream and this fork share version
 * numbers, so "2.88.0 → 2.88.0" can still be a different script. A change in
 * either half is an update worth announcing.
 *
 * @param {{fork?: string, version?: string}} [source] - Usually `window.Toolasha`
 * @returns {{fork: string, version: string}}
 */
export function buildIdentity(source = {}) {
    return {
        fork: String(source.fork || 'unknown-fork'),
        version: String(source.version || '0.0.0'),
    };
}

/**
 * Whether the build changed since the state was last saved.
 *
 * @param {{fork: string, version: string}|null} stored - From storage; null on first run
 * @param {{fork: string, version: string}} current - From `buildIdentity`
 * @returns {boolean}
 */
export function identityChanged(stored, current) {
    if (!stored) return false;
    return stored.fork !== current.fork || stored.version !== current.version;
}

/**
 * The update, described the way a person would ask about it.
 *
 * A same-fork bump reads as an update; a fork change is called out as one,
 * because "switched from Celasha/Toolasha 2.88.0" answers a question that
 * "updated to 2.88.0" would actively hide — the number may not even change.
 *
 * A same-fork, same-version case exists too — a dev build, or any release that
 * adds settings without a version bump — and "Updated 3.40.0 → 3.40.0" would
 * be nonsense there: nothing about the *version* updated. The popup still only
 * appears because there is something new to show, so it is described as that:
 * `New in 3.40.0`, true whether this is a dev build or a real release.
 *
 * @param {{fork: string, version: string}|null} stored - Previous identity
 * @param {{fork: string, version: string}} current - This build
 * @returns {string} e.g. `Updated 2.88.0 → 2.89.0`, `New in 2.88.0`, or
 *   `Switched from Celasha/Toolasha 2.88.0`
 */
export function describeUpdate(stored, current) {
    if (!stored) return `Version ${current.version}`;
    if (stored.fork !== current.fork) {
        return `Switched from ${stored.fork} ${stored.version} (now ${current.fork} ${current.version})`;
    }
    if (stored.version === current.version) {
        return `New in ${current.version}`;
    }
    return `Updated ${stored.version} → ${current.version}`;
}

/**
 * The setting IDs this user has never been shown.
 *
 * @param {Array<string>} schemaIds - Every ID in the current schema
 * @param {Array<string>} knownIds - Every ID the user has been shown before
 * @returns {Array<string>} New since last time, in schema order
 */
export function newSettingIds(schemaIds, knownIds) {
    const known = new Set(knownIds || []);
    return (schemaIds || []).filter((id) => !known.has(id));
}

/**
 * Which of the new settings should be forced off, under the conservative policy.
 *
 * Only switches that arrive **on**: a new checkbox defaulting to true is the
 * update changing behaviour unasked, which is precisely what the policy exists
 * to stop. Numbers and dropdowns keep their defaults — a number has to be
 * something, and a default value is not a feature switching itself on.
 *
 * Never applied without a baseline: on a first run every setting in the schema
 * is "new", and forcing the lot off would disable the whole script on install.
 *
 * @param {Array<string>} newIds - From `newSettingIds`
 * @param {Function} lookup - id → schema entry ({type, default, ...}) or null
 * @returns {Array<string>} IDs to persist as off
 */
export function conservativeOverrides(newIds, lookup) {
    const overrides = [];
    for (const id of newIds || []) {
        const entry = lookup(id);
        if (!entry) continue;
        const type = entry.type || 'checkbox';
        if (type === 'checkbox' && entry.default === true) overrides.push(id);
    }
    return overrides;
}

/**
 * Settings that already existed, were off for the people who never turned them on, and are worth
 * one more look after a change that makes them more useful. Each is offered once per `round`, in the
 * update popup, with its live switch, and is never switched on for anyone. Raising an entry's `round`
 * offers it again to players who have it off, including those who saw an earlier round.
 *
 * - `simulateScrollEffects` (round 2): the scroll chips now sit on every action panel. A new player
 *   starts with nothing selected, but a player who chose scrolls in Defaults... or the Loadouts panel
 *   while it was off has them applied the moment it is switched on, so the popup says how many are
 *   chosen. Round 2 is worth another look for anyone who passed on it the first time, now that the
 *   Scroll Planner feeds the same scrolls.
 *
 * - `networth_abilityBooksAsInventory` (round 1): now on for new players. Existing players keep their
 *   split, and are reminded once that books can count as Current Assets. Total net worth is the same
 *   either way.
 *
 * - `scrollPlanner` (round 1): plans and steps through opening scrolls. Only a player who turned it
 *   off sees it; worth another look next to the scroll simulation.
 *
 * Not `newSettingIds`: those were never shown. These were, and nothing about them is new. Not
 * `conservativeOverrides` either, which switches things off; nothing here changes a value.
 *
 * Stored form (`offeredIds`): round 1 is the plain id, exactly as before rounds existed; round N > 1
 * is `id#N`. A plain id therefore reads as round 1 in every build, and an older build ignores the
 * `#N` keys it does not know.
 *
 * @type {ReadonlyArray<{id: string, round: number}>}
 */
export const REOFFERED_SETTINGS = Object.freeze([
    Object.freeze({ id: 'simulateScrollEffects', round: 2 }),
    Object.freeze({ id: 'networth_abilityBooksAsInventory', round: 1 }),
    Object.freeze({ id: 'scrollPlanner', round: 1 }),
]);

/**
 * Normalize a list entry: a bare string is round 1.
 * @param {string|{id: string, round?: number}} entry
 * @returns {{id: string, round: number}}
 */
function toEntry(entry) {
    if (typeof entry === 'string') return { id: entry, round: 1 };
    const round = Number.isInteger(entry?.round) && entry.round > 1 ? entry.round : 1;
    return { id: entry?.id, round };
}

/**
 * The key one round of one setting is stored under.
 * @param {string} id - The setting id
 * @param {number} round - The round, 1 or more
 * @returns {string} The plain id for round 1, `id#round` after
 */
export function offerKey(id, round) {
    return round > 1 ? `${id}#${round}` : id;
}

/**
 * The re-offered settings this player has not been shown yet.
 *
 * @param {Array<string|{id: string, round: number}>} reoffered - The list to offer (`REOFFERED_SETTINGS`)
 * @param {Array<string>|undefined} offeredIds - Keys already offered, from the saved state; absent in a
 *   state written before this field existed. A plain id counts as round 1.
 * @returns {Array<string>} Setting ids not yet offered at their current round, in list order
 */
export function unofferedSettingIds(reoffered, offeredIds) {
    const offered = new Set(Array.isArray(offeredIds) ? offeredIds : []);
    return (reoffered || [])
        .map(toEntry)
        .filter(({ id, round }) => !offered.has(offerKey(id, round)))
        .map(({ id }) => id);
}

/**
 * Which re-offered settings to show now: not yet offered at the current round, and off right now. One
 * that is on has nothing to offer; it is still marked as offered (see `unofferedSettingIds`), so
 * switching it off later does not bring the offer back.
 *
 * @param {Array<string|{id: string, round: number}>} reoffered - The list to offer (`REOFFERED_SETTINGS`)
 * @param {Array<string>|undefined} offeredIds - Keys already offered, from the saved state
 * @param {(id: string) => boolean} isOn - Whether the setting is on for this character
 * @returns {Array<string>} Setting ids to show, in list order
 */
export function reofferedSettingIds(reoffered, offeredIds, isOn) {
    return unofferedSettingIds(reoffered, offeredIds).filter((id) => !isOn(id));
}

/**
 * The offered list to save: what was recorded, plus every round up to the current one for everything
 * on the list. Lower rounds are recorded too, so an older build that knows only the plain id never
 * offers a setting again that this build already asked about.
 *
 * @param {Array<string>|undefined} offeredIds - Keys already offered, from the saved state
 * @param {Array<string|{id: string, round: number}>} reoffered - The list (`REOFFERED_SETTINGS`)
 * @returns {Array<string>} Union, recorded keys first. Keys no longer on the list are kept, so a
 *   later build that reuses one does not offer it to someone who was already asked
 */
export function markOffered(offeredIds, reoffered) {
    const result = Array.isArray(offeredIds) ? [...offeredIds] : [];
    for (const entry of reoffered || []) {
        const { id, round } = toEntry(entry);
        for (let r = 1; r <= round; r++) {
            const key = offerKey(id, r);
            if (!result.includes(key)) result.push(key);
        }
    }
    return result;
}
