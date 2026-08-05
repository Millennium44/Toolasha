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
 * ## `atkCounter` says who attacked
 *
 * `mMap` is a delta — it carries the units the server touched this tick, not the
 * wave, so it is usually nought or one entry against a roster of three. And each
 * monster in it carries `atkCounter`, which is exactly what its name suggests:
 * it goes up when that monster attacks. On a recorded dungeon it rose on exactly
 * one monster for thirty-two of the thirty-eight ticks the character was hit,
 * and the other six were a monster's first appearance in the delta, alone.
 *
 * ## The ladder
 *
 * 1. **`atkCounter` rose** — it attacked. This is the answer nearly every time.
 * 2. **`cMP` fell** — it cast, for a payload that does not carry `atkCounter`.
 * 3. **Its first appearance in the delta, alone** — there is no baseline to
 *    compare against, but the server mentioned it and nothing else.
 * 4. **Nothing about it changed at all** — the same idea for a payload with
 *    fewer fields; a monster with nothing to report is in the delta because it
 *    acted.
 * 5. **`dmgCounter` rose** — it was hit this tick. MCS's proxy, kept last:
 *    being hit is not attacking, and what it names is the monster *you* hit.
 * 6. **Nobody** — no candidate rather than a guess, shown as "Unknown Enemy".
 *
 * Several candidates of the same kind resolve rather than falling through, since
 * "what hit me" has the same answer either way.
 *
 * ## Two wrong turns worth remembering
 *
 * The first version had "there is only one monster in the tick" as its second
 * rung, justified as "no ambiguity to resolve". It was right most of the time
 * for the wrong reason — the wave was usually still three strong, and what made
 * the tick unambiguous was the delta, not the fight — so it fell through to
 * rung 5 and credited the monster you were attacking whenever two units
 * reported together.
 *
 * The second version replaced it with "nothing about it changed", measured off a
 * recorded run where that held on thirty-seven of forty-two hits. That recording
 * had been **hand-trimmed** down to five fields when it was made into a fixture,
 * and the trimming was what made the monsters look unchanged. Against a real
 * payload it fires never, and everything went to Unknown Enemy. The fixture for
 * this module now keeps every field a tick carries, which is the only reason
 * `atkCounter` was visible at all.
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
    return { playersHP: {}, playersDmg: {}, monsters: {} };
}

/**
 * Whether a monster reported anything different from last time.
 *
 * Every field the tick carries, rather than a list of the ones known today: a
 * monster that is in the delta only because of a field this does not know about
 * would otherwise be read as having acted.
 *
 * @param {Object} before - Its previous state
 * @param {Object} now - Its state this tick
 * @returns {boolean}
 */
function unchanged(before, now) {
    for (const key of Object.keys(now)) {
        if (now[key] !== before[key]) return false;
    }
    return true;
}

/**
 * Which monsters could have acted this tick.
 *
 * A list rather than one index, because "both Eyes swung" is a real answer: the
 * caller knows their names and can see that the ambiguity does not matter.
 * Picking one of them arbitrarily would throw that away, and returning nothing
 * would lose damage the payload was perfectly clear about.
 *
 * @param {Object} mMap - The tick's monsters, which is a delta and not the wave
 * @param {Object} state - From `newTakenState`, mutated with this tick's units
 * @returns {Array<string>} Monster indices, empty when nothing identifies one
 */
export function findAttackers(mMap, state) {
    const entries = Object.entries(mMap || {}).filter(([, monster]) => monster);
    const attacked = [];
    const cast = [];
    const fresh = [];
    const quiet = [];
    const struck = [];

    for (const [index, monster] of entries) {
        const before = state.monsters[index];
        state.monsters[index] = monster;

        // No baseline to diff against. All that is known is that the server
        // mentioned it, which is only worth anything if it mentioned nothing else
        if (!before) {
            fresh.push(index);
            continue;
        }

        if (Number(monster.atkCounter ?? 0) > Number(before.atkCounter ?? 0)) attacked.push(index);
        else if (Number(monster.cMP) < Number(before.cMP)) cast.push(index);
        else if (Number(monster.dmgCounter ?? 0) > Number(before.dmgCounter ?? 0)) struck.push(index);
        else if (unchanged(before, monster)) quiet.push(index);
    }

    if (attacked.length) return attacked;
    if (cast.length) return cast;
    if (fresh.length === 1 && entries.length === 1) return fresh;
    if (quiet.length) return quiet;
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
 * @returns {Array<Object>} `{playerIndex, monsters, damage, isMiss, isRegen, isDeath}`
 */
export function attributeIncoming(tick, state) {
    const events = [];
    const pMap = tick?.pMap || {};
    const attackers = findAttackers(tick?.mMap, state);

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
                monsters: attackers,
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
 * What to call a hit, given every monster that could have landed it.
 *
 * Several candidates of the same kind are not ambiguous in any way a reader
 * cares about: "an Eyes hit you for 41" is true whichever of the two Eyes it
 * was. Candidates that disagree are genuinely unknown, and saying so is better
 * than picking the first one — a wrong name here would move damage from one
 * monster of a wave onto another and then be read as evidence about which of
 * them is dangerous.
 *
 * @param {Array<string>} candidates - Monster indices
 * @param {Function} nameOf - Monster index → name, or null
 * @returns {string} A monster name, or `Unknown Enemy`
 */
export function resolveName(candidates, nameOf) {
    const names = new Set();
    for (const index of candidates || []) {
        const name = nameOf(index);
        if (!name) return 'Unknown Enemy';
        names.add(name);
    }
    return names.size === 1 ? [...names][0] : 'Unknown Enemy';
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

        const name = resolveName(event.monsters, nameOf);
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
