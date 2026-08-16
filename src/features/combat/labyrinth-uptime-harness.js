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

    let prevMatk;
    let prevMAbility;
    let prevPHP;
    let prevPdmg;
    let firstAt;
    let lastAt;
    let fights = 0;
    let sawAttack = false;
    // Swings awaiting their resolution, oldest first — each holds the ability the
    // monster was preparing when it swung.
    const pending = [];

    const resetFight = () => {
        prevMatk = undefined;
        prevMAbility = undefined;
        prevPHP = undefined;
        prevPdmg = undefined;
        pending.length = 0;
    };

    for (const tick of ticks || []) {
        const at = tick?.at;
        if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
        if (Number.isFinite(at)) lastAt = at;

        const monster = tick?.payload?.mMap?.[mi];
        const player = tick?.payload?.pMap?.[pi];
        if (!monster) {
            // Monster gone between fights, or a brief render gap: the health
            // readings around it snap to stale/max values, so drop ALL running
            // baselines — health included — and re-seed cleanly on the next
            // spawn rather than reading a giant drop off a corrupted baseline.
            resetFight();
            continue;
        }

        const matk = Number(monster.atkCounter);
        const php = player && Number.isFinite(Number(player.cHP)) ? Number(player.cHP) : null;
        const pdmg = player && Number.isFinite(Number(player.dmgCounter)) ? Number(player.dmgCounter) : null;

        // Respawn — the monster's counter reset. New fight; drop the baselines so
        // the reset is not read as a burst of attacks.
        if (prevMatk !== undefined && Number.isFinite(matk) && matk < prevMatk) {
            fights += 1;
            resetFight();
        }

        if (hasDmgCounter) {
            // The monster's swings drive cast share, labelled by the ability it
            // was preparing before the swing (the hit was cast by what came
            // before it, not the next thing already being wound up).
            if (prevMatk !== undefined && Number.isFinite(matk) && matk > prevMatk) {
                const label = prevMAbility || monster.abilityHrid || 'autoAttack';
                for (let n = 0; n < matk - prevMatk; n++) {
                    rec(label).casts += 1;
                    pending.push(label);
                }
                sawAttack = true;
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
                sawAttack = true;
            }
        } else {
            // Health-drop fallback, for a capture with no damage counter.
            const drop = prevPHP != null && php != null ? prevPHP - php : 0;
            if (prevMatk !== undefined && Number.isFinite(matk) && matk > prevMatk) {
                const label = prevMAbility || monster.abilityHrid || 'autoAttack';
                const r = rec(label);
                r.casts += matk - prevMatk;
                if (drop > 0) {
                    r.hits += 1;
                    r.damage += drop;
                    r.samples.push(drop);
                } else {
                    r.misses += matk - prevMatk;
                }
                sawAttack = true;
            } else if (prevMatk !== undefined && drop > 0) {
                const r = rec('damageOverTime');
                r.hits += 1;
                r.damage += drop;
                r.samples.push(drop);
            }
        }

        if (Number.isFinite(matk)) prevMatk = matk;
        if (monster.abilityHrid) prevMAbility = monster.abilityHrid;
        if (php != null) prevPHP = php;
        if (pdmg != null) prevPdmg = pdmg;
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
        // Cadence, read straight off the attack counter — the reliable half. A
        // damage-share gap on an ability whose cast share matches is a magnitude
        // question (per-cast damage), not a rotation one.
        const castShareGap = (s?.castSharePct ?? 0) - (r?.castSharePct ?? 0);
        let verdict = 'ok';
        if (!s) verdict = 'sim-missing';
        else if (!r) verdict = 'sim-extra';
        else if (Math.abs(dmgShareGap) >= tolerancePct) verdict = dmgShareGap < 0 ? 'sim-under' : 'sim-over';
        return { ability: String(ability).split('/').pop(), real: r, sim: s, dmgShareGap, castShareGap, verdict };
    });

    rows.sort((a, b) => (b.real?.dmgSharePct ?? 0) - (a.real?.dmgSharePct ?? 0));
    return { rows, realTotals: realT, simTotals: simT };
}
