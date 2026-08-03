/**
 * Damage taken
 *
 * What is hitting you, and for how much, from a payload that never says.
 *
 * The mirror of `damage-attribution.js`. That module answers "who in the party
 * hit what"; this one answers "what hit whom in the party", which is a different
 * question with a different join and a worse one.
 *
 * ## A hit is a counter, not a health drop
 *
 * Same rule as the outgoing side, for the same reason: health moves for regen,
 * for bleeds, and for food. A hit is the player's `dmgCounter` **rising**, and
 * the size of it is how much health went with it. A counter that rose with the
 * health unchanged is a **miss** — the one event a health diff can never
 * express. Health rising is regeneration and is counted separately, because
 * "took 3,400 and healed 3,600" is the reading that says whether a zone is
 * survivable and a net figure is not.
 *
 * ## Which monster did it is a guess, and it is labelled as one
 *
 * Outgoing has mana: only the caster's mana falls, so the attacker is known.
 * Incoming has that only for a monster casting an ability — a monster swinging
 * an auto-attack spends nothing, and most of what hits you is auto-attacks. So
 * there is a ladder, in the order MCS's IHurt uses it:
 *
 * 1. **A monster's mana fell** — it cast, and it is the attacker.
 * 2. **There is only one monster** — no ambiguity to resolve.
 * 3. **A monster's own `dmgCounter` rose** — it was hit this tick. A proxy, and
 *    a weak one: being hit is not attacking. It is right in the common case
 *    (you and it are trading) and wrong when the party is spread across a wave.
 * 4. **Nobody** — recorded against `null` rather than against a guess, and shown
 *    as "Unknown Enemy".
 *
 * Rung 3 is the one to be suspicious of. It is kept because it is what IHurt
 * does, and a panel that disagrees with the one it is modelled on is worse than
 * one that inherits its uncertainty — but the damage credited by it is not
 * evidence about which monster in a wave is dangerous.
 *
 * The model is IHurt's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/**
 * A fresh set of the counters a tick is measured against.
 * @returns {Object}
 */
export function newTakenState() {
    return { playersHP: {}, playersDmg: {}, monstersMP: {}, monstersDmg: {} };
}

/**
 * Which monster acted this tick, as far as anything can tell.
 *
 * @param {Object} mMap - The tick's monsters
 * @param {Object} state - From `newTakenState`, mutated with this tick's counters
 * @returns {string|null} A monster index, or null when nothing identifies one
 */
export function findAttacker(mMap, state) {
    const monsters = Object.entries(mMap || {});
    let cast = null;
    let struck = null;

    for (const [index, monster] of monsters) {
        if (!monster) continue;

        const previousMP = state.monstersMP[index];
        if (previousMP !== undefined && Number(monster.cMP) < previousMP) cast = index;
        state.monstersMP[index] = Number(monster.cMP);

        const previousDmg = state.monstersDmg[index];
        const currentDmg = Number(monster.dmgCounter ?? 0);
        if (previousDmg !== undefined && currentDmg > previousDmg) struck = index;
        state.monstersDmg[index] = currentDmg;
    }

    if (cast !== null) return cast;
    if (monsters.length === 1) return monsters[0][0];
    return struck;
}

/**
 * What happened to the party on one tick.
 *
 * A player seen for the first time is recorded and produces nothing: there is no
 * previous reading to diff against, and treating the first sight as a full-health
 * hit would invent one enormous blow at the start of every battle.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} state - From `newTakenState`, mutated
 * @returns {Array<Object>} `{playerIndex, monsterIndex, damage, isMiss, isRegen, isDeath}`
 */
export function attributeIncoming(tick, state) {
    const events = [];
    const pMap = tick?.pMap || {};
    const attacker = findAttacker(tick?.mMap, state);

    for (const [index, player] of Object.entries(pMap)) {
        if (!player) continue;

        const health = Number(player.cHP);
        const counter = Number(player.dmgCounter ?? 0);
        const beforeHealth = state.playersHP[index];
        const beforeCounter = state.playersDmg[index];

        state.playersHP[index] = health;
        state.playersDmg[index] = counter;
        if (beforeHealth === undefined || beforeCounter === undefined) continue;

        // Its own event, so a death from a bleed still counts — it is not
        // conditional on the counter having risen
        if (beforeHealth > 0 && health <= 0) events.push({ playerIndex: index, isDeath: true });

        const lost = beforeHealth - health;
        if (counter > beforeCounter) {
            events.push({
                playerIndex: index,
                monsterIndex: attacker,
                damage: Math.max(0, lost),
                isMiss: lost <= 0,
            });
        } else if (lost < 0) {
            events.push({ playerIndex: index, damage: -lost, isRegen: true });
        }
    }

    return events;
}

/**
 * Add a tick's events to a running per-player tally.
 *
 * @param {Object} tally - Player index → totals, mutated
 * @param {Array<Object>} events - From `attributeIncoming`
 */
export function foldTaken(tally, events) {
    for (const event of events) {
        const entry = (tally[event.playerIndex] ||= { damage: 0, regen: 0, hits: 0, misses: 0, deaths: 0 });

        if (event.isDeath) entry.deaths += 1;
        else if (event.isRegen) entry.regen += event.damage;
        else if (event.isMiss) entry.misses += 1;
        else {
            entry.damage += event.damage;
            entry.hits += 1;
        }
    }
}

/**
 * Add a tick's events to a running per-monster tally.
 *
 * Hit ranges rather than just totals, because that is what says whether a zone
 * is survivable: an average of forty with a maximum of two hundred is a zone
 * that kills you, and the average alone says it is comfortable.
 *
 * @param {Object} tally - Monster name → totals, mutated
 * @param {Array<Object>} events - From `attributeIncoming`
 * @param {Function} nameOf - Monster index → name, or null
 */
export function foldTakenByEnemy(tally, events, nameOf) {
    for (const event of events) {
        if (event.isDeath || event.isRegen || event.isMiss) continue;

        const name =
            (event.monsterIndex === null || event.monsterIndex === undefined ? null : nameOf(event.monsterIndex)) ||
            'Unknown Enemy';
        const entry = (tally[name] ||= { damage: 0, hits: 0, min: null, max: null, byPlayer: {} });

        entry.damage += event.damage;
        entry.hits += 1;
        entry.min = entry.min === null ? event.damage : Math.min(entry.min, event.damage);
        entry.max = entry.max === null ? event.damage : Math.max(entry.max, event.damage);

        const player = (entry.byPlayer[event.playerIndex] ||= { damage: 0, hits: 0, min: null, max: null });
        player.damage += event.damage;
        player.hits += 1;
        player.min = player.min === null ? event.damage : Math.min(player.min, event.damage);
        player.max = player.max === null ? event.damage : Math.max(player.max, event.damage);
    }
}

/**
 * A name for a wave, so two of the same wave are recognised as the same wave.
 *
 * Sorted and counted rather than taken in spawn order: the game hands the same
 * three monsters over in whatever order it likes, and a key that follows that
 * order would file one wave under six different names and never accumulate
 * enough encounters of any of them to average.
 *
 * @param {Array<Object>|Object} monsters - Monsters from `new_battle`
 * @param {Function} nameOf - Monster → name
 * @returns {string} e.g. `Eye x2 + Veyes`
 */
export function waveKey(monsters, nameOf) {
    const counts = {};
    for (const monster of Object.values(monsters || {})) {
        const name = nameOf(monster) || 'Unknown';
        counts[name] = (counts[name] || 0) + 1;
    }

    return Object.keys(counts)
        .sort()
        .map((name) => (counts[name] > 1 ? `${name} x${counts[name]}` : name))
        .join(' + ');
}
