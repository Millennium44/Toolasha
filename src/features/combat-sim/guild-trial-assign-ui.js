/**
 * The Trial Sim's "Assign skilling" view: a recommended skilling sign-up sheet for this cycle.
 *
 * Reads the cycle from what Toolasha already holds — drawn trials and trial minimum levels off
 * the guild payload, the roster, join times and sign-ups off the guild XP tracker, slot caps off
 * the Skilling Encampment, skill levels off profiles the player has opened — and hands them to
 * {@link optimizeTrialAssignmentAsync}. Nothing is sent and nobody is signed up; members sign
 * themselves up. The planner's edits live in memory with the rest of the simulator's setup and
 * are dropped on a character switch.
 *
 * ## Levels
 *
 * A profile states the BASE skill level, which is also what a trial's minimum level is checked
 * against (the game's `getMemberLevelForTrial`). Success and work power run on the effective
 * level. The player's own reading fixes their effective level; the gap between it and their own
 * base level is offered as the assumed level bonus for everyone else in that skill.
 *
 * The roster and skill levels live in the combat bundle and are read through the bundle bridge
 * at draw time; a missing bridge reads as "not loaded".
 */
import dataManager from '../../core/data-manager.js';
import { guildMemberSkills, guildXpTracker } from '../../utils/bundle-bridge.js';
import { isTestServer } from '../../utils/game-server.js';
import { panelCard, panelNote, panelLine } from '../../utils/simple-panel.js';
import { runGuildTrialSimulation } from './guild-trial-runner.js';
import { buildTrialGameData, memberFromSkillingReading } from './guild-trial-adapter.js';
import {
    ASSIGN_MODES,
    BASE_SKILLING_SLOTS,
    BENCH_PIN,
    TRIAL_SECONDS,
    optimizeTrialAssignmentAsync,
    rateInputFromLevel,
    signupMessages,
    skillingSlotCap,
} from './guild-trial-assign.js';
import { TRIAL_SKILLS, parseCurrentTrialsData, trialWeekStart } from '../guild/guild-trials-math.js';

const ACCENT = '#b9a6ff';

/** Skilling trials drawn per cycle */
export const SKILLING_TRIALS_PER_CYCLE = 4;

/** Inputs for members without a reading when no reading of any skill exists */
export const FALLBACK_ASSUMPTION = Object.freeze({ efficiency: 0, actionSeconds: 10, doubleChance: 0 });

/** The game's cap on a trial's minimum level (`MAX_TRIAL_MIN_LEVEL`) */
export const MAX_TRIAL_MIN_LEVEL = 200;

/** Simulator runs per trial for the check */
const CHECK_RUNS = 50;

/** A skilling trial hrid from a trial or skill hrid, or null */
export function skillingTrialHrid(hrid) {
    const key = String(hrid || '')
        .split('/')
        .filter(Boolean)
        .pop();
    return key && TRIAL_SKILLS.includes(key) ? `/guild_skilling/${key}` : null;
}

/** The skill a trial is worked in, from the game's trial details where present */
export function trialSkillHrid(trialHrid, clientData) {
    return clientData?.guildTrialDetailMap?.[trialHrid]?.skillHrid || `/skills/${trialHrid.split('/').pop()}`;
}

/** The game's name for a trial's skill, else the hrid's last segment, capitalized */
export function trialLabel(trialHrid, clientData) {
    const name = clientData?.skillDetailMap?.[trialSkillHrid(trialHrid, clientData)]?.name;
    if (name) return name;
    const key = trialHrid.split('/').pop();
    return key[0].toUpperCase() + key.slice(1);
}

/**
 * This cycle's drawn skilling trials, from the most direct source available.
 *
 * `guildWeeklyTrialSet.skillHrids` (on `guild_updated` and the login payload) is what the game's
 * Trials tab sorts and draws. Once trials have started, `currentTrialsData` names them as well.
 *
 * @param {{weeklyTrialSet?: Object, characterData?: Object}} sources
 * @returns {{trials: string[], source: string|null}}
 */
export function drawnSkillingTrials({ weeklyTrialSet = null, characterData = null } = {}) {
    const fromList = (list) => [...new Set((Array.isArray(list) ? list : []).map(skillingTrialHrid).filter(Boolean))];
    for (const [set, source] of [
        [weeklyTrialSet, 'guild update'],
        [characterData?.guildWeeklyTrialSet, 'login payload'],
    ]) {
        const trials = fromList(set?.skillHrids);
        if (trials.length) return { trials: trials.slice(0, SKILLING_TRIALS_PER_CYCLE), source };
    }
    const raw = characterData?.guild?.currentTrialsData;
    const parsed = parseCurrentTrialsData(raw);
    let points = {};
    try {
        points = (typeof raw === 'string' ? JSON.parse(raw) : raw)?.points || {};
    } catch {
        points = {};
    }
    const trials = fromList([...Object.keys(parsed?.skilling?.trials || {}), ...Object.keys(points)]);
    return trials.length
        ? { trials: trials.slice(0, SKILLING_TRIALS_PER_CYCLE), source: 'trial progress' }
        : { trials: [], source: null };
}

/**
 * A guild's trial minimum levels, out of `guild.trialMinLevelsData`.
 *
 * The game sends a JSON string ("{}" or empty for none) mapping trial hrid → minimum, and clamps
 * each to 0..{@link MAX_TRIAL_MIN_LEVEL}. A zero is no minimum and is dropped.
 *
 * @param {string|Object} raw - As the guild object carries it
 * @returns {Object<string, number>} Skilling trial hrid → minimum base level
 */
export function parseTrialMinLevels(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        if (!raw.trim()) return {};
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {};
        }
    }
    const out = {};
    for (const [hrid, value] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
        const trial = skillingTrialHrid(hrid);
        const level = Math.max(0, Math.min(MAX_TRIAL_MIN_LEVEL, Math.floor(Number(value))));
        if (trial && hrid.startsWith('/guild_skilling/') && level > 0) out[trial] = level;
    }
    return out;
}

/**
 * The roster as the optimizer needs it.
 *
 * Eligibility is the game's `canMemberParticipate`: the join time strictly before the week's
 * start (Friday 00:00 UTC, computed from the clock as the game does), an unreadable join time
 * being ineligible. The test server waives the rule, as the game does there.
 *
 * @param {Object} tracker - The guild XP tracker
 * @param {{now?: number, testServer?: boolean}} [options]
 * @returns {{weekStartAt: string|null, members: Array<Object>}}
 */
export function cycleRoster(tracker, { now = Date.now(), testServer = isTestServer() } = {}) {
    const weekStartAt = tracker?.getCurrentWeekStartAt?.() ?? null;
    const weekMs = trialWeekStart(now);
    const members = [];
    for (const entry of tracker?.getMemberList?.() || []) {
        const meta = tracker.getMemberMeta?.(entry.characterID) || entry;
        if (!meta?.name || entry.characterID == null) continue;
        // A missing join time is unreadable, not 1970: new Date(null) would make it eligible
        const joinedMs = meta.joinTime == null || meta.joinTime === '' ? NaN : new Date(meta.joinTime).getTime();
        if (!testServer && !(joinedMs < weekMs)) continue;
        const thisCycle = weekStartAt != null && meta.signupWeekStartAt === weekStartAt;
        members.push({
            id: String(entry.characterID),
            name: meta.name,
            current: thisCycle ? skillingTrialHrid(meta.signedUpSkillingTrialHrid) : null,
            inCombat: thisCycle && Boolean(meta.signedUpCombatTrialHrid),
        });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return { weekStartAt, members };
}

/** Efficiency, time and double progress a reading states */
function assumptionFromReading(reading) {
    if (!reading) return null;
    const efficiency = Number(reading.efficiency);
    const seconds = Number(reading.actionTimeMs) / 1000;
    if (!Number.isFinite(efficiency) || !(seconds > 0)) return null;
    return { efficiency, actionSeconds: seconds, doubleChance: Number(reading.doubleProgressChance) || 0 };
}

/** The current character's base skill levels, skill hrid → level */
function ownBaseLevels() {
    const out = {};
    for (const skill of Array.isArray(dataManager.characterSkills) ? dataManager.characterSkills : []) {
        const level = Number(skill?.level);
        if (skill?.skillHrid && Number.isFinite(level)) out[skill.skillHrid] = level;
    }
    return out;
}

/**
 * Per-trial inputs for members without a reading: the player's own reading of that trial, else
 * their latest reading of any trial, else {@link FALLBACK_ASSUMPTION}.
 *
 * `levelBonus` is the effective level the reading's success curve implies minus the player's own
 * base level in that skill — an assumption that everyone's gear adds what the player's does.
 * Only a reading of that same trial gives one, and a capped (lower-bound) curve gives none.
 *
 * @param {string[]} trials - Trial hrids
 * @param {Object<string, Object>} readings - trial hrid → latest `guild_skilling_updated` (with `at`)
 * @param {{ownBaseLevels?: Object, successReadings?: Object, clientData?: Object}} [own]
 * @returns {Object<string, {efficiency: number, actionSeconds: number, doubleChance: number,
 *   levelBonus: number, source: string}>}
 */
export function defaultAssumptions(
    trials,
    readings = {},
    { ownBaseLevels: bases = {}, successReadings, clientData } = {}
) {
    const latest = Object.values(readings || {})
        .filter((reading) => assumptionFromReading(reading))
        .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    const out = {};
    for (const trial of trials) {
        const reading = readings?.[trial];
        const own = assumptionFromReading(reading);
        if (own) {
            const curve = memberFromSkillingReading(reading, '', Object.values(successReadings?.[trial] || {}));
            const base = bases?.[trialSkillHrid(trial, clientData)];
            const levelBonus =
                curve?.effectiveLevel != null && !curve.successLowerBound && Number.isFinite(base)
                    ? curve.effectiveLevel - base
                    : 0;
            out[trial] = {
                ...own,
                levelBonus,
                source: levelBonus
                    ? `your reading of this trial; level bonus ${levelBonus > 0 ? '+' : ''}${Math.round(levelBonus * 10) / 10} from it`
                    : 'your reading of this trial',
            };
        } else if (latest) {
            out[trial] = { ...assumptionFromReading(latest), levelBonus: 0, source: 'your reading of another trial' };
        } else {
            out[trial] = { ...FALLBACK_ASSUMPTION, levelBonus: 0, source: 'no reading: flat assumption' };
        }
    }
    return out;
}

/**
 * One member's rate input per trial and where it came from.
 *
 * The level typed in the table, a profile's level and the player's own level are all BASE levels;
 * the assumed level bonus is added before scoring. A known base level below the trial's minimum
 * closes the trial to the member.
 *
 * @returns {{rates: Object<string, Object|null>, coverage: Object<string, {kind: string,
 *   level: number|null, base: number|null, min: number, minUnverified: boolean}>}}
 *   `kind` is `reading`, `manual`, `level`, `below-min` or `missing`
 */
export function memberRates(
    member,
    trials,
    { ownId, ownLevels, readings, successReadings, manual, levelFor, assumed, clientData, minLevels }
) {
    const rates = {};
    const coverage = {};
    for (const trial of trials) {
        const skill = trialSkillHrid(trial, clientData);
        const own = member.id === ownId;
        const typedRaw = manual?.[trial];
        const typedNumber = typedRaw === '' || typedRaw == null ? NaN : Number(typedRaw);
        // A typed level outside any skill's range is ignored rather than scored
        const typed = typedNumber >= 1 && typedNumber <= 500 ? typedNumber : NaN;
        let base = Number.isFinite(typed) ? typed : own ? ownLevels?.[skill] : levelFor?.(member.name, skill);
        if (!Number.isFinite(base)) base = null;
        const min = minLevels?.[trial] || 0;
        const reading = own ? readings?.[trial] : null;
        const fromReading = reading
            ? memberFromSkillingReading(reading, member.name, Object.values(successReadings?.[trial] || {}))
            : null;
        let entry;
        if (min && base != null && base < min) {
            rates[trial] = null;
            entry = { kind: 'below-min', level: base };
        } else if (fromReading) {
            rates[trial] = fromReading;
            entry = { kind: 'reading', level: fromReading.effectiveLevel ?? null };
        } else if (base != null) {
            rates[trial] = rateInputFromLevel(base + (assumed[trial]?.levelBonus || 0), assumed[trial]);
            entry = { kind: rates[trial] ? (Number.isFinite(typed) ? 'manual' : 'level') : 'missing', level: base };
        } else {
            rates[trial] = null;
            entry = { kind: 'missing', level: null };
        }
        coverage[trial] = { ...entry, base, min, minUnverified: min > 0 && base == null && rates[trial] != null };
    }
    return { rates, coverage };
}

const MARKERS = { reading: 'R', manual: 'M', level: 'L', 'below-min': '<min', missing: '—' };

/** Copy text, falling back to a selected text area */
async function copyText(text, area) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        area?.select?.();
        return false;
    }
}

/** Remove any drawn recommendation from the page */
function removeResultCards() {
    if (typeof document === 'undefined') return;
    for (const card of document.querySelectorAll('[data-trial-assign="result"]')) card.remove();
}

/** Whether a member's pin still means something for these trials */
function pinApplies(pin, member, trials) {
    if (pin === BENCH_PIN) return true;
    return trials.includes(pin) && member?.coverage?.[pin]?.kind !== 'below-min';
}

export class TrialAssignPlanner {
    constructor(sim) {
        this.sim = sim;
        this.reset();
    }

    reset() {
        this.controller?.abort();
        this.controller = null;
        this.pendingBlurRedraw = false;
        this.mode = ASSIGN_MODES.Bench;
        this.trialOverrides = null;
        this.cap = null;
        this.baseWork = 40000;
        this.seconds = TRIAL_SECONDS;
        this.assumed = {};
        this.pins = {};
        this.manual = {};
        this.weeklyTrialSet = null;
        this.trialMinLevelsData = null;
        this.result = null;
        this.check = null;
        this.error = '';
        this.status = '';
    }

    /**
     * A drawn set off `guild_updated`. A different draw replaces any trials chosen here and the
     * recommendation made for the old ones.
     * @param {Object} set - `guildWeeklyTrialSet`
     */
    setWeeklyTrialSet(set) {
        if (JSON.stringify(set) === JSON.stringify(this.weeklyTrialSet)) return;
        this.weeklyTrialSet = set;
        this.trialOverrides = null;
        this.prunePins(drawnSkillingTrials({ weeklyTrialSet: set }).trials);
        this.edited();
    }

    /** Drop pins to trials that are not drawn */
    prunePins(trials) {
        for (const [id, pin] of Object.entries(this.pins))
            if (pin !== BENCH_PIN && !trials.includes(pin)) delete this.pins[id];
    }

    /** The cycle as currently known, with this planner's edits applied */
    context() {
        const clientData = dataManager.getInitClientData?.() || null;
        const characterData = dataManager.characterData || null;
        const tracker = guildXpTracker();
        const skills = guildMemberSkills();
        const drawn = drawnSkillingTrials({ weeklyTrialSet: this.weeklyTrialSet, characterData });
        const trials = this.trialOverrides ?? drawn.trials;
        const roster = cycleRoster(tracker);
        const encampment = Object.values(clientData?.guildBuildingDetailMap || {}).some(
            (detail) => Number(detail?.skillingTrialSlotsPerLevel) > 0
        );
        const derivedCap = skillingSlotCap(clientData?.guildBuildingDetailMap, dataManager.guildBuildingLevelMap);
        // An empty level map on a fresh login means "not loaded yet", not a level-0 Encampment
        const levelsKnown = Object.keys(dataManager.guildBuildingLevelMap || {}).length > 0;
        const ownLevels = ownBaseLevels();
        const defaults = defaultAssumptions(trials, this.sim.readings, {
            ownBaseLevels: ownLevels,
            successReadings: this.sim.successReadings,
            clientData,
        });
        const assumed = {};
        for (const trial of trials) assumed[trial] = { ...defaults[trial], ...(this.assumed[trial] || {}) };
        const minLevels = parseTrialMinLevels(this.trialMinLevelsData ?? characterData?.guild?.trialMinLevelsData);
        const ownId = String(dataManager.getCurrentCharacterId?.() ?? '');
        const levelFor = skills?.levelFor ? (name, skill) => skills.levelFor(name, skill) : null;
        const members = roster.members.map((member) => {
            const rated = {
                ...member,
                ...memberRates(member, trials, {
                    ownId,
                    ownLevels,
                    readings: this.sim.readings,
                    successReadings: this.sim.successReadings,
                    manual: this.manual[member.id],
                    levelFor,
                    assumed,
                    clientData,
                    minLevels,
                }),
            };
            const pin = this.pins[member.id];
            rated.pin = pin && pinApplies(pin, rated, trials) ? pin : '';
            return rated;
        });
        const context = {
            clientData,
            trials,
            drawnSource: this.trialOverrides ? 'chosen here' : drawn.source,
            weekStartAt: roster.weekStartAt,
            cap: this.cap ?? derivedCap,
            derivedCap,
            encampment,
            capUnknown: encampment && !levelsKnown && this.cap == null,
            assumed,
            minLevels,
            members,
            hasRoster: members.length > 0,
            hasSkills: Boolean(skills?.initialized && Object.keys(skills.all?.() || {}).length),
        };
        // What a recommendation depends on, so one made from other inputs is not shown as current
        context.signature = JSON.stringify([
            trials,
            context.cap,
            // Whether Recommend is allowed yet: hydration can flip it without changing the cap
            context.capUnknown,
            this.mode,
            this.baseWork,
            minLevels,
            trials.map((trial) => {
                const a = assumed[trial];
                return [a.efficiency, a.actionSeconds, a.doubleChance, a.levelBonus];
            }),
            members.map((m) => [
                m.id,
                // Names go into the chat text, so a rename makes the sheet stale
                m.name,
                m.current,
                m.inCombat,
                m.pin,
                trials.map((t) => [m.coverage[t].kind, m.coverage[t].level]),
                // The rates the optimizer consumes: a new reading can change them without changing the level
                trials.map((t) => m.rates[t]),
            ]),
        ]);
        return context;
    }

    /** The optimizer's problem from a context */
    problem(context) {
        const members = [];
        const belowMinimum = [];
        let unplaced = 0;
        for (const member of context.members) {
            const anyRate = context.trials.some((trial) => member.rates[trial]);
            let pin = member.pin || null;
            if (!anyRate && !pin) {
                // No data: keep a current sign-up (it still adds to the pool), otherwise leave them out.
                // A sign-up the member's known level is below the minimum for cannot stand.
                // Kept out of the recommendation, but still counted where they signed up in the
                // current sheet's score, where their zero-work sign-up adds 1% to that pool
                if (member.current && member.coverage[member.current]?.kind === 'below-min') {
                    belowMinimum.push(member.name);
                    members.push({
                        id: member.id,
                        name: member.name,
                        rates: member.rates,
                        pin: BENCH_PIN,
                        current: member.current,
                        inCombat: member.inCombat,
                    });
                    continue;
                }
                if (!member.current || !context.trials.includes(member.current)) {
                    unplaced++;
                    continue;
                }
                pin = member.current;
            }
            members.push({
                id: member.id,
                name: member.name,
                rates: member.rates,
                pin,
                current: member.current,
                inCombat: member.inCombat,
            });
        }
        return {
            problem: {
                trials: context.trials,
                cap: context.cap,
                mode: this.mode,
                baseWork: this.baseWork,
                seconds: this.seconds,
                members,
                seed: 1,
                restarts: 4,
            },
            unplaced,
            belowMinimum,
        };
    }

    owner() {
        return { generation: this.sim.generation, character: dataManager.getCurrentCharacterId?.() ?? null };
    }

    stillOwner(owner) {
        return (
            owner.generation === this.sim.generation &&
            owner.character === (dataManager.getCurrentCharacterId?.() ?? null)
        );
    }

    async recommend() {
        if (this.controller) return;
        const owner = this.owner();
        const controller = new AbortController();
        this.controller = controller;
        this.error = '';
        this.check = null;
        this.status = 'Searching…';
        this.sim.panel?.render();
        try {
            const context = this.context();
            if (!context.trials.length) throw new Error('Choose the cycle’s skilling trials first.');
            const { problem, unplaced, belowMinimum } = this.problem(context);
            if (!problem.members.length) throw new Error('No eligible member has a skill level or reading yet.');
            const result = await optimizeTrialAssignmentAsync(problem, { signal: controller.signal });
            if (controller.signal.aborted) throw new Error('Assignment canceled.');
            if (!this.stillOwner(owner)) return;
            this.result = { result, unplaced, belowMinimum, context, problem, signature: context.signature };
            this.status = '';
        } catch (error) {
            if (!this.stillOwner(owner)) return;
            this.error = controller.signal.aborted ? '' : error.message;
            this.status = controller.signal.aborted ? 'Canceled.' : '';
        } finally {
            if (this.stillOwner(owner) && this.controller === controller) {
                this.controller = null;
                this.sim.panel?.render();
            }
        }
    }

    async checkWithSimulator() {
        if (this.controller || !this.result) return;
        const owner = this.owner();
        const controller = new AbortController();
        this.controller = controller;
        this.error = '';
        this.check = [];
        this.sim.panel?.render();
        const { result, problem } = this.result;
        try {
            const gameData = buildTrialGameData();
            if (!gameData) throw new Error('Game data is not ready.');
            const byId = new Map(problem.members.map((member) => [member.id, member]));
            for (const trial of result.trials) {
                const members = trial.memberIds
                    .map((id) => byId.get(id))
                    .filter((member) => member?.rates?.[trial.trialHrid])
                    .map((member) => ({ id: member.id, name: member.name, ...member.rates[trial.trialHrid] }));
                if (!members.length) continue;
                this.status = `Simulating ${trialLabel(trial.trialHrid, this.result.context.clientData)}…`;
                this.sim.panel?.render();
                const summary = await runGuildTrialSimulation(
                    {
                        type: 'start_guild_trial_simulation',
                        taskId: `guild-trial-assign-${Date.now()}-${owner.generation}`,
                        gameData,
                        scenario: {
                            kind: 'skilling',
                            trialHrid: trial.trialHrid,
                            baseWork: problem.baseWork,
                            seconds: problem.seconds,
                            runs: CHECK_RUNS,
                            seed: 1,
                            participantCount: trial.signups,
                            members,
                        },
                    },
                    () => {},
                    { signal: controller.signal }
                );
                if (controller.signal.aborted) throw new Error('Simulation canceled.');
                if (!this.stillOwner(owner)) return;
                this.check.push({ trialHrid: trial.trialHrid, summary });
            }
            this.status = '';
        } catch (error) {
            if (!this.stillOwner(owner)) return;
            if (controller.signal.aborted) {
                // A partial check would read as the whole sheet's
                this.check = null;
                this.error = '';
                this.status = 'Canceled.';
            } else {
                this.error = `Simulator check failed: ${error.message}`;
                this.status = '';
            }
        } finally {
            if (this.stillOwner(owner) && this.controller === controller) {
                this.controller = null;
                this.sim.panel?.render();
            }
        }
    }

    edited() {
        this.result = null;
        this.check = null;
        this.error = '';
        // Taken off the page now rather than on the next draw, which would also take the caret
        // out of the input being typed into
        removeResultCards();
    }

    /**
     * Something the view reads changed: sign-ups, the roster, the draw, minimums, building levels,
     * captured skill levels, the player's own levels or readings. The one entry point for all of
     * them, called by the simulator a tick after the message (see its `notifyInputs`).
     *
     * A recommendation built on other inputs is dropped, and the view redraws when what it would
     * show changed — unless the player is typing into it; the next notification or draw catches up.
     * A running search or check is left alone; its own redraw checks the inputs when it ends.
     */
    inputsChanged() {
        if (this.controller || (this.sim.kind !== 'assign' && !this.result)) return;
        const signature = this.context().signature;
        if (this.result && this.result.signature !== signature) {
            this.result = null;
            this.check = null;
            this.status = 'The roster, sign-ups, levels or readings changed since the last recommendation.';
            removeResultCards();
        }
        if (this.sim.kind !== 'assign' || signature === this.drawnSignature) return;
        const active = typeof document === 'undefined' ? null : document.activeElement;
        const typing =
            active?.closest?.('[data-trial-assign-root]') && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);
        if (!typing) {
            this.sim.panel?.render();
            return;
        }
        // Catch up once the player leaves the field; a tick later, so focus moving to another field in
        // the view is seen as still typing
        if (this.pendingBlurRedraw) return;
        this.pendingBlurRedraw = true;
        active.addEventListener(
            'blur',
            () =>
                setTimeout(() => {
                    this.pendingBlurRedraw = false;
                    this.inputsChanged();
                }, 0),
            { once: true }
        );
    }

    /**
     * Draw the view.
     * @param {HTMLElement} body - Panel body
     * @param {{button: Function, row: Function, field: Function, select: Function}} ui - The simulator's controls
     */
    draw(body, ui) {
        const { button, row, field, select } = ui;
        const busy = Boolean(this.controller);
        body.dataset.trialAssignRoot = 'true';
        const context = this.context();
        this.drawnSignature = context.signature;
        const label = (trial) => trialLabel(trial, context.clientData);
        const rerender = () => this.sim.panel?.render();
        if (this.result && !busy && this.result.signature !== context.signature) {
            this.result = null;
            this.check = null;
            this.status = 'The roster, sign-ups, levels or readings changed since the last recommendation.';
        }

        body.appendChild(
            panelNote(
                'Recommends who should sign up for which skilling trial this cycle. Nothing is sent: members sign themselves up. Combat trials are not assigned here.'
            )
        );

        const setup = panelCard(body, 'Cycle', ACCENT);
        setup.dataset.trialAssign = 'setup';
        const settings = row(setup);
        select(
            settings,
            'Objective',
            this.mode,
            [
                [ASSIGN_MODES.Bench, 'Max guild points (bench allowed)'],
                [ASSIGN_MODES.Fill, 'Everyone eligible gets a skilling slot'],
            ],
            (mode) => {
                this.mode = mode;
                this.edited();
                rerender();
            },
            busy
        );
        field(
            settings,
            'Slots per trial',
            context.cap,
            (value) => {
                // Out of 0–100 (a cleared field reads as 0 too) is refused visibly; the last valid cap stays
                const input = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
                const raw = input?.value;
                const valid = raw !== '' && Number.isFinite(value) && value >= 0 && value <= 100;
                if (input) {
                    input.style.borderColor = valid ? '' : '#ff6b6b';
                    input.title = valid ? '' : 'Must be between 0 and 100; the last valid value is used';
                }
                if (!valid) return;
                this.cap = Math.floor(value);
                this.edited();
            },
            { min: 0, max: 100, step: 1, disabled: busy }
        );
        field(
            settings,
            'Tier 1 base work',
            this.baseWork,
            (value) => {
                // A zero or negative pool would make every tier instant: refuse it visibly and keep the last
                // valid figure
                const input = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
                const valid = Number.isFinite(value) && value >= 1 && value <= 1e9;
                if (input) {
                    input.style.borderColor = valid ? '' : '#ff6b6b';
                    input.title = valid ? '' : 'Must be between 1 and 1,000,000,000; the last valid value is used';
                }
                if (!valid) return;
                this.baseWork = value;
                this.edited();
            },
            { min: 1, max: 1e9, disabled: busy }
        );
        if (this.mode === ASSIGN_MODES.Bench)
            setup.appendChild(
                panelNote(
                    'Only members signed up for a combat trial are left out of skilling for points: they keep the weekly participation bonus either way. Anyone else stays in skilling unless the slots run out or you pin them out, and the sheet flags them.'
                )
            );
        setup.appendChild(
            panelNote(
                `${context.capUnknown ? 'Slots: the Skilling Encampment level has not loaded yet — open the Guild panel, or set Slots per trial here.' : context.encampment ? `Slots: ${context.derivedCap} from the Skilling Encampment.` : `Slots: ${BASE_SKILLING_SLOTS} (Encampment data unavailable).`} Base work 40,000 matches every recorded skilling pool (Milking, Alchemy, Cheesesmithing, Crafting).`
            )
        );

        const trialRow = row(setup);
        const options = [
            ['', '(none)'],
            ...TRIAL_SKILLS.map((key) => [`/guild_skilling/${key}`, label(`/guild_skilling/${key}`)]),
        ];
        for (let i = 0; i < SKILLING_TRIALS_PER_CYCLE; i++) {
            select(
                trialRow,
                `Trial ${i + 1}`,
                context.trials[i] || '',
                options,
                (hrid) => {
                    const next = [...context.trials];
                    next[i] = hrid;
                    this.trialOverrides = [...new Set(next.filter(Boolean))];
                    this.prunePins(this.trialOverrides);
                    this.edited();
                    rerender();
                },
                busy
            );
        }
        setup.appendChild(
            panelNote(
                context.trials.length
                    ? `Trials from the ${context.drawnSource}.`
                    : 'This cycle’s skilling trials are not known yet — open the guild panel or choose them here.'
            )
        );
        const minimums = context.trials.filter((trial) => context.minLevels[trial]);
        setup.appendChild(
            panelNote(
                minimums.length
                    ? `Minimum skill level (base, without bonuses): ${minimums.map((trial) => `${label(trial)} min ${context.minLevels[trial]}`).join(', ')}.`
                    : 'No trial has a minimum skill level.'
            )
        );

        if (context.trials.length) {
            const assumptions = panelCard(body, 'Members without a reading', ACCENT);
            assumptions.appendChild(
                panelNote(
                    'Work power is effective level × (1 + efficiency); only your own trial reading states efficiency and work time, so everyone else is given these. Effective level is the base skill level plus the level bonus below, which defaults to what your own reading shows over your base level — an assumption that their gear adds what yours does. No consumables in trials.'
                )
            );
            for (const trial of context.trials) {
                const line = row(assumptions);
                const assumed = context.assumed[trial];
                // min/max attributes do not stop the input event, so an out-of-range value is refused here and
                // the last valid one stays in use, with the field marked
                const bounded = (key, min, max, scale) => (v) => {
                    const input = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
                    const valid = Number.isFinite(v) && v >= min && v <= max;
                    if (input) {
                        input.style.borderColor = valid ? '' : '#ff6b6b';
                        input.title = valid ? '' : `Must be between ${min} and ${max}; the last valid value is used`;
                    }
                    if (!valid) return;
                    this.assumed[trial] = { ...(this.assumed[trial] || {}), [key]: v * scale };
                    this.edited();
                };
                field(
                    line,
                    `${label(trial)} efficiency (%)`,
                    assumed.efficiency * 100,
                    bounded('efficiency', 0, 1000, 1 / 100),
                    {
                        min: 0,
                        max: 1000,
                        disabled: busy,
                    }
                );
                field(line, 'Level bonus', assumed.levelBonus, bounded('levelBonus', -100, 200, 1), {
                    min: -100,
                    max: 200,
                    disabled: busy,
                });
                field(line, 'Work time (s)', assumed.actionSeconds, bounded('actionSeconds', 0.1, 3600, 1), {
                    min: 0.1,
                    max: 3600,
                    disabled: busy,
                });
                field(
                    line,
                    'Double progress (%)',
                    assumed.doubleChance * 100,
                    bounded('doubleChance', 0, 100, 1 / 100),
                    {
                        min: 0,
                        max: 100,
                        disabled: busy,
                    }
                );
                line.appendChild(panelNote(this.assumed[trial] ? 'edited' : assumed.source));
            }
            this.drawRoster(body, context, ui, busy);
        }

        const actions = row(body);
        button(
            actions,
            this.controller && !this.check ? 'Searching…' : 'Recommend sign-ups',
            () => this.recommend(),
            busy || !context.trials.length || context.capUnknown
        );
        button(actions, 'Check with simulator', () => this.checkWithSimulator(), busy || !this.result);
        if (this.controller) button(actions, 'Cancel', () => this.controller?.abort());
        if (this.status) body.appendChild(panelNote(this.status));
        if (this.error) {
            const note = panelNote(this.error);
            note.style.color = '#ffb0a9';
            note.setAttribute('role', 'alert');
            body.appendChild(note);
        }
        if (this.result) this.drawResult(body, ui);
    }

    drawRoster(body, context, ui, busy) {
        const { select } = ui;
        const label = (trial) => trialLabel(trial, context.clientData);
        const covered = context.members.filter((m) => context.trials.some((t) => m.coverage[t].kind !== 'missing'));
        const roster = panelCard(
            body,
            `Eligible members · ${context.members.length} · ${covered.length} with data`,
            ACCENT
        );
        roster.dataset.trialAssign = 'roster';
        roster.style.maxHeight = '300px';
        roster.style.overflowY = 'auto';
        roster.style.display = 'block';
        if (!context.hasRoster) {
            roster.appendChild(panelNote('The guild roster is not loaded yet. Open the guild panel.'));
            return;
        }
        roster.appendChild(
            panelNote(
                `Levels are base skill levels. R = your trial reading · L = level from their profile (yours from your character) · M = level typed here · <min = below the trial’s minimum · ?min = minimum unverified · — = no data. ${
                    context.hasSkills
                        ? 'Open members’ profiles (the trials tab’s profile cycler) to fill in levels.'
                        : 'Skill levels need the Guild Trials feature on (and profiles opened).'
                }`
            )
        );
        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
        const head = document.createElement('tr');
        for (const title of ['Member', 'Now', ...context.trials.map(label), 'Pin']) {
            const cell = document.createElement('th');
            cell.textContent = title;
            cell.style.textAlign = 'left';
            head.appendChild(cell);
        }
        table.appendChild(head);
        for (const member of context.members) {
            const tr = document.createElement('tr');
            tr.dataset.memberId = member.id;
            const name = document.createElement('td');
            name.textContent = member.name + (member.inCombat ? ' ⚔' : '');
            name.title = member.inCombat ? 'Signed up for a combat trial' : '';
            tr.appendChild(name);
            const now = document.createElement('td');
            now.textContent = member.current ? label(member.current) : '—';
            tr.appendChild(now);
            for (const trial of context.trials) {
                const cell = document.createElement('td');
                const coverage = member.coverage[trial];
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '1';
                input.max = '500';
                input.step = '1';
                input.disabled = busy || coverage.kind === 'reading';
                input.setAttribute('aria-label', `${member.name} ${label(trial)} level`);
                input.style.cssText =
                    'width:56px;background:#1b2030;color:#eee;border:1px solid #495268;border-radius:4px;padding:2px;';
                const typed = this.manual[member.id]?.[trial];
                input.value = typed ?? '';
                input.placeholder = coverage.level != null ? String(Math.round(coverage.level * 10) / 10) : '—';
                // The same 1–500 range memberRates scores; anything else is shown as not used
                const markRange = () => {
                    const raw = input.value;
                    const outOfRange = raw !== '' && !(Number(raw) >= 1 && Number(raw) <= 500);
                    input.style.borderColor = outOfRange ? '#ff6b6b' : '';
                    input.title = outOfRange ? 'Level must be between 1 and 500; this value is not used' : '';
                };
                markRange();
                input.addEventListener('input', () => {
                    markRange();
                    this.manual[member.id] = { ...(this.manual[member.id] || {}), [trial]: input.value };
                    this.edited();
                });
                const marker = document.createElement('span');
                marker.textContent = ` ${MARKERS[coverage.kind]}${coverage.minUnverified ? ' ?min' : ''}`;
                marker.dataset.coverage = coverage.kind;
                cell.append(input, marker);
                tr.appendChild(cell);
            }
            const pinCell = document.createElement('td');
            select(
                pinCell,
                '',
                member.pin,
                [['', 'Auto'], [BENCH_PIN, 'Not in skilling'], ...context.trials.map((trial) => [trial, label(trial)])],
                (value) => {
                    if (value) this.pins[member.id] = value;
                    else delete this.pins[member.id];
                    this.edited();
                },
                busy
            );
            tr.appendChild(pinCell);
            table.appendChild(tr);
        }
        roster.appendChild(table);
    }

    drawResult(body, ui) {
        const { button, row } = ui;
        const { result, context, unplaced, belowMinimum = [] } = this.result;
        const label = (trial) => trialLabel(trial, context.clientData);
        const format = (n, digits = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: digits });
        const card = panelCard(body, 'Recommended sign-ups', ACCENT);
        card.dataset.trialAssign = 'result';
        card.appendChild(
            panelLine(
                'Expected base points',
                `${format(result.totalPoints)} (current sign-ups: ${format(result.currentPoints)})`
            )
        );
        const trials = document.createElement('table');
        trials.style.cssText = 'width:100%;border-collapse:collapse;text-align:right;margin:6px 0;';
        const head = document.createElement('tr');
        for (const title of ['Trial', 'Sign-ups', 'Expected tier', 'Base points']) {
            const cell = document.createElement('th');
            cell.textContent = title;
            head.appendChild(cell);
        }
        trials.appendChild(head);
        for (const trial of result.trials) {
            const tr = document.createElement('tr');
            for (const text of [
                label(trial.trialHrid),
                `${trial.signups}/${trial.cap}`,
                `T${trial.nominalTiers} + ${format(trial.nominalProgress * 100)}%`,
                format(trial.points),
            ]) {
                const cell = document.createElement('td');
                cell.textContent = text;
                cell.style.padding = '2px 5px';
                tr.appendChild(cell);
            }
            trials.appendChild(tr);
        }
        card.appendChild(trials);

        const members = document.createElement('table');
        members.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';
        const mhead = document.createElement('tr');
        for (const title of ['Member', 'Trial', 'Adds (pts)', 'Change']) {
            const cell = document.createElement('th');
            cell.textContent = title;
            cell.style.textAlign = 'left';
            mhead.appendChild(cell);
        }
        members.appendChild(mhead);
        const placed = [...result.members].sort(
            (a, b) => (b.trialHrid ? 1 : 0) - (a.trialHrid ? 1 : 0) || b.marginalPoints - a.marginalPoints
        );
        for (const member of placed) {
            const tr = document.createElement('tr');
            let change =
                member.trialHrid === member.currentTrialHrid
                    ? 'unchanged'
                    : !member.currentTrialHrid
                      ? 'sign up'
                      : !member.trialHrid
                        ? `leave ${label(member.currentTrialHrid)}`
                        : `was ${label(member.currentTrialHrid)}`;
            if (!member.trialHrid)
                change += member.losesBonus ? ' — loses participation bonus unless in combat' : ' (stays in combat)';
            if (member.pinDropped) change += ' — pin dropped: trial full';
            for (const text of [
                member.name +
                    (belowMinimum.includes(member.name) ? ' (below minimum)' : member.pinned ? ' (pinned)' : ''),
                member.trialHrid ? label(member.trialHrid) : 'Not in skilling',
                member.trialHrid ? format(member.marginalPoints, 1) : '—',
                change,
            ]) {
                const cell = document.createElement('td');
                cell.textContent = text;
                cell.style.padding = '2px 5px';
                tr.appendChild(cell);
            }
            members.appendChild(tr);
        }
        card.appendChild(members);
        if (belowMinimum.length)
            card.appendChild(
                panelNote(
                    `${belowMinimum.join(', ')}: below the trial minimum: must change sign-up. Their level is under the minimum of the trial they signed up for, and no other drawn trial is open to them on known data.`
                )
            );
        if (unplaced)
            card.appendChild(
                panelNote(
                    `${unplaced} eligible members have no level or reading for any drawn trial and are not placed.`
                )
            );
        if (result.members.some((m) => m.trialHrid && m.hasRate === false))
            card.appendChild(
                panelNote('Members kept in a trial without data add to its pool but are counted as doing no work.')
            );

        if (result.moves.length) {
            const moves = panelCard(card, `Moves · ${result.moves.length}`, ACCENT);
            for (const move of result.moves.slice(0, 30)) {
                moves.appendChild(
                    panelNote(
                        `${move.name}: ${move.from ? label(move.from) : 'not signed up'} → ${move.to ? label(move.to) : 'not in skilling'}`
                    )
                );
            }
            if (result.moves.length > 30) moves.appendChild(panelNote(`…and ${result.moves.length - 30} more.`));
        }

        const groups = result.trials.map((trial) => ({
            label: label(trial.trialHrid),
            names: trial.memberIds.map((id) => result.members.find((m) => m.id === id)?.name).filter(Boolean),
        }));
        const messages = signupMessages(groups);
        const text = panelCard(card, 'Sign-up text for chat', ACCENT);
        for (const [i, message] of messages.entries()) {
            const area = document.createElement('textarea');
            area.readOnly = true;
            area.value = message;
            area.setAttribute('aria-label', `Sign-up message ${i + 1}`);
            area.style.cssText = 'width:100%;box-sizing:border-box;min-height:48px;background:#1b2030;color:#eee;';
            text.appendChild(area);
            button(row(text), messages.length > 1 ? `Copy message ${i + 1}` : 'Copy', () => copyText(message, area));
        }

        if (this.check) {
            const check = panelCard(card, 'Simulator check', ACCENT);
            check.dataset.trialAssign = 'check';
            for (const { trialHrid, summary } of this.check) {
                check.appendChild(
                    panelLine(
                        label(trialHrid),
                        `T${summary.lowHighestTier}–T${summary.highHighestTier} (P10–P90), median T${summary.medianHighestTier}, ${format(summary.meanBasePoints)} base points`
                    )
                );
            }
            check.appendChild(
                panelNote(
                    `${CHECK_RUNS} simulated runs per trial with the same inputs. The spread is action randomness, not how far off the inputs may be.`
                )
            );
        }
        card.appendChild(
            panelNote(
                'Expected values from a tier-by-tier walk at expected rates, averaged over ±10% rate changes. Members without a reading use the assumed efficiency and work time above, so their figures are estimates.'
            )
        );
    }
}
