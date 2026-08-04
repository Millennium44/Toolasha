/**
 * Sim accuracy
 *
 * The recorded fight, replayed against what the simulator said would happen.
 *
 * Everything else in this script that quotes a combat number gets it from the
 * simulator — the upgrade advisor, the food optimiser, the task profit cards.
 * All of them are predictions, and none of them has ever been checked against
 * the thing it predicts. A simulator that is 15% optimistic about your damage
 * will still rank two swords in the right order, so no amount of comparing its
 * own outputs will ever notice; only a real fight can.
 *
 * The recorder already keeps real fights. This reads one back, derives what
 * actually happened from it, runs the sim for the same zone with the current
 * character, and puts the two side by side.
 *
 * ## What the payloads honestly support
 *
 * A recording is `new_battle` plus the `pMap`/`mMap` of every tick, so what can
 * be derived is exactly what the damage trackers already derive:
 *
 * - **Damage dealt**, from the same attribution the Damage panel uses — a hit is
 *   a monster's `dmgCounter` rising, and the size of it is the health that went
 *   with it.
 * - **Damage taken**, likewise from the player's counter rising.
 * - **Fight length**, from the gap between one `new_battle` and the next.
 *
 * And what it does **not** support, which matters as much:
 *
 * - **No consumables.** Nothing in the feed says a drink was sipped or food
 *   eaten. If the recording was made with different drinks up than the sim is
 *   told about, the gap is that and not the engine.
 * - **No experience, no drops.** Neither is on the combat feed at all, so the
 *   half of the sim's output that people actually plan around is not checked
 *   here. This checks the combat, and the drops follow from the kills.
 * - **Solo only.** In a party the monsters spread their damage across everyone
 *   and the kills are the party's, so neither figure means what the solo sim
 *   means. Party recordings are refused rather than quietly mis-compared.
 *
 * ## The gear is snapshotted, because it used to be guessed
 *
 * A recording used to be stamped with when it was made and nothing else, and the
 * sim ran against whatever was worn at the moment you pressed the button. Change
 * a weapon between recording and checking — or record, go and enhance something,
 * then check — and the deviation was the weapon. The panel said so, which is
 * honest and useless: the caveat covered the whole result.
 *
 * So the loadout is captured when the recording starts, and again at every
 * segment rotation, and kept on the observation. What is captured is exactly
 * what the simulator reads: {@link captureLoadoutSnapshot} takes the adapter's
 * player DTO — the same one the check would otherwise have built fresh — and
 * keeps the parts that describe the character rather than the world. The check
 * then builds a current DTO and lays the snapshot over it, so a legacy
 * observation from before this existed keeps behaving exactly as it did.
 *
 * ## Fight length includes the gap after it
 *
 * A fight is measured from its `new_battle` to the next one, which takes in the
 * three seconds of respawn that follow it. That is deliberate: the sim's clock
 * runs through the respawn too, so its damage-per-second is over wall time and
 * not over time-in-combat. Measuring only the swinging would make the observed
 * rate look higher than predicted for no reason but the definition.
 *
 * ## Beyond sampling noise
 *
 * Six fights is a small sample and a small sample disagrees with everything. So
 * each metric carries a margin: the 95% interval on the mean of the per-fight
 * values, widened in quadrature by a flat allowance for the simulator's own
 * randomness. A deviation inside the margin is reported and not flagged — it is
 * what two samples of the same thing look like. Only what is outside it is worth
 * arguing about, and with fewer than three fights nothing is.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import {
    buildGameDataPayload,
    buildPlayerDTO,
    getCommunityBuffs,
    getCurrentCombatZone,
} from '../combat-sim/combat-sim-adapter.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import combatRecorder, {
    onRecordingCheckpoint,
    onRecordingComplete,
    onRecordingStopped,
    onSessionStart,
    setLoadoutProvider,
} from './combat-recorder.js';
import { recordControlState, toggleRecording } from './combat-record-control.js';
import { newAttributionState, noteActions, attributeTick, foldEvents } from '../../utils/damage-attribution.js';
import { newTakenState, attributeIncoming, foldTaken } from '../../utils/damage-taken.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
import { ROW_COLORS } from '../../utils/overlay-format.js';
import { formatRelativeTime, formatKMB } from '../../utils/formatters.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

/** Below this many fights the spread of the sample says nothing about the mean */
export const MIN_SAMPLE_FIGHTS = 3;

/** Two-sided 95% normal quantile */
const Z95 = 1.96;

/**
 * The simulator's own sampling noise at {@link SIM_HOURS}, as a percentage.
 *
 * The observed side gets a margin from its own spread; the predicted side cannot,
 * because one run is one number. A flat allowance is cruder than a repeated run
 * and costs nothing, and at half a day of simulated combat the run-to-run spread
 * on damage per second is small.
 */
export const SIM_NOISE_FLOOR_PCT = 2;

/** Long enough that the prediction is steady, short enough to wait for */
export const SIM_HOURS = 12;

/**
 * Below this margin the sample is large enough to argue with.
 *
 * Nothing magic about five percent; it is the point at which the noise stops
 * being the largest term in the comparison. A simulator that is five percent out
 * is a simulator worth reporting, so a sample that cannot see five percent is a
 * sample that cannot see anything anybody would act on.
 */
export const NOISE_QUIET_PCT = 5;

/**
 * Observations kept, oldest dropped first.
 *
 * Ten was sized for recordings pressed by hand, each one a sitting. Segment
 * rotation shrank the unit: a long recording now arrives as an observation every
 * four thousand ticks, which is roughly ten minutes of combat, so ten of them is
 * under two hours and a session left running would evict its own beginning
 * before the sample was interesting.
 *
 * Twenty-four is about four hours of continuous recording, which is long enough
 * for the aggregate to be worth the disk and short enough that a rolling window
 * still does its job — gear changed or a zone left behind ages out within a
 * session rather than sitting in the sample for days. It is a cap on kept
 * observations, not on how long you can record: the recording is unbounded, the
 * *window* over it is four hours.
 */
const MAX_OBSERVATIONS = 24;

/**
 * Where past observations live.
 *
 * Scoped per character, and resolved at each read and write since the user
 * switches characters without reloading. The pre-scoping global value is
 * *discarded* rather than adopted: an observation is a record of one
 * character's damage against a zone, and comparing another character's sim to
 * it would flag a difference that is only the difference between two
 * characters.
 */
const STORAGE_KEY = 'combatReplayCheck_observations';

/**
 * Where a recording still in progress is kept, so a refresh does not end it.
 *
 * One observation, rewritten at every fight boundary — the fights so far,
 * summarized exactly as a finished recording's are. Never the raw ticks: those
 * are megabytes and arrive several times a second, and persisting them would
 * turn a recording into a write storm.
 */
const CHECKPOINT_KEY = 'combatReplayCheck_recordingCheckpoint';

const DISCARD_LEGACY = { migrate: 'discard' };

const ACCENT = '#8fd0ff';

/**
 * The DTO fields that describe the character rather than the world.
 *
 * Community buffs, labyrinth token upgrades and the moo pass are the server's
 * state and are the same for the simulated run as for the recorded one, near
 * enough; equipment, levels, abilities, house rooms, guild shrines and the
 * consumable slots are the character's, and are exactly what changes between
 * recording something and getting round to checking it.
 */
const SNAPSHOT_FIELDS = [
    'equipment',
    'abilities',
    'food',
    'drinks',
    'houseRooms',
    'guildCombatBuffs',
    'guildShrineLevels',
    'achievementCombatBuffs',
];

/** The levels the combat engine reads. Skilling levels do not enter a fight. */
const SNAPSHOT_LEVELS = [
    'staminaLevel',
    'intelligenceLevel',
    'attackLevel',
    'meleeLevel',
    'defenseLevel',
    'rangedLevel',
    'magicLevel',
];

/**
 * What was worn when the recording started.
 *
 * Read off the player DTO rather than off `characterData`, because the DTO is
 * what the simulation consumes: anything the adapter derives, normalizes or
 * renames on the way is already done, and a snapshot taken upstream of it would
 * have to repeat that work and then drift from it.
 *
 * @param {Object} [dto] - The DTO to read; built fresh when not given
 * @returns {Object|null} The snapshot, or null when the character has not loaded
 */
export function captureLoadoutSnapshot(dto = buildPlayerDTO()) {
    if (!dto) return null;

    const snapshot = { capturedAt: Date.now(), levels: {} };
    for (const key of SNAPSHOT_LEVELS) {
        if (Number.isFinite(dto[key])) snapshot.levels[key] = dto[key];
    }
    for (const key of SNAPSHOT_FIELDS) {
        if (dto[key] !== undefined && dto[key] !== null) snapshot[key] = dto[key];
    }
    return snapshot;
}

/**
 * Lay a snapshot over a freshly built DTO.
 *
 * Over rather than instead of: a snapshot carries the character and not the
 * world, so the fields it does not name — community buff levels, token upgrades,
 * the hrid the sim keys results by — come from now, which is where they are
 * correct. A missing snapshot leaves the DTO exactly as it was built, which is
 * how observations recorded before any of this existed keep working.
 *
 * @param {Object} dto - From `buildPlayerDTO`
 * @param {Object} [snapshot] - From `captureLoadoutSnapshot`
 * @returns {Object|null} A new DTO; the argument is not modified
 */
export function applyLoadoutSnapshot(dto, snapshot) {
    if (!dto) return null;
    if (!snapshot) return dto;

    const merged = { ...dto, ...snapshot.levels };
    for (const key of SNAPSHOT_FIELDS) {
        if (snapshot[key] !== undefined && snapshot[key] !== null) merged[key] = snapshot[key];
    }
    return merged;
}

/**
 * What two snapshots have to agree on to count as the same loadout.
 *
 * When it was taken is not part of it: two segments of one recording are taken
 * minutes apart and are the same kit.
 *
 * @param {Object} [snapshot] - From `captureLoadoutSnapshot`
 * @returns {string}
 */
function loadoutSignature(snapshot) {
    if (!snapshot) return 'none';
    const fields = { levels: snapshot.levels };
    for (const key of SNAPSHOT_FIELDS) fields[key] = snapshot[key] ?? null;
    return JSON.stringify(fields);
}

/**
 * Split a recording into completed fights and tally each one.
 *
 * The battle still in progress when the recording stopped is dropped: its length
 * is unknown, and a fight cut off halfway reads as a fast one. Ticks arriving
 * before the first `new_battle` are dropped for the same reason — there is no
 * battle for them to belong to.
 *
 * @param {Array<Object>} ticks - A recording's ticks, in order
 * @returns {Array<Object>} One entry per completed fight
 */
export function replayFights(ticks) {
    const attribution = newAttributionState();
    const taken = newTakenState();
    const fights = [];

    let current = null;
    let monsters = {};

    for (const tick of ticks || []) {
        if (tick?.type === 'new_battle') {
            if (current) {
                current.endAt = tick.at;
                current.seconds = Math.max(0, (tick.at - current.startAt) / 1000);
                fights.push(current);
            }

            // Monster indices are reused every battle and mean a different
            // monster each time, so the counters they are diffed against are
            // rebuilt rather than carried over
            monsters = {};
            for (const [index, monster] of Object.entries(tick.payload?.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            attribution.monstersHP = {};
            attribution.dmgCounter = {};
            attribution.critCounter = {};
            taken.monsters = {};

            // The player is the one thing that *is* continuous across a battle
            // boundary, so `taken.playersHP` and `playersDmg` are deliberately
            // kept: resetting them would throw away the first hit of every fight
            noteActions(attribution, tick.payload?.players);

            current = {
                startAt: tick.at,
                endAt: null,
                seconds: 0,
                partySize: Object.keys(tick.payload?.players || {}).length,
                monsters: Object.values(monsters),
                players: {},
                taken: {},
                kills: 0,
            };
            continue;
        }

        if (!current) continue;

        const events = attributeTick(tick.payload, attribution);
        // Bound per tick rather than read from the outer `monsters`: the wave is
        // replaced at every battle, and a closure over the variable would name
        // this tick's monsters after whichever battle happened to be last
        const wave = monsters;
        foldEvents(current.players, events, {
            filterNonDamaging: true,
            nameOf: (index) => wave[index] || null,
        });
        for (const event of events) {
            if (event.isKill) current.kills += 1;
        }
        foldTaken(current.taken, attributeIncoming(tick.payload, taken));

        // After attributing, never before — see `noteActions`
        noteActions(attribution, tick.payload?.pMap);
    }

    return fights;
}

/**
 * Whose run this is: the party index that dealt the most damage.
 *
 * Solo, this is the only index there is. In a party it is a guess, which is one
 * of the reasons party recordings are not compared.
 *
 * @param {Array<Object>} fights - From `replayFights`
 * @returns {string|null}
 */
export function busiestPlayer(fights) {
    const totals = {};
    for (const fight of fights || []) {
        for (const [index, tally] of Object.entries(fight.players || {})) {
            totals[index] = (totals[index] || 0) + (tally.damage || 0);
        }
    }

    let best = null;
    for (const [index, damage] of Object.entries(totals)) {
        if (best === null || damage > totals[best]) best = index;
    }
    return best;
}

/**
 * What a recording says actually happened.
 *
 * @param {Object} recording - From `combatRecorder.recordingFile()`
 * @param {Object} [context] - `{zoneHrid, difficultyTier, recordedAt, loadout}` to stamp it with
 * @returns {Object|null} An observation, or null when there is no completed fight in it
 */
export function observeRecording(recording, context = {}) {
    const fights = replayFights(recording?.ticks);
    if (!fights.length) return null;

    const playerIndex = busiestPlayer(fights);
    if (playerIndex === null) return null;

    return {
        recordedAt: context.recordedAt ?? Date.now(),
        zoneHrid: context.zoneHrid ?? null,
        difficultyTier: context.difficultyTier ?? 0,
        truncated: Boolean(recording?.truncated),
        // What was worn while these fights happened, so the check can simulate
        // that character rather than whoever is logged in when it runs
        loadout: context.loadout ?? recording?.loadout ?? null,
        // The largest party seen, since a member joining mid-recording still
        // makes the whole of it a party run
        partySize: Math.max(...fights.map((fight) => fight.partySize || 1)),
        playerIndex,
        // Only the derived numbers are kept. The raw payloads are the recorder's
        // business and are far too large to keep ten of.
        fights: fights.map((fight) => ({
            seconds: fight.seconds,
            damageDealt: fight.players[playerIndex]?.damage || 0,
            damageTaken: fight.taken[playerIndex]?.damage || 0,
            regen: fight.taken[playerIndex]?.regen || 0,
            hits: fight.players[playerIndex]?.hits || 0,
            misses: fight.players[playerIndex]?.misses || 0,
            deaths: fight.taken[playerIndex]?.deaths || 0,
            kills: fight.kills,
            monsters: fight.monsters,
        })),
    };
}

/**
 * Fold several observations of the same zone into one sample.
 *
 * More fights is a narrower margin, and a second recording of the same zone is
 * the cheapest way to get them. Only observations agreeing on the zone and tier
 * are folded — everything else would be measuring two different things.
 *
 * @param {Array<Object>} observations - From `observeRecording`
 * @returns {Object|null}
 */
export function aggregateObservations(observations) {
    const list = (observations || []).filter((entry) => entry?.fights?.length);
    if (!list.length) return null;

    const newest = list.reduce((latest, entry) => (entry.recordedAt > latest.recordedAt ? entry : latest), list[0]);
    const matching = list.filter(
        (entry) => entry.zoneHrid === newest.zoneHrid && entry.difficultyTier === newest.difficultyTier
    );

    const fights = matching.flatMap((entry) => entry.fights);
    const seconds = fights.reduce((total, fight) => total + fight.seconds, 0);
    const damageDealt = fights.reduce((total, fight) => total + fight.damageDealt, 0);
    const damageTaken = fights.reduce((total, fight) => total + fight.damageTaken, 0);
    const kills = fights.reduce((total, fight) => total + fight.kills, 0);
    const deaths = fights.reduce((total, fight) => total + fight.deaths, 0);

    // The newest snapshot there is, which is the one the fights nearest to now
    // were fought in. When they disagree the sample straddles a gear change and
    // no single snapshot describes all of it — that is worth saying out loud
    // rather than picking one and going quiet.
    const byNewest = [...matching].sort((left, right) => right.recordedAt - left.recordedAt);
    const loadout = byNewest.find((entry) => entry.loadout)?.loadout ?? null;
    const signatures = new Set(matching.map((entry) => loadoutSignature(entry.loadout)));

    return {
        zoneHrid: newest.zoneHrid,
        difficultyTier: newest.difficultyTier,
        partySize: Math.max(...matching.map((entry) => entry.partySize || 1)),
        truncated: matching.some((entry) => entry.truncated),
        loadout,
        mixedLoadouts: signatures.size > 1,
        recordings: matching.length,
        recordedAt: newest.recordedAt,
        oldestRecordedAt: Math.min(...matching.map((entry) => entry.recordedAt)),
        fights: fights.length,
        seconds,
        damageDealt,
        damageTaken,
        kills,
        deaths,
        dps: seconds > 0 ? damageDealt / seconds : null,
        takenPerSecond: seconds > 0 ? damageTaken / seconds : null,
        secondsPerFight: fights.length ? seconds / fights.length : null,
        samples: {
            dps: fights.map((fight) => (fight.seconds > 0 ? fight.damageDealt / fight.seconds : null)),
            takenPerSecond: fights.map((fight) => (fight.seconds > 0 ? fight.damageTaken / fight.seconds : null)),
            secondsPerFight: fights.map((fight) => fight.seconds),
        },
    };
}

/**
 * The same three figures, as the simulator predicts them.
 *
 * Damage taken is the sum of everything the monsters dealt, which is only the
 * player's share when the player is alone — hence the solo restriction.
 *
 * @param {Object} simResult - From `runSimulation`
 * @param {Object} [options] - `{playerHrid}`
 * @returns {Object|null}
 */
export function predictFromSim(simResult, { playerHrid = 'player1' } = {}) {
    const seconds = (simResult?.simulatedTime || 0) / 1e9;
    if (!(seconds > 0)) return null;

    const damageDealt = simResult.totalDamageDealt?.[playerHrid] || 0;
    let damageTaken = 0;
    for (const [hrid, damage] of Object.entries(simResult.totalDamageDealt || {})) {
        if (!hrid.startsWith('player')) damageTaken += damage;
    }

    const encounters = simResult.encounters || 0;
    return {
        seconds,
        damageDealt,
        damageTaken,
        encounters,
        deaths: simResult.deaths?.[playerHrid] || 0,
        dps: damageDealt / seconds,
        takenPerSecond: damageTaken / seconds,
        secondsPerFight: encounters > 0 ? seconds / encounters : null,
        warnings: simResult.warnings || [],
    };
}

/**
 * How far the observation sits from the prediction, as a percentage of it.
 *
 * @param {number} observed - What happened
 * @param {number} predicted - What was said would happen
 * @returns {number|null} Positive when the observation is the larger
 */
export function deviationPct(observed, predicted) {
    if (!Number.isFinite(observed) || !Number.isFinite(predicted) || predicted === 0) return null;
    return ((observed - predicted) / predicted) * 100;
}

/**
 * How far apart two samples of the same thing could land by chance.
 *
 * The 95% interval on the mean of the per-fight values, in percent of that mean,
 * widened in quadrature by the simulator's own noise — two independent sources
 * of spread add as squares, not as sums.
 *
 * @param {Array<number>} samples - One value per fight
 * @param {number} [floorPct] - Allowance for the predicted side's own randomness
 * @returns {number|null} Null when there are too few fights to say
 */
export function noiseMargin(samples, floorPct = SIM_NOISE_FLOOR_PCT) {
    const values = (samples || []).filter((value) => Number.isFinite(value));
    if (values.length < MIN_SAMPLE_FIGHTS) return null;

    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    if (!(mean > 0)) return null;

    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length - 1);
    const standardError = Math.sqrt(variance / values.length);
    const samplePct = ((Z95 * standardError) / mean) * 100;

    return Math.hypot(samplePct, floorPct);
}

/**
 * How much of this sample is noise, said before anybody reads a number off it.
 *
 * Six fights is a small sample and a small sample disagrees with everything, so
 * the fight count on its own invites exactly the wrong reading: "six fights, 12%
 * under, the simulator is 12% out". The margin is what turns that into "six
 * fights, and six fights cannot see 12%".
 *
 * It is measured, not assumed. The rule of thumb — relative standard error is
 * about one over the square root of the sample — is only right when the spread
 * happens to equal the mean, and combat is nothing like that steady: fights
 * against the same wave land within a few percent of each other, so the real
 * margin is usually a fraction of what 1/√n would claim. The per-fight values
 * are kept on every observation, so {@link noiseMargin} uses the actual variance
 * and this reports what it found.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @returns {{fights: number, marginPct: number|null, quiet: boolean, text: string}}
 */
export function noiseSummary(observed) {
    const fights = Number(observed?.fights) || 0;
    const plural = fights === 1 ? '' : 's';
    const marginPct = noiseMargin(observed?.samples?.dps);

    if (marginPct === null) {
        return {
            fights,
            marginPct: null,
            quiet: false,
            text: `${fights} fight${plural} — too few to measure the noise; nothing here is a finding yet`,
        };
    }

    const band = marginPct >= 10 ? marginPct.toFixed(0) : marginPct.toFixed(1);
    const quiet = marginPct < NOISE_QUIET_PCT;
    return {
        fights,
        marginPct,
        quiet,
        text: quiet
            ? `${fights} fight${plural} — ±${band}% noise on this sample; large enough to argue with`
            : `${fights} fight${plural} — ±${band}% noise on this sample; ` +
              'differences inside that band are not findings',
    };
}

/**
 * One metric, observed against predicted.
 *
 * @param {Object} metric - `{key, label, observed, predicted, samples}`
 * @returns {Object} The same, plus `deviationPct`, `marginPct` and `verdict`
 */
export function compareMetric({ key, label, observed, predicted, samples }) {
    const deviation = deviationPct(observed, predicted);
    const margin = noiseMargin(samples);

    let verdict = 'insufficient';
    if (deviation !== null && margin !== null) {
        verdict = Math.abs(deviation) > margin ? 'beyond-noise' : 'within-noise';
    }

    return { key, label, observed, predicted, deviationPct: deviation, marginPct: margin, verdict };
}

/** The metrics compared, in the order they are shown */
const METRICS = [
    { key: 'dps', label: 'Damage dealt / sec' },
    { key: 'takenPerSecond', label: 'Damage taken / sec' },
    { key: 'secondsPerFight', label: 'Seconds per fight' },
];

/**
 * The whole comparison.
 *
 * @param {Object} observed - From `aggregateObservations`
 * @param {Object} predicted - From `predictFromSim`
 * @returns {Object|null}
 */
export function compareRun(observed, predicted) {
    if (!observed || !predicted) return null;

    return {
        fights: observed.fights,
        recordedAt: observed.recordedAt,
        oldestRecordedAt: observed.oldestRecordedAt,
        recordings: observed.recordings,
        zoneHrid: observed.zoneHrid,
        difficultyTier: observed.difficultyTier,
        observedSeconds: observed.seconds,
        predictedSeconds: predicted.seconds,
        warnings: predicted.warnings || [],
        metrics: METRICS.map(({ key, label }) =>
            compareMetric({
                key,
                label,
                observed: observed[key],
                predicted: predicted[key],
                samples: observed.samples?.[key],
            })
        ),
    };
}

/**
 * The one line the overlay tile carries.
 *
 * @param {Object} comparison - From `compareRun`
 * @returns {string}
 */
export function summaryLine(comparison) {
    const dps = comparison?.metrics?.find((metric) => metric.key === 'dps');
    if (!dps || dps.deviationPct === null) return 'No sim check yet';

    const fights = comparison.fights;
    const magnitude = Math.abs(dps.deviationPct).toFixed(1);
    const direction = dps.deviationPct < 0 ? 'under' : 'over';

    if (dps.verdict === 'insufficient') {
        return `${fights} fight${fights === 1 ? '' : 's'}: ${magnitude}% ${direction} predicted DPS (too few to judge)`;
    }
    if (dps.verdict === 'within-noise') {
        return `Last ${fights} fights: ${magnitude}% ${direction} predicted DPS (within noise)`;
    }
    return `Last ${fights} fights ran ${magnitude}% ${direction} predicted DPS`;
}

/**
 * The ink a verdict is drawn in.
 *
 * Only a deviation the sample can actually see gets a colour. Within-noise used
 * to be green, which read as "checked, and fine" — but it is not a finding
 * either way: a six-fight sample agreeing with the simulator to within its own
 * twenty percent margin has established nothing at all. Dim is what "the sample
 * cannot tell" looks like, and it is the same dim as too-few-fights because it
 * is the same statement.
 */
function verdictColor(verdict) {
    if (verdict === 'beyond-noise') return ROW_COLORS.bad;
    return ROW_COLORS.dim;
}

/**
 * A metric's value, formatted for what it measures.
 *
 * @param {string} key - Which metric
 * @param {number} value - What it read
 * @returns {string}
 */
function formatMetric(key, value) {
    if (!Number.isFinite(value)) return '—';
    if (key === 'secondsPerFight') return `${value.toFixed(1)}s`;
    return formatKMB(value, 1);
}

/**
 * The zone's name, or its hrid when the client has not said.
 * @param {string} zoneHrid - The zone
 * @returns {string}
 */
function zoneName(zoneHrid) {
    if (!zoneHrid) return 'Unknown zone';
    return dataManager.getInitClientData()?.actionDetailMap?.[zoneHrid]?.name || zoneHrid;
}

/**
 * What identifies an observation, closely enough to notice it twice.
 *
 * The fight count and the first fight's damage would collide across the segments
 * of one long recording sooner or later; the total is what makes two segments of
 * the same length distinguishable.
 *
 * @param {Object} observation - From `observeRecording`
 * @returns {string}
 */
function observationSignature(observation) {
    const fights = observation?.fights || [];
    const total = fights.reduce((sum, fight) => sum + (fight.damageDealt || 0), 0);
    return `${fights.length}:${fights[0]?.damageDealt}:${total}`;
}

class ReplayCheck {
    constructor() {
        this.observations = [];
        this.loaded = false;
        this.watching = false;
        this.detach = null;
        this.detachCheckpoint = null;
        this.detachStopped = null;
        this.comparison = null;
        this.running = false;
        this.error = null;
        this.progress = 0;
    }

    /**
     * Start keeping observations, the first time anyone asks for one.
     *
     * Called from the row's `render` rather than from an `initialize`, so a check
     * nobody has switched on costs nothing — and so the settings have finished
     * loading by the time the switch is read.
     */
    ensureWatching() {
        if (this.watching) return;
        if (!config.getSetting('replayCheck')) return;
        this.watching = true;

        this.detach = onRecordingComplete((file) => this.ingest(file));
        this.detachCheckpoint = onRecordingCheckpoint((file) => this.checkpoint(file));
        this.detachStopped = onRecordingStopped(() => this.clearCheckpoint());
        this.load();
    }

    /** Read back what previous sessions observed */
    async load() {
        if (this.loaded) return;
        this.loaded = true;
        try {
            this.observations = (await readScoped(STORAGE_KEY, 'settings', [], DISCARD_LEGACY)) || [];
            // Before the in-memory recording, so a session that was interrupted
            // and then restarted keeps both halves in the order they happened
            await this.recover();
            // A recording made before anyone looked at this is still sitting in
            // the recorder, and is the one most likely to be wanted
            await this.ingest(combatRecorder.recordingFile());
        } catch (error) {
            console.error('[ReplayCheck] Reading past observations failed:', error);
        }
    }

    /**
     * What a recording says happened, stamped with where and with what.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     * @returns {Object|null}
     */
    observationFrom(file) {
        if (!file?.ticks?.length) return null;

        const zone = getCurrentCombatZone();
        return observeRecording(file, {
            zoneHrid: zone?.zoneHrid ?? null,
            difficultyTier: zone?.difficultyTier ?? 0,
            loadout: file.loadout ?? null,
        });
    }

    /**
     * Keep an observation, unless it is one already kept.
     *
     * @param {Object} observation - From `observeRecording`
     * @returns {boolean} Whether it was new
     */
    remember(observation) {
        // An observation ingested twice would double every fight in it, and with
        // segments banked as they fill there are far more chances to do it
        const signature = observationSignature(observation);
        if (this.observations.some((entry) => observationSignature(entry) === signature)) return false;

        this.observations = [...this.observations, observation].slice(-MAX_OBSERVATIONS);
        return true;
    }

    /**
     * Derive an observation from a finished recording or a banked segment and keep it.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     */
    async ingest(file) {
        try {
            const observation = this.observationFrom(file);
            if (!observation) return;
            if (!this.remember(observation)) return;
            // The list in memory is right either way; what a full disk costs is
            // the write, and one failed write per segment rather than a stream
            if (storage.isQuotaExceeded()) return;

            await writeScoped(STORAGE_KEY, this.observations, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Keeping the observation failed:', error);
        }
    }

    /**
     * Write the recording so far somewhere that outlives the tab.
     *
     * Called at fight boundaries only. What is written is the summary — the same
     * per-fight numbers a finished recording yields — and never the ticks, which
     * arrive several times a second and would make this a write storm.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     */
    async checkpoint(file) {
        try {
            // Checked before deriving, not after: on a full disk the derivation
            // is the expensive half and it is thrown away
            if (storage.isQuotaExceeded()) return;

            const observation = this.observationFrom(file);
            // A segment with no completed fight in it is what a rotation leaves
            // behind, and the checkpoint from before the rotation now describes
            // fights that have already been folded in
            if (!observation) {
                await this.clearCheckpoint();
                return;
            }

            await writeScoped(CHECKPOINT_KEY, observation, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Checkpointing the recording failed:', error);
        }
    }

    /** Forget the in-progress recording, because it is no longer in progress */
    async clearCheckpoint() {
        try {
            await writeScoped(CHECKPOINT_KEY, null, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Clearing the checkpoint failed:', error);
        }
    }

    /**
     * Fold in whatever the last session was recording when it ended.
     *
     * Cleared first and kept second: a checkpoint that cannot be folded in — a
     * half-written record, an observation of a zone this character has since
     * left — is not worth recovering on every load for the rest of time.
     */
    async recover() {
        try {
            const checkpoint = await readScoped(CHECKPOINT_KEY, 'settings', null, DISCARD_LEGACY);
            if (!checkpoint?.fights?.length) return;

            await this.clearCheckpoint();
            if (!this.remember(checkpoint)) return;

            const count = checkpoint.fights.length;
            console.log(
                `[ReplayCheck] Recovered ${count} fight${count === 1 ? '' : 's'} from an interrupted recording`
            );
            if (storage.isQuotaExceeded()) return;
            await writeScoped(STORAGE_KEY, this.observations, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Recovering the interrupted recording failed:', error);
        }
    }

    /** What has been observed of the most recently recorded zone */
    observed() {
        return aggregateObservations(this.observations);
    }

    /**
     * Run the sim for the observed zone and compare.
     *
     * @returns {Promise<Object|null>} The comparison, or null when it could not be made
     */
    async check() {
        if (this.running) return this.comparison;

        const observed = this.observed();
        if (!observed) {
            this.error = 'Nothing recorded yet — press Record during a fight.';
            return null;
        }
        if (observed.partySize > 1) {
            this.error = `Recorded in a party of ${observed.partySize}. Only solo runs can be compared to a solo sim.`;
            return null;
        }
        if (!observed.zoneHrid) {
            this.error = 'The recording is not stamped with a zone, so there is nothing to simulate against it.';
            return null;
        }

        this.running = true;
        this.error = null;
        this.progress = 0;
        try {
            const current = buildPlayerDTO();
            if (!current) {
                this.error = 'The character has not loaded yet.';
                return null;
            }

            // The character as it was when the fights happened, where anything
            // says so. An observation from before snapshots existed carries
            // none, and falls through to the current character exactly as before
            const dto = applyLoadoutSnapshot(current, observed.loadout);

            const simResult = await runSimulation(
                {
                    gameData: buildGameDataPayload(),
                    playerDTOs: [dto],
                    zoneHrid: observed.zoneHrid,
                    difficultyTier: observed.difficultyTier || 0,
                    hours: SIM_HOURS,
                    communityBuffs: getCommunityBuffs(),
                },
                (percent) => {
                    this.progress = percent;
                }
            );

            this.comparison = compareRun(observed, predictFromSim(simResult));
            return this.comparison;
        } catch (error) {
            console.error('[ReplayCheck] The check failed:', error);
            this.error = `The simulation failed: ${error.message}`;
            return null;
        } finally {
            this.running = false;
        }
    }

    /** Forget everything observed */
    async forget() {
        this.observations = [];
        this.comparison = null;
        this.error = null;
        await writeScoped(STORAGE_KEY, [], 'settings');
        await this.clearCheckpoint();
    }

    disable() {
        this.detach?.();
        this.detachCheckpoint?.();
        this.detachStopped?.();
        this.detach = null;
        this.detachCheckpoint = null;
        this.detachStopped = null;
        this.watching = false;
        // Observations belong to the character that recorded them, so the next
        // ensureWatching — which is how a character switch arrives here — has
        // to read them again rather than carry these across
        this.observations = [];
        this.comparison = null;
        this.loaded = false;
    }
}

const replayCheck = new ReplayCheck();

// The recorder cannot build a loadout snapshot — the adapter that assembles one
// lives in another bundle — so it is told how. At module scope because a
// recording can start from the auto-record setting before any panel is drawn,
// and a segment recorded without a snapshot is one that can never gain one.
setLoadoutProvider(() => captureLoadoutSnapshot());

// Features are initialized after settings load, which makes this the first
// moment the switch below can be read — and so the moment to go looking for a
// recording the last session was interrupted in the middle of. Without it,
// recovery would wait for somebody to open a panel, which for a tile that is
// hidden by default may be never.
onSessionStart(() => replayCheck.ensureWatching());

/**
 * The comparison table.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} comparison - From `compareRun`
 */
function drawComparison(body, comparison) {
    const card = panelCard(body, 'Observed vs predicted', ACCENT);

    for (const metric of comparison.metrics) {
        const deviation =
            metric.deviationPct === null
                ? '—'
                : `${metric.deviationPct >= 0 ? '+' : ''}${metric.deviationPct.toFixed(1)}%`;
        // The deviation and the band it has to clear, side by side, because the
        // deviation alone is the number people quote and it means nothing alone
        const band = metric.marginPct === null ? ', too few fights' : ` ± ${metric.marginPct.toFixed(1)}%`;

        card.appendChild(
            panelLine(
                metric.label,
                `${formatMetric(metric.key, metric.observed)} vs ${formatMetric(metric.key, metric.predicted)}` +
                    `  (${deviation}${band})`,
                verdictColor(metric.verdict),
                `Observed ${formatMetric(metric.key, metric.observed)}, predicted ` +
                    `${formatMetric(metric.key, metric.predicted)}. ` +
                    (metric.verdict === 'beyond-noise'
                        ? `Outside the ±${metric.marginPct.toFixed(1)}% this sample can explain by chance.`
                        : metric.verdict === 'within-noise'
                          ? `Inconclusive: inside the ±${metric.marginPct.toFixed(1)}% this sample can explain by ` +
                            'chance. Record more of the same zone to narrow it.'
                          : `Fewer than ${MIN_SAMPLE_FIGHTS} fights, so the spread says nothing yet.`)
            )
        );
    }
}

/**
 * What the run was, and everything about it that is not known.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} observed - From `aggregateObservations`
 */
function drawProvenance(body, observed) {
    const card = panelCard(body, 'The recording', ACCENT);
    card.appendChild(panelLine('Zone', zoneName(observed.zoneHrid)));
    card.appendChild(
        panelLine(
            'Fights',
            `${observed.fights} over ${observed.seconds.toFixed(0)}s` +
                (observed.recordings > 1 ? ` (${observed.recordings} recordings)` : '')
        )
    );
    // Beside the fight count, because the fight count on its own is what invites
    // reading a twelve percent deviation off six fights as a twelve percent bug
    const noise = noiseSummary(observed);
    card.appendChild(
        panelLine(
            'Sample',
            noise.text,
            noise.quiet ? ROW_COLORS.good : ROW_COLORS.dim,
            'The 95% margin on the mean of the per-fight rates, from the actual spread of these fights rather ' +
                `than a rule of thumb, widened for the simulator's own randomness. Under ${NOISE_QUIET_PCT}% is ` +
                'a sample worth drawing conclusions from.'
        )
    );
    card.appendChild(panelLine('Recorded', formatRelativeTime(Date.now() - observed.recordedAt) + ' ago'));
    card.appendChild(panelLine('Kills', String(observed.kills)));
    if (observed.deaths) card.appendChild(panelLine('Deaths', String(observed.deaths), ROW_COLORS.bad));
    if (observed.truncated) {
        card.appendChild(panelLine('Truncated', 'a fight outran the tick limit and was dropped', ROW_COLORS.dim));
    }
}

/** The things that would make the deviation mean nothing */
function drawCaveats(body, observed) {
    if (observed.loadout) {
        body.appendChild(
            panelNote(
                'Simmed against the gear worn when recorded: equipment and enhancement levels, combat levels, ' +
                    'equipped abilities, house rooms and guild shrines were all captured as the recording started, ' +
                    'so enhancing or swapping something since does not show up as a deviation.'
            )
        );
        if (observed.mixedLoadouts) {
            body.appendChild(
                panelNote(
                    'These recordings were not all made with the same loadout. The newest snapshot is the one ' +
                        'simulated, so the older fights in this sample are being compared against kit they were ' +
                        'not fought in.'
                )
            );
        }
        body.appendChild(
            panelNote(
                'The drink and food slots were captured too, but nothing on the combat feed says whether they were ' +
                    'actually up — an empty inventory records as a full loadout. Experience and drops are not on ' +
                    'the feed at all and are not checked here.'
            )
        );
    } else {
        body.appendChild(
            panelNote(
                'This recording predates loadout snapshots, so gear is read as it is worn now, not as it was ' +
                    `${formatRelativeTime(Date.now() - observed.recordedAt)} ago when the fight was recorded. ` +
                    'Change a weapon, a level or a house room between the two and the deviation is that change.'
            )
        );
        body.appendChild(
            panelNote(
                'Consumables are not on the combat feed at all, so whether the recorded run had the same drinks up ' +
                    'as the simulated one is unknown. Experience and drops are not on it either and are not ' +
                    'checked here.'
            )
        );
    }
    body.appendChild(
        panelNote(
            'A fight is measured from one battle to the next, which includes the respawn gap after it — the same ' +
                'clock the simulator runs on.'
        )
    );
}

/**
 * The Record button, in this panel's chrome.
 *
 * What it says and what it does are {@link recordControlState}'s, so it reads
 * "Recording 240…" whether the recording was started here, from DPs, or by the
 * auto-record setting — and stopping it from here is the same stop. No file is
 * written: a recording started from this panel is read by the ingest that
 * follows it, not handed to anybody.
 *
 * @returns {HTMLElement|null} null when no recorder is reachable
 */
function recordButton() {
    const state = recordControlState();
    if (!state) return null;

    const button = document.createElement('button');
    button.textContent = state.label;
    button.title = state.title;
    Object.assign(button.style, {
        background: state.recording ? 'rgba(248, 113, 113, 0.18)' : 'none',
        border: `1px solid ${state.recording ? ROW_COLORS.bad : ROW_COLORS.dim}`,
        borderRadius: '4px',
        color: state.recording ? ROW_COLORS.bad : ROW_COLORS.dim,
        padding: '5px 10px',
        cursor: 'pointer',
    });
    button.addEventListener('click', () => {
        toggleRecording();
        replayCheckPanel.render();
    });
    return button;
}

export const replayCheckPanel = createPanel({
    id: 'replayCheck',
    title: 'Sim Accuracy',
    size: { width: 440, height: 460 },
    accent: ACCENT,
    refreshMs: 2000,
    draw: (body) => {
        replayCheck.ensureWatching();

        if (!config.getSetting('replayCheck')) {
            body.appendChild(panelNote('Sim accuracy is switched off in settings.'));
            return;
        }

        const observed = replayCheck.observed();

        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', gap: '6px', alignItems: 'center' });

        const run = document.createElement('button');
        run.textContent = replayCheck.running ? `Simulating… ${replayCheck.progress}%` : `Run ${SIM_HOURS}h check`;
        run.disabled = replayCheck.running || !observed;
        Object.assign(run.style, {
            background: ACCENT,
            color: '#0e1016',
            border: 'none',
            borderRadius: '4px',
            padding: '5px 10px',
            cursor: run.disabled ? 'default' : 'pointer',
            fontWeight: 'bold',
            opacity: run.disabled ? '0.5' : '1',
        });
        run.addEventListener('click', async () => {
            await replayCheck.check();
            replayCheckPanel.render();
        });

        const forget = document.createElement('button');
        forget.textContent = 'Forget';
        Object.assign(forget.style, {
            background: 'none',
            border: `1px solid ${ROW_COLORS.dim}`,
            borderRadius: '4px',
            color: ROW_COLORS.dim,
            padding: '5px 10px',
            cursor: 'pointer',
        });
        forget.addEventListener('click', async () => {
            await replayCheck.forget();
            replayCheckPanel.render();
        });

        controls.append(run, forget);

        // The same button DPs carries, driving the same recorder. Being told to
        // go and press it on another panel is the one thing this panel could
        // never do anything about, and the recording is what it runs on.
        const record = recordButton();
        if (record) controls.appendChild(record);

        body.appendChild(controls);

        if (!observed) {
            body.appendChild(
                panelNote(
                    'Nothing recorded yet. Press Record during a fight — here or on the DPs panel — or switch on ' +
                        '“Auto-record combat on load”, and this fills in when the recording stops.'
                )
            );
            return;
        }

        drawProvenance(body, observed);

        if (replayCheck.error) body.appendChild(panelNote(replayCheck.error));
        if (replayCheck.comparison) {
            drawComparison(body, replayCheck.comparison);
            for (const warning of replayCheck.comparison.warnings) {
                body.appendChild(panelNote(`The engine skipped a mechanic in this zone: ${warning}`));
            }
        } else if (!replayCheck.error) {
            body.appendChild(panelNote('Run the check to compare this recording against the simulator.'));
        }

        drawCaveats(body, observed);
    },
});

registerRow({
    key: 'replayCheck',
    name: 'Sim Accuracy',
    empty: 'No sim check yet',
    defaultVisible: false,
    defaultSize: { width: 250, height: 30 },
    onOpen: () => replayCheckPanel.toggle(),
    render: (container) => {
        replayCheck.ensureWatching();
        container.replaceChildren();

        if (!config.getSetting('replayCheck')) return;

        const comparison = replayCheck.comparison;
        if (!comparison) return;

        Object.assign(container.style, { display: 'flex', justifyContent: 'space-between', gap: '10px' });

        const label = document.createElement('span');
        label.textContent = 'Sim accuracy';

        const value = document.createElement('span');
        value.textContent = summaryLine(comparison);
        value.style.color = verdictColor(comparison.metrics.find((metric) => metric.key === 'dps')?.verdict);
        value.style.whiteSpace = 'nowrap';

        container.append(label, value);
        container.title = 'Double-click for the full comparison, its margins and its caveats.';
    },
});

export default replayCheck;
