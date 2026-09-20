/**
 * Stun persistence observer — does a stun outlive the monster that cast it?
 *
 * The combat simulator stores a stun's expiry on the *target* and nothing
 * prunes it when the caster dies, so a stun lands for its full duration
 * whatever happens to whoever cast it. That is a modelling choice nobody here
 * has ever measured, and it is worth a few percent of any fight in a zone whose
 * monsters stun. So: measure it off the live wire.
 *
 * ## What the wire can and cannot answer
 *
 * A `battle_updated` unit entry carries exactly one crowd-control field,
 * `isStunned`. There is no blind flag and no silence flag anywhere in the
 * payload, so **this measures stun and only stun** — no part of it generalizes
 * to the other two, and the panel says so.
 *
 * `isStunned: true` is restated on every tick a unit is stunned and the key is
 * simply omitted once it is not. Entries are whole per-unit snapshots, so a
 * later snapshot of the same unit without the key is a genuine "not stunned".
 * A unit *missing from the map entirely* is a different thing — nothing about
 * it changed — and must not be read as the stun ending. That distinction is the
 * whole parser.
 *
 * ## The primary metric, and why it is the primary one
 *
 * **The fraction of qualifying episodes where `isStunned: true` is restated on
 * at least one tick strictly after the caster's death tick.** Near 1.0 means a
 * stun outlives its caster and the simulator is right; near 0 means the game
 * cancels it and the simulator is wrong.
 *
 * It is the headline because it needs no duration lookup. Comparing an observed
 * stun length against `stunDuration` would make the answer depend on our
 * reading of the game's own data being right; counting whether the flag comes
 * back after the killer is dead depends on nothing but the flag.
 *
 * ## Why so many episodes are thrown away
 *
 * An episode only means something if exactly one thing in the wave could have
 * cast it. The best zone for this — Golem Cave — runs two stunning species and
 * a filler that does not stun, so roughly half its waves are answerable and
 * roughly half are not. Guessing which golem stunned you would be inventing the
 * measurement, so an ambiguous wave is discarded and counted as discarded.
 *
 * Three more discards, each of which would otherwise bias the answer:
 *
 * - **The wave ended.** `new_battle` cuts off the evidence mid-episode, and a
 *   stun still flagged when the payload stops arriving looks exactly like a
 *   stun that ended. Counting those would manufacture support for "cancelled at
 *   death", so a caster that was the last thing alive on its side is dropped.
 * - **Possible re-stun.** If something else that can stun dealt damage between
 *   the death and the stun ending, a fresh stun explains the observation just as
 *   well as a persisting one.
 * - **The caster outlived the stun's nominal duration.** Then its death proves
 *   nothing either way.
 *
 * The discard counts are reported next to the headline rather than hidden,
 * because they are how anyone reading it knows the sample was selected honestly.
 *
 * ## The artefact that biases toward our own answer
 *
 * Units are only sent when something about them changes, and a stunned player
 * does nothing — their entry is mostly restated when a monster hits them.
 * Measured gaps for one player slot ran to 5.1 s against a 2–3 s stun. So the
 * end of a stun is never a moment, only a **bracket**: the last tick flagged,
 * and the first later tick not flagged. A 2 s stun has been seen to "run 4.0 s"
 * purely because nobody sent the unit in between.
 *
 * That artefact stretches stuns and therefore pushes the answer toward "stun
 * outlives caster", which is the answer we already believe. So the bracket-width
 * distribution sits beside the headline, and a result that agrees with us is
 * only worth anything if the brackets are tight.
 *
 * ## The reverse direction
 *
 * A monster stunned by a player whose caster then dies is the same question
 * asked the other way, and monster-side stuns are far denser. Player ability
 * rosters are not on the wire, so a player counts as a candidate caster only
 * once it has been *seen* using a stunning ability this session. If the two
 * directions disagree, that matters more than either one alone.
 */

import dataManager from '../../core/data-manager.js';

/** How many stun episodes it takes before the verdict says anything */
export const MIN_EPISODES = 30;

/** The most per-episode audit rows kept, so a handful can be checked by hand */
export const MAX_AUDIT_EPISODES = 40;

/** Upper edges of the bracket-width buckets, in seconds; the last is the tail */
export const BRACKET_EDGES = [0.1, 0.25, 0.5, 1, 2, Infinity];

/** Bucket labels, index-aligned with {@link BRACKET_EDGES} */
export const BRACKET_LABELS = ['<0.1s', '0.1–0.25s', '0.25–0.5s', '0.5–1s', '1–2s', '>2s'];

/** Why an episode was thrown away, in the order the panel lists them */
export const DISCARD_REASONS = [
    'ambiguousCaster',
    'casterSurvived',
    'deathAfterDuration',
    'waveEnded',
    'possibleRestun',
    'noDuration',
];

/** Plain-language names for the discard reasons */
export const DISCARD_LABELS = {
    ambiguousCaster: 'Caster ambiguous (not exactly one stunner in the wave)',
    casterSurvived: 'Caster did not die while the stun was running',
    deathAfterDuration: 'Caster outlived the stun’s own duration',
    waveEnded: 'Wave ended before the stun was seen to end',
    possibleRestun: 'Another stunner could have re-applied it',
    noDuration: 'No stun duration in game data for that caster',
};

/** The two directions measured, keyed by the side the stunned unit is on */
export const DIRECTIONS = { monsterCaster: 'monsterCaster', playerCaster: 'playerCaster' };

/** Nanoseconds per second — every duration in the game data is in nanoseconds */
const NS_PER_SECOND = 1e9;

/**
 * How long an ability's stun lasts, if it stuns at all.
 *
 * Only effects that can actually stun count: an effect with a `stunDuration` and
 * a zero `stunChance` never lands one, and reading its duration would invent a
 * stunner out of an ability that has none.
 *
 * @param {string} abilityHrid - Ability hrid
 * @param {Object} [abilityDetailMap] - Game data; the live copy by default
 * @returns {number|null} Seconds, or null when the ability cannot stun
 */
export function stunSecondsOfAbility(abilityHrid, abilityDetailMap = liveClientData()?.abilityDetailMap) {
    if (!abilityDetailMap || typeof abilityHrid !== 'string') return null;
    const effects = abilityDetailMap[abilityHrid]?.abilityEffects;
    if (!Array.isArray(effects)) return null;

    let best = 0;
    for (const effect of effects) {
        if (!(Number(effect?.stunChance) > 0)) continue;
        const seconds = Number(effect?.stunDuration) / NS_PER_SECOND;
        if (Number.isFinite(seconds) && seconds > best) best = seconds;
    }
    return best > 0 ? best : null;
}

/**
 * Whether a monster can stun, and for how long.
 *
 * A monster hrid the game data does not know is reported as `unknown`, which
 * the episode filter treats as "might stun" — an unrecognised monster must widen
 * the candidate set and disqualify the wave, never quietly shrink it.
 *
 * @param {string} monsterHrid - Monster hrid
 * @param {Object} [clientData] - Game data; the live copy by default
 * @returns {{stuns: boolean, unknown: boolean, seconds: number|null}} Profile
 */
export function monsterStunProfile(monsterHrid, clientData = liveClientData()) {
    const detail = clientData?.combatMonsterDetailMap?.[monsterHrid];
    if (!detail) return { stuns: true, unknown: true, seconds: null };

    let best = 0;
    for (const slot of detail.abilities || []) {
        const seconds = stunSecondsOfAbility(slot?.abilityHrid, clientData?.abilityDetailMap);
        if (seconds && seconds > best) best = seconds;
    }
    return { stuns: best > 0, unknown: false, seconds: best > 0 ? best : null };
}

/**
 * The live game data, or null before it has arrived.
 * @returns {Object|null} Init client data
 */
function liveClientData() {
    try {
        return dataManager.getInitClientData?.() || null;
    } catch {
        return null;
    }
}

/**
 * A unit's key in the watch's per-unit map.
 * @param {string} side - 'm' or 'p'
 * @param {string|number} index - Slot index within that side's map
 * @returns {string} Key
 */
function unitKey(side, index) {
    return `${side}:${index}`;
}

/**
 * Whether a unit snapshot says the unit is dead.
 *
 * Both signals are checked because a death is announced as either, and reading
 * only one of them would miss the tick that matters.
 *
 * @param {Object} entry - A `pMap`/`mMap` entry
 * @returns {boolean} True when the unit is down
 */
function isDead(entry) {
    return entry?.cHP === 0 || entry?.isActive === false;
}

/**
 * A fresh watch over the open-world battle stream.
 *
 * Nothing here reads the clock or the network: `newBattle` and `battleUpdated`
 * are handed the payload and the time it arrived, and finished episodes come
 * back out of {@link drain}. That is what lets synthetic tick sequences and a
 * recorded fixture drive exactly the same code the live stream does.
 *
 * @param {Object} [options] - Watch options
 * @param {Object} [options.clientData] - Game data; the live copy by default
 * @returns {{newBattle: Function, battleUpdated: Function, drain: Function, open: Function}} Watch
 */
export function createStunWatch({ clientData = null } = {}) {
    const data = () => clientData || liveClientData();

    let tick = 0;
    let roster = null;
    /** @type {Map<string, Object>} Per-unit state, keyed by side and slot */
    let units = new Map();
    /** @type {Map<string, Set<string>>} Abilities each player slot has been seen using */
    const seenPlayerAbilities = new Map();
    /** @type {Array<Object>} Episodes closed and ready to be folded into the tally */
    const finished = [];

    /**
     * The state kept for one unit slot, created on first sight.
     * @param {string} key - Unit key
     * @returns {Object} Unit state
     */
    function unitState(key) {
        let state = units.get(key);
        if (!state) {
            state = {
                alive: true,
                deathTick: null,
                deathMs: null,
                dmgCounter: null,
                lastDamageTick: null,
                stun: null,
                pendingClose: false,
            };
            units.set(key, state);
        }
        return state;
    }

    /**
     * What could have cast a stun that began now, on the given side.
     *
     * Read from the aliveness as it stood *before* this tick's deaths are
     * applied: a monster that stuns and dies in the same payload was alive when
     * it cast, and dropping it here would report the wave as having no stunner
     * at all.
     *
     * @param {string} casterSide - 'm' or 'p' — the side the caster is on
     * @returns {Array<{key: string, index: string, hrid: string|null, seconds: number|null}>} Candidates
     */
    function candidateCasters(casterSide) {
        const out = [];
        if (!roster) return out;

        if (casterSide === 'm') {
            for (const [index, monster] of roster.monsters.entries()) {
                const key = unitKey('m', index);
                if (units.get(key)?.alive === false) continue;
                if (!monster.profile.stuns) continue;
                out.push({ key, index: String(index), hrid: monster.hrid, seconds: monster.profile.seconds });
            }
            // A slot the roster never named is an unknown unit, and an unknown
            // unit has to count as a possible stunner
            for (const [key, state] of units) {
                if (!key.startsWith('m:') || state.alive === false) continue;
                const index = Number(key.slice(2));
                if (index < roster.monsters.length) continue;
                out.push({ key, index: String(index), hrid: null, seconds: null });
            }
            return out;
        }

        for (const [key, abilities] of seenPlayerAbilities) {
            if (units.get(key)?.alive === false) continue;
            let best = 0;
            for (const abilityHrid of abilities) {
                const seconds = stunSecondsOfAbility(abilityHrid, data()?.abilityDetailMap);
                if (seconds && seconds > best) best = seconds;
            }
            if (best > 0) out.push({ key, index: key.slice(2), hrid: null, seconds: best });
        }
        return out;
    }

    /**
     * Whether anything on a side is still standing, used to spot the caster
     * having been the last one alive — the case where the wave ends on its death
     * and the evidence stops with it.
     * @param {string} side - 'm' or 'p'
     * @returns {boolean} True when at least one unit on that side is alive
     */
    function anyAlive(side) {
        for (const [key, state] of units) {
            if (key.startsWith(`${side}:`) && state.alive !== false) return true;
        }
        return false;
    }

    /**
     * Start tracking a stun that has just been flagged.
     * @param {string} key - The stunned unit's key
     * @param {string} side - 'm' or 'p', the stunned unit's side
     * @param {number} at - Arrival time in ms
     * @returns {Object} The open episode
     */
    function openEpisode(key, side, at) {
        const casterSide = side === 'm' ? 'p' : 'm';
        const candidates = candidateCasters(casterSide);
        const caster = candidates.length === 1 ? candidates[0] : null;
        return {
            direction: side === 'm' ? DIRECTIONS.playerCaster : DIRECTIONS.monsterCaster,
            targetKey: key,
            casterSide,
            casterKey: caster?.key || null,
            casterHrid: caster?.hrid || null,
            durationSeconds: caster?.seconds ?? null,
            candidateCount: candidates.length,
            startTick: tick,
            startMs: at,
            lastStunnedTick: tick,
            lastStunnedMs: at,
            endTick: null,
            endMs: null,
            truncated: false,
            casterWasLast: false,
            restunSuspect: false,
        };
    }

    /**
     * Close an open episode and file the verdict on it.
     * @param {Object} episode - The open episode
     * @param {Object} state - The stunned unit's state
     * @returns {void}
     */
    function closeEpisode(episode, state) {
        state.stun = null;
        state.pendingClose = false;
        finished.push(judgeEpisode(episode, units.get(episode.casterKey || '') || null));
    }

    return {
        /**
         * A new wave. Everything the old one knew about its units is gone, and
         * any stun still running when it arrives is evidence that got cut off.
         * @param {Object} payload - `new_battle` payload
         * @param {number} at - Arrival time in ms
         * @returns {void}
         */
        newBattle(payload, at) {
            for (const [, state] of units) {
                if (!state.stun) continue;
                state.stun.truncated = true;
                state.stun.endTick = tick;
                state.stun.endMs = at;
                closeEpisode(state.stun, state);
            }

            const clientData = data();
            roster = {
                monsters: (payload?.monsters || []).map((monster) => ({
                    hrid: monster?.hrid || null,
                    profile: monsterStunProfile(monster?.hrid, clientData),
                })),
                playerCount: (payload?.players || []).length,
            };
            units = new Map();

            // Seeded rather than waited for: a unit that has not been sent yet
            // is alive, and leaving it out of the map would let a caster look
            // like the last thing standing while three of its friends are still
            // swinging — which discards the episode for the wrong reason
            for (let i = 0; i < roster.monsters.length; i += 1) unitState(unitKey('m', i));
            for (let i = 0; i < roster.playerCount; i += 1) unitState(unitKey('p', i));
        },

        /**
         * One tick of the fight.
         * @param {Object} payload - `battle_updated` payload (`pMap`/`mMap`)
         * @param {number} at - Arrival time in ms
         * @returns {void}
         */
        battleUpdated(payload, at) {
            tick += 1;

            const sides = [
                ['p', payload?.pMap],
                ['m', payload?.mMap],
            ];

            // Stun transitions first, while aliveness still reads as it did
            // before this tick — see candidateCasters
            for (const [side, map] of sides) {
                for (const [index, entry] of Object.entries(map || {})) {
                    if (!entry || typeof entry !== 'object') continue;
                    const key = unitKey(side, index);
                    const state = unitState(key);

                    if (side === 'p' && typeof entry.abilityHrid === 'string') {
                        if (!seenPlayerAbilities.has(key)) seenPlayerAbilities.set(key, new Set());
                        seenPlayerAbilities.get(key).add(entry.abilityHrid);
                    }

                    if (entry.isStunned) {
                        if (!state.stun) state.stun = openEpisode(key, side, at);
                        else {
                            state.stun.lastStunnedTick = tick;
                            state.stun.lastStunnedMs = at;
                        }
                    } else if (state.stun && !state.pendingClose) {
                        // Noted, not closed. The payload that stops flagging a
                        // stun is very often the same payload that reports its
                        // caster dying, and a verdict taken here would be taken
                        // before that death had been applied — which files the
                        // single cleanest observation of a cancel-on-death rule
                        // as "the caster never died"
                        state.stun.endTick = tick;
                        state.stun.endMs = at;
                        state.pendingClose = true;
                    }
                }
            }

            // Then the deaths and the damage counters this tick reported
            for (const [side, map] of sides) {
                for (const [index, entry] of Object.entries(map || {})) {
                    if (!entry || typeof entry !== 'object') continue;
                    const state = unitState(unitKey(side, index));

                    const dmg = Number(entry.dmgCounter);
                    if (Number.isFinite(dmg)) {
                        if (state.dmgCounter !== null && dmg > state.dmgCounter) state.lastDamageTick = tick;
                        state.dmgCounter = dmg;
                    }

                    if (isDead(entry)) {
                        if (state.alive !== false) {
                            state.alive = false;
                            state.deathTick = tick;
                            state.deathMs = at;
                        }
                    } else {
                        state.alive = true;
                    }
                }
            }

            // A caster that was the last thing standing takes the wave with it,
            // so note it at the death rather than guessing later
            for (const [, state] of units) {
                const episode = state.stun;
                if (!episode || !episode.casterKey) continue;
                const caster = units.get(episode.casterKey);
                if (caster?.alive !== false || caster.deathTick !== tick) continue;
                if (!anyAlive(episode.casterSide)) episode.casterWasLast = true;
            }

            // Anything else on the caster's side that could stun, landing a hit
            // after the caster died, is a fresh stun waiting to be mistaken for
            // a persisting one
            for (const [, state] of units) {
                const episode = state.stun;
                if (!episode || !episode.casterKey) continue;
                const caster = units.get(episode.casterKey);
                if (caster?.deathTick === null || caster?.deathTick === undefined) continue;
                if (caster.alive !== false) continue;
                for (const [otherKey, other] of units) {
                    if (otherKey === episode.casterKey) continue;
                    if (!otherKey.startsWith(`${episode.casterSide}:`)) continue;
                    if (other.lastDamageTick === tick && other.lastDamageTick > caster.deathTick) {
                        episode.restunSuspect = true;
                    }
                }
            }

            // Only now, with this tick's deaths and hits on the record
            for (const [, state] of units) {
                if (!state.pendingClose) continue;
                state.pendingClose = false;
                closeEpisode(state.stun, state);
            }
        },

        /**
         * Take the episodes finished since the last call.
         * @returns {Array<Object>} Judged episodes
         */
        drain() {
            return finished.splice(0, finished.length);
        },

        /**
         * How many episodes are still running, for the panel's "watching" line.
         * @returns {number} Open episode count
         */
        open() {
            let count = 0;
            for (const [, state] of units) if (state.stun) count += 1;
            return count;
        },
    };
}

/**
 * Decide what a closed episode is worth.
 *
 * The order of the checks is the order of the doubts. Truncated evidence is
 * worthless whatever else is true of it, so it goes first; an ambiguous caster
 * makes every later question unanswerable, so it goes second; and only an
 * episode that survives all of them gets to vote.
 *
 * @param {Object} episode - A closed episode
 * @param {Object|null} caster - The caster's unit state, if there was one
 * @returns {Object} The episode with `qualifies`, `discard` and `outlivedCaster` filled in
 */
export function judgeEpisode(episode, caster) {
    const out = {
        ...episode,
        bracketSeconds: episode.endMs !== null ? Math.max(0, (episode.endMs - episode.lastStunnedMs) / 1000) : null,
        observedSeconds: Math.max(0, (episode.lastStunnedMs - episode.startMs) / 1000),
        deathTick: caster?.deathTick ?? null,
        deathMs: caster?.deathMs ?? null,
        postDeathSeconds: null,
        outlivedCaster: null,
        qualifies: false,
        discard: null,
    };

    if (episode.truncated || episode.casterWasLast) {
        out.discard = 'waveEnded';
        return out;
    }
    if (episode.candidateCount !== 1) {
        out.discard = 'ambiguousCaster';
        return out;
    }
    // `<= endTick` rather than `< endTick` on purpose. If the game cancels a
    // stun when its caster dies, the cleanest possible observation of that is
    // the death and the missing flag arriving in the same payload — the exact
    // tick a strict comparison would throw away, and throwing it away would
    // discard the evidence against this project's own model while keeping the
    // evidence for it. An episode ending naturally on the tick its caster
    // happened to die is caught a line later by the duration check instead.
    if (out.deathTick === null || out.deathTick <= episode.startTick || out.deathTick > episode.endTick) {
        out.discard = 'casterSurvived';
        return out;
    }
    if (!(episode.durationSeconds > 0)) {
        out.discard = 'noDuration';
        return out;
    }
    if (out.deathMs - episode.startMs >= episode.durationSeconds * 1000) {
        out.discard = 'deathAfterDuration';
        return out;
    }
    if (episode.restunSuspect) {
        out.discard = 'possibleRestun';
        return out;
    }

    out.qualifies = true;
    out.outlivedCaster = episode.lastStunnedTick > out.deathTick;
    out.postDeathSeconds = out.outlivedCaster ? (episode.lastStunnedMs - out.deathMs) / 1000 : 0;
    return out;
}

/**
 * Which bracket-width bucket a width falls in.
 * @param {number} seconds - Bracket width
 * @returns {number} Bucket index into {@link BRACKET_LABELS}
 */
export function bracketBucket(seconds) {
    for (let i = 0; i < BRACKET_EDGES.length; i += 1) if (seconds < BRACKET_EDGES[i]) return i;
    return BRACKET_EDGES.length - 1;
}

/**
 * An empty tally, the shape that gets written to storage.
 * @returns {Object} Tally
 */
export function emptyTally() {
    const direction = () => ({
        episodes: 0,
        outlived: 0,
        brackets: BRACKET_LABELS.map(() => 0),
        postDeathSeconds: [],
    });
    return {
        version: 1,
        startedAt: null,
        updatedAt: null,
        monsterCaster: direction(),
        playerCaster: direction(),
        discards: Object.fromEntries(DISCARD_REASONS.map((reason) => [reason, 0])),
        audit: [],
    };
}

/**
 * Fold one judged episode into a tally, in place.
 *
 * In place because this runs several times a second on a live stream and a
 * fresh deep copy per tick is a cost with nothing to show for it. The caller
 * owns the tally.
 *
 * @param {Object} tally - The tally to add to
 * @param {Object} episode - A judged episode
 * @param {number} [now] - Clock, for the timestamps
 * @returns {Object} The same tally
 */
export function foldEpisode(tally, episode, now = Date.now()) {
    if (!tally || !episode) return tally;
    if (tally.startedAt === null) tally.startedAt = now;
    tally.updatedAt = now;

    if (!episode.qualifies) {
        const reason = episode.discard;
        if (reason && reason in tally.discards) tally.discards[reason] += 1;
        return tally;
    }

    const bucket = tally[episode.direction];
    if (!bucket) return tally;

    bucket.episodes += 1;
    if (episode.outlivedCaster) {
        bucket.outlived += 1;
        bucket.postDeathSeconds.push(round(episode.postDeathSeconds, 3));
    }
    bucket.brackets[bracketBucket(episode.bracketSeconds ?? Infinity)] += 1;

    tally.audit.unshift({
        at: now,
        direction: episode.direction,
        casterHrid: episode.casterHrid,
        durationSeconds: episode.durationSeconds,
        observedSeconds: round(episode.observedSeconds, 3),
        bracketSeconds: round(episode.bracketSeconds, 3),
        postDeathSeconds: round(episode.postDeathSeconds, 3),
        outlivedCaster: episode.outlivedCaster,
        startTick: episode.startTick,
        deathTick: episode.deathTick,
        lastStunnedTick: episode.lastStunnedTick,
        endTick: episode.endTick,
    });
    if (tally.audit.length > MAX_AUDIT_EPISODES) tally.audit.length = MAX_AUDIT_EPISODES;

    return tally;
}

/**
 * Round for storage, so a float does not carry sixteen meaningless digits into
 * IndexedDB and back out into a panel.
 * @param {number|null} value - The number
 * @param {number} places - Decimal places
 * @returns {number|null} Rounded, or null
 */
function round(value, places) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

/**
 * The median of a list, or null when there is nothing to take one of.
 * @param {Array<number>} values - Numbers
 * @returns {number|null} Median
 */
export function median(values) {
    const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Read a tally back as something a panel can print, and say what it means.
 *
 * The verdict is deliberately reluctant. Below {@link MIN_EPISODES} it says so
 * and stops; above it, the Wilson interval has to sit wholly on one side of a
 * wide neutral band before the wording commits to anything, because the
 * interesting outcome here is the one that contradicts a model this project
 * already ships.
 *
 * @param {Object} tally - A tally
 * @param {Function} wilsonInterval - The interval function, injected so this
 *   module stays free of the sim engine in tests
 * @returns {Object} Summary
 */
export function summarize(tally, wilsonInterval) {
    const safe = tally || emptyTally();
    const directions = {};

    for (const key of Object.keys(DIRECTIONS)) {
        const bucket = safe[key] || { episodes: 0, outlived: 0, brackets: [], postDeathSeconds: [] };
        const interval = wilsonInterval(bucket.outlived, bucket.episodes);
        directions[key] = {
            episodes: bucket.episodes,
            outlived: bucket.outlived,
            fraction: bucket.episodes > 0 ? bucket.outlived / bucket.episodes : null,
            low: interval.low,
            high: interval.high,
            brackets: BRACKET_LABELS.map((label, index) => ({ label, count: bucket.brackets?.[index] || 0 })),
            medianBracketSeconds: medianBracket(bucket.brackets),
            medianPostDeathSeconds: median(bucket.postDeathSeconds),
        };
    }

    const primary = directions.monsterCaster;
    const discarded = DISCARD_REASONS.reduce((sum, reason) => sum + (safe.discards?.[reason] || 0), 0);

    return {
        directions,
        discards: DISCARD_REASONS.map((reason) => ({
            reason,
            label: DISCARD_LABELS[reason],
            count: safe.discards?.[reason] || 0,
        })),
        discarded,
        verdict: verdictFor(primary, directions.playerCaster),
        updatedAt: safe.updatedAt,
        startedAt: safe.startedAt,
    };
}

/**
 * The midpoint bucket of a bracket histogram, as the representative width.
 *
 * A histogram cannot give a real median, so this reports the *bucket* the
 * middle episode fell in — enough to see whether the brackets are tight, which
 * is all the caveat needs.
 *
 * @param {Array<number>} brackets - Counts per bucket
 * @returns {string|null} Bucket label
 */
export function medianBracket(brackets) {
    const counts = brackets || [];
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (!total) return null;
    let seen = 0;
    for (let i = 0; i < counts.length; i += 1) {
        seen += counts[i];
        if (seen >= total / 2) return BRACKET_LABELS[i];
    }
    return BRACKET_LABELS[BRACKET_LABELS.length - 1];
}

/**
 * The plain-language reading of the primary direction.
 * @param {Object} primary - The monster-caster direction summary
 * @param {Object} control - The player-caster direction summary
 * @returns {{text: string, decided: boolean}} Verdict
 */
export function verdictFor(primary, control) {
    if (!primary || primary.episodes < MIN_EPISODES) {
        const have = primary?.episodes || 0;
        return {
            decided: false,
            text: `${have} of ${MIN_EPISODES} qualifying episodes with a monster caster. Not enough to say anything yet.`,
        };
    }

    const wideBrackets = primary.medianBracketSeconds === '>2s' || primary.medianBracketSeconds === '1–2s';
    const caution = wideBrackets
        ? ' The end brackets are wide, though, which stretches stuns and pushes this result the way it ' +
          'already leans — treat it as weak.'
        : '';

    const disagrees =
        control?.episodes >= MIN_EPISODES &&
        ((primary.low > 0.8 && control.high < 0.2) || (primary.high < 0.2 && control.low > 0.8));
    const split = disagrees
        ? ' The two directions disagree, which no single rule explains — look at both before changing anything.'
        : '';

    const band = `95% CI ${pct(primary.low)}–${pct(primary.high)}`;

    if (primary.low > 0.8) {
        return {
            decided: true,
            text:
                `The stun keeps being reported after its caster died in ${pct(primary.fraction)} of ` +
                `${primary.episodes} episodes (${band}). A stun outlives the monster that cast it, ` +
                `which is what the simulator already assumes.${caution}${split}`,
        };
    }
    if (primary.high < 0.2) {
        return {
            decided: true,
            text:
                `The stun stops being reported at its caster's death in ${pct(1 - primary.fraction)} of ` +
                `${primary.episodes} episodes (${band} for persistence). The game appears to cancel a stun ` +
                `when its caster dies, and the simulator does not.${caution}${split}`,
        };
    }
    return {
        decided: false,
        text:
            `Persistence is ${pct(primary.fraction)} of ${primary.episodes} episodes (${band}) — ` +
            `too wide to call either way. Keep collecting.${caution}${split}`,
    };
}

/**
 * A proportion as a percentage string.
 * @param {number|null} value - Proportion
 * @returns {string} e.g. "94%"
 */
export function pct(value) {
    return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}
