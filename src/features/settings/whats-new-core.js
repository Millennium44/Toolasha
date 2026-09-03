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
