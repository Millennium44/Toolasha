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
 * React replaces that element between waves or zone changes.
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { runningCombatAction } from '../../utils/combat-actions.js';

const COUNTER_ID = 'mwi-battle-counter';

// How often the poll below checks that the chip is still in the header. A
// React re-render can rewrite the header's children in place, detaching the
// chip without inserting any node the class observer would see. A mutation
// watcher here once fed back on the game's own ticking header and froze the
// tab (see the 854c04f8 revert), so recovery is a slow poll instead: reading
// one element by id is microseconds and cannot feed back into anything.
const REINJECT_POLL_MS = 1500;
const ACTION_NAME_SELECTOR = '[class*="Header_actionName"]';
const CURRENT_ACTION_SELECTOR = '[class*="Header_currentAction"]';

class CombatBattleCounter {
    constructor() {
        this.initialized = false;
        this.newBattleHandler = null;
        this.labyrinthHandler = null;
        this._onCharacterSwitching = null;
        this.unregisterObserver = null;
        this.battleId = 0;
        this.currentWave = 0;
        this.isDungeon = false;
        this.labyrinthAttempt = 0;
        this.timers = createTimerRegistry();
    }

    /**
     * Drop all tracked numbers and the injected span. Mirrors combat-boss-eta:
     * called on character_switching (the immediate cleanup-phase event) because
     * the registry's disableAllFeatures runs later on the async lifecycle
     * chain — until it lands, the re-inject poll would keep painting the
     * departing character's "Battle #N" / "Attempt #N" into the arriving
     * character's header.
     */
    _reset() {
        this.battleId = 0;
        this.currentWave = 0;
        this.isDungeon = false;
        this.labyrinthAttempt = 0;
        document.getElementById(COUNTER_ID)?.remove();
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

        this._onCharacterSwitching = () => this._reset();
        dataManager.on('character_switching', this._onCharacterSwitching);

        this.unregisterObserver = domObserver.onClass('CombatBattleCounter', 'Header_actionName', () =>
            this._injectOrUpdate()
        );

        // See REINJECT_POLL_MS: the in-place-re-render recovery. Only does
        // work when there is a chip to maintain or state that wants one.
        this.timers.registerInterval(
            setInterval(() => {
                if (this.battleId > 0 || this.labyrinthAttempt > 0 || document.getElementById(COUNTER_ID)) {
                    this._injectOrUpdate();
                }
            }, REINJECT_POLL_MS)
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
            this._reset();
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
        // A `new_battle` message with no battleId still means a battle
        // happened — boss-eta tolerates the same gap by text-parsing this
        // counter's own last-shown number as a fallback. Zeroing here would
        // both blank the counter and take away the very text boss-eta reads,
        // so a missing id keeps whatever id was last known instead.
        const battleId = Number(data?.battleId) || 0;
        if (battleId) this.battleId = battleId;

        // The running zone is the lowest-ordinal unfinished combat action, not
        // the first in array order — a requeued repeat sits first with a higher
        // ordinal, which made a dungeon show "Battle #N" instead of "Wave N".
        const combatAction = runningCombatAction(dataManager.getCurrentActions());
        this.isDungeon = combatAction
            ? dataManager.getActionDetails(combatAction.actionHrid)?.combatZoneInfo?.isDungeon === true
            : false;
        this.currentWave = this.isDungeon ? (data.wave ?? 0) : 0;
        this._injectOrUpdate();
    }

    _injectOrUpdate() {
        const currentAction = document.querySelector(CURRENT_ACTION_SELECTOR);
        const nameRow = currentAction?.querySelector(ACTION_NAME_SELECTOR);
        if (!currentAction || !nameRow) return;

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
        // Timers cleared first and unconditionally: a later step throwing (an
        // observer teardown, say) must not leave a live interval running while
        // `finally` marks us disabled — the next enable() would then stack a
        // second poll on top of one nothing ever stopped.
        this.timers.clearAll();
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
            if (this._onCharacterSwitching) {
                dataManager.off('character_switching', this._onCharacterSwitching);
                this._onCharacterSwitching = null;
            }
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
            this._reset();
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
