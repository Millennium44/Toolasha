/**
 * Notice policy
 *
 * The "how loudly, and when" half of a notification, kept apart from the
 * service that delivers it.
 *
 * Every question this file answers is a pure function of an event key, a clock
 * and a couple of settings strings — which category a notice belongs to,
 * whether that category is allowed to interrupt, whether the wall clock is
 * inside the player's quiet window, and what a pile of batched notices reads as
 * in one line. None of it touches the DOM, storage or `Notification`, so all of
 * it can be tested without a browser, and the service stays a delivery
 * mechanism rather than a policy engine.
 *
 * ## Why the category is derived and not passed in
 *
 * Sixteen features call `notify`, and every one of them already names its event
 * — `market-undercut-1234`, `community-buff-expiring:…`, `task-slots:full`.
 * Asking each to also declare a category would be sixteen edits to features
 * whose job is deciding *what* to say, for information their event key already
 * carries. The table below reads the key instead, so digesting and quiet hours
 * arrived without a single alert feature changing its mind about anything.
 */

/**
 * The categories a notice can belong to.
 *
 * The key is what a settings allow-list is written in, the label is what the
 * digest line says. Kept short deliberately: a summary reading "Market: 3
 * undercuts" only works while the category name is a word, not a sentence.
 */
export const CATEGORIES = {
    market: 'Market',
    buffs: 'Buffs',
    consumables: 'Consumables',
    queue: 'Queue',
    combat: 'Combat',
    tasks: 'Tasks',
    labyrinth: 'Labyrinth',
    guild: 'Guild',
    skills: 'Skills',
    enhancement: 'Enhancement',
    progress: 'Progress',
    other: 'Other',
};

/**
 * Event key prefix → what kind of thing it is.
 *
 * `noun` is what the digest counts. Singular and plural are both spelled out
 * because half of these do not pluralise by adding an s ("1 lapsing", "3
 * lapsing"), and a summary that says "3 lapsings" reads as a bug.
 *
 * Matched longest-prefix-first, so a key that extends another key's prefix
 * still lands on its own row.
 */
export const NOTICE_KINDS = [
    { prefix: 'market-undercut', category: 'market', noun: { one: 'undercut', many: 'undercuts' } },
    { prefix: 'market-listing-filled', category: 'market', noun: { one: 'filled listing', many: 'filled listings' } },
    { prefix: 'community-buff-expiring', category: 'buffs', noun: { one: 'lapsing', many: 'lapsing' } },
    { prefix: 'combat-consumable-low', category: 'consumables', noun: { one: 'running dry', many: 'running dry' } },
    { prefix: 'consumable-low', category: 'consumables', noun: { one: 'running dry', many: 'running dry' } },
    { prefix: 'empty-queue', category: 'queue', noun: { one: 'queue empty', many: 'queue empty' } },
    { prefix: 'combat-death', category: 'combat', noun: { one: 'death', many: 'deaths' } },
    { prefix: 'task-slots', category: 'tasks', noun: { one: 'slot warning', many: 'slot warnings' } },
    { prefix: 'labyrinth-entry', category: 'labyrinth', noun: { one: 'entry ready', many: 'entries ready' } },
    { prefix: 'labyrinth-stopped', category: 'labyrinth', noun: { one: 'run finished', many: 'runs finished' } },
    { prefix: 'guild-trial-start', category: 'guild', noun: { one: 'trial starting', many: 'trials starting' } },
    { prefix: 'guild-trial-results', category: 'guild', noun: { one: 'trial finished', many: 'trials finished' } },
    { prefix: 'skill-levelup', category: 'skills', noun: { one: 'level up', many: 'level ups' } },
    { prefix: 'enhancement-target', category: 'enhancement', noun: { one: 'target reached', many: 'targets reached' } },
    { prefix: 'ttl-target', category: 'progress', noun: { one: 'target reached', many: 'targets reached' } },
];

/** Longest first, so `combat-consumable-low` never answers to `combat-death`'s row by accident */
const KINDS_BY_LENGTH = [...NOTICE_KINDS].sort((a, b) => b.prefix.length - a.prefix.length);

/** Categories that may interrupt regardless of digesting or quiet hours, out of the box */
export const DEFAULT_CRITICAL_CATEGORIES = 'combat, queue, consumables';

/** Categories that batch when digest mode is on, out of the box */
export const DEFAULT_DIGEST_CATEGORIES = 'market, buffs, tasks, labyrinth, guild, skills, enhancement, progress, other';

/** How many subjects a digest line names before it gives up and counts */
export const DIGEST_SUBJECT_LIMIT = 3;

/**
 * Which kind of thing an event key names.
 * @param {string} eventKey - As handed to `notify`
 * @returns {{prefix: string, category: string, noun: {one: string, many: string}}} The row, or the `other` fallback
 */
export function kindForEventKey(eventKey) {
    const key = String(eventKey ?? '');
    const found = KINDS_BY_LENGTH.find((kind) => key.startsWith(kind.prefix));
    return found || { prefix: '', category: 'other', noun: { one: 'notice', many: 'notices' } };
}

/**
 * Which category an event key belongs to.
 * @param {string} eventKey - As handed to `notify`
 * @returns {string} A key of {@link CATEGORIES}
 */
export function categoryForEventKey(eventKey) {
    return kindForEventKey(eventKey).category;
}

/**
 * The display name of a category.
 * @param {string} category - Category key
 * @returns {string} Label, or the key itself if it is one we do not know
 */
export function categoryLabel(category) {
    return CATEGORIES[category] || String(category || 'Other');
}

/**
 * Read a comma-separated allow-list into a set.
 *
 * Forgiving on purpose — this is a text box a player types into, so spaces,
 * capitals, empty entries and trailing commas all have to mean nothing.
 *
 * @param {string} value - The setting's text
 * @returns {Set<string>} Lower-cased category keys
 */
export function parseCategoryList(value) {
    return new Set(
        String(value ?? '')
            .split(',')
            .map((part) => part.trim().toLowerCase())
            .filter(Boolean)
    );
}

/**
 * Whether a category is allowed to interrupt.
 *
 * The one thing this whole feature must not break: dying, running out of queue
 * and running out of drinks are the notifications the player switched the
 * script on for, and burying them in a fifteen-minute summary or behind quiet
 * hours would make the feature a downgrade.
 *
 * @param {string} category - Category key
 * @param {string} allowList - The critical-categories setting
 * @returns {boolean} True when it bypasses digesting and quiet hours
 */
export function isCriticalCategory(category, allowList) {
    return parseCategoryList(allowList).has(String(category || '').toLowerCase());
}

/**
 * Whether a category batches when digest mode is on.
 * @param {string} category - Category key
 * @param {string} allowList - The digest-categories setting
 * @returns {boolean} True when its notices should be held for the summary
 */
export function isDigestCategory(category, allowList) {
    return parseCategoryList(allowList).has(String(category || '').toLowerCase());
}

/**
 * A `HH:MM` string as minutes past local midnight.
 * @param {string} value - e.g. `23:00`
 * @returns {number|null} Minutes, or null when it is not a time
 */
export function parseTimeOfDay(value) {
    const match = /^\s*(\d{1,2})\s*:\s*(\d{2})\s*$/.exec(String(value ?? ''));
    if (!match) return null;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!(hours >= 0 && hours <= 23) || !(minutes >= 0 && minutes <= 59)) return null;
    return hours * 60 + minutes;
}

/**
 * Whether a moment falls inside a quiet window.
 *
 * Local wall-clock minutes on both sides, never elapsed time: quiet hours are
 * "do not wake me between eleven and seven", and that means eleven and seven on
 * the clock on the wall — through a daylight-saving change, on a machine whose
 * timezone the player has just changed, and on the day the offset shifts by
 * half an hour. Comparing `Date` objects would make the window an hour wrong
 * twice a year; comparing minutes-past-midnight cannot.
 *
 * A window whose ends are equal is empty rather than eternal. "From 23:00 to
 * 23:00" is far more likely to be a half-finished setting than a request to be
 * silenced for twenty-four hours.
 *
 * @param {Date|number} when - The moment to test
 * @param {string} start - `HH:MM`, inclusive
 * @param {string} end - `HH:MM`, exclusive
 * @returns {boolean} True when the moment is inside the window
 */
export function isWithinQuietHours(when, start, end) {
    const from = parseTimeOfDay(start);
    const to = parseTimeOfDay(end);
    if (from === null || to === null || from === to) return false;

    const date = when instanceof Date ? when : new Date(when);
    if (Number.isNaN(date.getTime())) return false;
    const minutes = date.getHours() * 60 + date.getMinutes();

    // A window that does not cross midnight is one interval; one that does is
    // the two intervals either side of it, which is the case worth having a
    // function for at all
    return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * Turn a batch of held notices into the one line that replaces them.
 *
 * Grouped by category and then by kind, because the reader wants "how much of
 * what" and not a transcript — the transcript is in the log, which is where the
 * batched notices went individually. Subjects are named up to a limit and then
 * counted, since a line that lists eleven item names is a line nobody finishes.
 *
 * @param {Array<{category: string, noun: {one: string, many: string}, subject?: string}>} entries - Held notices
 * @returns {string} e.g. `Market: 3 undercuts (Cheese, Milk, Flax) · Buffs: 1 lapsing`
 */
export function summarizeDigest(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';

    /** category → noun label → {count, subjects, noun} */
    const byCategory = new Map();
    for (const entry of entries) {
        if (!entry) continue;
        const category = entry.category || 'other';
        if (!byCategory.has(category)) byCategory.set(category, new Map());

        const kinds = byCategory.get(category);
        const noun = entry.noun || { one: 'notice', many: 'notices' };
        if (!kinds.has(noun.one)) kinds.set(noun.one, { count: 0, subjects: [], noun });

        const kind = kinds.get(noun.one);
        kind.count += 1;
        // A repeated subject is one thing that keeps being reported, not two
        // things — the same listing undercut twice is still one listing
        if (entry.subject && !kind.subjects.includes(entry.subject)) kind.subjects.push(entry.subject);
    }

    const parts = [];
    for (const [category, kinds] of byCategory) {
        const pieces = [];
        for (const { count, subjects, noun } of kinds.values()) {
            const named = subjects.slice(0, DIGEST_SUBJECT_LIMIT).join(', ');
            const rest = subjects.length - DIGEST_SUBJECT_LIMIT;
            const tail = named ? ` (${named}${rest > 0 ? `, +${rest}` : ''})` : '';
            // Distinct subjects when there are any, entries when there are not.
            // The de-duplication above already decided that the same listing
            // undercut twice is one listing; leaving the count at the number of
            // entries said "3 undercuts (Cheese)", which names one thing and
            // claims three
            const shown = subjects.length ? subjects.length : count;
            pieces.push(`${shown} ${shown === 1 ? noun.one : noun.many}${tail}`);
        }
        parts.push(`${categoryLabel(category)}: ${pieces.join(', ')}`);
    }

    return parts.join(' · ');
}
