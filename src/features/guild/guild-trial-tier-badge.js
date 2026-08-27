/**
 * The small "T17" marker that sits beside a trial card's "Lv.260".
 *
 * The game states a trial's level and never its tier, and the two are the same
 * fact: tiers start at {@link module:./guild-trials-math.TRIAL_START_LEVEL} and
 * step ten levels each, so Lv.250 is T16, Lv.260 is T17 and Lv.290 is T20 —
 * pairs read straight off live cards. Everything else this feature says is
 * phrased in tiers, so the card is labelled in tiers too.
 *
 * ## Two things the level alone cannot do
 *
 * **The level caps.** It stops rising at
 * {@link module:./guild-trials-math.TRIAL_MAX_LEVEL}, and
 * {@link module:./guild-trials-math.TRIAL_MAX_TIER} is the last tier there is —
 * nothing exists above T21. So a card reading Lv.300 is T21 exactly, and the
 * badge reads `T21` with no `+`: the `+` promised a ladder that does not exist,
 * and "T24+" — which this used to draw from a banked count nothing bounded — was
 * a tier the game cannot fight. What survives the cap is only that the *level*
 * has stopped identifying the tier, so the banked count is consulted as the
 * better number and the whole thing is held at the top of the ladder.
 *
 * **A badge is never allowed to read low.** Where the trials record knows more
 * tiers are banked than the level implies, the banked count wins — a marker
 * under a card that has plainly cleared more is worse than no marker.
 *
 * ## Re-injection rather than a one-shot flag
 *
 * The old injector stamped `data-mwi-tier-injected` on the level line and
 * returned early ever after. React reuses that node and replaces its children
 * on every redraw, so the span went and the flag stayed: the badge vanished the
 * first time the card updated and never came back. So the guard is now the
 * badge's own presence, and a badge whose text has gone stale is rewritten in
 * place rather than duplicated.
 */

import { tierFromLevel, TRIAL_MAX_LEVEL, TRIAL_MAX_TIER } from './guild-trials-math.js';

/** Class every injected badge carries, so cleanup and the guard are one query */
export const TIER_BADGE_CLASS = 'mwi-trial-tier';

/** How the marker is drawn: present, readable, and not competing with the game's own text */
const BADGE_STYLE = 'color:#9ca3af; margin-left:3px; font-size:0.85em; white-space:nowrap;';

/**
 * The tier a card is showing, from its level and what it has banked.
 *
 * @param {Object} input - Inputs
 * @param {number|null} input.level - The card's stated trial level
 * @param {number|null} [input.bankedTiers] - Tiers the record says are banked
 * @returns {{tier: number, atCap: boolean}|null} The tier, or null when nothing
 *   identifies one. `atCap` says the *level* has stopped identifying the tier —
 *   not that the tier is a floor, because {@link TRIAL_MAX_TIER} is the ceiling
 */
export function badgeTierFor({ level, bankedTiers = null } = {}) {
    const fromLevel = tierFromLevel(level);
    const banked = Number.isFinite(bankedTiers) && bankedTiers > 0 ? Math.floor(bankedTiers) : null;

    // Below the first trial level there is no tier at all — which is also what
    // keeps a guild *building*'s "Lv. 10 / 20" from being labelled as a trial
    if (fromLevel === null) return null;

    // At the cap every tier from the top of the ladder up reads Lv.300, so the
    // level alone no longer identifies the tier and the count of tiers actually
    // banked is the better number. It is still not allowed to exceed the ladder:
    // T21 is the last tier, so a banked count above it is a miscount rather than
    // a tier, and clamping is what keeps "T24" off a card
    const atCap = Number.isFinite(level) && level >= TRIAL_MAX_LEVEL;
    const tier = Math.min(TRIAL_MAX_TIER, Math.max(fromLevel, banked ?? 0, atCap ? TRIAL_MAX_TIER : 0));
    return { tier, atCap };
}

/**
 * What the badge should read, or null when there is nothing to say.
 * @param {Object} input - As {@link badgeTierFor}
 * @returns {string|null} e.g. `T17`, or `T21` at the level cap — the top of the ladder
 */
export function badgeText(input) {
    const badge = badgeTierFor(input);
    if (!badge) return null;
    return `T${badge.tier}`;
}

/** The level a "Lv.260" line is stating, or null. */
export function levelFromText(text) {
    const match = String(text ?? '').match(/Lv\.\s*(\d+)/);
    if (!match) return null;
    const level = Number(match[1]);
    return Number.isFinite(level) ? level : null;
}

/**
 * Put the badge beside a card's level line, idempotently.
 *
 * Safe to call on every observation of the same element: an existing badge is
 * updated in place, never duplicated, and a redraw that wiped it puts it back.
 *
 * @param {Element} el - The element whose text holds `Lv.<n>`
 * @param {Object} [options] - Options
 * @param {number|null} [options.bankedTiers] - Tiers banked, where the record knows
 * @returns {Element|null} The badge, or null when the element states no trial level
 */
export function renderTierBadge(el, { bankedTiers = null } = {}) {
    if (!el || typeof el.querySelector !== 'function') return null;

    const existing = el.querySelector(`.${TIER_BADGE_CLASS}`);
    // Read the level off the element's text *without* the badge's own "T17" in
    // it — harmless for the level regex, but cheap insurance against a badge
    // that has been re-read as content
    const level = levelFromText(existing ? el.textContent.replace(existing.textContent, '') : el.textContent);
    const text = badgeText({ level, bankedTiers });

    if (text === null) {
        if (existing) existing.remove();
        return null;
    }

    if (existing) {
        if (existing.textContent !== text) existing.textContent = text;
        return existing;
    }

    const badge = el.ownerDocument.createElement('span');
    badge.className = TIER_BADGE_CLASS;
    badge.style.cssText = BADGE_STYLE;
    badge.textContent = text;
    el.appendChild(badge);
    return badge;
}
