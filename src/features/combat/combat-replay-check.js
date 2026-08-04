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
 * - **No gear at the time of recording.** A recording is stamped with when it
 *   was made and nothing else; the sim runs against whatever is worn *now*.
 *   Change a weapon between the two and the deviation is the weapon.
 * - **Solo only.** In a party the monsters spread their damage across everyone
 *   and the kills are the party's, so neither figure means what the solo sim
 *   means. Party recordings are refused rather than quietly mis-compared.
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
import {
    buildGameDataPayload,
    buildPlayerDTO,
    getCommunityBuffs,
    getCurrentCombatZone,
} from '../combat-sim/combat-sim-adapter.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import combatRecorder, { onRecordingComplete } from './combat-recorder.js';
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

/** Observations kept, oldest dropped first */
const MAX_OBSERVATIONS = 10;

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
const DISCARD_LEGACY = { migrate: 'discard' };

const ACCENT = '#8fd0ff';

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
 * @param {Object} [context] - `{zoneHrid, difficultyTier, recordedAt}` to stamp it with
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

    return {
        zoneHrid: newest.zoneHrid,
        difficultyTier: newest.difficultyTier,
        partySize: Math.max(...matching.map((entry) => entry.partySize || 1)),
        truncated: matching.some((entry) => entry.truncated),
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

/** The ink a verdict is drawn in */
function verdictColor(verdict) {
    if (verdict === 'beyond-noise') return ROW_COLORS.bad;
    if (verdict === 'within-noise') return ROW_COLORS.good;
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

class ReplayCheck {
    constructor() {
        this.observations = [];
        this.loaded = false;
        this.watching = false;
        this.detach = null;
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
        this.load();
    }

    /** Read back what previous sessions observed */
    async load() {
        if (this.loaded) return;
        try {
            this.observations = (await readScoped(STORAGE_KEY, 'settings', [], DISCARD_LEGACY)) || [];
            this.loaded = true;
            // A recording made before anyone looked at this is still sitting in
            // the recorder, and is the one most likely to be wanted
            this.ingest(combatRecorder.recordingFile());
        } catch (error) {
            console.error('[ReplayCheck] Reading past observations failed:', error);
            this.loaded = true;
        }
    }

    /**
     * Derive an observation from a finished recording and keep it.
     *
     * @param {Object} file - From `combatRecorder.recordingFile()`
     */
    async ingest(file) {
        try {
            if (!file?.ticks?.length) return;

            const zone = getCurrentCombatZone();
            const observation = observeRecording(file, {
                zoneHrid: zone?.zoneHrid ?? null,
                difficultyTier: zone?.difficultyTier ?? 0,
            });
            if (!observation) return;

            // A recording ingested twice would double every fight in it. The
            // start of the run and its fight count identify one closely enough.
            const signature = `${observation.fights.length}:${observation.fights[0]?.damageDealt}`;
            const seen = this.observations.some(
                (entry) => `${entry.fights.length}:${entry.fights[0]?.damageDealt}` === signature
            );
            if (seen) return;

            this.observations = [...this.observations, observation].slice(-MAX_OBSERVATIONS);
            await writeScoped(STORAGE_KEY, this.observations, 'settings');
        } catch (error) {
            console.error('[ReplayCheck] Keeping the observation failed:', error);
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
            const dto = buildPlayerDTO();
            if (!dto) {
                this.error = 'The character has not loaded yet.';
                return null;
            }

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
    }

    disable() {
        this.detach?.();
        this.detach = null;
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
        const margin = metric.marginPct === null ? 'too few fights' : `±${metric.marginPct.toFixed(1)}% noise`;

        card.appendChild(
            panelLine(
                metric.label,
                `${formatMetric(metric.key, metric.observed)} vs ${formatMetric(metric.key, metric.predicted)}` +
                    `  (${deviation})`,
                verdictColor(metric.verdict),
                `Observed ${formatMetric(metric.key, metric.observed)}, predicted ` +
                    `${formatMetric(metric.key, metric.predicted)} — ${margin}. ` +
                    (metric.verdict === 'beyond-noise'
                        ? 'Outside what sampling alone explains.'
                        : metric.verdict === 'within-noise'
                          ? 'Inside what sampling alone explains.'
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
    card.appendChild(panelLine('Recorded', formatRelativeTime(Date.now() - observed.recordedAt) + ' ago'));
    card.appendChild(panelLine('Kills', String(observed.kills)));
    if (observed.deaths) card.appendChild(panelLine('Deaths', String(observed.deaths), ROW_COLORS.bad));
    if (observed.truncated) {
        card.appendChild(panelLine('Truncated', 'the recorder hit its tick limit', ROW_COLORS.dim));
    }
}

/** The things that would make the deviation mean nothing */
function drawCaveats(body, observed) {
    body.appendChild(
        panelNote(
            `Gear is read as it is worn now, not as it was ${formatRelativeTime(Date.now() - observed.recordedAt)} ` +
                'ago when the fight was recorded. Change a weapon, a level or a house room between the two and the ' +
                'deviation is that change.'
        )
    );
    body.appendChild(
        panelNote(
            'Consumables are not on the combat feed at all, so whether the recorded run had the same drinks up as ' +
                'the simulated one is unknown. Experience and drops are not on it either and are not checked here.'
        )
    );
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
