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
 *   - **Real**, from a tick capture: each time the monster's attack counter
 *     rises, an attack landed; the ability it was preparing the tick before
 *     names it, and the player's health drop is the damage. Health falling with
 *     no attack-counter rise is a damage-over-time tick.
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
 * @param {Array<Object>} ticks - `battle_updated` payloads, as recorded
 * @param {Object} [opts] - `{monsterIndex='0', playerIndex='0'}`
 * @returns {{durationMs: number, fights: number, byAbility: Object}}
 *   `byAbility[ability] = {casts, hits, misses, damage, samples: number[]}`
 */
export function extractMonsterAttacks(ticks, opts = {}) {
    const mi = opts.monsterIndex ?? '0';
    const pi = opts.playerIndex ?? '0';
    const byAbility = {};
    const rec = (ability) =>
        (byAbility[ability] = byAbility[ability] || { casts: 0, hits: 0, misses: 0, damage: 0, samples: [] });

    let prevAtk;
    let prevAbility;
    let prevPHP;
    let firstAt;
    let lastAt;
    let fights = 0;
    let sawAttack = false;

    for (const tick of ticks || []) {
        const at = tick?.at;
        if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
        if (Number.isFinite(at)) lastAt = at;

        const monster = tick?.payload?.mMap?.[mi];
        const player = tick?.payload?.pMap?.[pi];
        if (!monster) {
            // Monster gone between fights — drop the running counters so the next
            // spawn's first counter reading is not read as a burst of attacks.
            prevAtk = undefined;
            prevAbility = undefined;
            continue;
        }

        const atk = Number(monster.atkCounter);
        const php = player && Number.isFinite(Number(player.cHP)) ? Number(player.cHP) : null;
        const drop = prevPHP != null && php != null ? prevPHP - php : 0;

        if (prevAtk !== undefined && Number.isFinite(atk)) {
            if (atk < prevAtk) {
                // Counter reset — a new fight (respawn).
                fights += 1;
            } else if (atk > prevAtk) {
                const ability = prevAbility || monster.abilityHrid || 'autoAttack';
                const r = rec(ability);
                r.casts += atk - prevAtk;
                if (drop > 0) {
                    r.hits += 1;
                    r.damage += drop;
                    r.samples.push(drop);
                } else {
                    r.misses += atk - prevAtk;
                }
                sawAttack = true;
            } else if (drop > 0) {
                // Health fell with no attack this tick → damage over time.
                const r = rec('damageOverTime');
                r.hits += 1;
                r.damage += drop;
                r.samples.push(drop);
            }
        }

        prevAtk = Number.isFinite(atk) ? atk : prevAtk;
        if (monster.abilityHrid) prevAbility = monster.abilityHrid;
        if (php != null) prevPHP = php;
    }

    return { durationMs: (lastAt ?? 0) - (firstAt ?? 0), fights: fights + (sawAttack ? 1 : 0), byAbility };
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
        let verdict = 'ok';
        if (!s) verdict = 'sim-missing';
        else if (!r) verdict = 'sim-extra';
        else if (Math.abs(dmgShareGap) >= tolerancePct) verdict = dmgShareGap < 0 ? 'sim-under' : 'sim-over';
        return { ability: String(ability).split('/').pop(), real: r, sim: s, dmgShareGap, verdict };
    });

    rows.sort((a, b) => (b.real?.dmgSharePct ?? 0) - (a.real?.dmgSharePct ?? 0));
    return { rows, realTotals: realT, simTotals: simT };
}
