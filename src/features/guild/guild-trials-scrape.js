/**
 * Reading the guild "In Progress" tab.
 *
 * The trial state a member can see is on the screen, and — as far as anything
 * this script can observe — only on the screen. The socket carries who signed up
 * (`guild_trial_signup_updated`, and `signedUpSkillingTrialHrid` /
 * `signedUpCombatTrialHrid` on every guild character) and when the week started
 * (`guild.currentWeekStartAt`), but nothing that has been seen carries a running
 * trial's pool fill or a trial boss's health. A participant's own client gets
 * `new_battle` and `battle_updated` for the fight they are in; everybody else in
 * the guild gets the panel. So the panel is what is read, and the socket is used
 * where it is authoritative.
 *
 * ## Why this parses shapes rather than class names
 *
 * The one class name this can lean on is `GuildPanel_tileSummary`, which is
 * already load-bearing elsewhere in the codebase (`guild-credit-value.js` tags
 * tier badges onto it) and carries the `Lv.<n>` the tier is derived from. The
 * rest of the tab's class names have not been verified against a live client, so
 * everything else is found by shape: a tile is whatever element holds a summary,
 * a progress reading is any `<n> / <n>` in the tile's text, and the two readings
 * on a combat card are told apart by which of them *moves which way* over time
 * rather than by which comes first in the markup.
 *
 * That caution turned out to be warranted and not cautious enough. The whole
 * feature was hung off one *unverified* container class — `GuildPanel_trialsContent`
 * — and if the game does not spell it that way, every reading, every projection
 * and the overlay tile that reads from them are all dark at once, silently,
 * with no error anywhere: the observer simply never fires and the interval's
 * `querySelector` simply never matches. Which is what was reported during a live
 * trial. So the container is now *found* rather than named: {@link findTrialsRoot}
 * prefers the class if it exists and otherwise falls back to the guild panel
 * itself, and {@link readTrialTiles} is safe to point at a whole panel because a
 * tile only counts as a trial when its level lands on the trial ladder — a guild
 * building's "Lv. 10 / 20" is below the first tier's level 100 and drops out,
 * which is the same discriminator `guild-credit-value.js` already uses to decide
 * which tile summaries get a tier badge.
 *
 * That last one matters: the observed combat card shows both a small falling
 * number over a large one (boss health) and a large rising number over a round
 * one. Assuming an order would silently invert every rate the moment the game
 * reflowed the card. Direction cannot be got wrong.
 *
 * Nothing here mutates the DOM — it only reads. The feature module does the
 * drawing.
 */

import { COMBAT_ENCOUNTERS, tierFromLevel } from './guild-trials-math.js';

/** Suffix multipliers on abbreviated numbers the game renders in bars */
const SUFFIXES = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * A number as the game writes it: `618000`, `618,000`, `618K`, `1.2M`.
 * @param {string} raw - Text
 * @returns {number|null} The number, or null when it is not one
 */
export function parseAmount(raw) {
    if (typeof raw !== 'string') return null;
    const match = raw.trim().match(/^([\d,]*\.?\d+)\s*([kmbt])?$/i);
    if (!match) return null;

    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;

    const suffix = match[2]?.toLowerCase();
    return suffix ? value * SUFFIXES[suffix] : value;
}

/**
 * Every `current / max` reading in a blob of text, in the order they appear.
 *
 * Text rather than elements because the readings have been seen both inside a
 * progress-bar label and as loose text beside one, and a reading that is only
 * found in one of those two placements is a reading that vanishes on a redesign.
 *
 * @param {string} text - Text to scan
 * @returns {Array<{current: number, max: number}>} Readings, in document order
 */
export function parseBarReadings(text) {
    if (typeof text !== 'string') return [];

    const readings = [];
    const pattern = /([\d,]*\.?\d+\s*[kmbt]?)\s*\/\s*([\d,]*\.?\d+\s*[kmbt]?)/gi;
    let match = pattern.exec(text);
    while (match) {
        const current = parseAmount(match[1]);
        const max = parseAmount(match[2]);
        // A max of zero is a bar that has not been populated, not a full one
        if (Number.isFinite(current) && Number.isFinite(max) && max > 0) {
            readings.push({ current, max });
        }
        match = pattern.exec(text);
    }
    return readings;
}

/**
 * The trial level a tile is showing, from its `Lv.<n>` summary.
 * @param {string} text - Tile text
 * @returns {number|null} Level, or null when the tile does not carry one
 */
export function parseTrialLevel(text) {
    const match = typeof text === 'string' ? text.match(/Lv\.?\s*(\d+)/i) : null;
    if (!match) return null;
    const level = Number(match[1]);
    return Number.isFinite(level) ? level : null;
}

/**
 * A `mm:ss` or `h:mm:ss` clock, in milliseconds.
 * @param {string} text - Text to scan
 * @returns {number|null} Milliseconds, or null when there is no clock in it
 */
export function parseClockMs(text) {
    const match = typeof text === 'string' ? text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})\b/) : null;
    if (!match) return null;

    const hours = match[1] ? Number(match[1]) : 0;
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (![hours, minutes, seconds].every(Number.isFinite)) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Whether a trial name is one of the five combat encounters.
 * @param {string} name - Trial name, e.g. `Trial Chameleon`
 * @returns {boolean} True for a combat trial
 */
export function isCombatTrialName(name) {
    const lowered = String(name || '').toLowerCase();
    return COMBAT_ENCOUNTERS.some((encounter) => lowered.includes(encounter));
}

/**
 * Match a displayed trial name against the hrids the socket reports sign-ups for.
 *
 * The sign-up messages carry hrids (`signedUpCombatTrialHrid`) and the panel
 * carries names, and nothing carries both. Comparing the hrid's last segment to
 * the name with everything but letters stripped joins them without needing a
 * table that would go stale the first time a trial was renamed.
 *
 * @param {string} name - Displayed name
 * @param {string[]} hrids - Candidate hrids
 * @returns {string|null} The matching hrid, or null
 */
export function matchTrialHrid(name, hrids) {
    const normalise = (value) =>
        String(value || '')
            .toLowerCase()
            .replace(/[^a-z]/g, '');
    const target = normalise(name);
    if (!target) return null;

    for (const hrid of hrids || []) {
        const tail = normalise(String(hrid).split('/').pop());
        if (!tail) continue;
        if (target.includes(tail) || tail.includes(target)) return hrid;
    }
    return null;
}

/**
 * Class names the trials tab might carry, most specific first.
 *
 * Two spellings rather than one because only the *shape* of the tab has been
 * observed, not its markup: the members tab is `GuildPanel_membersTab` and the
 * overview `GuildPanel_overviewTab`, so `trialsTab` is at least as likely as the
 * `trialsContent` this was written against.
 */
const TRIALS_ROOT_CLASSES = ['GuildPanel_trialsContent', 'GuildPanel_trialsTab'];

/**
 * Where to look for trial tiles.
 *
 * The named container when the game has one, and the guild panel as a whole when
 * it does not. Falling back to the panel is safe because {@link readTrialTiles}
 * only accepts tiles whose level is on the trial ladder, and it is what stops
 * one unverified class name from taking the entire feature offline.
 *
 * `querySelector` returns the first match in document order, and an ancestor
 * always precedes its descendants — so the guild-panel fallback is the outermost
 * `GuildPanel_*` element rather than whichever small child happens to match.
 *
 * @param {Document|Element} [scope] - Where to look
 * @returns {Element|null} The narrowest container known to hold the tiles, or null
 */
export function findTrialsRoot(scope = typeof document === 'undefined' ? null : document) {
    if (!scope || typeof scope.querySelector !== 'function') return null;

    for (const className of TRIALS_ROOT_CLASSES) {
        const named = scope.querySelector(`[class*="${className}"]`);
        if (named) return named;
    }
    // No tiles anywhere means the guild panel is on another tab, and handing
    // back the panel would only make the caller scrape it for nothing
    if (!scope.querySelector('[class*="GuildPanel_tileSummary"]')) return null;
    return scope.querySelector('[class*="GuildPanel"]');
}

/**
 * The tiles on the In Progress tab.
 *
 * A tile is an element containing a `GuildPanel_tileSummary`; the outermost such
 * element wins, so a summary nested two levels deep still yields one tile rather
 * than two. Tiles without a level are dropped — a card with no `Lv.` on it is
 * not a trial — and so are tiles whose level is below the first tier's, which is
 * what keeps a guild building's "Lv. 10 / 20" out when the root being scraped is
 * a whole guild panel rather than the trials tab.
 *
 * @param {Element} root - The `GuildPanel_trialsContent` element, or any ancestor
 * @returns {Array<{element: Element, name: string, level: number, tier: number|null,
 *   kind: 'combat'|'skilling', readings: Array<{current: number, max: number}>}>} Tiles, in document order
 */
export function readTrialTiles(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];

    const summaries = Array.from(root.querySelectorAll('[class*="GuildPanel_tileSummary"]'));
    const tiles = [];
    const seen = new Set();

    for (const summary of summaries) {
        // Climb to the card the summary belongs to. The `:not` matters: the
        // summary's own class starts `GuildPanel_tileSummary`, so a bare
        // `[class*="GuildPanel_tile"]` matches the summary itself and every card
        // collapses to its level line.
        const tile =
            summary.closest('[class*="GuildPanel_tile"]:not([class*="GuildPanel_tileSummary"])') ||
            summary.parentElement ||
            summary;
        if (seen.has(tile)) continue;
        seen.add(tile);

        const lines = textLines(tile);

        // Per element, never off the whole card. `textContent` welds siblings
        // together with no separator: a card holding "Lv.110" beside a bar
        // holding "1.2M / 4M" reads as `Lv.1101.2M / 4M`, which parses as level
        // 1,101 and a current of 1,101,200,000. Both wrong, neither obviously so.
        const level = lines.map(parseTrialLevel).find((candidate) => candidate !== null) ?? null;
        if (level === null) continue;

        // Below the trial ladder is a guild building, not a trial
        const tier = tierFromLevel(level);
        if (tier === null) continue;

        const name = readTileName(tile, summary, lines);
        tiles.push({
            element: tile,
            name,
            level,
            tier,
            kind: isCombatTrialName(name) ? 'combat' : 'skilling',
            readings: lines.flatMap(parseBarReadings),
        });
    }

    return tiles;
}

/**
 * A card's text, one entry per element that actually holds text.
 *
 * The leaves are what the game rendered as separate runs; joining them, which is
 * what `textContent` does, invents numbers that were never on the screen. A card
 * whose whole content is one text node still yields one line, so the caller does
 * not need a special case for it.
 *
 * @param {Element} tile - The tile
 * @returns {string[]} Trimmed, non-empty texts, in document order
 */
export function textLines(tile) {
    const nodes = [tile, ...Array.from(tile.querySelectorAll?.('*') || [])];
    const lines = [];
    for (const node of nodes) {
        if (node.childElementCount > 0) continue;
        const text = (node.textContent || '').trim();
        if (text) lines.push(text);
    }
    return lines;
}

/**
 * A tile's trial name.
 *
 * Taken from a name element when the markup offers one. Failing that, from the
 * line that carries the level marker with words in front of it — "Trial
 * Jellyfish Lv.170" — because that is where a name provably is, whereas "the
 * first line that is not the summary" is only where a name usually is: on a card
 * whose summary holds both the name and the level, that rule picks up the
 * progress bar instead and calls the trial "1.2M / 4M", which then classifies as
 * skilling and matches no sign-up hrid. Only when neither is available does it
 * fall back to the first line that is not the summary.
 *
 * @param {Element} tile - The tile
 * @param {Element} summary - Its summary element
 * @param {string[]} lines - The card's text lines, from {@link textLines}
 * @returns {string} The name, or an empty string
 */
function readTileName(tile, summary, lines) {
    const named = tile.querySelector?.('[class*="GuildPanel_tileName"], [class*="GuildPanel_name"]');
    if (named?.textContent?.trim()) return named.textContent.trim();

    const levelMarker = /Lv\.?\s*\d+/i;
    for (const line of lines) {
        if (!levelMarker.test(line)) continue;
        const beforeLevel = line.split(levelMarker)[0].trim();
        if (beforeLevel) return beforeLevel;
    }

    const summaryText = summary?.textContent?.trim() || '';
    const first = lines.find((line) => line !== summaryText) || summaryText;
    return first.split(levelMarker)[0].trim() || first;
}

/**
 * Which reading on a tile is the boss health and which is the shared pool.
 *
 * Decided from movement, not position: over two or more samples the boss bar's
 * `current` falls and the pool bar's rises. Before there is movement to read,
 * a single reading is called by its trial kind and a pair is left unclassified
 * rather than guessed at.
 *
 * @param {Array<Array<{current: number, max: number}>>} history - Readings per sample, oldest first
 * @param {'combat'|'skilling'} kind - What the trial is
 * @returns {{bossIndex: number|null, poolIndex: number|null}} Indices into a tile's readings
 */
export function classifyReadings(history, kind) {
    const samples = (history || []).filter(Array.isArray);
    const width = samples.reduce((max, sample) => Math.max(max, sample.length), 0);
    if (width === 0) return { bossIndex: null, poolIndex: null };

    let bossIndex = null;
    let poolIndex = null;

    for (let index = 0; index < width; index += 1) {
        let fell = 0;
        let rose = 0;
        for (let step = 1; step < samples.length; step += 1) {
            const before = samples[step - 1][index]?.current;
            const after = samples[step][index]?.current;
            if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
            if (after < before) fell += 1;
            if (after > before) rose += 1;
        }
        if (fell > rose && bossIndex === null) bossIndex = index;
        if (rose > fell && poolIndex === null) poolIndex = index;
    }

    // No movement yet. One reading on a card is unambiguous from its kind; two
    // are not, and a coin flip here would invert a rate.
    if (bossIndex === null && poolIndex === null && width === 1) {
        if (kind === 'combat') bossIndex = 0;
        else poolIndex = 0;
    }

    return { bossIndex, poolIndex };
}
