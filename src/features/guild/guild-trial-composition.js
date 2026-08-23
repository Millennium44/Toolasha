/**
 * The roster composition planner: the gaps, before sign-up rather than after.
 *
 * Every other check in this feature runs on a trial that is already happening.
 * `guild-trial-abilities-ui.js` counts the auras in the party, the utility
 * headcount says whether anybody brought Revive, and `guild-trial-plan.js`
 * compares the kits against what the lead wrote down — all of it true, all of it
 * an hour too late to do anything about.
 *
 * The composition planner asks the same questions of a roster that has not
 * signed up yet: the last cycle's participants by default, or a pasted list of
 * names. Everything it knows about a name comes from what the feature already
 * captured — the stored loadouts (`guild-loadouts.js`), the trial's own Battle
 * Info captures, and the class inference in `utils/class-inference.js` — so it
 * says nothing new about anybody. What it adds is the *arithmetic over the
 * roster*: how many tanks against how many the tier wants, whether the one
 * revive carrier is actually on the list, which aura two people are both
 * bringing.
 *
 * ## Coverage before conclusions
 *
 * A roster of twenty-eight names with fourteen known kits cannot be told it has
 * no revive; it can only be told that none of the fourteen has one. Every check
 * therefore has three states, not two — `ok`, `gap` and `unknown` — and a gap is
 * only ever claimed when the whole roster is known. That is the same rule
 * `auraCoverage` follows for a live trial and for the same reason: a partial
 * capture must never masquerade as proof of absence.
 *
 * The coverage line ("14 of 28 kits known") is therefore not a footnote. It is
 * the thing that says how much of the checklist below it is a finding and how
 * much is a shrug.
 *
 * ## Suggested swaps come off the bench, never out of thin air
 *
 * A suggestion names a real member whose real captured kit carries the missing
 * thing. Where the bench has nobody who does, the check says the gap and offers
 * nothing, because "recruit a tank" is not a swap.
 *
 * Pure throughout: game data, the roster and the captures all arrive as
 * arguments, so the rules are testable without a connection, a DOM or a clock.
 */

import { TRIAL_MAX_TIER } from './guild-trials-math.js';
import { duplicateAuraWarnings } from '../../utils/party-lint.js';
import { inferClass } from '../../utils/class-inference.js';

/** The utility ability whose absence loses a wipe that a party would have survived */
export const REVIVE_HRID = '/abilities/revive';

/** The special that keeps a tank standing through a tier's burst */
export const INVINCIBLE_HRID = '/abilities/invincible';

/**
 * Tanks a tier wants, as the lowest tier each step applies from.
 *
 * Not a rule the game states anywhere — it has no such number — so this is a
 * declared convention rather than a measurement, kept in one table so a guild
 * that runs it differently has one place to argue with. The shape is the one
 * every trial roster settles into: one tank holds the early tiers, the boss's
 * output outgrows a single health bar somewhere in the middle, and the top of
 * the ladder wants a tank per group.
 */
export const TANK_TIER_STEPS = [
    { fromTier: 1, tanks: 1 },
    { fromTier: 6, tanks: 2 },
    { fromTier: 11, tanks: 3 },
    { fromTier: 16, tanks: 4 },
];

/**
 * How many tanks the tier being aimed at wants.
 *
 * @param {number|null} tier - The tier the guild is going for
 * @returns {number|null} Tanks wanted, or null when no tier was named
 */
export function tanksNeededForTier(tier) {
    if (!Number.isFinite(tier) || tier < 1) return null;
    const capped = Math.min(tier, TRIAL_MAX_TIER);
    let wanted = TANK_TIER_STEPS[0].tanks;
    for (const step of TANK_TIER_STEPS) {
        if (capped >= step.fromTier) wanted = step.tanks;
    }
    return wanted;
}

/**
 * A pasted roster, as names.
 *
 * Newlines or commas, because a lead pastes whichever the thing they copied
 * from produced. Leading list markers and trailing role notes in brackets are
 * stripped: "1. Alice (tank)" is a name somebody typed, and refusing it because
 * of the decoration would be the planner being difficult about its own input.
 * Duplicates collapse case-insensitively — the same person twice is one person.
 *
 * @param {string} text - As pasted
 * @returns {string[]} Names, in the order given
 */
export function parseRosterNames(text) {
    const names = [];
    const seen = new Set();

    for (const piece of String(text || '').split(/[\n,]/)) {
        const cleaned = piece
            .trim()
            .replace(/^[-*•\d.)\s]+/, '')
            .replace(/\s*[([{<].*$/, '')
            .trim();
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(cleaned);
    }
    return names;
}

/**
 * What is known about each name on a roster.
 *
 * The two sources are the ones the feature already fills: a trial's own Battle
 * Info captures, which are authoritative, and the stored loadouts, which are
 * whatever was last seen. Captures win where both exist. A name neither knows
 * is carried through with `known: false` rather than dropped — an unknown kit
 * is the single most important thing the coverage line has to count.
 *
 * @param {Array<string>} names - The proposed roster
 * @param {Object} [sources] - Where kits come from
 * @param {Object} [sources.captures] - `name (lowercased) → {abilities, stats}`
 * @param {Object} [sources.loadouts] - `name (lowercased) → {abilities, stats}`
 * @param {Object} [sources.abilityDetailMap] - Game data, for the class inference
 * @returns {Array<{name: string, known: boolean, source: string|null,
 *   abilities: Array<Object>, stats: Object|null, classTag: Object|null}>} One entry per name
 */
export function resolveRosterKits(names, { captures = {}, loadouts = {}, abilityDetailMap = {} } = {}) {
    return (names || []).map((name) => {
        const key = String(name || '')
            .trim()
            .toLowerCase();
        const capture = captures?.[key] || null;
        const loadout = capture ? null : loadouts?.[key] || null;
        const held = capture || loadout;

        const abilities = (held?.abilities || []).filter((ability) => ability?.hrid);
        // An empty stats object is a sighting that read no sheet, not a sheet
        // full of zeros — it must not make a name count as known
        const stats = held?.stats && Object.keys(held.stats).length > 0 ? held.stats : null;
        const known = abilities.length > 0 || Boolean(stats);

        return {
            name: String(name || '').trim(),
            known,
            source: capture ? 'capture' : loadout ? 'loadout' : null,
            abilities,
            stats,
            classTag: known ? inferClass({ kit: abilities, stats }, abilityDetailMap) : null,
        };
    });
}

/**
 * Who on the bench carries a given ability.
 *
 * @param {Array<Object>} bench - Resolved kits not on the proposed roster
 * @param {string} hrid - The ability wanted
 * @returns {string[]} Their names
 */
function benchCarrying(bench, hrid) {
    return (bench || [])
        .filter((member) => member.known && (member.abilities || []).some((ability) => ability.hrid === hrid))
        .map((member) => member.name);
}

/**
 * Who on the bench the inference calls a tank.
 * @param {Array<Object>} bench - Resolved kits not on the proposed roster
 * @returns {string[]} Their names
 */
function benchTanks(bench) {
    return (bench || []).filter((member) => member.classTag?.key === 'tank').map((member) => member.name);
}

/**
 * One check's verdict.
 *
 * @param {string} key - Stable identifier, for tests and for the UI's ordering
 * @param {'ok'|'gap'|'unknown'} status - What can be claimed
 * @param {string} text - The line a reader sees
 * @param {Object} [extra] - `detail` and `suggestions`
 * @returns {Object} The check
 */
function check(key, status, text, { detail = '', suggestions = [] } = {}) {
    return { key, status, text, detail, suggestions };
}

/**
 * A utility check: somebody has to be carrying this, and here is who could.
 *
 * @param {Object} options - The question
 * @param {string} options.key - Check key
 * @param {string} options.hrid - The ability
 * @param {string} options.label - What to call it
 * @param {Array<Object>} options.members - Resolved roster kits
 * @param {Array<Object>} options.bench - Resolved kits off the roster
 * @param {boolean} options.complete - Whether every roster kit is known
 * @returns {Object} A check
 */
function utilityCheck({ key, hrid, label, members, bench, complete }) {
    const carriers = members.filter((member) => (member.abilities || []).some((ability) => ability.hrid === hrid));
    if (carriers.length) {
        const who = carriers.map((member) => member.name).join(', ');
        return check(key, 'ok', `${label}: ${carriers.length} carrying`, { detail: who });
    }
    if (!complete) {
        return check(key, 'unknown', `${label}: nobody known to carry it`, {
            detail: 'Some kits on this roster have never been captured, so this is not proof nobody has it.',
            suggestions: benchCarrying(bench, hrid),
        });
    }
    return check(key, 'gap', `${label}: nobody on this roster carries it`, {
        detail: 'Every kit on the roster is known and none of them has it.',
        suggestions: benchCarrying(bench, hrid),
    });
}

/**
 * Auras two or more of the roster would both bring.
 *
 * The wording and the rule are `duplicateAuraWarnings`' — one aura reaches every
 * ally, so the second copy is a wasted special slot — reached here through the
 * player-DTO shape that lint reads.
 *
 * @param {Array<Object>} members - Resolved roster kits
 * @param {Object} abilityDetailMap - Game data
 * @returns {Object} A check
 */
function duplicateAuraCheck(members, abilityDetailMap) {
    const known = members.filter((member) => member.known);
    const playerDTOs = known.map((member, index) => ({
        hrid: `roster${index}`,
        equipment: {},
        abilities: member.abilities,
    }));
    const playerInfo = known.map((member, index) => ({ hrid: `roster${index}`, name: member.name }));
    // The lint declines to speak about a party of one, which is right for a
    // party and wrong here: two known kits out of twenty-eight is still two
    // kits that may carry the same aura
    const warnings = playerDTOs.length >= 2 ? duplicateAuraWarnings(playerDTOs, playerInfo, abilityDetailMap) : [];

    if (!warnings.length) return check('duplicateAuras', 'ok', 'No aura is brought twice');
    return check('duplicateAuras', 'gap', `${warnings.length} aura${warnings.length === 1 ? '' : 's'} brought twice`, {
        detail: warnings.join('\n'),
    });
}

/**
 * Tanks against what the tier wants.
 *
 * The count is of *inferred* tanks, so it inherits the inference's honesty: a
 * verdict is drawn from threat on a captured sheet or a taunt in the kit, and a
 * member nothing is known about is not counted either way.
 *
 * @param {Array<Object>} members - Resolved roster kits
 * @param {Array<Object>} bench - Resolved kits off the roster
 * @param {number|null} tier - The tier being aimed at
 * @param {boolean} complete - Whether every roster kit is known
 * @returns {Object} A check
 */
function tankCheck(members, bench, tier, complete) {
    const wanted = tanksNeededForTier(tier);
    const tanks = members.filter((member) => member.classTag?.key === 'tank');
    const found = tanks.length;

    if (wanted === null) {
        return check('tanks', 'unknown', `${found} tank${found === 1 ? '' : 's'} on the roster`, {
            detail: 'No tier named, so there is nothing to compare the count against.',
        });
    }

    if (found >= wanted) {
        return check('tanks', 'ok', `${found} of ${wanted} tanks wanted for tier ${tier}`, {
            detail: tanks.map((member) => member.name).join(', '),
        });
    }

    const status = complete ? 'gap' : 'unknown';
    return check('tanks', status, `${found} of ${wanted} tanks wanted for tier ${tier}`, {
        detail: complete
            ? 'Every kit on the roster is known and this is the whole count.'
            : 'Some kits have never been captured, so there may be tanks this cannot see.',
        suggestions: benchTanks(bench),
    });
}

/**
 * The written plan against the roster's kits.
 *
 * Takes the comparison `guild-trial-plan.js` already produces rather than
 * re-implementing it — the plan syntax, the forgiving name matching and the
 * refusal to silently drop an unrecognised token all live there.
 *
 * @param {Object|null} planCompare - From `comparePlan`
 * @returns {Object|null} A check, or null when no plan is written
 */
function planCheck(planCompare) {
    const summary = planCompare?.summary;
    if (!summary?.planLines) return null;

    const off = summary.plannedPlayers - summary.onPlan;
    if (summary.comparedPlayers === 0) {
        return check('plan', 'unknown', `Plan written for ${summary.plannedPlayers}, no kits captured yet`, {
            detail: 'Nobody the plan names has a captured kit to compare against.',
        });
    }
    if (off === 0) {
        return check('plan', 'ok', `${summary.onPlan} of ${summary.plannedPlayers} on the written plan`);
    }

    const offNames = (planCompare.verdicts || [])
        .filter((verdict) => verdict.status === 'missing' || verdict.status === 'underLevel')
        .map((verdict) => `${verdict.name}: ${(verdict.missing || []).join(', ') || 'below the planned level'}`);

    return check('plan', 'gap', `${off} of ${summary.plannedPlayers} not on the written plan`, {
        detail: offNames.join('\n'),
    });
}

/**
 * The whole checklist for a proposed roster.
 *
 * @param {Object} options - The roster and what is known about it
 * @param {Array<Object>} options.members - From {@link resolveRosterKits}
 * @param {Array<Object>} [options.bench] - Resolved kits for members not on the roster
 * @param {number|null} [options.tier] - The tier being aimed at
 * @param {Object} [options.abilityDetailMap] - Game data
 * @param {Object|null} [options.planCompare] - From `comparePlan`
 * @returns {{coverage: {known: number, total: number, complete: boolean, line: string},
 *   checks: Array<Object>, gaps: number, unknowns: number}} The checklist
 */
export function lintComposition({
    members = [],
    bench = [],
    tier = null,
    abilityDetailMap = {},
    planCompare = null,
} = {}) {
    const roster = members || [];
    const known = roster.filter((member) => member.known).length;
    const complete = roster.length > 0 && known === roster.length;

    const checks = [
        utilityCheck({ key: 'revive', hrid: REVIVE_HRID, label: 'Revive', members: roster, bench, complete }),
        utilityCheck({
            key: 'invincible',
            hrid: INVINCIBLE_HRID,
            label: 'Invincible',
            members: roster,
            bench,
            complete,
        }),
        duplicateAuraCheck(roster, abilityDetailMap),
        tankCheck(roster, bench, tier, complete),
    ];

    const plan = planCheck(planCompare);
    if (plan) checks.push(plan);

    return {
        coverage: {
            known,
            total: roster.length,
            complete,
            line: `${known} of ${roster.length} kits known`,
        },
        checks,
        gaps: checks.filter((entry) => entry.status === 'gap').length,
        unknowns: checks.filter((entry) => entry.status === 'unknown').length,
    };
}

/**
 * The one-line verdict the panel's header wears.
 * @param {Object} lint - From {@link lintComposition}
 * @returns {string} e.g. `2 gaps · 1 unknown · 14 of 28 kits known`
 */
export function compositionStatusLine(lint) {
    if (!lint?.coverage?.total) return 'No roster to check.';
    const parts = [];
    if (lint.gaps) parts.push(`${lint.gaps} gap${lint.gaps === 1 ? '' : 's'}`);
    if (lint.unknowns) parts.push(`${lint.unknowns} unknown`);
    if (!parts.length) parts.push('no gaps found');
    parts.push(lint.coverage.line);
    return parts.join(' · ');
}
