/**
 * Labyrinth Room Logs
 * Records per-action success/fail/double outcomes for labyrinth skilling and
 * enhancing rooms, shown in a floating panel toggled from the labyrinth tabs.
 * Ported from dakonglong's MIT-licensed Labyrinth Clear Rate Calculator.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import domObserver from '../../core/dom-observer.js';

const STORAGE_KEY = 'labyrinthRoomLogs';
const MAX_SESSIONS = 30;
const MAX_ACTIONS = 60;
const BUTTON_CLASS = 'mwi-lab-logs-button';
const PANEL_ID = 'mwi-lab-logs-panel';

const OUTCOME_COLORS = {
    success: '#3ddc84',
    fail: '#ff6464',
    double: '#ffcf5c',
    unknown: '#9ab0d8',
};

class LabyrinthRoomLogs {
    constructor() {
        this.isInitialized = false;
        this.sessions = [];
        this.activeSession = null;
        this.labContext = null; // { runKey, roomKey, room }
        this.progressHandler = null;
        this.labyrinthHandler = null;
        this.unregisterObserver = null;
        this.panel = null;
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

        this.unregisterObserver = domObserver.onClass(
            'LabyrinthRoomLogs',
            'LabyrinthPanel_tabsComponentContainer',
            (node) => this.injectButton(node)
        );
        const existing = document.querySelector('[class*="LabyrinthPanel_tabsComponentContainer"]');
        if (existing) {
            this.injectButton(existing);
        }
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
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this.finalizeActiveSession('feature_disabled');
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        document.getElementById(PANEL_ID)?.remove();
        this.panel = null;
        this.labContext = null;
        this.isInitialized = false;
    }

    // -------------------------------------------------------------------------
    // Labyrinth context tracking
    // -------------------------------------------------------------------------

    onLabyrinthUpdated(data) {
        const labyrinth = data?.labyrinth;
        if (!labyrinth) {
            this.finalizeActiveSession('left_labyrinth');
            this.labContext = null;
            return;
        }

        const runKey = `${labyrinth.startedAt || ''}|${Math.floor(Number(labyrinth.currentFloor) || 0)}`;
        const path = this.parsePathData(labyrinth.pathData);
        const head = path?.[0];
        const roomKey = head && Number.isInteger(head.x) && Number.isInteger(head.y) ? `${head.x},${head.y}` : '';
        const room = roomKey ? labyrinth.roomData?.[head.y]?.[head.x] || null : null;

        this.labContext = { runKey, roomKey, room };

        // Finalize the active session when the run or the current room changed
        if (this.activeSession && (this.activeSession.runKey !== runKey || this.activeSession.roomKey !== roomKey)) {
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

    ensureSession(snapshot) {
        const context = this.labContext || {};
        const mode = snapshot.isEnhancing ? 'enhancing' : 'skilling';
        const sessionKey = `${context.runKey || ''}|${context.roomKey || ''}|${mode}`;

        if (this.activeSession && this.activeSession.sessionKey !== sessionKey) {
            this.finalizeActiveSession('room_switch');
        }
        if (this.activeSession) {
            return this.activeSession;
        }

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

    isSessionComplete(session) {
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
        this.persist();
        this.renderIfOpen();
    }

    // -------------------------------------------------------------------------
    // UI
    // -------------------------------------------------------------------------

    injectButton(tabsContainer) {
        if (!tabsContainer || tabsContainer.querySelector(`.${BUTTON_CLASS}`)) return;

        const innerContainer = tabsContainer.querySelector('[class*="TabsComponent_tabsContainer"] > div > div > div');
        if (!innerContainer) return;

        const button = document.createElement('div');
        button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary ' + BUTTON_CLASS;
        button.textContent = 'Logs';
        button.style.cssText =
            'cursor: pointer; background: #2d3e5f; color: #fff; border-radius: 4px; padding: 4px 10px; font-size: 12px; white-space: nowrap;';
        button.addEventListener('click', () => this.togglePanel());
        innerContainer.appendChild(button);
    }

    togglePanel() {
        const panel = this.ensurePanel();
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            this.renderPanel();
        } else {
            panel.style.display = 'none';
        }
    }

    ensurePanel() {
        if (this.panel && this.panel.isConnected) return this.panel;

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText =
            'position:fixed; top:90px; right:14px; width:330px; max-height:60vh; display:none; flex-direction:column; ' +
            'border:1px solid rgba(128,170,255,0.5); border-radius:8px; background:rgba(10,14,22,0.97); color:#f2f7ff; ' +
            `box-shadow:0 10px 24px rgba(0,0,0,0.55); z-index:${config.Z_FLOATING_PANEL}; user-select:none;`;

        const header = document.createElement('div');
        header.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px 6px; ' +
            'border-bottom:1px solid rgba(146,182,255,0.24); cursor:move;';

        const title = document.createElement('div');
        title.style.cssText = 'color:#9ec4ff; font-size:12px; font-weight:700;';
        title.textContent = `Room Logs (Last ${MAX_SESSIONS})`;

        const actions = document.createElement('div');
        actions.style.cssText = 'display:inline-flex; align-items:center; gap:6px;';

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText =
            'height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:10px; cursor:pointer; padding:0 6px;';
        clearBtn.addEventListener('click', () => this.clearLogs());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText =
            'width:18px; height:18px; border:0; border-radius:4px; background:rgba(255,255,255,0.12); color:#fff; font-size:13px; line-height:1; cursor:pointer;';
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
        });

        actions.appendChild(clearBtn);
        actions.appendChild(closeBtn);
        header.appendChild(title);
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
        return panel;
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
            this.renderPanel();
        }
    }

    renderPanel() {
        const panel = this.ensurePanel();
        const list = panel.querySelector('.mwi-lab-logs-list');
        if (!list) return;
        list.textContent = '';

        const sessions = this.activeSession ? [this.activeSession, ...this.sessions] : this.sessions;
        if (!sessions.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'font-size:11px; color:#9ab0d8; text-align:center; padding:8px;';
            empty.textContent = 'No logs yet';
            list.appendChild(empty);
            return;
        }

        for (const session of sessions.slice(0, MAX_SESSIONS)) {
            list.appendChild(this.renderSessionCard(session));
        }
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
        } else if (session.incomplete || !session.completed) {
            header.appendChild(this.makeChip('Incomplete', 'rgba(244,124,71,0.22)', '#ffba92'));
        }
        card.appendChild(header);

        const meta = document.createElement('div');
        meta.style.cssText = 'font-size:10px; color:rgba(221,232,255,0.9); margin-bottom:3px;';
        const successPct = (session.successRate * 100).toFixed(0);
        const doublePct = (session.doubleChance * 100).toFixed(0);
        if (session.mode === 'enhancing') {
            meta.textContent = `Success ${successPct}% / Double ${doublePct}% | Enh +${session.currentEnhLevel}/+${session.targetLevel}`;
        } else {
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
            dash.textContent = '--';
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
};
