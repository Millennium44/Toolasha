/**
 * Labyrinth Room Logs
 *
 * What actually happened in each room, and — for fights — whether the sim was
 * right about it.
 *
 * Skilling and enhancing rooms announce every action they take, so their logs
 * are a direct transcript. Combat rooms announce nothing of the sort: the tile
 * badge quotes a clear chance computed before you walked in, the fight happens,
 * and then the tile is either cleared or it is not. Standing those two side by
 * side is the only way to find out whether the number was ever true.
 *
 * Two views, because they answer different questions. The room list is "how did
 * this run go" — grouped by floor, with what each floor cost and returned; the
 * accuracy view is "does the calculator know what it is talking about", which
 * needs every room ever recorded rather than the last few floors.
 *
 * Reached from a tab beside Lab Sim, which is up whether or not a run is in
 * progress: reviewing a run is something you do after it.
 *
 * Ported in part from dakonglong's MIT-licensed Labyrinth Clear Rate Calculator.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { classifyFight, fightTally, failureShape } from './labyrinth-fight-log.js';
import { accuracyReport } from './labyrinth-outcome-log.js';
import { formatKMB, timeReadable } from '../../utils/formatters.js';
import { ROOM_TRAVEL_SECONDS } from './labyrinth-formulas.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

/** Re-exported from labyrinth-formulas.js, where it now lives */
export { ROOM_TRAVEL_SECONDS };

/**
 * Where the room log lives.
 *
 * Scoped per character — a run is one character's run — and resolved at every
 * read and write, since the user switches characters without reloading. The
 * pre-scoping global log is adopted by the main character once.
 */
const STORAGE_KEY = 'labyrinthRoomLogs';
/** Used when the setting is unreadable; the setting itself is the real bound */
const DEFAULT_SESSIONS = 120;
/** However large the log is set, one room cannot fill it */
const MAX_ACTIONS = 60;
/** A room retried this many times has made its point */
const MAX_ATTEMPTS = 40;
const PANEL_ID = 'mwi-lab-logs-panel';
const TAB_ID = 'mwi-lab-logs-tab';

/**
 * Ticks arrive about three times a second and stop dead when the fight ends.
 * Nothing announces the ending, so this silence is the ending.
 */
const FIGHT_STALE_MS = 4000;

/**
 * How long a finished room stays open to experience still arriving for it.
 *
 * A room ends when the floor says the path moved on, and the experience it
 * earned is a separate message that need not have arrived by then. Sampling the
 * skill totals at the moment of finalizing therefore caught nothing at all: the
 * room was closed before it had been paid. The room stays claimable for a few
 * seconds, and only then goes into the long-term record.
 */
const XP_GRACE_MS = 4000;

const OUTCOME_COLORS = {
    success: '#3ddc84',
    fail: '#ff6464',
    double: '#ffcf5c',
    unknown: '#9ab0d8',
    clear: '#3ddc84',
    death: '#ff6464',
    timeout: '#ffa94d',
};

const VERDICT_COLORS = {
    'sim too high': '#ff8a8a',
    'sim too low': '#8ac6ff',
    consistent: '#8fe3b0',
    // Fights taking longer than simulated is the same kind of news as a clear
    // rate that is too optimistic, so it reads in the same colour
    'sim too fast': '#ff8a8a',
    'sim too slow': '#8ac6ff',
};

/**
 * Split a newest-first list of rooms into the floors they were run on.
 *
 * Grouped on consecutive runs of the same run-and-floor key rather than by
 * collecting every session with that key, so a floor revisited on a later run
 * reads as a second group instead of being silently merged into the first.
 *
 * @param {Array<Object>} sessions - Sessions, newest first
 * @returns {Array<{runKey: string, floor: number, sessions: Array<Object>}>}
 */
export function groupByFloor(sessions) {
    const groups = [];
    for (const session of sessions || []) {
        const runKey = String(session?.runKey || '');
        const last = groups[groups.length - 1];
        if (last && last.runKey === runKey) {
            last.sessions.push(session);
        } else {
            groups.push({ runKey, floor: Math.max(0, Math.floor(Number(session?.floor) || 0)), sessions: [session] });
        }
    }
    return groups;
}

/**
 * What a floor cost and what it returned.
 *
 * Experience per hour is measured over the rooms on the floor, not over the
 * whole floor's wall-clock: the time between rooms is spent reading the map and
 * deciding where to go, and charging that to the rooms would make a floor you
 * thought about look slower than the same floor rushed.
 *
 * The walk to each room is charged, though — `ROOM_TRAVEL_SECONDS` per finished
 * room, exactly what the forecast charges. The measured rate is here to be set
 * against the predicted one, and two rates over different denominators cannot
 * be compared: this one used to read about a second per room too fast, which on
 * a floor of ten-second skilling rooms is a tenth of the figure.
 *
 * `seconds` stays the time spent inside the rooms — it is displayed as such —
 * while `chargedSeconds` is what the rate divides by.
 *
 * @param {Array<Object>} sessions - The floor's rooms
 * @returns {{rooms: number, cleared: number, seconds: number, chargedSeconds: number,
 *   xp: number, xpPerHour: number|null}}
 */
export function floorSummary(sessions) {
    const list = sessions || [];
    let seconds = 0;
    let chargedSeconds = 0;
    let xp = 0;
    let cleared = 0;

    for (const session of list) {
        const ended = session?.endedAt || 0;
        // Only a finished room has a duration; one still running has not
        // taken its time yet — and has not been walked away from either, so
        // it is charged no travel
        if (ended > 0) {
            const inRoom = Math.max(0, (ended - (Number(session.startedAt) || 0)) / 1000);
            seconds += inRoom;
            chargedSeconds += inRoom + ROOM_TRAVEL_SECONDS;
        }
        xp += Math.max(0, Number(session?.xp) || 0);
        if (session?.completed) cleared++;
    }

    return {
        rooms: list.length,
        cleared,
        seconds,
        chargedSeconds,
        xp,
        xpPerHour: chargedSeconds > 0 && xp > 0 ? (xp / chargedSeconds) * 3600 : null,
    };
}

class LabyrinthRoomLogs {
    constructor() {
        this.isInitialized = false;
        this.sessions = [];
        this.activeSession = null;
        this.labContext = null; // { runKey, roomKey, room }
        this.roomData = null;
        this.progressHandler = null;
        this.labyrinthHandler = null;
        this.battleHandler = null;
        this.panel = null;
        this.view = 'rooms';
        this.simSource = null;
        this.fight = null;
        this.fightTimer = null;
        this.renderToken = 0;
        this.resetArmed = false;
        this.tabButton = null;
        this.unregisterTab = null;
        this.xpHandlers = [];
        this.xpBaseline = null;
        this.pendingReport = null;
        this.reportTimer = null;
        // Which room types are showing their levels. Closed to start with: the
        // record runs to a couple of hundred rooms, and the pooled reading is
        // the one worth reading first — the levels are what you open when it
        // says something.
        this.expandedSubjects = new Set();
        // Whether the accuracy view is showing everything or only what has
        // happened since the baseline was marked
        this.sinceBaseline = false;
    }

    /** How many rooms of history to keep */
    logSize() {
        const raw = Number(config.getSettingValue('labyrinthRoomLogSize', DEFAULT_SESSIONS));
        return Math.min(500, Math.max(20, Math.floor(raw) || DEFAULT_SESSIONS));
    }

    /**
     * Total experience across every skill, right now.
     *
     * Measured rather than derived. The calculator has a formula for what a
     * room is worth, but that formula is one of the things being checked here,
     * so reading it back would only confirm itself. Summing every skill also
     * picks up the experience a fight spreads over several of them.
     *
     * @returns {number|null} null when character data has not arrived
     */
    totalExperience() {
        const skills = dataManager.getSkills();
        if (!Array.isArray(skills)) return null;
        return skills.reduce((sum, skill) => sum + (Number(skill?.experience) || 0), 0);
    }

    /**
     * Credit experience that has just landed to the room that earned it.
     *
     * Differences against a rolling baseline rather than a snapshot taken per
     * room, because the two ends of a room are not the two ends of its payment.
     * Experience arriving while no room is open — outside the labyrinth, or in
     * the gap between rooms — still advances the baseline so it cannot be
     * mistaken for the next room's.
     */
    absorbExperience() {
        const total = this.totalExperience();
        if (!Number.isFinite(total)) return;
        if (!Number.isFinite(this.xpBaseline)) {
            this.xpBaseline = total;
            return;
        }

        const gained = total - this.xpBaseline;
        this.xpBaseline = total;
        if (gained <= 0) return;

        const pending = this.pendingReport;
        const target = this.activeSession || (pending && Date.now() - pending.endedAt < XP_GRACE_MS ? pending : null);
        if (!target) return;

        target.xp = Math.max(0, (Number(target.xp) || 0) + gained);
        this.persist();
        this.renderIfOpen();
    }

    /**
     * Accept the sim's predictions and its fight record.
     *
     * The clear-rate feature owns both — it runs the sims and keeps the tally of
     * how fights went — and it already imports this module to hang a button off
     * the labyrinth panel. Importing it back would close the loop, so it hands
     * over accessors instead and this module works without them.
     *
     * @param {Object} source - { predictedFor, accuracy, reset }
     */
    useSimSource(source) {
        this.simSource = source || null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('labyrinthRoomLogs')) return;
        this.isInitialized = true;

        const stored = await readScoped(STORAGE_KEY, 'settings', null, { migrate: 'adopt' });
        if (Array.isArray(stored?.sessions)) {
            this.sessions = stored.sessions.slice(0, this.logSize());
        }

        this.progressHandler = (data) => this.onRoomProgress(data);
        webSocketHook.on('labyrinth_room_progress', this.progressHandler);

        this.labyrinthHandler = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.labyrinthHandler);

        this.battleHandler = (data) => this.onBattleUpdated(data);
        webSocketHook.on('battle_updated', this.battleHandler);

        // Experience is credited by its own messages, on their own schedule.
        // Watching for it to land and attributing it to whichever room is open
        // works whichever message brings it and whether it turns up during the
        // room or a moment after it.
        this.xpBaseline = this.totalExperience();
        const absorb = () => this.absorbExperience();
        for (const type of ['action_completed', 'skills_updated', 'labyrinth_updated']) {
            webSocketHook.on(type, absorb);
            this.xpHandlers.push([type, absorb]);
        }

        this.unregisterTab = domObserver.onClass('LabyrinthRoomLogsTab', 'LabyrinthPanel_tabsComponentContainer', () =>
            this.ensureTabButton()
        );
        this.ensureTabButton();
        setTimeout(() => this.ensureTabButton(), 500);
    }

    disable() {
        if (this.progressHandler) {
            webSocketHook.off('labyrinth_room_progress', this.progressHandler);
            this.progressHandler = null;
        }
        if (this.labyrinthHandler) {
            webSocketHook.off('labyrinth_updated', this.labyrinthHandler);
            this.labyrinthHandler = null;
        }
        if (this.battleHandler) {
            webSocketHook.off('battle_updated', this.battleHandler);
            this.battleHandler = null;
        }
        for (const [type, handler] of this.xpHandlers) webSocketHook.off(type, handler);
        this.xpHandlers = [];
        this.flushReport();
        if (this.unregisterTab) {
            this.unregisterTab();
            this.unregisterTab = null;
        }
        this.resolveFight();
        this.finalizeActiveSession('feature_disabled');
        document.getElementById(TAB_ID)?.remove();
        this.tabButton = null;
        document.getElementById(PANEL_ID)?.remove();
        this.panel = null;
        this.labContext = null;
        this.roomData = null;
        // The log belongs to the character that walked those rooms. Dropped so
        // that a re-initialize — which is how a character switch arrives here —
        // reads the arriving character's log rather than persisting this one's
        // under their key.
        this.sessions = [];
        this.activeSession = null;
        this.isInitialized = false;
    }

    // -------------------------------------------------------------------------
    // Labyrinth context tracking
    // -------------------------------------------------------------------------

    onLabyrinthUpdated(data) {
        const labyrinth = data?.labyrinth;
        if (!labyrinth) {
            this.resolveFight();
            this.finalizeActiveSession('left_labyrinth');
            this.labContext = null;
            return;
        }

        // Held so a fight can ask, once it is over, whether the room it was in
        // ended up cleared. The last tick of a won fight usually still shows the
        // monster alive — the killing blow's update never arrives — so the floor
        // is the only reliable witness.
        if (labyrinth.roomData) this.roomData = labyrinth.roomData;

        const floor = Math.floor(Number(labyrinth.currentFloor) || 0);
        const runKey = `${labyrinth.startedAt || ''}|${floor}`;
        const path = this.parsePathData(labyrinth.pathData);
        const head = path?.[0];
        const roomKey = head && Number.isInteger(head.x) && Number.isInteger(head.y) ? `${head.x},${head.y}` : '';
        const room = roomKey ? labyrinth.roomData?.[head.y]?.[head.x] || null : null;

        this.labContext = { runKey, roomKey, room, floor };

        // Finalize the active session when the run or the current room changed
        if (this.activeSession && (this.activeSession.runKey !== runKey || this.activeSession.roomKey !== roomKey)) {
            this.resolveFight();
            this.finalizeActiveSession('room_switch');
        }
    }

    parsePathData(pathData) {
        if (Array.isArray(pathData)) return pathData;
        if (typeof pathData === 'string' && pathData) {
            try {
                const parsed = JSON.parse(pathData);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    }

    /**
     * Whether the header is showing a labyrinth fight. Read from the title
     * rather than from run state, following the battle counter: a labyrinth run
     * stays active while you fight regular zones, so the flags mislabel it.
     * @returns {boolean}
     */
    inLabyrinthFight() {
        const row = document.querySelector("div[class*='Header_actionName']");
        return !!row && /labyrinth/i.test(row.textContent || '');
    }

    // -------------------------------------------------------------------------
    // Session tracking
    // -------------------------------------------------------------------------

    onRoomProgress(progress) {
        if (!progress || typeof progress !== 'object') return;

        const snapshot = this.buildSnapshot(progress);
        if (!snapshot) return;

        const session = this.ensureSession(snapshot);
        if (!session) return;

        this.appendAction(session, snapshot);
        this.applySnapshot(session, snapshot);
        this.persist();
        this.renderIfOpen();
    }

    buildSnapshot(progress) {
        const isEnhancing = progress.targetLevel != null;
        const normalize = (v) => {
            const n = Number(v) || 0;
            if (n > 1 && n <= 100) return Math.min(1, n / 100);
            return Math.min(1, Math.max(0, n));
        };
        const targetWorkValue = Math.max(0, Number(progress.targetWorkValue) || 0);
        let currentWorkValue = Math.max(0, Number(progress.currentWorkValue) || 0);
        if (targetWorkValue > 0 && currentWorkValue <= 0) {
            const ratio = Math.min(1, Math.max(0, Number(progress.currentProgress) || 0));
            if (ratio > 0) currentWorkValue = targetWorkValue * ratio;
        }
        return {
            isEnhancing,
            actionCounter: Math.max(0, Math.floor(Number(progress.actionCounter) || 0)),
            successRate: normalize(progress.successRate),
            doubleChance: normalize(progress.doubleProgressChance),
            progressPerAction: Math.max(0, Number(progress.progressPerAction) || 0),
            targetWorkValue,
            currentWorkValue,
            targetLevel: Math.max(0, Math.floor(Number(progress.targetLevel) || 0)),
            currentEnhLevel: Math.max(0, Math.floor(Number(progress.currentEnhLevel) || 0)),
        };
    }

    /**
     * Close out whatever room was being logged, if this is a different one.
     * @param {string} sessionKey - Key of the room now being logged
     * @returns {Object|null} The active session when it is still the right one
     */
    reuseSession(sessionKey) {
        if (this.activeSession && this.activeSession.sessionKey !== sessionKey) {
            this.resolveFight();
            this.finalizeActiveSession('room_switch');
        }
        return this.activeSession;
    }

    ensureSession(snapshot) {
        const context = this.labContext || {};
        const mode = snapshot.isEnhancing ? 'enhancing' : 'skilling';
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|${mode}`;

        const existing = this.reuseSession(sessionKey);
        if (existing) return existing;

        const room = context.room || {};
        const skillHrid = String(room.skillHrid || '');
        const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            floor: Math.max(0, Math.floor(Number(context.floor) || 0)),
            mode,
            subjectHrid: skillHrid,
            skillName: this.prettySkillName(skillHrid, mode),
            roomLevel,
            forecast: this.forecastFor(skillHrid, roomLevel, 'skilling'),
            xp: 0,
            actionCount: 0,
            successCount: 0,
            doubleCount: 0,
            startedAt: Date.now(),
            endedAt: 0,
            successRate: snapshot.successRate,
            doubleChance: snapshot.doubleChance,
            progressPerAction: snapshot.progressPerAction,
            targetWorkValue: snapshot.targetWorkValue,
            currentWorkValue: snapshot.currentWorkValue,
            targetLevel: snapshot.targetLevel,
            currentEnhLevel: snapshot.currentEnhLevel,
            actions: [],
            lastSnapshot: snapshot,
            incomplete: snapshot.actionCounter > 0, // joined mid-room
            completed: false,
        };
        return this.activeSession;
    }

    prettySkillName(skillHrid, mode) {
        const tail = skillHrid.split('/').pop() || (mode === 'enhancing' ? 'enhancing' : 'skilling');
        return tail.charAt(0).toUpperCase() + tail.slice(1);
    }

    prettyMonsterName(monsterHrid) {
        const tail = String(monsterHrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ');
        return tail.replace(/\b\w/g, (c) => c.toUpperCase()) || 'Monster';
    }

    appendAction(session, snapshot) {
        const prev = session.lastSnapshot;
        const prevCounter = Math.max(0, Math.floor(Number(prev?.actionCounter) || 0));
        const nextCounter = snapshot.actionCounter;

        if (!prev || nextCounter <= prevCounter) return;

        if (nextCounter - prevCounter > 1) {
            session.incomplete = true;
            for (let c = prevCounter + 1; c < nextCounter; c++) {
                session.actions.push({ outcome: 'unknown', text: '?' });
            }
        }

        const action = this.deriveAction(prev, snapshot);
        // Counted here rather than from the drawn list, which is trimmed once a
        // room runs long — the rate has to survive the trimming
        session.actionCount = (session.actionCount || 0) + 1;
        if (action.outcome === 'success' || action.outcome === 'double') {
            session.successCount = (session.successCount || 0) + 1;
        }
        if (action.outcome === 'double') session.doubleCount = (session.doubleCount || 0) + 1;

        session.actions.push(action);
        if (session.actions.length > MAX_ACTIONS) {
            session.incomplete = true;
            session.actions = session.actions.slice(session.actions.length - MAX_ACTIONS);
        }
    }

    /**
     * Derive an action outcome by comparing consecutive progress snapshots
     */
    deriveAction(prev, next) {
        if (next.isEnhancing) {
            const levelDelta = next.currentEnhLevel - Math.max(0, Math.floor(Number(prev?.currentEnhLevel) || 0));
            let outcome = 'fail';
            if (levelDelta >= 2) outcome = 'double';
            else if (levelDelta >= 1) outcome = 'success';
            return { outcome, text: `+${next.currentEnhLevel}` };
        }

        const workDelta = next.currentWorkValue - Math.max(0, Number(prev?.currentWorkValue) || 0);
        const expectedSingle = Math.max(0, Number(prev?.progressPerAction) || 0);
        let outcome = 'fail';
        if (workDelta > 0.0001) {
            outcome = expectedSingle > 0 && workDelta >= expectedSingle * 1.8 ? 'double' : 'success';
        }
        const progressPct =
            next.targetWorkValue > 0 ? Math.min(100, (next.currentWorkValue / next.targetWorkValue) * 100) : 0;
        return { outcome, text: `${Math.round(progressPct)}%` };
    }

    applySnapshot(session, snapshot) {
        session.successRate = snapshot.successRate;
        session.doubleChance = snapshot.doubleChance;
        session.progressPerAction = snapshot.progressPerAction;
        session.targetWorkValue = snapshot.targetWorkValue;
        session.currentWorkValue = snapshot.currentWorkValue;
        session.targetLevel = snapshot.targetLevel;
        session.currentEnhLevel = snapshot.currentEnhLevel;
        session.lastSnapshot = snapshot;
    }

    // -------------------------------------------------------------------------
    // Combat rooms
    //
    // A fight has no progress messages to transcribe, so it is watched through
    // battle_updated — both sides' health, three times a second — and recorded
    // as one attempt per fight rather than one entry per swing. Individual
    // swings are noise; whether the room fell, and how close it came, is not.
    // -------------------------------------------------------------------------

    /**
     * Track a labyrinth fight for the room log.
     * @param {Object} data - battle_updated payload
     */
    onBattleUpdated(data) {
        const player = data?.pMap?.['0'];
        const monster = data?.mMap?.['0'];
        if (!player || !monster || !(monster.mHP > 0) || !(player.mHP > 0)) return;

        const context = this.labContext;
        const room = context?.room;
        if (!room?.monsterHrid || !this.inLabyrinthFight()) return;

        const session = this.ensureCombatSession(context, room);
        if (!session) return;

        const monsterHpFraction = monster.cHP / monster.mHP;
        const playerHpFraction = player.cHP / player.mHP;
        const atkCounter = Number(player.atkCounter) || 0;

        // battleId stays put across labyrinth attempts and a retry of the same
        // room brings back a monster with the same maximum, so neither says a
        // new fight started. Two things do: health that went up, which only a
        // fresh monster can do, and an attack counter that went down, which only
        // a fresh battle can do.
        const fight = this.fight;
        const isNewFight =
            !fight ||
            fight.session !== session ||
            fight.battleId !== data.battleId ||
            fight.monsterMaxHp !== monster.mHP ||
            monster.cHP > fight.lastMonsterHp ||
            atkCounter < fight.lastAtkCounter;

        if (isNewFight) {
            this.resolveFight(); // whatever was being watched has ended
            this.fight = {
                session,
                roomKey: session.roomKey,
                monsterHrid: session.monsterHrid,
                battleId: data.battleId,
                monsterMaxHp: monster.mHP,
                startedAt: Date.now(),
            };
        }

        Object.assign(this.fight, {
            lastMonsterHp: monster.cHP,
            lastAtkCounter: atkCounter,
            monsterHpFraction,
            playerHpFraction,
        });

        // The tile may not have been calculated when the room was entered, and
        // a prediction that arrives during the fight is still a prediction made
        // before the outcome was known
        if (session.predicted === null) {
            session.forecast = this.forecastFor(session.monsterHrid, session.roomLevel, 'combat');
            session.predicted = session.forecast?.clearChance ?? null;
        }
        session.entryCount = Math.max(session.entryCount || 0, Math.floor(Number(room.entryCount) || 0));

        if (this.fightTimer) clearTimeout(this.fightTimer);
        this.fightTimer = setTimeout(() => this.resolveFight(), FIGHT_STALE_MS);

        if (isNewFight) this.renderIfOpen();
    }

    /**
     * What the calculator claims about a room, captured on the way in.
     *
     * Taken once at the start rather than read when the room is drawn, because
     * the claim being checked is the one that was on screen when you decided to
     * walk in — not one recomputed later for gear you have since changed.
     *
     * @param {string} subjectHrid - Monster or skill
     * @param {number} roomLevel - Room level
     * @param {string} kind - 'combat' or 'skilling'
     * @returns {Object|null} Trimmed to the fields worth keeping
     */
    forecastFor(subjectHrid, roomLevel, kind) {
        try {
            const forecast = this.simSource?.forecast?.(subjectHrid, roomLevel, kind);
            if (!forecast) return null;
            const keep = (v) => (Number.isFinite(v) ? v : null);
            return {
                clearChance: keep(forecast.clearChance),
                expectedSeconds: Number.isFinite(forecast.expectedSeconds) ? forecast.expectedSeconds : null,
                successChance: keep(forecast.successChance),
                doubleChance: keep(forecast.doubleChance),
                xpPerRoom: keep(forecast.xpPerRoom),
                xpPerHour: keep(forecast.xpPerHour),
            };
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the room forecast failed:', error);
            return null;
        }
    }

    ensureCombatSession(context, room) {
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|combat`;

        const existing = this.reuseSession(sessionKey);
        if (existing) return existing;

        const monsterHrid = String(room.monsterHrid || '');
        const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        const forecast = this.forecastFor(monsterHrid, roomLevel, 'combat');
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            floor: Math.max(0, Math.floor(Number(context.floor) || 0)),
            mode: 'combat',
            monsterHrid,
            subjectHrid: monsterHrid,
            skillName: this.prettyMonsterName(monsterHrid),
            roomLevel,
            forecast,
            predicted: forecast && Number.isFinite(forecast.clearChance) ? forecast.clearChance : null,
            xp: 0,
            entryCount: Math.max(0, Math.floor(Number(room.entryCount) || 0)),
            startedAt: Date.now(),
            endedAt: 0,
            actions: [],
            cleared: false,
            incomplete: false,
            completed: false,
        };
        return this.activeSession;
    }

    /**
     * Whether the floor says a room was cleared.
     *
     * A cleared room is stripped of its monster, so demanding that the square
     * still name the fight you just had is demanding the one thing a won room
     * cannot do — it would answer "cannot say" for exactly the wins it is being
     * asked about. A square naming a *different* monster is a different room on
     * a floor that has moved on, and that one really is unanswerable.
     *
     * @param {string} roomKey - "x,y"
     * @param {string} monsterHrid - The monster that was there
     * @returns {boolean|undefined} undefined when the floor cannot say
     */
    roomCleared(roomKey, monsterHrid) {
        const [x, y] = String(roomKey || '')
            .split(',')
            .map(Number);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
        const room = this.roomData?.[y]?.[x];
        if (!room) return undefined;
        if (room.monsterHrid && room.monsterHrid !== monsterHrid) return undefined;
        return !!room.isCleared;
    }

    /** File the fight being watched as an attempt, whatever became of it */
    resolveFight() {
        const fight = this.fight;
        this.fight = null;
        if (this.fightTimer) {
            clearTimeout(this.fightTimer);
            this.fightTimer = null;
        }
        if (!fight) return;

        const session = fight.session;
        const attempt = classifyFight({
            monsterHpFraction: fight.monsterHpFraction,
            playerHpFraction: fight.playerHpFraction,
            seconds: (Date.now() - fight.startedAt) / 1000,
            cleared: this.roomCleared(fight.roomKey, fight.monsterHrid),
        });

        session.actions.push(attempt);
        if (session.actions.length > MAX_ATTEMPTS) {
            session.incomplete = true;
            session.actions = session.actions.slice(session.actions.length - MAX_ATTEMPTS);
        }
        if (attempt.outcome === 'clear') session.cleared = true;
        session.endedAt = Date.now();

        this.persist();
        this.renderIfOpen();
    }

    isSessionComplete(session) {
        if (session.mode === 'combat') {
            return !!session.cleared;
        }
        if (session.mode === 'enhancing') {
            return session.targetLevel > 0 && session.currentEnhLevel >= session.targetLevel;
        }
        if (session.targetWorkValue > 0) {
            return session.currentWorkValue >= session.targetWorkValue - 0.0001;
        }
        return false;
    }

    finalizeActiveSession(reason) {
        const session = this.activeSession;
        if (!session) return;
        this.activeSession = null;

        session.endedAt = Date.now();
        session.completed = this.isSessionComplete(session);
        if (!session.completed && reason !== 'room_complete') {
            session.incomplete = true;
        }
        delete session.lastSnapshot;

        // Held back rather than reported now: the experience this room earned
        // may not have been credited yet, and a record written before the
        // payment arrives is a record of a room that earned nothing
        this.flushReport();
        this.pendingReport = session;
        this.reportTimer = setTimeout(() => this.flushReport(), XP_GRACE_MS);

        this.sessions.unshift(session);
        this.sessions = this.sessions.slice(0, this.logSize());
        this.persist();
        this.renderIfOpen();
    }

    /** Report whichever room has been waiting for its experience, if any */
    flushReport() {
        if (this.reportTimer) {
            clearTimeout(this.reportTimer);
            this.reportTimer = null;
        }
        const session = this.pendingReport;
        this.pendingReport = null;
        if (session) this.reportRoomResult(session);
    }

    /**
     * Hand a finished room to the long-term record.
     *
     * Rooms you gave up on are reported too. A labyrinth room pays only when it
     * is completed, so an abandoned one is time spent for nothing — and dropping
     * it would raise the measured experience per hour every time you walked away
     * from a room. The record keeps its duration apart from the finished rooms'
     * so it cannot distort what a room takes to complete, which is a different
     * question.
     *
     * @param {Object} session - The finalized session
     */
    reportRoomResult(session) {
        if (!session.subjectHrid || !this.simSource?.record) return;

        const seconds = Math.max(0, (session.endedAt - session.startedAt) / 1000);
        const skilling = session.mode !== 'combat';

        // A combat room's only other signal is how long its fights ran. Clears
        // over attempts needs hundreds of fights to say anything and a room
        // gives you ten; fight length is measured on every attempt, win or
        // lose, and the sim already predicts it — so a model that has the fight
        // wrong shows up in a handful rather than in a season.
        const fights = skilling ? [] : session.actions || [];
        const fightSeconds = fights.reduce((sum, attempt) => sum + (Number(attempt.seconds) || 0), 0);
        const fightSquares = fights.reduce((sum, attempt) => sum + (Number(attempt.seconds) || 0) ** 2, 0);

        Promise.resolve(
            this.simSource.record({
                subjectHrid: session.subjectHrid,
                roomLevel: session.roomLevel,
                kind: skilling ? 'skilling' : 'combat',
                cleared: !!session.completed,
                seconds,
                xp: session.xp,
                actions: skilling ? session.actionCount : 0,
                successes: skilling ? session.successCount : 0,
                doubles: skilling ? session.doubleCount : 0,
                fights: fights.length,
                fightSeconds,
                fightSquares,
                predictedFightSeconds: session.forecast?.avgFightSeconds,
                predictedSeconds: session.forecast?.expectedSeconds,
                predictedSuccess: session.forecast?.successChance,
                predictedDouble: session.forecast?.doubleChance,
                // The server states the rates it is using with every action, so
                // the calculator's figure can be checked against the truth
                // rather than only against a sample of outcomes
                serverSuccess: skilling ? session.successRate : undefined,
                serverDouble: skilling ? session.doubleChance : undefined,
            })
        ).catch((error) => console.error('[LabyrinthRoomLogs] Recording a finished room failed:', error));
    }

    persist() {
        const sessions = this.sessions.map((session) => {
            const copy = { ...session };
            delete copy.lastSnapshot;
            return copy;
        });
        writeScoped(STORAGE_KEY, { sessions }, 'settings').catch((error) => {
            console.error('[LabyrinthRoomLogs] Failed to persist logs:', error);
        });
    }

    clearLogs() {
        this.sessions = [];
        this.activeSession = null;
        this.fight = null;
        this.persist();
        this.renderIfOpen();
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    /**
     * The labyrinth page's own tab bar, which is up whether or not a run is in
     * progress.
     *
     * The button used to live on the calculate bar inside a run, which put the
     * history of your last three floors behind having to be standing in a
     * fourth. Reviewing a run is something you do after it, so the way in has to
     * outlive it.
     *
     * @returns {HTMLElement|null}
     */
    findLabyrinthTabBar() {
        const container = document.querySelector('[class*="LabyrinthPanel_tabsComponentContainer"]');
        return container?.querySelector('[class*="TabsComponent_tabsContainer"] > div > div > div') || null;
    }

    /**
     * A tab beside Lab Sim that shows and hides the panel.
     *
     * Cloned from one of the game's own tabs so it sits in the row properly, and
     * marked with a ⧉ and dimmed while closed: a tab that does not change the
     * page when clicked, then does nothing visible when clicked again, reads as
     * broken. The glyph says it opens a panel, the dimming says whether that
     * panel is currently up. Same treatment as the Bulk Sell tab.
     */
    ensureTabButton() {
        const bar = this.findLabyrinthTabBar();
        if (!bar) {
            this.tabButton?.remove();
            this.tabButton = null;
            return;
        }
        if (this.tabButton && bar.contains(this.tabButton)) {
            this.keepAfterLabSim(bar);
            this.syncTabButton();
            return;
        }
        this.tabButton?.remove();

        const native = Array.from(bar.children).find(
            (el) => el.classList?.contains('MuiTab-root') && !el.classList.contains('toolasha-lab-sim-btn')
        );
        if (!native) return;

        const button = native.cloneNode(true);
        button.id = TAB_ID;
        button.title =
            'Room Logs — what happened in each room, and whether the calculator was right about it.\n\n' +
            'Rooms: the last runs grouped by floor, with time, clears and experience per hour for each.\n' +
            'Sim accuracy: every room ever recorded, set against the chance it was given.\n\n' +
            'Click to show or hide the panel.';
        const badge = button.querySelector('[class*="TabsComponent_badge"]');
        if (badge) {
            badge.innerHTML = '<div style="text-align: center;"><div>⧉ Room Logs</div></div>';
        } else {
            button.textContent = '⧉ Room Logs';
        }
        button.classList.remove('Mui-selected');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.togglePanel();
        });

        bar.appendChild(button);
        this.tabButton = button;
        this.keepAfterLabSim(bar);
        this.syncTabButton();
    }

    /** Lab Sim injects itself too and can land after us; stay on its right */
    keepAfterLabSim(bar) {
        const labSim = bar.querySelector('.toolasha-lab-sim-btn');
        if (labSim && labSim.nextElementSibling !== this.tabButton) labSim.after(this.tabButton);
    }

    syncTabButton() {
        if (!this.tabButton) return;
        const open = !!this.panel?.isConnected && this.panel.style.display !== 'none';
        this.tabButton.style.opacity = open ? '1' : '0.6';
    }

    togglePanel() {
        const panel = this.ensurePanel();
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            this.render();
        } else {
            panel.style.display = 'none';
        }
        this.syncTabButton();
    }

    ensurePanel() {
        if (this.panel && this.panel.isConnected) return this.panel;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText =
            'position:fixed; top:90px; right:14px; width:340px; max-height:60vh; display:none; flex-direction:column; ' +
            'border:1px solid rgba(128,170,255,0.5); border-radius:8px; background:rgba(10,14,22,0.97); color:#f2f7ff; ' +
            `box-shadow:0 10px 24px rgba(0,0,0,0.55); z-index:${config.Z_FLOATING_PANEL}; user-select:none;`;

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:8px 10px; flex-wrap:wrap; ' +
            'padding:8px 10px 6px; border-bottom:1px solid rgba(146,182,255,0.24); cursor:move;';

        const tabs = document.createElement('div');
        tabs.style.cssText = 'display:inline-flex; align-items:center; gap:4px;';
        this.tabButtons = {
            rooms: this.makeTab('Rooms', 'rooms'),
            accuracy: this.makeTab('Accuracy', 'accuracy'),
        };
        tabs.appendChild(this.tabButtons.rooms);
        tabs.appendChild(this.tabButtons.accuracy);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:inline-flex; align-items:center; flex-wrap:wrap; gap:4px 6px;';

        this.clearButton = document.createElement('button');
        this.clearButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.clearButton.addEventListener('click', () => this.onClearClicked());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText =
            'width:18px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:13px; line-height:1; cursor:pointer;';
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
            this.syncTabButton();
        });

        this.exportButton = document.createElement('button');
        this.exportButton.textContent = 'Export';
        this.exportButton.title = 'Copy the whole fight record as text, so it can be looked at somewhere else';
        this.exportButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.exportButton.addEventListener('click', () => this.exportAccuracy());

        this.recomputeButton = document.createElement('button');
        this.recomputeButton.textContent = 'Recompute';
        this.recomputeButton.title =
            'Throw away every cached clear-chance sim and simulate the rooms again. Use this after changing ' +
            'gear or a loadout — a plain equip does not always refresh a sim, so a cached result can be stale.';
        this.recomputeButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px; white-space:nowrap; flex-shrink:0;';
        this.recomputeButton.addEventListener('click', () => this.onRecomputeClicked());

        // A slow, timeout-heavy room (a hard combat tile) stops its sim on the
        // simulated-hours budget long before it pins the rate down, so its clear
        // chance reads "(capped)" with a wide band. With this on, Recompute lifts
        // that time cap and runs each room to its precision target — more precise,
        // but slower, so it is an opt-in toggle rather than the default.
        this.uncapped = false;
        this.uncappedButton = document.createElement('button');
        this.uncappedButton.textContent = 'Uncapped';
        this.uncappedButton.title =
            'Run Recompute with the sim’s time cap lifted, so slow rooms reach their precision target instead ' +
            'of stopping at a wide "(capped)" band. More precise but slower.';
        this.uncappedButton.addEventListener('click', () => {
            this.uncapped = !this.uncapped;
            this.paintUncapped();
        });

        actions.appendChild(this.uncappedButton);
        actions.appendChild(this.recomputeButton);
        actions.appendChild(this.exportButton);
        actions.appendChild(this.clearButton);
        actions.appendChild(closeBtn);
        header.appendChild(tabs);
        header.appendChild(actions);

        const list = document.createElement('div');
        list.className = 'mwi-lab-logs-list';
        list.style.cssText =
            'overflow-y:auto; display:flex; flex-direction:column; gap:6px; padding:8px; max-height:calc(60vh - 44px);';

        panel.appendChild(header);
        panel.appendChild(list);
        document.body.appendChild(panel);

        this.setupDrag(panel, header);
        this.panel = panel;
        this.paintChrome();
        return panel;
    }

    makeTab(label, view) {
        const button = document.createElement('button');
        button.textContent = label;
        button.addEventListener('click', () => {
            if (this.view === view) return;
            this.view = view;
            this.resetArmed = false;
            this.paintChrome();
            this.render(false);
        });
        return button;
    }

    /** Light the active tab and word the Clear button for what it would clear */
    paintChrome() {
        for (const [view, button] of Object.entries(this.tabButtons || {})) {
            const on = this.view === view;
            button.style.cssText =
                'height:18px; border:0; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; ' +
                'padding:0 7px; white-space:nowrap; flex-shrink:0; ' +
                (on
                    ? 'background:rgba(77,151,255,0.95); color:#fff;'
                    : 'background:rgba(255,255,255,0.1); color:#9ec4ff;');
        }
        if (!this.clearButton) return;

        const accuracy = this.view === 'accuracy';
        // Only the accuracy tab has a record worth exporting; the room log is
        // one run and is on screen already
        if (this.exportButton) this.exportButton.style.display = accuracy ? '' : 'none';
        this.clearButton.textContent = accuracy ? (this.resetArmed ? 'Sure?' : 'Reset') : 'Clear';
        this.clearButton.title = accuracy
            ? 'Throw away every recorded fight and start the accuracy record over'
            : 'Clear the room log';
        this.clearButton.style.background = this.resetArmed ? 'rgba(255,100,100,0.55)' : 'rgba(255,255,255,0.12)';
        this.paintUncapped();
    }

    /** Show whether an uncapped Recompute is armed */
    paintUncapped() {
        if (!this.uncappedButton) return;
        this.uncappedButton.style.cssText =
            'height:18px; border:0; border-radius:4px; font-size:10px; cursor:pointer; padding:0 6px; ' +
            'white-space:nowrap; flex-shrink:0; ' +
            (this.uncapped ? 'background:rgba(77,151,255,0.95); color:#fff;' : 'background:rgba(255,255,255,0.12); color:#9ec4ff;');
    }

    /**
     * Clear every cached clear-chance sim and simulate the rooms again.
     *
     * The heavy lifting lives in the clear-rate feature, reached through the sim
     * source; this only drives the button so a run in progress cannot be started
     * twice and says what it is doing while it runs.
     */
    async onRecomputeClicked() {
        const button = this.recomputeButton;
        if (!button || button.disabled) return;
        if (!this.simSource?.recompute) return;

        const label = button.textContent;
        button.disabled = true;
        button.textContent = this.uncapped ? 'Recomputing (uncapped)…' : 'Recomputing…';
        button.style.opacity = '0.6';
        try {
            await this.simSource.recompute(this.uncapped === true);
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Recomputing sims failed:', error);
        } finally {
            button.disabled = false;
            button.textContent = label;
            button.style.opacity = '';
            this.render();
        }
    }

    /**
     * Clearing the room log is cheap and clearing the fight record is not — it
     * is the only copy of every fight you have had — so the destructive one
     * takes two clicks.
     */
    onClearClicked() {
        if (this.view !== 'accuracy') {
            this.clearLogs();
            return;
        }
        if (!this.resetArmed) {
            this.resetArmed = true;
            this.paintChrome();
            return;
        }
        this.resetArmed = false;
        this.paintChrome();
        Promise.resolve(this.simSource?.reset?.())
            .then(() => this.render())
            .catch((error) => console.error('[LabyrinthRoomLogs] Clearing the fight record failed:', error));
    }

    setupDrag(panel, header) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        header.style.touchAction = 'none';

        const onPointerDown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            const onPointerMove = (moveEvent) => {
                panel.style.left = `${moveEvent.clientX - offsetX}px`;
                panel.style.top = `${moveEvent.clientY - offsetY}px`;
                panel.style.right = 'auto';
            };
            const onPointerUp = () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('pointercancel', onPointerUp);
            };
            // Attach document listeners only for the duration of the drag
            document.addEventListener('pointermove', onPointerMove);
            document.addEventListener('pointerup', onPointerUp);
            document.addEventListener('pointercancel', onPointerUp);
        };
        header.addEventListener('pointerdown', onPointerDown);
    }

    renderIfOpen() {
        if (this.panel && this.panel.isConnected && this.panel.style.display !== 'none') {
            this.render();
        }
    }

    /**
     * Redraw the open view, keeping the scroll position where it was.
     *
     * Both renderers empty the list and rebuild it, which resets the browser's
     * scroll to the top — and they run on every experience/labyrinth update, so
     * a panel left open while a fight ticks was yanked back to the top several
     * times a second and could not be read. The offset is saved before the wipe
     * and restored after (after the await, for the async accuracy view). A tab
     * switch is the one redraw that *should* start at the top, so it opts out.
     *
     * @param {boolean} [preserveScroll=true] - Keep the current scroll offset
     */
    render(preserveScroll = true) {
        const list = this.panel?.querySelector('.mwi-lab-logs-list');
        const top = preserveScroll && list ? list.scrollTop : 0;
        const restore = () => {
            if (!preserveScroll) return;
            const current = this.panel?.querySelector('.mwi-lab-logs-list');
            if (current) current.scrollTop = top;
        };

        if (this.view === 'accuracy') {
            this.renderAccuracy().then(restore).catch(restore);
        } else {
            this.renderPanel();
            restore();
        }
    }

    renderPanel() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;
        this.renderToken++;
        list.textContent = '';

        const sessions = (this.activeSession ? [this.activeSession, ...this.sessions] : this.sessions).slice(
            0,
            this.logSize()
        );
        if (!sessions.length) {
            list.appendChild(this.makeNote('No logs yet'));
            return;
        }

        // Grouped by floor because a floor is the unit a labyrinth run is
        // actually planned in — throughput over one room says far less than
        // throughput over the thirty of them you have to get through
        for (const group of groupByFloor(sessions)) {
            list.appendChild(this.renderFloorHeader(group));
            for (const session of group.sessions) list.appendChild(this.renderSessionCard(session));
        }
    }

    renderFloorHeader(group) {
        const summary = floorSummary(group.sessions);

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin-top:2px; ' +
            'padding:3px 2px 2px; border-bottom:1px solid rgba(146,182,255,0.25); font-size:11px;';

        const name = document.createElement('span');
        name.style.cssText = 'color:#9ec4ff; font-weight:700;';
        name.textContent = group.floor > 0 ? `Floor ${group.floor}` : 'Earlier rooms';
        header.appendChild(name);

        const stats = document.createElement('span');
        stats.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.85);';
        const parts = [`${summary.rooms} room${summary.rooms === 1 ? '' : 's'}`];
        if (summary.cleared < summary.rooms) parts.push(`${summary.cleared} cleared`);
        if (summary.seconds > 0) parts.push(timeReadable(Math.round(summary.seconds)));
        parts.push(summary.xpPerHour ? `${formatKMB(summary.xpPerHour)} xp/h` : 'xp not measured');
        stats.textContent = parts.join(' · ');
        header.appendChild(stats);

        header.title = [
            group.floor > 0 ? `Floor ${group.floor}` : 'Rooms logged before floors were recorded',
            `${summary.rooms} rooms logged, ${summary.cleared} of them cleared`,
            summary.seconds > 0 ? `${Math.round(summary.seconds)}s spent in them` : '',
            summary.xp > 0 ? `${Math.round(summary.xp).toLocaleString()} experience gained` : '',
            summary.xpPerHour
                ? 'Rate is measured experience over measured time, across every room on this floor, ' +
                  `plus ${ROOM_TRAVEL_SECONDS}s of travel per room — the same denominator the forecast uses, ` +
                  'so the two rates can be compared'
                : 'Experience is measured by the change in your skill totals, so rooms logged before that was recorded show none',
        ]
            .filter(Boolean)
            .join('\n');
        return header;
    }

    makeNote(text) {
        const note = document.createElement('div');
        note.style.cssText = 'font-size:11px; color:#9ab0d8; text-align:center; padding:8px; line-height:1.4;';
        note.textContent = text;
        return note;
    }

    renderSessionCard(session) {
        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.25); border-radius:5px; background:rgba(22,31,45,0.92); padding:6px 7px; font-size:11px; line-height:1.3;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; align-items:center; gap:6px; margin-bottom:3px; font-weight:700;';

        const name = document.createElement('span');
        name.textContent = session.roomLevel > 0 ? `${session.skillName} Lv.${session.roomLevel}` : session.skillName;
        header.appendChild(name);

        const endedAt = session.endedAt || Date.now();
        const seconds = Math.max(0, Math.round((endedAt - session.startedAt) / 1000));
        const time = document.createElement('span');
        time.style.cssText = 'opacity:0.8; font-weight:600;';
        time.textContent = `${seconds}s`;
        header.appendChild(time);

        if (session === this.activeSession) {
            header.appendChild(this.makeChip('Live', 'rgba(61,220,132,0.2)', '#3ddc84'));
        } else if (session.mode === 'combat' && session.cleared) {
            header.appendChild(this.makeChip('Cleared', 'rgba(61,220,132,0.2)', '#3ddc84'));
        } else if (session.incomplete || !session.completed) {
            header.appendChild(this.makeChip('Incomplete', 'rgba(244,124,71,0.22)', '#ffba92'));
        }
        card.appendChild(header);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.9); margin-bottom:3px;';
        if (session.mode === 'combat') {
            meta.textContent = this.combatMeta(session);
            card.title = this.combatTooltip(session).join('\n');
        } else if (session.mode === 'enhancing') {
            const successPct = (session.successRate * 100).toFixed(0);
            const doublePct = (session.doubleChance * 100).toFixed(0);
            meta.textContent = `Success ${successPct}% / Double ${doublePct}% | Enh +${session.currentEnhLevel}/+${session.targetLevel}`;
        } else {
            const successPct = (session.successRate * 100).toFixed(0);
            const doublePct = (session.doubleChance * 100).toFixed(0);
            const progressPct =
                session.targetWorkValue > 0
                    ? Math.min(100, (session.currentWorkValue / session.targetWorkValue) * 100).toFixed(0)
                    : '0';
            meta.textContent = `Success ${successPct}% / Double ${doublePct}% | Work ${Math.floor(session.progressPerAction)} | Progress ${progressPct}%`;
        }
        card.appendChild(meta);

        if (session.mode !== 'combat') {
            const check = this.skillingCheck(session);
            if (check) {
                const line = document.createElement('div');
                line.style.cssText = 'font-size:10px; color:#9ec4ff; margin-bottom:3px;';
                line.textContent = check;
                card.appendChild(line);
                card.title = this.skillingTooltip(session).join('\n');
            }
        }

        const actionsRow = document.createElement('div');
        actionsRow.style.cssText = 'display:flex; align-items:center; flex-wrap:wrap; gap:2px;';
        const actions = Array.isArray(session.actions) ? session.actions : [];
        if (!actions.length) {
            const dash = document.createElement('span');
            dash.style.color = OUTCOME_COLORS.unknown;
            dash.textContent = session.mode === 'combat' ? 'fighting…' : '--';
            actionsRow.appendChild(dash);
        }
        actions.forEach((action, index) => {
            if (index > 0) {
                const sep = document.createElement('span');
                sep.style.opacity = '0.5';
                sep.textContent = '-';
                actionsRow.appendChild(sep);
            }
            const node = document.createElement('span');
            node.style.cssText = `font-weight:700; color:${OUTCOME_COLORS[action.outcome] || OUTCOME_COLORS.unknown};`;
            node.textContent = action.text || '?';
            actionsRow.appendChild(node);
        });
        card.appendChild(actionsRow);

        return card;
    }

    /**
     * The skilling room's own results check: what the calculator predicted, what
     * actually happened, and what the room returned.
     *
     * Three numbers rather than two. The server states the rate it is using with
     * every action, so a skilling room can be checked twice over — the
     * calculator against the stated rate, which needs no sample at all, and the
     * stated rate against the actions, which does.
     *
     * @param {Object} session - A skilling or enhancing session
     * @returns {string} Empty when there is nothing to compare
     */
    skillingCheck(session) {
        const pct = (v) => `${Math.round(v * 100)}%`;
        const parts = [];

        const actions = Math.max(0, Math.floor(Number(session.actionCount) || 0));
        const predicted = session.forecast?.successChance;
        if (actions > 0) {
            const observed = (Number(session.successCount) || 0) / actions;
            parts.push(
                Number.isFinite(predicted)
                    ? `Calc ${pct(predicted)} → hit ${pct(observed)} of ${actions}`
                    : `Hit ${pct(observed)} of ${actions}`
            );
        }

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const expected = session.forecast?.expectedSeconds;
        if (session.completed && Number.isFinite(expected) && expected > 0) {
            parts.push(`${Math.round(seconds)}s vs ${Math.round(expected)}s est`);
        }

        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0 && seconds > 0) parts.push(`${formatKMB((xp / seconds) * 3600)} xp/h`);

        return parts.join(' | ');
    }

    skillingTooltip(session) {
        const pct = (v, places = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');
        const lines = [`${session.skillName} Lv.${session.roomLevel}`];

        const actions = Math.max(0, Math.floor(Number(session.actionCount) || 0));
        const forecast = session.forecast || {};
        if (Number.isFinite(forecast.successChance)) {
            lines.push(`Toolasha's formula predicted a ${pct(forecast.successChance)} success rate`);
        }
        if (Number.isFinite(session.successRate)) {
            lines.push(`The server says the rate is ${pct(session.successRate)}`);
        }
        if (
            Number.isFinite(forecast.successChance) &&
            Number.isFinite(session.successRate) &&
            Math.abs(forecast.successChance - session.successRate) > 0.005
        ) {
            lines.push('Those disagree, which is the formula being wrong rather than a run of bad luck');
        }
        if (actions > 0) {
            lines.push(`${session.successCount} of ${actions} actions succeeded, ${session.doubleCount} doubled`);
        }

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        if (Number.isFinite(forecast.expectedSeconds) && forecast.expectedSeconds > 0) {
            lines.push(`Expected to take ${Math.round(forecast.expectedSeconds)}s; took ${Math.round(seconds)}s`);
        }
        if (Number.isFinite(forecast.clearChance)) {
            lines.push(`Given a ${pct(forecast.clearChance)} chance of clearing inside the room's two minutes`);
        }

        const xp = Math.max(0, Number(session.xp) || 0);
        lines.push(
            xp > 0
                ? `Gained ${Math.round(xp).toLocaleString()} experience, measured from your skill totals`
                : 'No experience change was measured for this room'
        );
        return lines;
    }

    /** The one line under a fight's heading: what was promised against what happened */
    combatMeta(session) {
        const tally = fightTally(session.actions);
        const parts = [session.predicted === null ? 'Sim —' : `Sim ${(session.predicted * 100).toFixed(0)}%`];

        // Only fights watched on the combat view are classified (win/death/
        // timeout); the server's entryCount counts every attempt, including those
        // that ran while you were on another tab. Show the server total so a run
        // spent mostly off-screen does not read as if those attempts never
        // happened — with the watched subset named, since that is all the
        // died/timed-out breakdown can speak for.
        const serverAttempts = Math.floor(Number(session.entryCount) || 0);
        if (tally.total) {
            let result = `Won ${tally.clears}/${tally.total} (${Math.round(tally.rate * 100)}%)`;
            if (serverAttempts > tally.total) result += ` · ${serverAttempts} total`;
            parts.push(result);
        } else if (serverAttempts > 0) {
            parts.push(`${serverAttempts} attempt${serverAttempts === 1 ? '' : 's'}, none watched`);
        } else {
            parts.push('No result yet');
        }
        const shape = failureShape(tally);
        if (shape) parts.push(shape);

        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0 && seconds > 0) parts.push(`${formatKMB((xp / seconds) * 3600)} xp/h`);

        return parts.join(' | ');
    }

    combatTooltip(session) {
        const tally = fightTally(session.actions);
        const lines = [`${session.skillName} Lv.${session.roomLevel}`];

        lines.push(
            session.predicted === null
                ? 'No clear chance was simulated for this room — calculate its tile and the next fights get judged'
                : `The sim gave this room a ${(session.predicted * 100).toFixed(1)}% chance of clearing`
        );
        if (tally.total) {
            lines.push(`Logged ${tally.clears} clears in ${tally.total} attempts (${Math.round(tally.rate * 100)}%)`);
        }
        const shape = failureShape(tally);
        if (shape) lines.push(`Losing by: ${shape}`);
        if (tally.unknown) lines.push(`${tally.unknown} attempt(s) ended out of sight and are not counted`);
        if (session.entryCount > tally.total) {
            lines.push(
                `The server has counted ${session.entryCount} entries for this room, including earlier sessions`
            );
        }
        const seconds = Math.max(0, ((session.endedAt || Date.now()) - session.startedAt) / 1000);
        const xp = Math.max(0, Number(session.xp) || 0);
        if (xp > 0) {
            lines.push(
                `Gained ${Math.round(xp).toLocaleString()} experience over ${Math.round(seconds)}s in this room`
            );
            lines.push('Measured from your skill totals, so losing attempts count toward it as well as the win');
        }
        if (Number.isFinite(session.forecast?.xpPerHour) && session.forecast.xpPerHour > 0) {
            lines.push(`The sim expected ${formatKMB(session.forecast.xpPerHour)} experience per hour here`);
        }
        lines.push('Wins show how long they took; losses show the health the monster had left');
        return lines;
    }

    // -------------------------------------------------------------------------
    // Sim accuracy
    //
    // The room list covers one run. This covers every fight ever recorded,
    // because that is the only sample large enough to say anything: a room that
    // says 24% and loses three times running has said nothing, and the same
    // room losing twenty-one times running has said plenty.
    // -------------------------------------------------------------------------

    async renderAccuracy() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;

        const token = ++this.renderToken;
        list.textContent = '';

        if (!this.simSource?.accuracy) {
            list.appendChild(
                this.makeNote('The labyrinth clear rate feature is off, so no fights are being recorded.')
            );
            return;
        }

        let snapshot;
        try {
            snapshot = await this.simSource.accuracy({ since: this.sinceBaseline });
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the fight record failed:', error);
            list.appendChild(this.makeNote('Could not read the fight record.'));
            return;
        }
        // A slow read that lands after the user has moved on describes a view
        // that is no longer showing
        if (token !== this.renderToken || this.view !== 'accuracy') return;

        list.textContent = '';
        const { rows, summary } = snapshot;
        if (!rows.length) {
            list.appendChild(
                this.makeNote(
                    snapshot.since
                        ? 'Nothing recorded since the mark yet.'
                        : 'No labyrinth fights recorded yet. Fight some combat rooms and they will show up here.'
                )
            );
            // Still offered, or a view showing nothing would have no way back
            if (snapshot.baselineAt) list.appendChild(this.renderBaselineLine(snapshot));
            return;
        }

        this.lastAccuracy = snapshot;
        list.appendChild(this.renderAccuracySummary(summary, snapshot));

        // Each room type's pooled reading followed by its own levels, in the
        // game's order and by level within it. Every pooled row first and every
        // level after them read as two unrelated lists, and the levels were
        // ordered by how often each happened to be fought — which is no order
        // at all if you are looking for a particular room.
        const drawn = new Set();
        for (const group of snapshot.bySubject || []) {
            const levels = rows.filter((row) => row.subjectHrid === group.subjectHrid);
            levels.forEach((row) => drawn.add(row));

            list.appendChild(this.renderSubjectRow(group, levels.length));
            if (!this.expandedSubjects.has(group.subjectHrid)) continue;
            for (const row of levels) list.appendChild(this.renderAccuracyRow(row));
        }
        // Anything the pooling did not cover, rather than silently dropped
        for (const row of rows) if (!drawn.has(row)) list.appendChild(this.renderAccuracyRow(row));
    }

    /**
     * One room type, pooled across every level of it.
     *
     * Drawn above the per-level rows because it answers the question they
     * cannot: a level with nine fights is always "consistent", and nine levels
     * of that can still be a sim ten points high on every one of them.
     *
     * @param {Object} group - From `accuracyBySubject`
     * @param {number} levels - How many per-level rows it is hiding
     * @returns {HTMLElement}
     */
    renderSubjectRow(group, levels = 0) {
        const pct = (v, places = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');
        const open = this.expandedSubjects.has(group.subjectHrid);

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.18); border-left:3px solid rgba(146,182,255,0.5); ' +
            'border-radius:5px; background:rgba(18,26,38,0.92); padding:5px 7px; font-size:11px; ' +
            'line-height:1.35; cursor:pointer;';
        card.title = open ? 'Hide the levels of this room' : `Show the ${levels} level(s) behind this reading`;
        card.addEventListener('click', () => {
            if (open) this.expandedSubjects.delete(group.subjectHrid);
            else this.expandedSubjects.add(group.subjectHrid);
            this.render();
        });

        const header = document.createElement('div');
        header.style.cssText = 'display:flex; justify-content:space-between; gap:6px; font-weight:700;';
        const name = document.createElement('span');
        const caret = document.createElement('span');
        caret.textContent = open ? '−' : '+';
        caret.style.cssText = 'display:inline-block; width:10px; color:#9ec4ff;';
        name.append(caret, `${this.prettyMonsterName(group.subjectHrid)} — all levels`);
        const record = document.createElement('span');
        record.style.cssText = 'opacity:0.85;';
        record.textContent = `${group.clears}/${group.attempts}`;
        header.append(name, record);
        card.appendChild(header);

        const line = document.createElement('div');
        line.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
        const numbers = document.createElement('span');
        numbers.style.color = 'rgba(221,232,255,0.92)';
        if (group.judged > 0) {
            const sign = group.offBy >= 0 ? '+' : '';
            numbers.textContent =
                `Sim ${pct(group.predicted)} → actual ${pct(group.observed)} · ` +
                `${sign}${group.offBy.toFixed(1)} clears against ${group.expected.toFixed(1)} expected`;
        } else {
            numbers.textContent = `Never simmed — you clear ${pct(group.observed)}`;
        }
        line.appendChild(numbers);
        const colour = VERDICT_COLORS[group.verdict];
        if (colour) line.appendChild(this.makeChip(group.verdict, 'rgba(255,255,255,0.08)', colour));
        card.appendChild(line);

        const spread = document.createElement('div');
        spread.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
        spread.textContent =
            (group.lowestLevel === group.highestLevel
                ? `Lv.${group.lowestLevel} only`
                : `${group.levels} levels, Lv.${group.lowestLevel}–${group.highestLevel}`) +
            (open ? '' : ' — click to open');
        card.appendChild(spread);
        return card;
    }

    /**
     * Put the whole record on the clipboard.
     *
     * The record is the only thing that can say whether the model is wrong, and
     * it lives in one browser's IndexedDB where nobody can look at it. Text
     * rather than JSON because the point is that a person reads it.
     */
    async exportAccuracy() {
        const snapshot = this.lastAccuracy || (await this.simSource?.accuracy?.());
        if (!snapshot?.rows?.length) {
            this.flashExport('Nothing recorded yet');
            return;
        }

        const report = accuracyReport(snapshot, { name: (hrid) => this.prettyMonsterName(hrid) });
        try {
            await navigator.clipboard.writeText(report);
            this.flashExport('Copied ✓');
        } catch (error) {
            // A clipboard that refuses is not a reason to lose the report
            console.error('[LabyrinthRoomLogs] Copying the accuracy report failed:', error);
            console.log(report);
            this.flashExport('In console');
        }
    }

    /**
     * @param {string} text - What the button should say for a moment
     */
    flashExport(text) {
        if (!this.exportButton) return;
        this.exportButton.textContent = text;
        clearTimeout(this._exportFlash);
        this._exportFlash = setTimeout(() => {
            if (this.exportButton) this.exportButton.textContent = 'Export';
        }, 1600);
    }

    renderAccuracySummary(summary, snapshot = {}) {
        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.35); border-radius:5px; background:rgba(30,44,64,0.95); padding:6px 7px; ' +
            'font-size:11px; line-height:1.4;';

        const head = document.createElement('div');
        head.style.cssText = 'font-weight:700; color:#9ec4ff;';
        head.textContent = `${summary.attempts} fights over ${summary.buckets} monster/level rooms`;
        card.appendChild(head);

        const body = document.createElement('div');
        body.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.92);';
        if (summary.expected === null) {
            body.textContent = 'None of them have a simulated rate to compare against yet.';
        } else {
            const off = summary.judgedClears - summary.expected;
            const direction = off >= 0 ? 'above' : 'below';
            // With the spread beside it, because a shortfall of ten is a shrug
            // over one sample and a finding over another, and the figure alone
            // cannot say which
            const spread = summary.sd ? ` — ${Math.abs(summary.sigma).toFixed(1)} sd` : '';
            body.textContent =
                `Over the ${summary.judged} it had a rate for, the sim expected ${summary.expected.toFixed(1)} clears ` +
                `and you got ${summary.judgedClears} — ${Math.abs(off).toFixed(1)} ${direction}${spread}.`;
        }
        card.appendChild(body);

        if (summary.sd) {
            const scale = document.createElement('div');
            scale.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55);';
            scale.textContent =
                Math.abs(summary.sigma) < 2
                    ? 'Within what chance allows for — a record this size wanders by about ' +
                      `${summary.sd.toFixed(1)} clears on its own.`
                    : 'Further out than chance comfortably explains — a record this size wanders by about ' +
                      `${summary.sd.toFixed(1)} clears on its own.`;
            card.appendChild(scale);
        }

        card.appendChild(this.renderBaselineLine(snapshot));

        if (summary.contested > 0) {
            const flag = document.createElement('div');
            const chance = summary.contestedByChance;
            // A 95% interval is wrong one room in twenty by construction, so a
            // raw count of contradictions is not a finding until it is set
            // against the number this record would throw up anyway
            const alarming = chance === null || summary.contested > chance * 2;
            flag.style.cssText = `font-size:10px; font-weight:700; color:${alarming ? '#ff8a8a' : 'rgba(221,232,255,0.7)'};`;
            flag.textContent =
                `${summary.contested} room${summary.contested === 1 ? '' : 's'} the record contradicts` +
                (chance === null ? '' : ` — about ${chance.toFixed(1)} would be flagged by chance alone`);
            card.appendChild(flag);
        }
        return card;
    }

    /**
     * Marking a point to measure from, and switching between the two views.
     *
     * In the summary card rather than the header because it is a thing you do
     * once and then read, and the header already carries Export, Reset and the
     * tabs. Reset is left where it is — it answers a different question, which
     * is "throw this away", and sometimes that is the one being asked.
     *
     * @param {Object} snapshot - `{ baselineAt, since }`
     * @returns {HTMLElement}
     */
    renderBaselineLine(snapshot) {
        const line = document.createElement('div');
        line.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.55); margin-top:2px;';

        const act = (text, onClick, title) => {
            const button = document.createElement('span');
            button.textContent = text;
            button.title = title;
            button.style.cssText = 'color:#9ec4ff; cursor:pointer; text-decoration:underline dotted;';
            button.addEventListener('click', onClick);
            return button;
        };

        if (!snapshot.baselineAt) {
            line.append(
                'Everything ever recorded · ',
                act(
                    'mark a point to measure from',
                    () => this.markBaseline(),
                    'Keeps the whole record and lets you read only what has happened since — which is what ' +
                        'Reset was being used for, without losing anything'
                )
            );
            return line;
        }

        const when = new Date(snapshot.baselineAt).toLocaleDateString();
        line.append(
            snapshot.since ? `Since ${when} · ` : `Everything ever recorded · marked ${when} · `,
            act(
                snapshot.since ? 'show everything' : 'show only since then',
                () => {
                    this.sinceBaseline = !this.sinceBaseline;
                    this.render();
                },
                'Switch between the whole record and the period since the mark'
            ),
            ' · ',
            act('re-mark', () => this.markBaseline(), 'Move the mark to now'),
            ' · ',
            act(
                'forget the mark',
                () => {
                    Promise.resolve(this.simSource?.clearBaseline?.())
                        .then(() => {
                            this.sinceBaseline = false;
                            this.render();
                        })
                        .catch((error) => console.error('[LabyrinthRoomLogs] Forgetting the mark failed:', error));
                },
                'The record itself is untouched either way'
            )
        );
        return line;
    }

    /** Mark now as the point to measure from, and show the period since */
    markBaseline() {
        Promise.resolve(this.simSource?.markBaseline?.())
            .then(() => {
                this.sinceBaseline = true;
                this.render();
            })
            .catch((error) => console.error('[LabyrinthRoomLogs] Marking a baseline failed:', error));
    }

    renderAccuracyRow(row) {
        const pct = (v, places = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.25); border-radius:5px; background:rgba(22,31,45,0.92); ' +
            'padding:6px 7px; font-size:11px; line-height:1.35; margin-left:10px;';

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:6px; font-weight:700;';
        const name = document.createElement('span');
        name.textContent = `${this.prettyMonsterName(row.subjectHrid)} Lv.${row.level}`;
        const record = document.createElement('span');
        record.style.cssText = 'opacity:0.85;';
        record.textContent = `${row.clears}/${row.attempts}`;
        header.appendChild(name);
        header.appendChild(record);
        card.appendChild(header);

        const line = document.createElement('div');
        line.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
        const numbers = document.createElement('span');
        numbers.style.color = 'rgba(221,232,255,0.92)';
        numbers.textContent =
            row.predicted === null
                ? `Never simmed — you clear ${pct(row.observed)} (${pct(row.low)}–${pct(row.high)})`
                : `Sim ${pct(row.predicted)} → actual ${pct(row.observed)} (${pct(row.low)}–${pct(row.high)})`;
        line.appendChild(numbers);

        const colour = VERDICT_COLORS[row.verdict];
        if (colour) {
            line.appendChild(this.makeChip(row.verdict, 'rgba(255,255,255,0.08)', colour));
        }
        if (row.likelihood !== null && row.likelihood < 0.05) {
            const odds = document.createElement('span');
            odds.style.cssText = 'color:#ffba92; font-weight:700;';
            odds.textContent = `p=${(row.likelihood * 100).toFixed(row.likelihood < 0.001 ? 3 : 2)}%`;
            line.appendChild(odds);
        }
        card.appendChild(line);

        const rates = row.rates?.success;
        if (rates) {
            const actionLine = document.createElement('div');
            actionLine.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
            const text = document.createElement('span');
            text.style.color = 'rgba(221,232,255,0.8)';
            // Per room rather than per action, where there is one. A skilling
            // room ends the moment you clear it, so pooling every action across
            // rooms weights the rooms that went badly and reads several points
            // low for no reason but the stopping rule.
            const over = rates.rooms ? `over ${rates.rooms} room${rates.rooms === 1 ? '' : 's'}` : `of ${rates.trials}`;
            text.textContent =
                `Success — calc ${pct(rates.predicted)}, server ${pct(rates.server)}, ` +
                `seen ${pct(rates.observed)} ${over}`;
            actionLine.appendChild(text);
            // A formula that disagrees with the rate the server states is wrong
            // outright, which no amount of play will fix or reveal
            if (rates.formulaOff) {
                actionLine.appendChild(this.makeChip('formula off', 'rgba(255,255,255,0.08)', '#ff8a8a'));
            }
            card.appendChild(actionLine);
        }

        // A combat room's per-fight reading, which is the only thing that can
        // say anything about it before hundreds of fights have gone by
        if (row.fightLength) {
            const fl = row.fightLength;
            const fightLine = document.createElement('div');
            fightLine.style.cssText = 'display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:10px;';
            const text = document.createElement('span');
            text.style.color = 'rgba(221,232,255,0.8)';
            text.textContent =
                `Fight — sim ${Math.round(fl.predicted)}s, ran ${Math.round(fl.actual)}s ` +
                `over ${fl.fights} fight${fl.fights === 1 ? '' : 's'}`;
            fightLine.appendChild(text);
            const colour = VERDICT_COLORS[fl.verdict];
            if (colour) fightLine.appendChild(this.makeChip(fl.verdict, 'rgba(255,255,255,0.08)', colour));
            card.appendChild(fightLine);
        }

        const throughput = [];
        if (row.timing)
            throughput.push(`${Math.round(row.timing.actual)}s vs ${Math.round(row.timing.predicted)}s est per clear`);
        if (row.measured?.xpPerHour) throughput.push(`${formatKMB(row.measured.xpPerHour)} xp/h`);
        if (row.measured?.rooms) throughput.push(`${row.measured.rooms} finished`);
        if (throughput.length) {
            const timingLine = document.createElement('div');
            timingLine.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.65);';
            timingLine.textContent = throughput.join(' · ');
            card.appendChild(timingLine);
        }

        card.title = this.accuracyTooltip(row, pct).join('\n');
        return card;
    }

    /** The extra lines a room with finished runs behind it earns */
    throughputTooltip(row, pct) {
        const lines = [];
        if (row.rates?.success) {
            const { predicted, server, observed, pooled, rooms, low, high, formulaOff } = row.rates.success;
            const band = low === null ? '' : ` (${pct(low, 0)}–${pct(high, 0)})`;
            lines.push(
                `Success rate — Toolasha's formula says ${pct(predicted, 1)}, the server says ${pct(server, 1)}, ` +
                    (rooms
                        ? `and the mean across ${rooms} room(s) was ${pct(observed, 1)}${band}`
                        : `and ${pct(observed, 1)} of ${row.measured.actions} actions succeeded${band}`)
            );
            if (rooms && Number.isFinite(pooled) && Math.abs(pooled - observed) > 0.01) {
                lines.push(
                    `Pooled over all ${row.measured.actions} actions it reads ${pct(pooled, 1)}. A room ends the ` +
                        'moment you clear it, so a lucky room contributes few actions and an unlucky one contributes ' +
                        'the full budget — the pool is mostly made of unlucky rooms, and the gap between the two ' +
                        'figures is the size of that effect rather than anything the model got wrong'
                );
            }

            const dbl = row.rates.double;
            if (dbl && Number.isFinite(dbl.server)) {
                lines.push(
                    `Double rate — the server says ${pct(dbl.server, 1)}, and ${pct(dbl.observed, 1)} of your ` +
                        `${row.measured.successCount} successful actions doubled. Doubles roll on a success, not on ` +
                        'every action, which is why this is counted against successes'
                );
            }
            if (formulaOff) {
                lines.push(
                    'The formula and the server disagree, which is a bug rather than variance — the server states the ' +
                        'rate it is actually using, so no amount of play will bring the two together'
                );
            }
        }
        if (row.fightLength) {
            const fl = row.fightLength;
            const band = fl.low === null ? '' : ` (${Math.round(fl.low)}–${Math.round(fl.high)}s)`;
            lines.push(
                `A fight ran ${Math.round(fl.actual)}s on average over ${fl.fights} attempt(s)${band}, against ` +
                    `${Math.round(fl.predicted)}s simulated — ${fl.ratio.toFixed(2)}x. Every attempt counts here, ` +
                    "won or lost, and the sim's figure is the same kind of average, so this needs far fewer fights " +
                    'than a clear rate does before it can say anything'
            );
        }
        if (row.timing) {
            lines.push(
                `A clear cost ${Math.round(row.timing.actual)}s — every second of the ${row.timing.visits} visit(s) ` +
                    `to this room, ${Math.round(row.timing.seconds)}s in all, over the ${row.timing.clears} clear(s) ` +
                    `they bought. The calculator expects ${Math.round(row.timing.predicted)}s, which is also a ` +
                    `figure per clear and includes the attempts you lose — ${row.timing.ratio.toFixed(2)}x`
            );
            if (row.timing.perFinishedVisit) {
                lines.push(
                    `A visit that ended in a clear took ${Math.round(row.timing.perFinishedVisit)}s of that. The gap ` +
                        'between the two figures is the time this room has cost you in attempts that came to nothing'
                );
            }
        }
        if (row.measured?.xpPerHour) {
            lines.push(
                `${formatKMB(row.measured.xpPerHour)} experience per hour, measured from your skill totals over the ` +
                    'time actually spent in this room'
            );
        }
        return lines;
    }

    accuracyTooltip(row, pct) {
        const lines = [`${this.prettyMonsterName(row.subjectHrid)} at room level ${row.level} (${row.kind})`];
        lines.push(`${row.clears} clears in ${row.attempts} attempts — ${pct(row.observed, 1)}`);
        lines.push(`A record this size puts the true rate between ${pct(row.low, 1)} and ${pct(row.high, 1)}`);

        if (row.predicted === null) {
            lines.push('No forecast on record for this room, so its clear rate has nothing to be judged against.');
            lines.push('Calculate its tile once and the prediction is stamped on the next attempts.');
            return [...lines, ...this.throughputTooltip(row, pct)];
        }

        lines.push(
            `The sim says ${pct(row.predicted, 1)}${row.fromCache ? ' (from the sim run this session)' : ' (recorded when the fights happened)'}`
        );
        if (row.verdict === 'consistent') {
            lines.push('That sits inside the range these fights support, so the record does not contradict it.');
        } else {
            lines.push(`That sits outside the range these fights support: ${row.verdict}.`);
        }
        if (row.likelihood !== null) {
            const oneIn = row.likelihood > 0 ? Math.round(1 / row.likelihood) : Infinity;
            lines.push(
                `If the sim's rate were right, a record at least this lopsided would happen ${pct(row.likelihood, 2)} ` +
                    `of the time — about 1 run in ${Number.isFinite(oneIn) ? oneIn : 'a great many'}.`
            );
        }
        return [...lines, ...this.throughputTooltip(row, pct)];
    }

    makeChip(text, background, color) {
        const chip = document.createElement('span');
        chip.style.cssText = `display:inline-flex; border-radius:999px; padding:0 6px; background:${background}; color:${color}; font-size:10px; font-weight:700;`;
        chip.textContent = text;
        return chip;
    }
}

const labyrinthRoomLogs = new LabyrinthRoomLogs();

/** The singleton itself, for tests — the default export is the feature shell */
export { labyrinthRoomLogs };

export default {
    name: 'Labyrinth Room Logs',
    initialize: () => labyrinthRoomLogs.initialize(),
    disable: () => labyrinthRoomLogs.disable(),
    togglePanel: () => labyrinthRoomLogs.togglePanel(),
    useSimSource: (source) => labyrinthRoomLogs.useSimSource(source),
};
