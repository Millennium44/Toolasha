/**
 * Combat Battle Counter
 * Injects a battle/wave counter next to the action name in the top-left header panel.
 * - Regular zones: "Battle #N" — from battleId in new_battle message
 * - Dungeons: "Wave N · Battle #N" — wave from wave index, battle from battleId
 * - Labyrinth: "Attempt #N" — from entryCount in labyrinth_updated room data
 *
 * Which variant renders is decided by the header title itself: labyrinth
 * fights are titled "Labyrinth - <Monster>". State flags are NOT trusted for
 * this decision — a labyrinth run stays "active" between entries while the
 * player fights regular zones, and stale labyrinth messages arrive shortly
 * after exiting, so every flag-based scheme mislabeled one side or the other
 * (normal zones showing "Attempt #", or lab fights showing "Battle #").
 *
 * Target: Header_actionName (inline with zone name, e.g. "Chimerical Den · Wave 5")
 * domObserver watches Header_actionName so the span is re-injected whenever
 * React replaces that element wholesale between waves or zone changes.
 *
 * That only fires on a full element replacement, though. Queuing another
 * action mid-combat makes React re-render the header's Header_currentAction
 * container without necessarily swapping out Header_actionName itself — it
 * can rewrite the row's children in place, which silently detaches our
 * appended span without ever inserting a new Header_actionName node for the
 * class observer to catch. Left alone, the chip stays gone until the next
 * new_battle message, which on live can be minutes away. A plain
 * MutationObserver on the container catches that case too, since it fires on
 * any child/text change rather than only a class-matching insertion.
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import { createMutationWatcher, hasExternalMutation } from '../../utils/dom-observer-helpers.js';

const COUNTER_ID = 'mwi-battle-counter';
const ACTION_NAME_SELECTOR = '[class*="Header_actionName"]';
const CURRENT_ACTION_SELECTOR = '[class*="Header_currentAction"]';

class CombatBattleCounter {
    constructor() {
        this.initialized = false;
        this.newBattleHandler = null;
        this.labyrinthHandler = null;
        this.unregisterObserver = null;
        this._unwatchContainer = null;
        this._watchedContainer = null;
        this.battleId = 0;
        this.currentWave = 0;
        this.isDungeon = false;
        this.labyrinthAttempt = 0;
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('combatBattleCounter')) return;

        this.newBattleHandler = (data) => this._onNewBattle(data);
        webSocketHook.on('new_battle', this.newBattleHandler);

        this.labyrinthHandler = (data) => this._onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.labyrinthHandler);

        this._onActionsUpdated = (data) => this._checkCombatEnded(data);
        dataManager.on('actions_updated', this._onActionsUpdated);

        this.unregisterObserver = domObserver.onClass('CombatBattleCounter', 'Header_actionName', () =>
            this._injectOrUpdate()
        );

        this.initialized = true;
    }

    _checkCombatEnded(data) {
        if (this.battleId === 0 && this.labyrinthAttempt === 0) return;

        const combatEnded = data.endCharacterActions?.some(
            (a) => a.isDone && a.actionHrid?.startsWith('/actions/combat/')
        );
        const hasCombatAction = data.endCharacterActions?.some(
            (a) => !a.isDone && a.actionHrid?.startsWith('/actions/combat/')
        );
        const hasNewNonCombatAction = data.endCharacterActions?.some(
            (a) => !a.isDone && !a.actionHrid?.startsWith('/actions/combat/') && a.currentCount === 0
        );

        if (combatEnded || (hasNewNonCombatAction && !hasCombatAction)) {
            this.battleId = 0;
            this.currentWave = 0;
            this.isDungeon = false;
            this.labyrinthAttempt = 0;
            document.getElementById(COUNTER_ID)?.remove();
            return;
        }

        // Re-evaluate on any action change even when none of the above matched.
        // React swaps the header's text in place rather than replacing the
        // element, so the class observer does not fire on an action switch and
        // a counter left from the last fight would sit beside the new action —
        // an alchemy craft wearing "Attempt #1" from the labyrinth room before it.
        this._injectOrUpdate();
    }

    _onLabyrinthUpdated(data) {
        const labyrinth = data.labyrinth;
        if (!labyrinth) return;

        // Run over — never let a stale attempt count leak into later zones
        if (!labyrinth.isActive) {
            if (this.labyrinthAttempt !== 0) {
                this.labyrinthAttempt = 0;
                this._injectOrUpdate();
            }
            return;
        }

        let pathCoords;
        let roomRows = labyrinth.roomData;
        try {
            pathCoords = JSON.parse(labyrinth.pathData || '[]');
            if (typeof roomRows === 'string') roomRows = JSON.parse(roomRows);
        } catch {
            return;
        }
        if (!pathCoords.length || !Array.isArray(roomRows)) return;

        // pathData is the queue, and [0] is the room being run — the last
        // entry is the far end of what you lined up, which is routinely an
        // unrevealed room and used to abandon the count entirely
        const active = pathCoords[0];
        const room = roomRows?.[active.y]?.[active.x];
        if (!room || room.roomType !== '/labyrinth_room_types/combat') {
            // Moved to a non-combat room — the previous fight's attempt count
            // no longer applies
            if (this.labyrinthAttempt !== 0) {
                this.labyrinthAttempt = 0;
                this._injectOrUpdate();
            }
            return;
        }

        const entryCount = room.entryCount || 0;
        if (entryCount > 0) {
            this.labyrinthAttempt = entryCount;
            this._injectOrUpdate();
        }
    }

    _onNewBattle(data) {
        this.battleId = data.battleId || 0;

        const actions = dataManager.getCurrentActions();
        const combatAction = actions.find((a) => a.actionHrid?.startsWith('/actions/combat/') && !a.isDone);
        this.isDungeon = combatAction
            ? dataManager.getActionDetails(combatAction.actionHrid)?.combatZoneInfo?.isDungeon === true
            : false;
        this.currentWave = this.isDungeon ? (data.wave ?? 0) : 0;
        this._injectOrUpdate();
    }

    /**
     * Watch the current-action container for changes React makes without
     * replacing the container element itself — a re-render that swaps
     * children/text in place, which `domObserver.onClass` cannot see because
     * no new Header_actionName node is ever inserted.
     * @param {Element} container
     * @private
     */
    _watchContainer(container) {
        if (this._watchedContainer === container) return;
        this._unwatchContainer?.();
        this._watchedContainer = container;
        this._unwatchContainer = createMutationWatcher(
            container,
            (mutations) => {
                if (hasExternalMutation(mutations)) this._injectOrUpdate();
            },
            { childList: true, subtree: true, characterData: true }
        );
    }

    _injectOrUpdate() {
        const currentAction = document.querySelector(CURRENT_ACTION_SELECTOR);
        const nameRow = currentAction?.querySelector(ACTION_NAME_SELECTOR);
        if (!currentAction || !nameRow) return;

        this._watchContainer(currentAction);

        // The header title decides the variant: labyrinth fights are titled
        // "Labyrinth - <Monster>" (our appended counter text never contains
        // the word, so reading the row's full text is safe)
        const isLabyrinthFight = /labyrinth/i.test(nameRow.textContent || '');

        // A battle number describes a fight, so it has no business beside a
        // craft or an alchemy action. The labyrinth variant needs no such
        // guard: its title check already fails on anything else.
        // Lowest ordinal is the action actually running — the array arrives in
        // insertion order, so the first unfinished entry can be one you queued
        // behind it
        const runningAction = (dataManager.getCurrentActions() || [])
            .filter((action) => !action.isDone)
            .sort((a, b) => a.ordinal - b.ordinal)[0];
        const inSkillingAction =
            !!runningAction && !String(runningAction.actionHrid || '').startsWith('/actions/combat/');

        let text = '';
        if (isLabyrinthFight) {
            // Never show "Battle #" on a labyrinth fight — if the attempt
            // count hasn't arrived yet, show nothing
            text = this.labyrinthAttempt > 0 ? `· Attempt #${this.labyrinthAttempt}` : '';
        } else if (inSkillingAction) {
            text = '';
        } else if (this.isDungeon && this.battleId > 0) {
            text = `· Wave ${this.currentWave} · Battle #${this.battleId}`;
        } else if (this.battleId > 0) {
            text = `· Battle #${this.battleId}`;
        }

        let el = document.getElementById(COUNTER_ID);
        if (!text) {
            el?.remove();
            return;
        }
        if (!el || !el.isConnected) {
            el = document.createElement('span');
            el.id = COUNTER_ID;
            el.style.cssText = 'color: rgba(255,255,255,0.6); margin-left: 6px; white-space: nowrap;';
            nameRow.appendChild(el);
        }
        el.textContent = text;
    }

    disable() {
        try {
            if (this.newBattleHandler) {
                webSocketHook.off('new_battle', this.newBattleHandler);
                this.newBattleHandler = null;
            }
            if (this.labyrinthHandler) {
                webSocketHook.off('labyrinth_updated', this.labyrinthHandler);
                this.labyrinthHandler = null;
            }
            if (this._onActionsUpdated) {
                dataManager.off('actions_updated', this._onActionsUpdated);
                this._onActionsUpdated = null;
            }
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            if (this._unwatchContainer) {
                this._unwatchContainer();
                this._unwatchContainer = null;
            }
            this._watchedContainer = null;
            document.getElementById(COUNTER_ID)?.remove();
            this.battleId = 0;
            this.currentWave = 0;
            this.isDungeon = false;
            this.labyrinthAttempt = 0;
            this.initialized = false;
        } catch (error) {
            console.error('[Combat Battle Counter] Disable failed part-way:', error);
        } finally {
            this.initialized = false;
        }
    }
}

const combatBattleCounter = new CombatBattleCounter();

export default combatBattleCounter;
