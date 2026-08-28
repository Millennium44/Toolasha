/**
 * Combat Boss ETA
 * Injects a "battles left / time left until the boss is defeated" chip next
 * to the battle counter in the top-left header panel, for combat zones that
 * cycle a boss every N battles.
 *
 * N (`battlesPerBoss`) comes from the zone's `combatZoneInfo.fightInfo` — the
 * same field `combat-sim/engine/zone.js` reads for the offline simulator, and
 * `utils/combat-drop-model.js` / `utils/expected-kills.js` read for drop and
 * kill modelling. The current battle number comes from `battleId` on the
 * `new_battle` websocket message, falling back to parsing the battle counter
 * span's own text (`combat-battle-counter.js`) when a message ever omits it.
 *
 * A rolling average of the last several inter-battle gaps (time between
 * consecutive `new_battle` messages) estimates how long a battle takes in the
 * current zone; see `utils/boss-eta.js` for the arithmetic and the outlier
 * cutoff. The average — and the battle-number tracking — resets on a zone (or
 * tier) change, on combat ending, and on a character switch, so one
 * character's pace never leaks into another's estimate.
 *
 * Target: same `Header_actionName` row the battle counter injects into, so
 * this reuses its `domObserver` watch point.
 *
 * That watch point only fires on a full element replacement. Queuing another
 * action mid-combat can make React rewrite the row's children in place
 * instead, silently detaching this chip without inserting a new
 * Header_actionName node — see combat-battle-counter.js for the fuller
 * explanation. A plain MutationObserver on the container, shared via
 * `createMutationWatcher`, catches that case too.
 */

import webSocketHook from '../../core/websocket.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import { battlesToBoss, addBattleGap, averageBattleMs, formatBossEta, bossEtaTooltip } from '../../utils/boss-eta.js';
import { createMutationWatcher, hasExternalMutation } from '../../utils/dom-observer-helpers.js';

const ETA_ID = 'mwi-boss-eta';
const ACTION_NAME_SELECTOR = '[class*="Header_actionName"]';
const CURRENT_ACTION_SELECTOR = '[class*="Header_currentAction"]';
// The battle counter's own span — read only as a fallback when a new_battle
// message ever arrives without a battleId.
const BATTLE_COUNTER_ID = 'mwi-battle-counter';
const BATTLE_ID_TEXT_RE = /Battle #(\d+)/;

class CombatBossEta {
    constructor() {
        this.initialized = false;
        this.newBattleHandler = null;
        this._onActionsUpdated = null;
        this._onCharacterSwitching = null;
        this.unregisterObserver = null;
        this._unwatchContainer = null;
        this._watchedContainer = null;

        this._resetTracking();
    }

    _resetTracking() {
        this.zoneKey = null;
        this.battlesPerBoss = 0;
        this.hasBossCycle = false;
        this.battleNumber = 0;
        // null, not 0: a real Date.now() reading of exactly the epoch is not
        // realistic, but tests drive a fake clock that starts at 0, so 0 would
        // be indistinguishable from "no battle seen yet" there.
        this.lastBattleAt = null;
        this.samples = [];
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('combatBossEta')) return;

        this.newBattleHandler = (data) => this._onNewBattle(data);
        webSocketHook.on('new_battle', this.newBattleHandler);

        this._onActionsUpdated = (data) => this._checkCombatEnded(data);
        dataManager.on('actions_updated', this._onActionsUpdated);

        this._onCharacterSwitching = () => this._reset();
        dataManager.on('character_switching', this._onCharacterSwitching);

        this.unregisterObserver = domObserver.onClass('CombatBossEta', 'Header_actionName', () =>
            this._injectOrUpdate()
        );

        this.initialized = true;
    }

    _reset() {
        this._resetTracking();
        document.getElementById(ETA_ID)?.remove();
    }

    _checkCombatEnded(data) {
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

        // Mirror the battle counter: re-evaluate on any action change even
        // when none of the above matched, since React can swap the header's
        // text in place without the class observer firing.
        this._injectOrUpdate();
    }

    _onNewBattle(data) {
        const actions = dataManager.getCurrentActions() || [];
        const combatAction = actions.find((a) => a.actionHrid?.startsWith('/actions/combat/') && !a.isDone);
        const zoneDetail = combatAction ? dataManager.getActionDetails(combatAction.actionHrid) : null;
        const zoneInfo = zoneDetail?.combatZoneInfo;
        const fightInfo = zoneInfo?.fightInfo;

        // Tier is a separate field on the action, not part of the hrid — two
        // tiers of the same zone share battlesPerBoss but not battle pacing,
        // so both are part of the identity the rolling average is keyed on.
        const zoneKey = combatAction ? `${combatAction.actionHrid}:${combatAction.difficultyTier ?? ''}` : null;
        if (zoneKey !== this.zoneKey) {
            this.zoneKey = zoneKey;
            this.samples = [];
            this.lastBattleAt = null;
        }

        const battlesPerBoss = Number(fightInfo?.battlesPerBoss) || 0;
        const hasBossSpawns = Array.isArray(fightInfo?.bossSpawns) && fightInfo.bossSpawns.length > 0;
        this.hasBossCycle = zoneInfo?.isDungeon !== true && hasBossSpawns && battlesPerBoss > 0;
        this.battlesPerBoss = battlesPerBoss;

        let battleNumber = Number(data?.battleId) || 0;
        if (!battleNumber) {
            const counterText = document.getElementById(BATTLE_COUNTER_ID)?.textContent || '';
            const match = BATTLE_ID_TEXT_RE.exec(counterText);
            battleNumber = match ? Number(match[1]) : 0;
        }
        this.battleNumber = battleNumber;

        const now = Date.now();
        if (this.lastBattleAt !== null) {
            this.samples = addBattleGap(this.samples, now - this.lastBattleAt);
        }
        this.lastBattleAt = now;

        this._injectOrUpdate();
    }

    /**
     * Watch the current-action container for changes React makes without
     * replacing the container element itself — see combat-battle-counter.js's
     * copy of this method for the full explanation.
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

        // Same guards as the battle counter: never show on a labyrinth fight
        // (no boss-cycle concept there) or beside a skilling action queued in
        // front of a stale combat state.
        const isLabyrinthFight = /labyrinth/i.test(nameRow.textContent || '');
        const runningAction = (dataManager.getCurrentActions() || [])
            .filter((action) => !action.isDone)
            .sort((a, b) => a.ordinal - b.ordinal)[0];
        const inSkillingAction =
            !!runningAction && !String(runningAction.actionHrid || '').startsWith('/actions/combat/');

        let text = '';
        let title = '';
        if (!isLabyrinthFight && !inSkillingAction && this.hasBossCycle && this.battleNumber > 0) {
            const info = battlesToBoss(this.battleNumber, this.battlesPerBoss);
            if (info) {
                const avgMs = averageBattleMs(this.samples);
                text = formatBossEta(info, avgMs);
                title = bossEtaTooltip(info, avgMs);
            }
        }

        let el = document.getElementById(ETA_ID);
        if (!text) {
            el?.remove();
            return;
        }
        if (!el || !el.isConnected) {
            el = document.createElement('span');
            el.id = ETA_ID;
            el.style.cssText = 'color: rgba(255,255,255,0.6); margin-left: 6px; white-space: nowrap;';
            nameRow.appendChild(el);
        }
        el.textContent = `· ${text}`;
        el.title = title;
    }

    disable() {
        try {
            if (this.newBattleHandler) {
                webSocketHook.off('new_battle', this.newBattleHandler);
                this.newBattleHandler = null;
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
            if (this._unwatchContainer) {
                this._unwatchContainer();
                this._unwatchContainer = null;
            }
            this._watchedContainer = null;
            this._reset();
        } catch (error) {
            console.error('[Combat Boss ETA] Disable failed part-way:', error);
        } finally {
            this.initialized = false;
        }
    }
}

const combatBossEta = new CombatBossEta();

export default combatBossEta;
