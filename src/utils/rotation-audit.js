/**
 * Rotation audit
 *
 * Whether your own abilities actually fire, and what each one buys.
 *
 * The guild trial tooling already asks this about other people: `guild-trial-support.js`
 * counts the time a caster spent under the cheapest thing they cast and calls it
 * *starved*, because that is the moment a rotation stops being a rotation. Nothing
 * asked it about **you**, in a normal fight, where it is the one thing you can still
 * change — and the answer is per ability rather than per player, because "your mana
 * ran out" is not actionable and "the ability you slotted third has been ready for
 * two thirds of the fight and unaffordable for most of it" is.
 *
 * ## Ready, active, starved
 *
 * Every ability is in exactly one of three states at any instant, and this file
 * splits the fight's milliseconds between them per ability:
 *
 * - **active** — on cooldown, i.e. within `cooldownDuration` of its last cast.
 *   Summed over a fight and divided by the fight, that is the ability's *uptime*:
 *   how much of the possible it was used. An ability at 100% is being cast the
 *   instant it comes back; one at 4% is not in the rotation whatever the bar says.
 * - **ready and affordable** — off cooldown with the mana to pay for it. Time here
 *   is time the rotation *chose* something else, which is a priority question.
 * - **ready and starved** — off cooldown with mana below its cost. Time here is the
 *   ability being unable to fire, which is a mana question and has different fixes.
 *
 * The split is what separates "I never press it" from "I press it and nothing
 * happens", and those two have opposite remedies — the first wants a rotation
 * change, the second wants regen or a cheaper bar.
 *
 * ## Cooldown is read, not measured
 *
 * `abilityDetailMap[hrid].cooldownDuration` is in nanoseconds and is the game's own
 * statement. Haste shortens it, and nothing on the wire says by how much for this
 * character mid-fight, so the stated cooldown is used and an ability that fires
 * faster than stated simply reads above 100% uptime — which is capped for display
 * and left uncapped in the raw field, because a capped figure hides the fact that
 * the model is the conservative one.
 *
 * ## What is measured versus what is looked up
 *
 * Mana **spend and regen** are measured off `cMP` moving between ticks, which is
 * every source at once and cannot be short. Per-ability mana is `manaCost` times
 * casts, which is a lookup and can be — an ability the game never described
 * contributes casts and no mana, and the summary says `incomplete` rather than
 * reporting a short total as a measurement. That is `utils/mana-spend.js`' rule and
 * it is kept here deliberately.
 *
 * Everything in this module is pure over its arguments: it is handed ticks and
 * returns rows, so the arithmetic is tested without a DOM or a live fight. The
 * subscribing is `features/combat/rotation-tracker.js`' and the drawing is the
 * combat DPS panel's Rotation tab.
 */

import { LOW_MANA_FRACTION } from '../features/guild/guild-trial-support.js';

/** A tick further from the last than this is a gap between fights, not a long swing */
export const MAX_TICK_GAP_MS = 2000;

/** Auras are cast once and cost a lot; they are not the rotation and never set the floor */
const AURA_PATTERN = /_aura$/;

/** Under this share of its ready time, an ability is not really in the rotation */
export const DEAD_UPTIME = 0.15;

/** Over this share of ready time spent unaffordable, mana is the reason and not the rotation */
export const STARVED_SHARE = 0.4;

/** Below this many measured seconds, every share is one lucky fight rather than a figure */
export const MIN_SECONDS = 3;

/** The pseudo-ability damage-over-time and reflect arrive under; never a row */
export const DOT_ACTION = 'dot';

/**
 * A fresh audit state.
 *
 * One of these is a *scope* — the tracker keeps two, a fight one it clears at
 * `new_battle` and a session one it never does — so nothing here knows or cares
 * which it is.
 *
 * @returns {Object} State, mutated by the folds
 */
export function newRotationState() {
    return {
        /** Battles begun in this scope; the divisor for every per-fight figure */
        fights: 0,
        /** Measured fighting time, in ms — the sum of tick gaps, never wall clock */
        ms: 0,
        /** Mana that left the bar, measured from `cMP` falling */
        manaSpent: 0,
        /** Mana that arrived, measured from `cMP` rising: regen, food, drinks, leech */
        manaRestored: 0,
        /** Time under the cheapest thing this character casts — the rotation stalled */
        starvedMs: 0,
        starved: false,
        /** The cheapest non-aura cost on the bar; null until one is known */
        castFloor: null,
        /** Time under a fifth of the bar, on the trial module's own line */
        lowManaMs: 0,
        lowMana: false,
        /** Damage with no swing behind it — a bleed, a reflect. Real, and nobody's row */
        dotDamage: 0,
        maxMana: null,
        lastMana: null,
        lastAt: null,
        lastAtk: null,
        abilities: {},
    };
}

/**
 * The per-ability row this file keeps.
 * @param {string} hrid - The ability
 * @returns {Object} An empty row
 */
function emptyAbility(hrid) {
    return {
        hrid,
        /** Whether the game stated this ability is on the bar, as opposed to seen firing */
        equipped: false,
        casts: 0,
        damage: 0,
        healing: 0,
        hits: 0,
        misses: 0,
        /** ms on cooldown; over the scope's ms this is uptime */
        activeMs: 0,
        /** ms off cooldown, whether or not it could be paid for */
        readyMs: 0,
        /** ms off cooldown with the bar below its cost — inside `readyMs` */
        starvedMs: 0,
        manaCost: null,
        cooldownMs: null,
        lastCastAt: null,
    };
}

/**
 * Read an ability's stated cost and cooldown onto a row.
 *
 * Done on every touch rather than once, because client data can arrive after the
 * first tick and a row that learned "no cooldown" on tick one would keep saying so
 * for the rest of the session.
 *
 * @param {Object} row - The row, mutated
 * @param {Object} [detailMap] - `abilityDetailMap`
 */
function readDetail(row, detailMap) {
    const detail = detailMap?.[row.hrid];
    if (!detail) return;

    const cost = Number(detail.manaCost);
    if (Number.isFinite(cost) && cost >= 0) row.manaCost = cost;

    // Nanoseconds, as the game states it everywhere else
    const cooldown = Number(detail.cooldownDuration);
    if (Number.isFinite(cooldown) && cooldown > 0) row.cooldownMs = cooldown / 1e6;
}

/**
 * The row for one ability, created and refreshed from client data on the way past.
 * @param {Object} state - From {@link newRotationState}
 * @param {string} hrid - The ability
 * @param {Object} [detailMap] - `abilityDetailMap`
 * @returns {Object} The row
 */
function abilityRow(state, hrid, detailMap) {
    const row = (state.abilities[hrid] ||= emptyAbility(hrid));
    readDetail(row, detailMap);
    return row;
}

/**
 * Recompute the cheapest castable thing on the bar.
 *
 * The trial module sets its floor from what a player has been *seen* casting,
 * because a spectator never learns anyone's loadout. Here the loadout is stated —
 * `new_battle` carries this character's own `combatAbilities` — so the floor is the
 * cheapest ability equipped, which is right from the first tick rather than after
 * the first cast. Auras are excluded on the trial module's reasoning: cast once,
 * expensive, and not what stalling means.
 *
 * @param {Object} state - From {@link newRotationState}, mutated
 */
function refreshFloor(state) {
    let floor = null;
    for (const row of Object.values(state.abilities)) {
        if (AURA_PATTERN.test(row.hrid)) continue;
        if (!(row.manaCost > 0)) continue;
        floor = floor === null ? row.manaCost : Math.min(floor, row.manaCost);
    }
    state.castFloor = floor;
}

/**
 * Record the abilities the game says are on this character's bar.
 *
 * An ability that is slotted and never fires is the single most useful row this
 * panel has, and it exists only because the kit is read rather than inferred from
 * casts — a starved ability produces no casts to infer from, which is exactly the
 * case worth reporting.
 *
 * @param {Object} state - From {@link newRotationState}, mutated
 * @param {Array<Object|string>} kit - `combatAbilities`, or plain hrids
 * @param {Object} [detailMap] - `abilityDetailMap`
 */
export function noteRotationKit(state, kit, detailMap) {
    for (const entry of Array.isArray(kit) ? kit : []) {
        const hrid = typeof entry === 'string' ? entry : entry?.abilityHrid || entry?.hrid;
        if (!hrid) continue;
        abilityRow(state, hrid, detailMap).equipped = true;
    }
    refreshFloor(state);
}

/** Record that a battle began in this scope. @param {Object} state - Mutated */
export function noteRotationFight(state) {
    state.fights += 1;
}

/**
 * How much of `[from, to]` an ability spent off cooldown.
 *
 * @param {Object} row - An ability row
 * @param {number} from - Interval start, ms
 * @param {number} to - Interval end, ms
 * @returns {number} ms ready
 */
function readySpan(row, from, to) {
    if (!(to > from)) return 0;
    // Never cast, or no stated cooldown: ready for the whole interval. An
    // ability with no cooldown is off cooldown by definition, and one that has
    // never fired has nothing to be recovering from
    if (row.lastCastAt === null || !(row.cooldownMs > 0)) return to - from;

    const readyAt = row.lastCastAt + row.cooldownMs;
    return Math.max(0, to - Math.max(from, readyAt));
}

/**
 * Fold one combat tick into the audit.
 *
 * Order inside is deliberate: time is charged first, against the cooldowns as they
 * stood *before* this tick, and the cast is recorded after. A cast landing mid-tick
 * therefore starts its cooldown at the tick boundary rather than retroactively,
 * which is the conservative direction — it can only understate uptime, never invent
 * it.
 *
 * @param {Object} state - From {@link newRotationState}, mutated
 * @param {Object} tick - `{at, player, action, events, detailMap}`
 * @param {number} tick.at - When the tick arrived, ms since epoch
 * @param {Object} tick.player - This character's entry in the tick's `pMap`
 * @param {string} [tick.action] - What they were preparing going into this tick
 * @param {Array<Object>} [tick.events] - This character's events from `attributeTick`
 * @param {Object} [tick.detailMap] - `abilityDetailMap`
 */
export function foldRotationTick(state, { at, player, action, events, detailMap } = {}) {
    if (!Number.isFinite(at)) return;

    const previous = state.lastAt;
    state.lastAt = at;

    // Only the gap between two ticks of one fight is time spent fighting; the
    // first tick after a break contributes none, exactly as the damage tracker
    // has it — otherwise a night idle in town reads as an eternity of starvation
    const gap = previous === null ? 0 : at - previous;
    const dt = gap > 0 && gap < MAX_TICK_GAP_MS ? gap : 0;
    const from = at - dt;

    const mana = Number(player?.cMP);
    const maxMana = Number(player?.mMP);
    if (Number.isFinite(maxMana) && maxMana > 0) state.maxMana = maxMana;

    if (Number.isFinite(mana)) {
        if (state.lastMana !== null) {
            const change = mana - state.lastMana;
            if (change > 0) state.manaRestored += change;
            else if (change < 0) state.manaSpent += -change;
        }
        state.lastMana = mana;
    }

    // Cost and cooldown may only now have arrived with the client data
    for (const row of Object.values(state.abilities)) readDetail(row, detailMap);
    refreshFloor(state);

    if (dt > 0) {
        state.ms += dt;

        for (const row of Object.values(state.abilities)) {
            const ready = readySpan(row, from, at);
            row.readyMs += ready;
            row.activeMs += dt - ready;
            // Ready but unaffordable. Charged against the mana reading at the
            // end of the interval: a bar that emptied during it was affordable
            // for part of it, and claiming the whole interval would overstate
            // starvation on exactly the ticks the ability did fire
            if (Number.isFinite(mana) && row.manaCost > 0 && mana < row.manaCost) row.starvedMs += ready;
        }

        if (Number.isFinite(mana)) {
            const stalled = state.castFloor !== null && state.castFloor > 0 && mana < state.castFloor;
            state.starved = stalled;
            if (stalled) state.starvedMs += dt;

            const low = Number.isFinite(maxMana) && maxMana > 0 && mana / maxMana < LOW_MANA_FRACTION;
            state.lowMana = low;
            if (low) state.lowManaMs += dt;
        }
    }

    // A cast is the attack counter rising, with the ability that was being
    // prepared going into this tick — the same join the trial module and the
    // damage attribution both make, and for the same reason: the payload names
    // no caster and no cast, only a counter and an intention
    const attacks = Number(player?.atkCounter);
    if (Number.isFinite(attacks)) {
        if (state.lastAtk !== null && attacks > state.lastAtk && action && action !== 'idle' && action !== 'auto') {
            const row = abilityRow(state, action, detailMap);
            row.casts += 1;
            row.lastCastAt = at;
            refreshFloor(state);
        }
        state.lastAtk = attacks;
    }

    for (const event of Array.isArray(events) ? events : []) {
        if (event?.isKill) continue;
        const amount = Number(event?.amount) || 0;
        if (event?.action === DOT_ACTION) {
            state.dotDamage += amount;
            continue;
        }
        if (!event?.action || event.action === 'idle') continue;

        const row = abilityRow(state, event.action, detailMap);
        if (event.isMiss) row.misses += 1;
        else if (event.isHeal) row.healing += Math.abs(amount);
        else {
            row.damage += amount;
            row.hits += 1;
        }
    }
}

/**
 * What one row's numbers add up to, in a sentence.
 *
 * The verdicts are deliberately few and deliberately opposed: an ability that does
 * not fire because nothing is left to pay with, and one that does not fire because
 * the rotation never gets to it, look identical on a cast count and want opposite
 * fixes. Anything the measurement cannot separate says so instead of guessing.
 *
 * @param {Object} row - A summarised row
 * @param {number} seconds - Measured seconds in the scope
 * @returns {{kind: string, text: string}} A verdict and its reason
 */
export function abilityVerdict(row, seconds) {
    // An aura is cast once and kept up for the whole fight; it has no rotation
    // slot to fire in, so uptime and starvation say nothing about it
    if (AURA_PATTERN.test(row.hrid || '')) {
        return { kind: 'aura', text: 'Aura — cast once and kept up; not part of the rotation.' };
    }
    if (!(seconds >= MIN_SECONDS)) {
        return { kind: 'measuring', text: 'Not enough fighting measured yet to say.' };
    }
    if (row.uptime === null) {
        return {
            kind: 'unknown',
            text: 'The game states no cooldown for this ability, so its uptime cannot be worked out.',
        };
    }

    const uptimePct = Math.round(Math.min(1, row.uptime) * 100);
    const starvedPct = row.starvedShare === null ? null : Math.round(row.starvedShare * 100);

    if (starvedPct !== null && starvedPct >= STARVED_SHARE * 100 && row.uptime < DEAD_UPTIME) {
        return {
            kind: 'starved',
            text:
                `Effectively never fires: ${uptimePct}% uptime, starved ${starvedPct}% of its ready time — ` +
                'drop it or raise regen.',
        };
    }
    if (row.uptime < DEAD_UPTIME) {
        return {
            kind: 'idle',
            text:
                `${uptimePct}% uptime with mana to spare — the rotation is choosing something else, so it is a ` +
                'priority question rather than a mana one.',
        };
    }
    if (starvedPct !== null && starvedPct >= STARVED_SHARE * 100) {
        return {
            kind: 'pinched',
            text: `Fires, but starved ${starvedPct}% of its ready time — more regen would buy casts here.`,
        };
    }
    return { kind: 'fine', text: `Fine: ${uptimePct}% uptime.` };
}

/**
 * The single change with the best payoff, derived from the rows.
 *
 * A suggestion and labelled as one everywhere it is shown. It is arithmetic over
 * what happened, not a claim about what will: the most starved low-value ability is
 * the one whose casts cost the most and buy the least, which is where mana freed up
 * goes furthest — but nothing here has simulated the swap.
 *
 * @param {Object} summary - From {@link summariseRotation}
 * @returns {{kind: string, text: string}|null} Null when nothing stands out
 */
export function bestChange(summary) {
    if (!summary || summary.seconds < MIN_SECONDS) return null;

    const starved = summary.abilities.filter((row) => row.verdict.kind === 'starved');
    if (starved.length) {
        // The least value per point of mana among the ones that cannot fire:
        // freeing its cost is what pays for the rest of the bar
        const worst = starved.slice().sort((a, b) => (a.damagePerMana ?? Infinity) - (b.damagePerMana ?? Infinity))[0];
        return {
            kind: 'swap',
            text:
                `Suggestion: drop ${worst.hrid.split('/').pop().replace(/_/g, ' ')} — it is ready and unaffordable ` +
                `for ${Math.round((worst.starvedShare || 0) * 100)}% of the fight, so its slot is paying for ` +
                'nothing. Freeing its mana is the cheapest way to buy casts elsewhere.',
        };
    }

    if (summary.manaPerMinute !== null && summary.regenPerMinute !== null) {
        const deficit = summary.manaPerMinute - summary.regenPerMinute;
        if (deficit > 0 && summary.starvedSeconds > 0) {
            return {
                kind: 'regen',
                text:
                    `Suggestion: spending ${Math.round(deficit)} more mana a minute than comes back, and the ` +
                    `rotation stalls for ${summary.starvedSeconds.toFixed(1)}s per fight. A mana-restoring drink ` +
                    'or more regen closes that gap before any rotation change will.',
            };
        }
    }

    if (summary.starvedSeconds === 0 && summary.abilities.some((row) => row.verdict.kind === 'idle')) {
        return {
            kind: 'priority',
            text:
                'Suggestion: mana is not the constraint — nothing spent time under its cost. The low-uptime rows ' +
                'above are a rotation-order question, not a regen one.',
        };
    }
    return null;
}

/**
 * The audit, ready to draw.
 *
 * Every rate is null rather than zero when there is nothing to divide by, which is
 * the rule the rest of the combat trackers keep: no fights recorded is not a mana
 * cost of nothing, and no ready time is not a starvation share of nothing.
 *
 * @param {Object} state - From {@link newRotationState}
 * @returns {Object} `{seconds, fights, abilities, manaSpent, manaRestored, manaPerMinute,
 *   regenPerMinute, manaBalance, starvedSeconds, starvedShare, lowManaShare, incomplete,
 *   measurable, dotDamage, suggestion}`
 */
export function summariseRotation(state) {
    const ms = state?.ms || 0;
    const seconds = ms / 1000;
    const minutes = seconds / 60;
    const fights = state?.fights || 0;
    const measurable = seconds >= MIN_SECONDS;

    const abilities = Object.values(state?.abilities || {}).map((row) => {
        const readySeconds = row.readyMs / 1000;
        const cooldownSeconds = row.cooldownMs > 0 ? row.cooldownMs / 1000 : null;
        const mana = row.manaCost > 0 ? row.manaCost * row.casts : null;
        const output = row.damage + row.healing;

        return {
            ...row,
            uptime: cooldownSeconds === null || ms === 0 ? null : row.activeMs / ms,
            readySeconds,
            starvedSeconds: row.starvedMs / 1000,
            starvedShare: row.readyMs > 0 ? row.starvedMs / row.readyMs : null,
            castsPerMinute: minutes > 0 ? row.casts / minutes : null,
            castsPerFight: fights > 0 ? row.casts / fights : null,
            manaSpent: mana,
            output,
            outputPerCast: row.casts > 0 ? output / row.casts : null,
            damagePerMana: mana > 0 ? output / mana : null,
            // What a second of the cooldown it occupies is worth: the figure that
            // ranks a slow heavy ability against a fast light one on the same axis
            damagePerCooldownSecond: cooldownSeconds && row.casts > 0 ? output / (row.casts * cooldownSeconds) : null,
            cooldownSeconds,
        };
    });

    for (const row of abilities) row.verdict = abilityVerdict(row, seconds);

    // Slotted and silent first, because the row worth reading is the one that is
    // not firing; everything else by what it actually produced
    const order = { starved: 0, idle: 1, pinched: 2, unknown: 3, measuring: 4, fine: 5 };
    abilities.sort(
        (a, b) =>
            (order[a.verdict.kind] ?? 9) - (order[b.verdict.kind] ?? 9) || b.output - a.output || b.casts - a.casts
    );

    const summary = {
        seconds,
        fights,
        measurable,
        abilities,
        dotDamage: state?.dotDamage || 0,
        manaSpent: state?.manaSpent || 0,
        manaRestored: state?.manaRestored || 0,
        manaPerMinute: minutes > 0 ? (state?.manaSpent || 0) / minutes : null,
        regenPerMinute: minutes > 0 ? (state?.manaRestored || 0) / minutes : null,
        manaBalance: minutes > 0 ? ((state?.manaRestored || 0) - (state?.manaSpent || 0)) / minutes : null,
        // Per fight, because that is the comparable figure — a total only says
        // how long you have been playing
        starvedSeconds: fights > 0 ? state.starvedMs / 1000 / fights : 0,
        starvedShare: ms > 0 ? (state?.starvedMs || 0) / ms : null,
        lowManaShare: ms > 0 ? (state?.lowManaMs || 0) / ms : null,
        castFloor: state?.castFloor ?? null,
        // Said out loud: a per-mana figure quietly missing an ability's cost
        // reads as a measurement rather than as a gap
        incomplete: abilities.some((row) => row.casts > 0 && !(row.manaCost >= 0)),
    };
    summary.suggestion = bestChange(summary);
    return summary;
}
