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
 * this run go"; the accuracy view is "does the sim know what it is talking
 * about", which needs every fight ever recorded rather than the last thirty
 * rooms.
 *
 * Ported in part from dakonglong's MIT-licensed Labyrinth Clear Rate Calculator.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { classifyFight, fightTally, failureShape } from './labyrinth-fight-log.js';

const STORAGE_KEY = 'labyrinthRoomLogs';
const MAX_SESSIONS = 30;
const MAX_ACTIONS = 60;
/** A room retried this many times has made its point */
const MAX_ATTEMPTS = 40;
const PANEL_ID = 'mwi-lab-logs-panel';

/**
 * Ticks arrive about three times a second and stop dead when the fight ends.
 * Nothing announces the ending, so this silence is the ending.
 */
const FIGHT_STALE_MS = 4000;

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
};

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

        const stored = await storage.getJSON(STORAGE_KEY, 'settings', null);
        if (Array.isArray(stored?.sessions)) {
            this.sessions = stored.sessions.slice(0, MAX_SESSIONS);
        }

        this.progressHandler = (data) => this.onRoomProgress(data);
        webSocketHook.on('labyrinth_room_progress', this.progressHandler);

        this.labyrinthHandler = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.labyrinthHandler);

        this.battleHandler = (data) => this.onBattleUpdated(data);
        webSocketHook.on('battle_updated', this.battleHandler);
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
        this.resolveFight();
        this.finalizeActiveSession('feature_disabled');
        document.getElementById(PANEL_ID)?.remove();
        this.panel = null;
        this.labContext = null;
        this.roomData = null;
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

        const runKey = `${labyrinth.startedAt || ''}|${Math.floor(Number(labyrinth.currentFloor) || 0)}`;
        const path = this.parsePathData(labyrinth.pathData);
        const head = path?.[0];
        const roomKey = head && Number.isInteger(head.x) && Number.isInteger(head.y) ? `${head.x},${head.y}` : '';
        const room = roomKey ? labyrinth.roomData?.[head.y]?.[head.x] || null : null;

        this.labContext = { runKey, roomKey, room };

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
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            mode,
            skillName: this.prettySkillName(skillHrid, mode),
            roomLevel: Math.max(0, Math.floor(Number(room.recommendedLevel) || 0)),
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

        session.actions.push(this.deriveAction(prev, snapshot));
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
            session.predicted = this.predictionFor(session.monsterHrid, session.roomLevel);
        }
        session.entryCount = Math.max(session.entryCount || 0, Math.floor(Number(room.entryCount) || 0));

        if (this.fightTimer) clearTimeout(this.fightTimer);
        this.fightTimer = setTimeout(() => this.resolveFight(), FIGHT_STALE_MS);

        if (isNewFight) this.renderIfOpen();
    }

    /** The sim's claim for a room, or null when it has not made one */
    predictionFor(monsterHrid, roomLevel) {
        try {
            const rate = this.simSource?.predictedFor?.(monsterHrid, roomLevel);
            return Number.isFinite(rate) ? rate : null;
        } catch (error) {
            console.error('[LabyrinthRoomLogs] Reading the predicted clear chance failed:', error);
            return null;
        }
    }

    ensureCombatSession(context, room) {
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|combat`;

        const existing = this.reuseSession(sessionKey);
        if (existing) return existing;

        const monsterHrid = String(room.monsterHrid || '');
        const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        this.activeSession = {
            id: `lab-log-${Date.now()}`,
            sessionKey,
            runKey: String(context.runKey || ''),
            roomKey: String(context.roomKey || ''),
            mode: 'combat',
            monsterHrid,
            skillName: this.prettyMonsterName(monsterHrid),
            roomLevel,
            predicted: this.predictionFor(monsterHrid, roomLevel),
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

        this.sessions.unshift(session);
        this.sessions = this.sessions.slice(0, MAX_SESSIONS);
        this.persist();
        this.renderIfOpen();
    }

    persist() {
        const sessions = this.sessions.map((session) => {
            const copy = { ...session };
            delete copy.lastSnapshot;
            return copy;
        });
        storage.setJSON(STORAGE_KEY, { sessions }, 'settings').catch((error) => {
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

    togglePanel() {
        const panel = this.ensurePanel();
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            this.render();
        } else {
            panel.style.display = 'none';
        }
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
            'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px 6px; ' +
            'border-bottom:1px solid rgba(146,182,255,0.24); cursor:move;';

        const tabs = document.createElement('div');
        tabs.style.cssText = 'display:inline-flex; align-items:center; gap:4px;';
        this.tabButtons = {
            rooms: this.makeTab(`Rooms (${MAX_SESSIONS})`, 'rooms'),
            accuracy: this.makeTab('Sim accuracy', 'accuracy'),
        };
        tabs.appendChild(this.tabButtons.rooms);
        tabs.appendChild(this.tabButtons.accuracy);

        const actions = document.createElement('div');
        actions.style.cssText = 'display:inline-flex; align-items:center; gap:6px;';

        this.clearButton = document.createElement('button');
        this.clearButton.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px;';
        this.clearButton.addEventListener('click', () => this.onClearClicked());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText =
            'width:18px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:13px; line-height:1; cursor:pointer;';
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
        });

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
            this.render();
        });
        return button;
    }

    /** Light the active tab and word the Clear button for what it would clear */
    paintChrome() {
        for (const [view, button] of Object.entries(this.tabButtons || {})) {
            const on = this.view === view;
            button.style.cssText =
                'height:18px; border:0; border-radius:4px; font-size:10px; font-weight:700; cursor:pointer; padding:0 7px; ' +
                (on
                    ? 'background:rgba(77,151,255,0.95); color:#fff;'
                    : 'background:rgba(255,255,255,0.1); color:#9ec4ff;');
        }
        if (!this.clearButton) return;

        const accuracy = this.view === 'accuracy';
        this.clearButton.textContent = accuracy ? (this.resetArmed ? 'Sure?' : 'Reset') : 'Clear';
        this.clearButton.title = accuracy
            ? 'Throw away every recorded fight and start the accuracy record over'
            : 'Clear the room log';
        this.clearButton.style.background = this.resetArmed ? 'rgba(255,100,100,0.55)' : 'rgba(255,255,255,0.12)';
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
        const onMouseDown = (e) => {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            const offsetX = e.clientX - rect.left;
            const offsetY = e.clientY - rect.top;

            const onMouseMove = (moveEvent) => {
                panel.style.left = `${moveEvent.clientX - offsetX}px`;
                panel.style.top = `${moveEvent.clientY - offsetY}px`;
                panel.style.right = 'auto';
            };
            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            // Attach document listeners only for the duration of the drag
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };
        header.addEventListener('mousedown', onMouseDown);
    }

    renderIfOpen() {
        if (this.panel && this.panel.isConnected && this.panel.style.display !== 'none') {
            this.render();
        }
    }

    render() {
        if (this.view === 'accuracy') {
            this.renderAccuracy();
        } else {
            this.renderPanel();
        }
    }

    renderPanel() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;
        this.renderToken++;
        list.textContent = '';

        const sessions = this.activeSession ? [this.activeSession, ...this.sessions] : this.sessions;
        if (!sessions.length) {
            list.appendChild(this.makeNote('No logs yet'));
            return;
        }

        for (const session of sessions.slice(0, MAX_SESSIONS)) {
            list.appendChild(this.renderSessionCard(session));
        }
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

    /** The one line under a fight's heading: what was promised against what happened */
    combatMeta(session) {
        const tally = fightTally(session.actions);
        const parts = [session.predicted === null ? 'Sim —' : `Sim ${(session.predicted * 100).toFixed(0)}%`];

        parts.push(
            tally.total ? `Won ${tally.clears}/${tally.total} (${Math.round(tally.rate * 100)}%)` : 'No result yet'
        );
        const shape = failureShape(tally);
        if (shape) parts.push(shape);
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
            snapshot = await this.simSource.accuracy();
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
                this.makeNote('No labyrinth fights recorded yet. Fight some combat rooms and they will show up here.')
            );
            return;
        }

        list.appendChild(this.renderAccuracySummary(summary));
        for (const row of rows) list.appendChild(this.renderAccuracyRow(row));
    }

    renderAccuracySummary(summary) {
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
            body.textContent =
                `Over the ${summary.judged} it had a rate for, the sim expected ${summary.expected.toFixed(1)} clears ` +
                `and you got ${summary.judgedClears} — ${Math.abs(off).toFixed(1)} ${direction}.`;
        }
        card.appendChild(body);

        if (summary.contested > 0) {
            const flag = document.createElement('div');
            flag.style.cssText = 'font-size:10px; color:#ff8a8a; font-weight:700;';
            flag.textContent = `${summary.contested} room${summary.contested === 1 ? '' : 's'} the record contradicts`;
            card.appendChild(flag);
        }
        return card;
    }

    renderAccuracyRow(row) {
        const pct = (v, places = 0) => (Number.isFinite(v) ? `${(v * 100).toFixed(places)}%` : '—');

        const card = document.createElement('div');
        card.style.cssText =
            'border:1px solid rgba(146,182,255,0.25); border-radius:5px; background:rgba(22,31,45,0.92); padding:6px 7px; font-size:11px; line-height:1.35;';

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:6px; font-weight:700;';
        const name = document.createElement('span');
        name.textContent = `${this.prettyMonsterName(row.monsterHrid)} Lv.${row.level}`;
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

        card.title = this.accuracyTooltip(row, pct).join('\n');
        return card;
    }

    accuracyTooltip(row, pct) {
        const lines = [`${this.prettyMonsterName(row.monsterHrid)} at room level ${row.level}`];
        lines.push(`${row.clears} clears in ${row.attempts} attempts — ${pct(row.observed, 1)}`);
        lines.push(`A record this size puts the true rate between ${pct(row.low, 1)} and ${pct(row.high, 1)}`);

        if (row.predicted === null) {
            lines.push('No sim result on record for this room, so there is nothing to judge it against.');
            lines.push('Calculate its tile once and the prediction is stamped on the next fights.');
            return lines;
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
        return lines;
    }

    makeChip(text, background, color) {
        const chip = document.createElement('span');
        chip.style.cssText = `display:inline-flex; border-radius:999px; padding:0 6px; background:${background}; color:${color}; font-size:10px; font-weight:700;`;
        chip.textContent = text;
        return chip;
    }
}

const labyrinthRoomLogs = new LabyrinthRoomLogs();

export default {
    name: 'Labyrinth Room Logs',
    initialize: () => labyrinthRoomLogs.initialize(),
    disable: () => labyrinthRoomLogs.disable(),
    togglePanel: () => labyrinthRoomLogs.togglePanel(),
    useSimSource: (source) => labyrinthRoomLogs.useSimSource(source),
};
