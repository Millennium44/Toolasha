/**
 * Wipe event summaries for the Combat Sim results.
 *
 * The engine keeps the last 200 hits that landed on a player in a dungeon and
 * saves them with the wipe (`SimResult.addWipeEvent`). Each hit carries
 * `source`, `ability`, `target`, `damage`, `isCrit`, `beforeHp`, `afterHp`,
 * `time`, `wave` and `playersHp`. Nothing in it says who died: a death is a hit
 * whose `afterHp` is 0 on a target that was above 0 before it.
 *
 * The same log also carries the party's side, merged in time order: `heal`
 * entries (`source`, `ability`, `target`, `amount`, `beforeHp`, `afterHp`,
 * `targetHpPct`, `time`) and `cast` entries (`source`, `ability`, `target`).
 * Entries are told apart by `kind`; an entry with none is a hit, which is how a
 * result saved before heals were logged still reads. Only hits are damage:
 * deaths, killing blows and damage shares never look at the other kinds.
 *
 * Pure functions, no DOM: the UI escapes the strings it draws.
 */

const SPECIAL_ABILITIES = {
    autoAttack: 'Auto Attack',
    damageOverTime: 'DoT',
    physicalThorns: 'Physical Thorns',
    elementalThorns: 'Elemental Thorns',
    retaliation: 'Retaliation',
    lifesteal: 'Life Steal',
};

/**
 * "/monsters/gummy_bear" -> "Gummy Bear"
 * @param {string} hrid
 * @returns {string}
 */
function prettifyHrid(hrid) {
    return String(hrid)
        .split('/')
        .pop()
        .split('_')
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Build the name lookups for one result.
 * @param {Object} options
 * @param {Array<{hrid: string, name: string}>} [options.playerInfo] - Party roster (engine hrids like "player2")
 * @param {Object} [options.gameData] - Game data for monster and ability names
 * @returns {{player: function(string): string, source: function(string): string, ability: function(string): string}}
 */
export function createWipeNamer({ playerInfo = [], gameData = null } = {}) {
    const players = new Map((playerInfo || []).map((p) => [p?.hrid, p?.name]));
    const player = (hrid) => players.get(hrid) || hrid;
    return {
        player,
        source: (hrid) => {
            if (!hrid) return 'Damage over time';
            if (players.has(hrid)) return player(hrid);
            return gameData?.combatMonsterDetailMap?.[hrid]?.name || (hrid.includes('/') ? prettifyHrid(hrid) : hrid);
        },
        ability: (ability) => {
            if (!ability) return 'Unknown';
            if (SPECIAL_ABILITIES[ability]) return SPECIAL_ABILITIES[ability];
            return (
                gameData?.abilityDetailMap?.[ability]?.name ||
                gameData?.itemDetailMap?.[ability]?.name ||
                (ability.includes('/') ? prettifyHrid(ability) : ability)
            );
        },
    };
}

/**
 * Read one wipe's hit log.
 *
 * `down` lists the players that ended the window down, in the order they fell;
 * a player who fell, was hit again while standing (revived), and fell again
 * counts once, at the last fall. Players that fell on the same simulated
 * tick share a `tick` so the UI can show them as simultaneous.
 *
 * @param {Array<Object>} logs - `wipeEvents[n].logs`
 * @returns {{down: Array<{target: string, source: string, ability: string, damage: number, isCrit: boolean,
 *   time: number, tick: number}>, hits: Array<Object>}}
 */
export function analyzeWipe(logs) {
    const all = Array.isArray(logs) ? logs : [];
    const isHit = (log) =>
        log &&
        !log.error &&
        (log.kind === undefined || log.kind === 'hit') &&
        typeof log.target === 'string' &&
        Number.isFinite(log.damage);
    const hits = all.filter(isHit);
    const heals = all.filter(
        (log) => log && !log.error && log.kind === 'heal' && typeof log.target === 'string' && log.amount > 0
    );
    const casts = all.filter((log) => log && !log.error && log.kind === 'cast');
    const fallen = new Map();
    let hitOrder = 0;
    all.forEach((log, at) => {
        if (!isHit(log)) return;
        const order = hitOrder++;
        if ((log.beforeHp ?? 0) > 0) fallen.delete(log.target); // standing when hit: any earlier fall was undone
        if ((log.afterHp ?? 1) <= 0 && (log.beforeHp ?? 0) > 0) {
            fallen.set(log.target, {
                target: log.target,
                source: log.source,
                ability: log.ability,
                damage: log.damage,
                isCrit: !!log.isCrit,
                time: log.time,
                order,
                at,
            });
        }
    });
    const down = [...fallen.values()].sort((a, b) => a.order - b.order);
    // Index of the simulated tick: equal `time` values share one
    let tick = -1;
    let lastTime = null;
    for (const d of down) {
        if (d.time !== lastTime) tick++;
        lastTime = d.time;
        d.tick = tick;
    }
    return { down, hits, heals, casts, entries: all };
}

/**
 * What the party's healing looked like going into one wipe.
 *
 * `heals` counts the heals in the last 30 s before the log's final entry and
 * who they landed on; `lastHealed` says how long before the first player to
 * fall they were last healed. Both are empty when the log holds no party-side
 * entries at all (a result from before they were recorded, or a wipe with no
 * heals and no casts), so an old result does not claim "not healed".
 *
 * @param {ReturnType<typeof analyzeWipe>} analysis
 * @param {ReturnType<typeof createWipeNamer>} namer
 * @returns {{heals: string, lastHealed: string}}
 */
export function describeWipeHealing(analysis, namer) {
    const { down, heals, casts, entries } = analysis;
    if (heals.length === 0 && casts.length === 0) return { heals: '', lastHealed: '' };

    const times = entries.filter((log) => log && !log.error && Number.isFinite(log.time)).map((log) => log.time);
    const end = times.length > 0 ? Math.max(...times) : 0;
    const recent = heals.filter((h) => h.time >= end - 30e9);
    const perTarget = new Map();
    for (const h of recent) {
        const name = namer.player(h.target);
        perTarget.set(name, (perTarget.get(name) || 0) + 1);
    }
    const spread = [...perTarget]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([name, n]) => `${name} ×${n}`)
        .join(', ');
    const healsText = `Heals in the last 30 s: ${recent.length}${spread ? `, to: ${spread}` : ''}`;

    let lastHealed = '';
    if (down.length > 0) {
        const first = down[0];
        let last = null;
        entries.forEach((log, i) => {
            if (i < first.at && log?.kind === 'heal' && log.target === first.target && log.amount > 0) last = log;
        });
        const name = namer.player(first.target);
        lastHealed = last
            ? `${name} last healed ${Math.max(0, (first.time - last.time) / 1e9).toFixed(1)} s before falling`
            : `${name} not healed in the log window`;
    }
    return { heals: healsText, lastHealed };
}

/**
 * Header text for one wipe: who went down first, to what, and the order after.
 * @param {ReturnType<typeof analyzeWipe>} analysis
 * @param {ReturnType<typeof createWipeNamer>} namer
 * @returns {{first: string, order: string}} Plain strings, empty when the log shows no death
 */
export function describeWipe(analysis, namer) {
    const { down } = analysis;
    if (down.length === 0) return { first: '', order: '' };
    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    const lead = down.filter((d) => d.tick === down[0].tick);
    const first = lead
        .map((d) => {
            const by =
                d.ability === 'damageOverTime'
                    ? 'damage over time'
                    : `${namer.source(d.source)}'s ${namer.ability(d.ability)}`;
            return `${namer.player(d.target)} — ${by} ${fmt(d.damage)}${d.isCrit ? ' (crit)' : ''}`;
        })
        .join('; ');
    const groups = [];
    for (const d of down) {
        const group = groups[groups.length - 1];
        if (group && group.tick === d.tick) group.names.push(namer.player(d.target));
        else groups.push({ tick: d.tick, names: [namer.player(d.target)] });
    }
    return { first, order: groups.map((g) => g.names.join(' + ')).join(' → ') };
}

/**
 * Aggregate across every recorded wipe.
 * @param {Array<{wave: number, logs: Array<Object>}>} wipeEvents
 * @param {ReturnType<typeof createWipeNamer>} namer
 * @param {number} [topN=3]
 * @returns {{waves: Array<{wave: *, count: number}>, firstDown: Array<{name: string, count: number}>,
 *   killers: Array<{label: string, blows: number}>, damage: Array<{label: string, total: number, share: number}>,
 *   withLog: number}}
 */
export function summarizeWipes(wipeEvents, namer, topN = 3) {
    const waveCounts = new Map();
    const firstCounts = new Map();
    const blowCounts = new Map();
    const damageTotals = new Map();
    let totalDamage = 0;
    let withLog = 0;
    const byCountThenLabel = (a, b, key) =>
        b[key] - a[key] || String(a.label ?? a.name).localeCompare(b.label ?? b.name);

    for (const event of wipeEvents || []) {
        const wave = event?.wave ?? '?';
        waveCounts.set(wave, (waveCounts.get(wave) || 0) + 1);
        const { down, hits } = analyzeWipe(event?.logs);
        if (hits.length > 0) withLog++;
        if (down.length > 0) {
            // Same-tick first falls each count: neither went down "second"
            for (const d of down.filter((x) => x.tick === down[0].tick)) {
                const name = namer.player(d.target);
                firstCounts.set(name, (firstCounts.get(name) || 0) + 1);
            }
        }
        for (const d of down) {
            const label = killLabel(d.source, d.ability, namer);
            blowCounts.set(label, (blowCounts.get(label) || 0) + 1);
        }
        for (const hit of hits) {
            const label = killLabel(hit.source, hit.ability, namer);
            damageTotals.set(label, (damageTotals.get(label) || 0) + hit.damage);
            totalDamage += hit.damage;
        }
    }

    return {
        waves: [...waveCounts]
            .map(([wave, count]) => ({ wave, count }))
            .sort((a, b) => b.count - a.count || Number(b.wave) - Number(a.wave)),
        firstDown: [...firstCounts]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => byCountThenLabel(a, b, 'count')),
        killers: [...blowCounts]
            .map(([label, blows]) => ({ label, blows }))
            .sort((a, b) => byCountThenLabel(a, b, 'blows'))
            .slice(0, topN),
        damage: [...damageTotals]
            .map(([label, total]) => ({ label, total, share: totalDamage > 0 ? total / totalDamage : 0 }))
            .sort((a, b) => byCountThenLabel(a, b, 'total'))
            .slice(0, topN),
        withLog,
    };
}

/**
 * "Gummy Bear — Crushing Strike"; a damage-over-time tick has no source.
 * @private
 */
function killLabel(source, ability, namer) {
    if (ability === 'damageOverTime') return 'Damage over time';
    return `${namer.source(source)} — ${namer.ability(ability)}`;
}
