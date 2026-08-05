/**
 * Reading the guild trial tabs.
 *
 * ## There are two of them, and they hold different halves of the answer
 *
 * Confirmed from a live client, which is what this file spent its first two
 * revisions guessing at. The guild page's nav is Overview, Members,
 * Applications, **Trials**, **In Progress**, Buildings, Shop, Icons — and the
 * two trial tabs are not two views of one thing:
 *
 * - **Trials** is the setup tab. Its cards carry the trial's name and level
 *   ("Milking Lv.130"), what clearing it is worth ("600 pts"), how many members
 *   have signed up ("1/28 signed up"), and a countdown ("20m 53s"). There is no
 *   progress bar anywhere on it.
 * - **In Progress** is the live tab. Its card carries the reading everything
 *   here exists to measure — "Alchemy 18,850 / 65,280" — beside the members
 *   working on it, and a footer with the trial's own clock ("Time: 20m 37s").
 *   It carries no level and no tier.
 *
 * So neither tab is sufficient. The rate comes from In Progress, the tier and
 * the participant count come from Trials, and they are joined by the one thing
 * both cards carry: the trial's name. Sampling either tab writes into the same
 * record under the same key, and a card with nothing moving on it updates the
 * trial's identity without pushing a reading — see `recordTileSample`.
 *
 * The cost of getting this wrong was two revisions of a feature that recorded
 * nothing: the first required a container class the game does not use, and the
 * second required every card to carry a progress bar, which is true of exactly
 * one of the two tabs.
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
 * trial. So the container is now *found* rather than named ({@link findTrialsRoot}),
 * and a card is found by its contents rather than by its container.
 *
 * What keeps that from reading the rest of the guild page as trials is the one
 * part of a card that is not a number: `isTrialName` knows the five encounters
 * and the ten skills a trial can be run in, and a card whose name is not one of
 * them is not a trial — not a building, not a guild XP bar, not a member row.
 * That is a stronger filter than the level ladder it replaces, and unlike the
 * ladder it survives a card that carries no level at all, which is every card on
 * the In Progress tab.
 *
 * That last one matters: the observed combat card shows both a small falling
 * number over a large one (boss health) and a large rising number over a round
 * one. Assuming an order would silently invert every rate the moment the game
 * reflowed the card. Direction cannot be got wrong.
 *
 * Nothing here mutates the DOM — it only reads. The feature module does the
 * drawing.
 */

import { COMBAT_ENCOUNTERS, TRIAL_MAX_TIER, isTrialName, tierFromLevel } from './guild-trials-math.js';

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

/** A line saying how many members have signed up, either way round */
const SIGNUP_PATTERN = /signed\s*up/i;

/**
 * How many members have signed up for a trial, from its card.
 *
 * The Trials tab writes it both ways round — "1/28 signed up" under a skilling
 * card and "Signed Up 3/56" under a combat one — so the ratio is looked for in a
 * line that says what it is rather than at a fixed position.
 *
 * This matters twice over. It is a better participant count than the socket's,
 * because it is the number the game itself is showing; and a ratio that is *not*
 * recognised as a sign-up count is a catastrophe rather than a gap, since
 * "1 / 28" has exactly the shape of a progress bar and would be sampled as one.
 *
 * @param {string} text - A card line
 * @returns {{signed: number, total: number}|null} The count, or null when the line is not one
 */
export function parseSignups(text) {
    if (typeof text !== 'string' || !SIGNUP_PATTERN.test(text)) return null;

    const match = text.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
    if (!match) return null;

    const signed = Number(match[1].replace(/,/g, ''));
    const total = Number(match[2].replace(/,/g, ''));
    return Number.isFinite(signed) && Number.isFinite(total) ? { signed, total } : null;
}

/**
 * What a trial's card says clearing it is worth, from its "600 pts".
 * @param {string} text - A card line
 * @returns {number|null} Points, or null when the line does not carry any
 */
export function parsePoints(text) {
    const match = typeof text === 'string' ? text.match(/(\d[\d,]*)\s*(?:pts?|points?)\b/i) : null;
    if (!match) return null;
    const points = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(points) ? points : null;
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
 * The tier a card states outright, from its `T6` or `Tier 6` badge.
 *
 * The tier used to be derived from the level and only from the level, which
 * meant a card that states its tier and not its level — which is how the Trials
 * tab's cards were found to be drawn — recorded no tier at all. Everything the
 * tier unlocks went with it: `tiers` stayed empty so no growth curve could be
 * fitted, `pointsByTier` stayed empty because filing a points figure requires a
 * tier to file it under, and the banked-points arithmetic reported "unknown"
 * beside a card that was plainly showing T6.
 *
 * Bounded by the ladder rather than accepting any `T<n>`: a stray "T3" in prose
 * is not a tier, and a tier above {@link module:./guild-trials-math.TRIAL_MAX_TIER}
 * is not one either.
 *
 * @param {string} text - A card line
 * @returns {number|null} The tier, or null when the line does not state one
 */
export function parseTrialTier(text) {
    const match = typeof text === 'string' ? text.match(/\b(?:tier\s*|T)(\d{1,2})\b/i) : null;
    if (!match) return null;
    const tier = Number(match[1]);
    return Number.isFinite(tier) && tier >= 1 && tier <= TRIAL_MAX_TIER ? tier : null;
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
 * A duration written in words — `42m 15s`, `1h 3m`, `58 sec`.
 *
 * The clock is only ever *seen* as `mm:ss` on the observed tab, but the game
 * writes durations both ways in different places and the whole point of this
 * search is that the named row it used to read may not exist. A second spelling
 * costs one regex and removes one more single point of failure.
 *
 * @param {string} text - Text to scan
 * @returns {number|null} Milliseconds, or null when no unit-marked duration is in it
 */
export function parseWordyDurationMs(text) {
    if (typeof text !== 'string') return null;

    const units = { h: 3600_000, m: 60_000, s: 1000 };
    const pattern = /(\d+)\s*(h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi;

    let total = null;
    let match = pattern.exec(text);
    while (match) {
        const unit = units[match[2][0].toLowerCase()];
        if (unit) total = (total ?? 0) + Number(match[1]) * unit;
        match = pattern.exec(text);
    }
    return total;
}

/**
 * The trial countdown, found anywhere on the tab.
 *
 * `GuildPanel_eventStatusRow` is as unverified as the tab container was, and it
 * is the *only* thing that ever produced a time left — so when it is missing,
 * `projectPace` never runs and "On pace for" silently never appears, which is
 * the same class of invisible failure as the tab itself. This looks for the
 * clock instead of being told where it is.
 *
 * Both live tabs carry one: "20m 53s" on each Trials card, and "Time: 20m 37s"
 * in the In Progress footer. Both are written in units rather than as a colon
 * clock, which is fortunate, because the page also carries text that a colon
 * clock reader would swallow whole — see the guards.
 *
 * What keeps it from reading a countdown out of something that is not one, which
 * matters because the root may be a whole guild panel:
 *
 * - **Per element, never the welded `textContent`.** Joining siblings invents
 *   digit runs that were never on screen, the same way it invents levels.
 * - **Nothing containing a `/`.** A trial's bar reads `582,115 / 600,000`, and
 *   `15 / 60` would otherwise parse as fifteen minutes.
 * - **No times of day.** The Trials tab's header reads "Skilling Trial - In
 *   Progress Thu 09:00 AM". As a colon clock that is nine minutes, it sits in a
 *   line saying "in progress", and it would have won — a confident, wrong
 *   deadline. A weekday or an am/pm anywhere in the line disqualifies it.
 * - **No decimals or percentages.** The In Progress footer reads "Work Time
 *   3.14s, Success Rate 60.8%". A countdown is never written with a decimal
 *   point, and "Work Time" is exactly the sort of line a label test would like.
 * - **Plausible as a trial clock or not at all.** A trial runs an hour, so
 *   anything above that or at zero is something else. Rejected rather than
 *   clamped: clamping an hour and a half down to an hour would turn a wrong
 *   reading into a confident one.
 *
 * Candidates are then ranked rather than taken first-come: a duration written in
 * units beats a colon clock, since only the latter is ambiguous with a time of
 * day, and a line that says what it is ("remaining", "Time:") beats a bare one.
 *
 * @param {Element} root - The trials root, from {@link findTrialsRoot}
 * @param {number} maxMs - Longest a trial can run; anything longer is not this clock
 * @returns {number|null} Milliseconds left, or null when no clock is on the page
 */
export function findTrialClockMs(root, maxMs) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;

    const plausible = (value) => Number.isFinite(value) && value > 0 && value <= maxMs;
    const labelled = /remain|left|ends?\b|until|time/i;
    const notAClock = /\d+\.\d|%|\b(?:am|pm)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)/i;

    // [labelled units, bare units, labelled colon, bare colon]
    const ranked = [null, null, null, null];
    for (const line of textLines(root)) {
        if (line.includes('/') || notAClock.test(line)) continue;

        const wordy = parseWordyDurationMs(line);
        const value = plausible(wordy) ? wordy : parseClockMs(line);
        if (!plausible(value)) continue;

        const rank = (plausible(wordy) ? 0 : 2) + (labelled.test(line) ? 0 : 1);
        if (ranked[rank] === null) ranked[rank] = value;
    }
    return ranked.find((value) => value !== null) ?? null;
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
const TRIALS_ROOT_CLASSES = [
    'GuildPanel_trialsContent',
    'GuildPanel_trialsTab',
    'GuildPanel_inProgressTab',
    'GuildPanel_inProgressContent',
];

/**
 * Where to look for trial cards.
 *
 * The named container when the game has one, and the guild panel as a whole when
 * it does not — which is the case that actually happens, since none of the four
 * names above has ever been seen on a live client. What makes the fallback safe
 * is not the container but the filter: {@link readTrialTiles} only accepts a card
 * whose name is a trial's.
 *
 * The guild panel is only handed back when something trial-shaped is on it, so
 * the Members tab is not scraped every five seconds for nothing. Two shapes
 * qualify, because the two tabs look nothing alike: a tile summary, which the
 * Trials tab's cards carry, or an `n / m` reading, which is all the In Progress
 * tab's card has.
 *
 * `querySelector` returns the first match in document order, and an ancestor
 * always precedes its descendants — so the guild-panel fallback is the outermost
 * `GuildPanel_*` element rather than whichever small child happens to match.
 *
 * @param {Document|Element} [scope] - Where to look
 * @returns {Element|null} The narrowest container known to hold the cards, or null
 */
export function findTrialsRoot(scope = typeof document === 'undefined' ? null : document) {
    if (!scope || typeof scope.querySelector !== 'function') return null;

    for (const className of TRIALS_ROOT_CLASSES) {
        const named = scope.querySelector(`[class*="${className}"]`);
        if (named) return named;
    }

    const panel = scope.querySelector('[class*="GuildPanel"]');
    if (!panel) return null;

    // A cheap existence probe, and the one place the welded `textContent` is the
    // right thing to read: whether *some* reading is on the panel does not
    // depend on which element holds it, and the cards themselves are read line
    // by line further down
    const hasSummary = Boolean(panel.querySelector('[class*="GuildPanel_tileSummary"]'));
    const hasReading = /\d[\d,.]*\s*\/\s*\d/.test(panel.textContent || '');
    return hasSummary || hasReading ? panel : null;
}

/** How far to climb from a reading before giving up on finding its card */
const CARD_CLIMB_LIMIT = 6;

/**
 * An element's own text, without its children's.
 *
 * The difference is the whole reason cards can be found at all: `textContent`
 * welds a card's runs into one string that parses as numbers nobody displayed,
 * while own text says what *this* element is showing — which is what makes it an
 * anchor or not.
 *
 * @param {Element} el - The element
 * @returns {string} Its own text, trimmed
 */
function ownText(el) {
    let text = '';
    for (const child of el?.childNodes || []) {
        if (child.nodeType === 3) text += child.textContent || '';
    }
    return text.trim();
}

/**
 * The card an element belongs to.
 *
 * By class where the game offers one, and otherwise by climbing until the
 * subtree holds a name as well as the number that was climbed from. Trial cards
 * on the In Progress tab carry no class this file can name and no level, so
 * "the smallest ancestor that has both a name and a reading" is what a card
 * *is* there — and it is the definition that survives a redesign, since it
 * describes the card rather than its markup.
 *
 * @param {Element} start - The element the number was found on
 * @param {Element} root - Never climb past this
 * @returns {Element} The card, or the starting element when nothing better is found
 */
function cardFor(start, root) {
    const named = start.closest?.('[class*="GuildPanel_tile"]:not([class*="GuildPanel_tileSummary"])');
    if (named) return named;

    let node = start;
    for (let step = 0; step < CARD_CLIMB_LIMIT; step += 1) {
        if (textLines(node).some((line) => isTrialName(line))) return node;
        if (!node.parentElement || node === root) break;
        node = node.parentElement;
    }
    return start;
}

/**
 * The trial cards on either trial tab.
 *
 * Cards are found by what they contain rather than by what they are called: a
 * tile summary (the Trials tab's setup cards) or a progress reading (the In
 * Progress tab's live card). Everything after that is per-card text, and
 * everything a card does not carry comes back null rather than being guessed —
 * a Trials card has a level and no reading, the In Progress card has a reading
 * and no level, and the record joins them by name.
 *
 * The filter that makes this safe against a whole-panel root is the name: a card
 * whose name is not a trial's is dropped, which excludes guild buildings, member
 * rows and the guild's own XP bar without needing to know what any of them look
 * like.
 *
 * @param {Element} root - The trials root, from {@link findTrialsRoot}
 * @returns {Array<{element: Element, name: string, level: number|null, tier: number|null,
 *   kind: 'combat'|'skilling', readings: Array<{current: number, max: number}>,
 *   signups: {signed: number, total: number}|null, points: number|null}>} Cards, in document order
 */
export function readTrialTiles(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];

    // What a card is anchored by: the level line that the Trials tab's cards
    // carry, or the reading that is all the In Progress tab's card has. Own text
    // rather than `textContent`, so an anchor is the element that actually holds
    // the run — and so that a level line this script has appended a tier badge
    // to is still found.
    const anchors = [...root.querySelectorAll('*')].filter((el) => {
        // Never this script's own output: the per-card block is appended to the
        // card it describes, so a careless anchor list reads it straight back
        if (el.closest?.('[class*="mwi-"]')) return false;
        if (typeof el.className === 'string' && el.className.includes('GuildPanel_tileSummary')) return true;

        // A stated tier or a points line anchors a card too. Without them a
        // Trials card that carries neither a level nor a bar — which is how the
        // live tab was found to draw them, "840 pts" over "T6" — has nothing to
        // be found by, and the tab that holds the tier and the points is read as
        // holding no trials at all. Everything found here is still filtered by
        // `isTrialName` below, so a stray "T3" in prose costs one climb.
        const own = ownText(el);
        return (
            parseTrialLevel(own) !== null ||
            parseBarReadings(own).length > 0 ||
            parseTrialTier(own) !== null ||
            parsePoints(own) !== null
        );
    });

    const tiles = [];
    const seen = new Set();

    for (const anchor of anchors) {
        const tile = cardFor(anchor, root);
        if (seen.has(tile)) continue;
        seen.add(tile);

        // Per element, never off the whole card. `textContent` welds siblings
        // together with no separator: a card holding "Lv.110" beside a bar
        // holding "1.2M / 4M" reads as `Lv.1101.2M / 4M`, which parses as level
        // 1,101 and a current of 1,101,200,000. Both wrong, neither obviously so.
        const lines = textLines(tile);
        const name = readTileName(tile, anchor, lines);
        // The one filter standing between this and the rest of the guild page
        if (!isTrialName(name)) continue;

        const level = lines.map(parseTrialLevel).find((candidate) => candidate !== null) ?? null;
        const signups = lines.map(parseSignups).find((candidate) => candidate !== null) ?? null;
        // A stated tier beats a derived one, and is available on a card that
        // carries no level at all. `textLines` skips this script's own elements,
        // so the `T<n>` badge `guild-credit-value.js` writes into the level line
        // is never read back as if the game had said it
        const statedTier = lines.map(parseTrialTier).find((candidate) => candidate !== null) ?? null;

        tiles.push({
            element: tile,
            name,
            level,
            tier: statedTier ?? (level === null ? null : tierFromLevel(level)),
            kind: isCombatTrialName(name) ? 'combat' : 'skilling',
            // Sign-up counts are excluded rather than filtered afterwards:
            // "1/28 signed up" has precisely the shape of a progress bar, and a
            // trial sampled against a sign-up ratio would report a pool that
            // fills and empties as members join
            readings: lines.filter((line) => !SIGNUP_PATTERN.test(line)).flatMap(parseBarReadings),
            signups,
            points: lines.map(parsePoints).find((candidate) => candidate !== null) ?? null,
        });
    }

    return tiles;
}

/**
 * A card's text, one entry per run the game rendered.
 *
 * Text *nodes* rather than leaf elements, which is a correction rather than a
 * refinement: this script appends a `T<n>` tier badge inside the very element
 * that carries "Lv.130" (`guild-credit-value.js`), and a leaf-element walk skips
 * any element that has acquired a child — so the level line disappeared from
 * every card the moment the badge was added to it, and the tier could not be
 * read from a card this script had itself annotated. Walking text nodes keeps
 * the two runs apart *and* keeps them both.
 *
 * Joining them, which is what `textContent` does, is the other failure: a card
 * holding "Lv.110" beside a bar holding "1.2M / 4M" reads as `Lv.1101.2M / 4M`.
 *
 * Anything this script injected is skipped. A card's own block is appended to
 * the card, so without that the panel would read its own output back — "Next
 * tier work (T5)" is not something the game said.
 *
 * @param {Element} tile - The tile
 * @returns {string[]} Trimmed, non-empty runs of text, in document order
 */
export function textLines(tile) {
    const lines = [];
    if (!tile || typeof tile !== 'object') return lines;

    const ours = (node) => typeof node.className === 'string' && node.className.includes('mwi-');
    const walk = (node) => {
        for (const child of node.childNodes || []) {
            // 3 is a text node, 1 an element; anything else (comments) is not text
            if (child.nodeType === 3) {
                const text = (child.textContent || '').trim();
                if (text) lines.push(text);
            } else if (child.nodeType === 1 && !ours(child)) {
                walk(child);
            }
        }
    };

    walk(tile);
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
