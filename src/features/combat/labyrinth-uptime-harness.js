/**
 * Uptime / cadence harness
 *
 * The stat check and blind sim pin the sim's *stats* and *effect production*.
 * They cannot see the last failure mode: **timing** — how often the monster
 * casts, and how long its buffs stay up. That is what a "monster deals more
 * damage than predicted" gap (the Salamander +13%) comes down to once the stats
 * and the buff magnitudes are confirmed right.
 *
 * This decomposes the monster's *incoming* damage the same way the replay
 * decomposes the player's outgoing damage — but per ability, and from two
 * sources put side by side:
 *
 *   - **Real**, from a tick capture: an incoming attack is the *player's*
 *     `dmgCounter` rising (immune to regen, and exact even when the health
 *     snapshot lags the swing); the monster's attack counter names which swing it
 *     pays off, labelled by the ability the monster was preparing before it, and
 *     the player's health drop that tick is the damage. A counter rise with no
 *     swing waiting is a damage-over-time tick. (See `damage-attribution.js` — the
 *     same counter-based attribution, pointed at the monster→player direction.)
 *   - **Sim**, from `SimResult.attacks[monster][player]`, which already records a
 *     per-ability damage histogram — no sim instrumentation needed.
 *
 * The comparison is deliberately **unit-free** — share of casts, share of
 * damage, and mean damage per cast — so it needs no alignment of real vs sim
 * total combat time (which the two don't share). The signal:
 *
 *   - a **cast-share** gap on an ability → cadence / cooldown / cast-condition;
 *   - a **damage-share** or **mean-damage** gap on an amplified ability → the
 *     buff that amplifies it is up a different fraction of the fight (uptime),
 *     or its magnitude is off (which the blind sim would have already caught).
 *
 * The 3 Hz tick feed occasionally merges two hits into one health delta, so
 * treat per-cast means as slightly coarsened; cast *counts* come from the
 * attack counter and stay exact.
 */

/**
 * Extract the monster's outgoing attacks (the player's incoming damage) from a
 * tick-capture tick list.
 *
 * ## Attempts, not one long fight
 *
 * A capture spans retries. The authoritative boundary between them is the
 * `new_battle` message the capture keeps whole — battle ids are reused (a whole
 * session of retries all arrive as battle 1), so the id can never segment, and
 * the old counter-reset heuristic could not either: `new_battle` carries no
 * compact monster map, which used to wipe the very baselines the reset would
 * have been detected against. A whole capture of retries then read as ONE
 * fight, the leading partial included, and every share and sample count on it.
 *
 * Each `new_battle` now opens a fresh attempt AND seeds the baselines from its
 * full unit snapshots (attack and damage counters, health, what each side is
 * preparing) — so the first compact tick is measured against the fight's true
 * start rather than becoming an unmeasured baseline that silently swallowed
 * the opening hit. Ticks before the first `new_battle` are a fight already in
 * progress when recording began: kept as a partial attempt, excluded from the
 * aggregate, never passed off as a complete fight. Counter resets remain as
 * the boundary of last resort for old captures that carry no start messages.
 *
 * @param {Array<Object>} ticks - Capture ticks (`battle_updated` and
 *   `new_battle`), as recorded
 * @param {Object} [opts] - `{monsterIndex='0', playerIndex='0', nonDamaging}`,
 *   where `nonDamaging` is a Set of ability hrids that deal no damage (buffs,
 *   debuffs) — counted as casts but never credited incoming damage
 * @returns {{durationMs: number, fights: number, partialFights: number,
 *   captureStartedMidFight: boolean, attempts: Array<Object>, byAbility: Object}}
 *   `byAbility[ability] = {casts, hits, misses, damage, samples: number[]}`,
 *   aggregated over complete attempts only; `attempts[n]` carries per-attempt
 *   `{complete, outcome, startAt, endAt, byAbility}`
 */
export function extractMonsterAttacks(ticks, opts = {}) {
    const mi = opts.monsterIndex ?? '0';
    const pi = opts.playerIndex ?? '0';
    // Ability hrids that deal no damage — a monster's self-buffs and debuffs
    // (Toughness, a guardian aura, a smoke burst). They still take a turn, so
    // they count as casts, but they land no hit: queueing one would let the next
    // real swing's damage pay off the buff's slot, crediting incoming damage to
    // an ability that cannot deal any. Empty set = label everything as it comes.
    const nonDamaging = opts.nonDamaging instanceof Set ? opts.nonDamaging : new Set();

    // Prefer the player's damage counter. A resolved incoming attack is
    // `dmgCounter` **rising** — which, unlike a health drop, is immune to regen,
    // survives the health snapshot lagging the swing (the counter is exact even
    // when the HP number that tick is stale), and states a miss (`dmgCounter` up,
    // health flat) as plainly as a hit. The monster's own `atkCounter` names the
    // swing but its damage lands a tick or two later for a cast ability, so the
    // swings queue up and each is paid off by the next resolution (FIFO). This is
    // the same signal the damage panel and calibration replay attribute from,
    // pointed at the monster→player direction. When the capture lacks the counter
    // we fall back to health drops, labelling by the ability prepared before.
    const hasDmgCounter = (ticks || []).some((t) => Number.isFinite(Number(t?.payload?.pMap?.[pi]?.dmgCounter)));

    // Only a capture that carries start messages can tell a fight-in-progress
    // from a fight it saw open. An old capture with none is read as before:
    // its leading segment counts as a whole fight, because calling every legacy
    // capture "all partial" would empty the aggregate it was recorded for.
    const hasStarts = (ticks || []).some((t) => t?.type === 'new_battle');

    let prevMatk;
    let prevMLabel;
    let prevPHP;
    let prevPdmg;
    let firstAt;
    let lastAt;
    // Swings awaiting their resolution, oldest first — each holds the ability the
    // monster was preparing when it swung.
    const pending = [];

    const resetBaselines = () => {
        prevMatk = undefined;
        prevMLabel = undefined;
        prevPHP = undefined;
        prevPdmg = undefined;
        pending.length = 0;
    };

    // The attempt being accumulated, and the ones already closed. The first
    // attempt is partial when ticks precede the first `new_battle` — a fight
    // already in progress when recording began.
    const attempts = [];
    let current = null;
    let byAbility = {};
    const rec = (ability) =>
        (byAbility[ability] = byAbility[ability] || { casts: 0, hits: 0, misses: 0, damage: 0, samples: [] });

    const closeAttempt = () => {
        if (!current) return;
        // The last health readings inside the attempt say how it ended; a
        // boundary reached with both sides standing stays unknown
        current.outcome = current.lastPHP === 0 ? 'loss' : current.lastMHP === 0 ? 'win' : 'unknown';
        current.byAbility = byAbility;
        attempts.push(current);
        current = null;
        byAbility = {};
    };

    const openAttempt = (complete, at) => {
        closeAttempt();
        current = { complete, startAt: at ?? null, endAt: at ?? null, lastPHP: null, lastMHP: null, sawAttack: false };
    };

    /** The unit at an index in a `new_battle` array-or-map payload. */
    const unitAt = (units, index) => {
        if (Array.isArray(units)) return units[Number(index)];
        return units ? units[index] : undefined;
    };

    for (const tick of ticks || []) {
        const at = tick?.at;
        if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
        if (Number.isFinite(at)) lastAt = at;

        if (tick?.type === 'new_battle') {
            // The authoritative attempt boundary. Open the fresh attempt and
            // seed every baseline from the full start snapshot, so the first
            // compact tick is measured against the true start instead of
            // becoming an unmeasured baseline (which cost the opening hit).
            openAttempt(true, at);
            resetBaselines();
            const startMonster = unitAt(tick?.payload?.monsters, mi);
            const startPlayer = unitAt(tick?.payload?.players, pi);
            if (Number.isFinite(Number(startMonster?.attackAttemptCounter))) {
                prevMatk = Number(startMonster.attackAttemptCounter);
            }
            if (Number.isFinite(Number(startPlayer?.damageSplatCounter))) {
                prevPdmg = Number(startPlayer.damageSplatCounter);
            }
            if (Number.isFinite(Number(startPlayer?.currentHitpoints))) {
                prevPHP = Number(startPlayer.currentHitpoints);
                current.lastPHP = prevPHP;
            }
            if (Number.isFinite(Number(startMonster?.currentHitpoints))) {
                current.lastMHP = Number(startMonster.currentHitpoints);
            }
            if (startMonster?.preparingAbilityHrid) prevMLabel = startMonster.preparingAbilityHrid;
            else if (startMonster?.isPreparingAutoAttack) prevMLabel = 'autoAttack';
            continue;
        }

        const monster = tick?.payload?.mMap?.[mi];
        const player = tick?.payload?.pMap?.[pi];
        if (!monster) {
            // Monster gone between fights, or a brief render gap: the health
            // readings around it snap to stale/max values, so drop ALL running
            // baselines — health included — and re-seed cleanly on the next
            // spawn rather than reading a giant drop off a corrupted baseline.
            resetBaselines();
            continue;
        }

        // Compact ticks before any `new_battle` are a fight already in progress
        // when recording began — kept, flagged, and excluded from the aggregate.
        // (When the capture has no start messages at all, the legacy reading
        // holds and the leading segment is a whole fight.)
        if (!current) openAttempt(!hasStarts, at);
        if (Number.isFinite(at)) current.endAt = at;

        const matk = Number(monster.atkCounter);
        const php = player && Number.isFinite(Number(player.cHP)) ? Number(player.cHP) : null;
        const pdmg = player && Number.isFinite(Number(player.dmgCounter)) ? Number(player.dmgCounter) : null;
        if (php != null) current.lastPHP = php;
        if (Number.isFinite(Number(monster.cHP))) current.lastMHP = Number(monster.cHP);

        // Respawn with no start message — the counter of last resort for old
        // captures. New attempt; drop the baselines so the reset is not read as
        // a burst of attacks.
        if (prevMatk !== undefined && Number.isFinite(matk) && matk < prevMatk) {
            openAttempt(true, at);
            resetBaselines();
        }

        if (hasDmgCounter) {
            // The monster's swings drive cast share, labelled by the ability it
            // was preparing before the swing (the hit was cast by what came
            // before it, not the next thing already being wound up).
            if (prevMatk !== undefined && Number.isFinite(matk) && matk > prevMatk) {
                const label = prevMLabel || monster.abilityHrid || 'autoAttack';
                const dealsDamage = !nonDamaging.has(label);
                for (let n = 0; n < matk - prevMatk; n++) {
                    rec(label).casts += 1;
                    // A buff/debuff takes a turn but lands no hit, so it never
                    // joins the queue the next resolution pays off.
                    if (dealsDamage) pending.push(label);
                }
                current.sawAttack = true;
            }
            // The attacks that actually connected this tick, from the exact
            // counter. Each pays off the oldest pending swing; a resolution with
            // no swing waiting is a damage-over-time tick.
            if (prevPdmg !== undefined && pdmg !== null && pdmg > prevPdmg) {
                const count = pdmg - prevPdmg;
                const drop = prevPHP != null && php != null ? Math.max(0, prevPHP - php) : 0;
                const per = count > 0 ? drop / count : 0; // even split across a merged tick
                for (let n = 0; n < count; n++) {
                    const label = pending.length ? pending.shift() : 'damageOverTime';
                    const r = rec(label);
                    if (per > 0) {
                        r.hits += 1;
                        r.damage += per;
                        r.samples.push(per);
                    } else {
                        r.misses += 1;
                    }
                }
                current.sawAttack = true;
            }
        } else {
            // Health-drop fallback, for a capture with no damage counter.
            const drop = prevPHP != null && php != null ? prevPHP - php : 0;
            if (prevMatk !== undefined && Number.isFinite(matk) && matk > prevMatk) {
                const label = prevMLabel || monster.abilityHrid || 'autoAttack';
                const r = rec(label);
                r.casts += matk - prevMatk;
                if (nonDamaging.has(label)) {
                    // A buff/debuff cast lands no hit; a health drop this tick is
                    // something else resolving (a damage-over-time), not this cast.
                    if (drop > 0) {
                        const dot = rec('damageOverTime');
                        dot.hits += 1;
                        dot.damage += drop;
                        dot.samples.push(drop);
                    }
                } else if (drop > 0) {
                    r.hits += 1;
                    r.damage += drop;
                    r.samples.push(drop);
                } else {
                    r.misses += matk - prevMatk;
                }
                current.sawAttack = true;
            } else if (prevMatk !== undefined && drop > 0) {
                const r = rec('damageOverTime');
                r.hits += 1;
                r.damage += drop;
                r.samples.push(drop);
            }
        }

        if (Number.isFinite(matk)) prevMatk = matk;
        // What the monster is doing this tick, so the NEXT swing is labelled by
        // it. The payload names a special in abilityHrid only on its cast tick and
        // never persists it, marking ordinary swings with isAutoAtk instead — so
        // an auto-attack tick must reset the label to autoAttack. Without this the
        // last special sticks and every following auto inherits it, inflating
        // special cast-share past what the cooldowns physically allow (an auto
        // share the fight length cannot produce) and starving autoAttack.
        if (monster.abilityHrid) prevMLabel = monster.abilityHrid;
        else if (monster.isAutoAtk) prevMLabel = 'autoAttack';
        if (php != null) prevPHP = php;
        if (pdmg != null) prevPdmg = pdmg;
    }

    closeAttempt();

    // The aggregate the comparison runs on: complete attempts only. The leading
    // partial is reported, never averaged in — its missing opening would read
    // as a shorter, gentler fight than anybody actually had.
    const complete = attempts.filter((attempt) => attempt.complete && attempt.sawAttack);
    const aggregate = {};
    for (const attempt of complete) {
        for (const [ability, r] of Object.entries(attempt.byAbility || {})) {
            const target = (aggregate[ability] = aggregate[ability] || {
                casts: 0,
                hits: 0,
                misses: 0,
                damage: 0,
                samples: [],
            });
            target.casts += r.casts;
            target.hits += r.hits;
            target.misses += r.misses;
            target.damage += r.damage;
            target.samples.push(...r.samples);
        }
    }

    return {
        durationMs: (lastAt ?? 0) - (firstAt ?? 0),
        fights: complete.length,
        partialFights: attempts.filter((attempt) => !attempt.complete && attempt.sawAttack).length,
        captureStartedMidFight: attempts.length > 0 && !attempts[0].complete,
        attempts,
        byAbility: aggregate,
    };
}

/**
 * Summarise the sim side from `SimResult.attacks[monsterHrid][playerHrid]`.
 * @param {Object} attacksForPair - `{ability: {<damage>|'miss': count}}`
 * @returns {{byAbility: Object}}
 */
export function summarizeSimAttacks(attacksForPair) {
    const byAbility = {};
    for (const [ability, hist] of Object.entries(attacksForPair || {})) {
        let hits = 0;
        let misses = 0;
        let damage = 0;
        for (const [key, count] of Object.entries(hist || {})) {
            if (key === 'miss') {
                misses += count;
            } else {
                hits += count;
                damage += Number(key) * count;
            }
        }
        byAbility[ability] = { casts: hits + misses, hits, misses, damage };
    }
    return { byAbility };
}

/** Totals across a `byAbility` map, for the share denominators. */
function totalsOf(byAbility) {
    let casts = 0;
    let damage = 0;
    for (const r of Object.values(byAbility || {})) {
        casts += r.casts || 0;
        damage += r.damage || 0;
    }
    return { casts, damage };
}

/**
 * Per-ability real-vs-sim comparison of the monster's attacks — cast share,
 * damage share, and mean damage per cast, all unit-free so no time alignment is
 * needed. Rows are ordered by real damage share (what hurts most, first).
 *
 * @param {Object} real - From {@link extractMonsterAttacks}
 * @param {Object} sim - From {@link summarizeSimAttacks}
 * @param {number} [tolerancePct=15] - Share gap beyond which a row is flagged
 * @returns {{rows: Array<Object>, realTotals, simTotals}}
 */
export function compareIncoming(real, sim, tolerancePct = 15) {
    const realT = totalsOf(real?.byAbility);
    const simT = totalsOf(sim?.byAbility);
    const abilities = [...new Set([...Object.keys(real?.byAbility || {}), ...Object.keys(sim?.byAbility || {})])];

    const side = (r, tot) =>
        r
            ? {
                  casts: r.casts,
                  hits: r.hits,
                  damage: Math.round(r.damage),
                  castSharePct: tot.casts ? (100 * r.casts) / tot.casts : 0,
                  dmgSharePct: tot.damage ? (100 * r.damage) / tot.damage : 0,
                  meanDmgPerCast: r.casts ? r.damage / r.casts : r.hits ? r.damage / r.hits : 0,
              }
            : null;

    const rows = abilities.map((ability) => {
        const r = side(real?.byAbility?.[ability], realT);
        const s = side(sim?.byAbility?.[ability], simT);
        // The headline gap: how the ability's share of incoming damage differs.
        const dmgShareGap = (s?.dmgSharePct ?? 0) - (r?.dmgSharePct ?? 0);
        // Cadence, read straight off the attack counter — the reliable half. A
        // damage-share gap on an ability whose cast share matches is a magnitude
        // question (per-cast damage), not a rotation one.
        const castShareGap = (s?.castSharePct ?? 0) - (r?.castSharePct ?? 0);
        let verdict = 'ok';
        if (!s) {
            // A self-buff (precision, a fierce/guardian aura) casts but deals no
            // damage, so it never enters the sim's attack tally — that is the
            // tally correctly omitting a non-damaging ability, not the sim
            // failing to produce a damage source. Flag those apart from a
            // genuinely absent damaging ability, which the blind-buff probe is
            // the right tool to verify; otherwise every buff cast reads as a bug.
            verdict = r && r.damage === 0 && r.hits === 0 ? 'buff' : 'sim-missing';
        } else if (!r) verdict = 'sim-extra';
        else if (Math.abs(dmgShareGap) >= tolerancePct) verdict = dmgShareGap < 0 ? 'sim-under' : 'sim-over';
        return { ability: String(ability).split('/').pop(), real: r, sim: s, dmgShareGap, castShareGap, verdict };
    });

    rows.sort((a, b) => (b.real?.dmgSharePct ?? 0) - (a.real?.dmgSharePct ?? 0));
    return { rows, realTotals: realT, simTotals: simT };
}
