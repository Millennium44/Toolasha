/**
 * The Trial Sim's "Assign skilling" view: a recommended skilling sign-up sheet for this cycle.
 *
 * Reads the cycle from what Toolasha already holds — drawn trials off the guild payload, the
 * roster, join times and sign-ups off the guild XP tracker, slot caps off the Skilling
 * Encampment, skill levels off profiles the player has opened — and hands them to
 * {@link optimizeTrialAssignmentAsync}. Nothing is sent and nobody is signed up; members sign
 * themselves up. The planner's edits live in memory with the rest of the simulator's setup and
 * are dropped on a character switch.
 *
 * The roster and skill levels live in the combat bundle and are read through the
 * `Toolasha.Combat` bridge at draw time; a missing bridge reads as "no roster".
 */
import dataManager from '../../core/data-manager.js';
import { panelCard, panelNote, panelLine } from '../../utils/simple-panel.js';
import { runGuildTrialSimulation } from './guild-trial-runner.js';
import { buildTrialGameData, memberFromSkillingReading } from './guild-trial-adapter.js';
import {
    ASSIGN_MODES,
    BENCH_PIN,
    TRIAL_SECONDS,
    optimizeTrialAssignmentAsync,
    rateInputFromLevel,
    signupMessages,
    skillingSlotCap,
} from './guild-trial-assign.js';
import { TRIAL_SKILLS, parseCurrentTrialsData } from '../guild/guild-trials-math.js';

const ACCENT = '#b9a6ff';

/** Skilling trials drawn per cycle */
export const SKILLING_TRIALS_PER_CYCLE = 4;

/** Inputs for members without a reading when no reading of any skill exists */
export const FALLBACK_ASSUMPTION = Object.freeze({ efficiency: 0, actionSeconds: 10, doubleChance: 0 });

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
 * The roster as the optimizer needs it.
 *
 * Eligibility is the game's rule: joined before the cycle started. A member whose join time or
 * the cycle start is unknown is kept, and the result says so.
 *
 * @param {Object} tracker - The guild XP tracker
 * @returns {{weekStartAt: string|null, members: Array<Object>, unknownJoin: number}}
 */
export function cycleRoster(tracker) {
    const weekStartAt = tracker?.getCurrentWeekStartAt?.() ?? null;
    const weekMs = Date.parse(weekStartAt);
    const members = [];
    let unknownJoin = 0;
    for (const entry of tracker?.getMemberList?.() || []) {
        const meta = tracker.getMemberMeta?.(entry.characterID) || entry;
        if (!meta?.name || entry.characterID == null) continue;
        const joinedMs = Date.parse(meta.joinTime);
        if (!Number.isFinite(joinedMs) || !Number.isFinite(weekMs)) unknownJoin++;
        else if (joinedMs >= weekMs) continue;
        const thisCycle = weekStartAt != null && meta.signupWeekStartAt === weekStartAt;
        members.push({
            id: String(entry.characterID),
            name: meta.name,
            current: thisCycle ? skillingTrialHrid(meta.signedUpSkillingTrialHrid) : null,
            inCombat: thisCycle && Boolean(meta.signedUpCombatTrialHrid),
        });
    }
    members.sort((a, b) => a.name.localeCompare(b.name));
    return { weekStartAt, members, unknownJoin };
}

/** Efficiency, time and double progress a reading states */
function assumptionFromReading(reading) {
    if (!reading) return null;
    const efficiency = Number(reading.efficiency);
    const seconds = Number(reading.actionTimeMs) / 1000;
    if (!Number.isFinite(efficiency) || !(seconds > 0)) return null;
    return { efficiency, actionSeconds: seconds, doubleChance: Number(reading.doubleProgressChance) || 0 };
}

/**
 * Per-trial inputs for members known only by level: the player's own reading of that trial,
 * else their latest reading of any trial, else {@link FALLBACK_ASSUMPTION}.
 *
 * @param {string[]} trials - Trial hrids
 * @param {Object<string, Object>} readings - trial hrid → latest `guild_skilling_updated` (with `at`)
 * @returns {Object<string, {efficiency: number, actionSeconds: number, doubleChance: number, source: string}>}
 */
export function defaultAssumptions(trials, readings = {}) {
    const latest = Object.values(readings || {})
        .filter((reading) => assumptionFromReading(reading))
        .sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    const out = {};
    for (const trial of trials) {
        const own = assumptionFromReading(readings?.[trial]);
        if (own) out[trial] = { ...own, source: 'your reading of this trial' };
        else if (latest) out[trial] = { ...assumptionFromReading(latest), source: 'your reading of another trial' };
        else out[trial] = { ...FALLBACK_ASSUMPTION, source: 'no reading: flat assumption' };
    }
    return out;
}

/**
 * One member's rate input per trial and where it came from.
 *
 * @returns {{rates: Object<string, Object|null>, coverage: Object<string, {kind: string, level: number|null}>}}
 *   `kind` is `reading`, `manual`, `level` or `missing`
 */
export function memberRates(
    member,
    trials,
    { ownId, readings, successReadings, manual, levelFor, assumed, clientData }
) {
    const rates = {};
    const coverage = {};
    for (const trial of trials) {
        const reading = member.id === ownId ? readings?.[trial] : null;
        const fromReading = reading
            ? memberFromSkillingReading(reading, member.name, Object.values(successReadings?.[trial] || {}))
            : null;
        const typed = Number(manual?.[trial]);
        const level = levelFor?.(member.name, trialSkillHrid(trial, clientData)) ?? null;
        if (fromReading) {
            rates[trial] = fromReading;
            coverage[trial] = { kind: 'reading', level: fromReading.effectiveLevel ?? null };
        } else if (manual?.[trial] !== '' && manual?.[trial] != null && Number.isFinite(typed)) {
            rates[trial] = rateInputFromLevel(typed, assumed[trial]);
            coverage[trial] = { kind: rates[trial] ? 'manual' : 'missing', level: typed };
        } else if (Number.isFinite(level)) {
            rates[trial] = rateInputFromLevel(level, assumed[trial]);
            coverage[trial] = { kind: rates[trial] ? 'level' : 'missing', level };
        } else {
            rates[trial] = null;
            coverage[trial] = { kind: 'missing', level: null };
        }
    }
    return { rates, coverage };
}

const MARKERS = { reading: 'R', manual: 'M', level: 'L', missing: '—' };

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

/** The bridge to the combat bundle's guild singletons */
function combatBridge() {
    return (typeof window !== 'undefined' && window.Toolasha?.Combat) || {};
}

export class TrialAssignPlanner {
    constructor(sim) {
        this.sim = sim;
        this.reset();
    }

    reset() {
        this.controller?.abort();
        this.controller = null;
        this.mode = ASSIGN_MODES.Bench;
        this.trialOverrides = null;
        this.cap = null;
        this.baseWork = 40000;
        this.seconds = TRIAL_SECONDS;
        this.assumed = {};
        this.pins = {};
        this.manual = {};
        this.weeklyTrialSet = null;
        this.result = null;
        this.check = null;
        this.error = '';
        this.status = '';
    }

    /** The cycle as currently known, with this planner's edits applied */
    context() {
        const clientData = dataManager.getInitClientData?.() || null;
        const characterData = dataManager.characterData || null;
        const bridge = combatBridge();
        const drawn = drawnSkillingTrials({ weeklyTrialSet: this.weeklyTrialSet, characterData });
        const trials = this.trialOverrides ?? drawn.trials;
        const roster = cycleRoster(bridge.guildXPTracker);
        const derivedCap = skillingSlotCap(clientData?.guildBuildingDetailMap, dataManager.guildBuildingLevelMap);
        const defaults = defaultAssumptions(trials, this.sim.readings);
        const assumed = {};
        for (const trial of trials) assumed[trial] = { ...defaults[trial], ...(this.assumed[trial] || {}) };
        const ownId = String(dataManager.getCurrentCharacterId?.() ?? '');
        const skills = bridge.guildMemberSkills;
        const levelFor = skills?.levelFor ? (name, skill) => skills.levelFor(name, skill) : null;
        const members = roster.members.map((member) => ({
            ...member,
            ...memberRates(member, trials, {
                ownId,
                readings: this.sim.readings,
                successReadings: this.sim.successReadings,
                manual: this.manual[member.id],
                levelFor,
                assumed,
                clientData,
            }),
        }));
        return {
            clientData,
            trials,
            drawnSource: this.trialOverrides ? 'chosen here' : drawn.source,
            weekStartAt: roster.weekStartAt,
            unknownJoin: roster.unknownJoin,
            cap: this.cap ?? derivedCap,
            derivedCap,
            assumed,
            members,
            hasRoster: Boolean(bridge.guildXPTracker),
            hasSkills: Boolean(levelFor),
        };
    }

    /** The optimizer's problem from a context */
    problem(context) {
        const members = [];
        let unplaced = 0;
        for (const member of context.members) {
            const anyRate = context.trials.some((trial) => member.rates[trial]);
            let pin = this.pins[member.id] || null;
            if (!anyRate && !pin) {
                // No data: keep a current sign-up (it still adds to the pool), otherwise leave them out
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
            const { problem, unplaced } = this.problem(context);
            if (!problem.members.length) throw new Error('No eligible member has a skill level or reading yet.');
            const result = await optimizeTrialAssignmentAsync(problem, { signal: controller.signal });
            if (!this.stillOwner(owner) || controller.signal.aborted) return;
            this.result = { result, unplaced, context, problem };
            this.status = '';
        } catch (error) {
            if (this.stillOwner(owner)) {
                this.error = error.message;
                this.status = '';
            }
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
                if (!this.stillOwner(owner) || controller.signal.aborted) return;
                this.check.push({ trialHrid: trial.trialHrid, summary });
            }
            this.status = '';
        } catch (error) {
            if (this.stillOwner(owner)) {
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
    }

    /**
     * Draw the view.
     * @param {HTMLElement} body - Panel body
     * @param {{button: Function, row: Function, field: Function, select: Function}} ui - The simulator's controls
     */
    draw(body, ui) {
        const { button, row, field, select } = ui;
        const busy = Boolean(this.controller);
        const context = this.context();
        const label = (trial) => trialLabel(trial, context.clientData);
        const rerender = () => this.sim.panel?.render();

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
                this.cap = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
                this.edited();
            },
            { min: 0, max: 100, step: 1, disabled: busy }
        );
        field(
            settings,
            'Tier 1 base work',
            this.baseWork,
            (value) => {
                this.baseWork = value;
                this.edited();
            },
            { min: 1, max: 1e9, disabled: busy }
        );
        if (this.mode === ASSIGN_MODES.Bench)
            setup.appendChild(
                panelNote(
                    'Anyone signed up for a combat trial still earns the weekly participation bonus, so leaving them out of skilling costs them no tokens.'
                )
            );
        setup.appendChild(
            panelNote(
                `Slots: ${context.derivedCap} from the Skilling Encampment. Base work 40,000 matches every recorded skilling pool (Milking, Alchemy, Cheesesmithing, Crafting).`
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

        if (context.trials.length) {
            const assumptions = panelCard(body, 'Members without a reading', ACCENT);
            assumptions.appendChild(
                panelNote(
                    'Work power is effective level × (1 + efficiency); only your own trial reading states efficiency and work time, so everyone else is given these. Effective level is the skill level from their profile — no consumables in trials.'
                )
            );
            for (const trial of context.trials) {
                const line = row(assumptions);
                const assumed = context.assumed[trial];
                const update = (key, value) => {
                    this.assumed[trial] = { ...(this.assumed[trial] || {}), [key]: value };
                    this.edited();
                };
                field(
                    line,
                    `${label(trial)} efficiency (%)`,
                    assumed.efficiency * 100,
                    (v) => update('efficiency', v / 100),
                    {
                        min: 0,
                        max: 1000,
                        disabled: busy,
                    }
                );
                field(line, 'Work time (s)', assumed.actionSeconds, (v) => update('actionSeconds', v), {
                    min: 0.1,
                    max: 3600,
                    disabled: busy,
                });
                field(line, 'Double progress (%)', assumed.doubleChance * 100, (v) => update('doubleChance', v / 100), {
                    min: 0,
                    max: 100,
                    disabled: busy,
                });
                line.appendChild(panelNote(this.assumed[trial] ? 'edited' : assumed.source));
            }
            this.drawRoster(body, context, ui, busy);
        }

        const actions = row(body);
        button(
            actions,
            this.controller && !this.check ? 'Searching…' : 'Recommend sign-ups',
            () => this.recommend(),
            busy || !context.trials.length
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
                `R = your trial reading · L = skill level from their profile · M = level typed here · — = no data. ${
                    context.hasSkills
                        ? 'Open members’ profiles (the trials tab’s profile cycler) to fill in levels.'
                        : 'Skill levels need the Guild Trials feature on.'
                }${context.unknownJoin ? ` ${context.unknownJoin} members’ join times are unknown and are treated as eligible.` : ''}`
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
                input.max = '1000';
                input.step = '1';
                input.disabled = busy || coverage.kind === 'reading';
                input.setAttribute('aria-label', `${member.name} ${label(trial)} level`);
                input.style.cssText =
                    'width:56px;background:#1b2030;color:#eee;border:1px solid #495268;border-radius:4px;padding:2px;';
                const typed = this.manual[member.id]?.[trial];
                input.value = typed ?? '';
                input.placeholder = coverage.level != null ? String(Math.round(coverage.level * 10) / 10) : '—';
                input.addEventListener('input', () => {
                    this.manual[member.id] = { ...(this.manual[member.id] || {}), [trial]: input.value };
                    this.edited();
                });
                const marker = document.createElement('span');
                marker.textContent = ` ${MARKERS[coverage.kind]}`;
                marker.dataset.coverage = coverage.kind;
                cell.append(input, marker);
                tr.appendChild(cell);
            }
            const pinCell = document.createElement('td');
            select(
                pinCell,
                '',
                this.pins[member.id] || '',
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
        const { result, context, unplaced } = this.result;
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
            const change =
                member.trialHrid === member.currentTrialHrid
                    ? 'unchanged'
                    : !member.currentTrialHrid
                      ? 'sign up'
                      : !member.trialHrid
                        ? `leave ${label(member.currentTrialHrid)}${member.inCombat ? ' (stays in combat)' : ''}`
                        : `was ${label(member.currentTrialHrid)}`;
            for (const text of [
                member.name + (member.pinned ? ' (pinned)' : ''),
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
