/**
 * Rotation tracker
 *
 * The subscription behind the DPS panel's Rotation tab: it watches this
 * character's own slot and hands every tick to `utils/rotation-audit.js`, which
 * holds all of the arithmetic and none of the plumbing.
 *
 * ## Two scopes, because they answer different questions
 *
 * A **fight** scope is cleared at every `new_battle`: the fight on screen is the
 * one still worth changing something about, and an average over a session hides
 * the wave where the bar ran dry. A **session** scope is never cleared until it
 * is asked to be: uptime over one thirty-second fight is luck, and starvation
 * over an hour is a build problem. Both are folded on the same tick, so they can
 * never disagree about what happened — only about how much of it they remember.
 *
 * ## Whose slot
 *
 * `new_battle` names every player, so the index whose name matches this
 * character's is the one to watch. Nothing is measured until that match is made
 * — a party where the name has not arrived yet is not "slot 0", and guessing
 * would put somebody else's mana bar on your panel. It is re-resolved at every
 * battle, because a slot is a seat in this fight and the party re-deals.
 *
 * Only `new_battle` carries `combatDetails.combatAbilities`, which is the whole
 * reason an ability that never fires can appear as a row at all: it is read from
 * the stated bar rather than inferred from casts, and a starved ability produces
 * no casts to infer from.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { newAttributionState, noteActions, attributeTick } from '../../utils/damage-attribution.js';
import {
    newRotationState,
    noteRotationKit,
    noteRotationFight,
    foldRotationTick,
    summariseRotation,
} from '../../utils/rotation-audit.js';

/** The counters this tick is measured against — this module's own, never shared */
let state = newAttributionState();

/** Cleared at every battle: what is happening in the fight on screen */
let fight = newRotationState();

/** Kept across battles: what the run says about the build */
let session = newRotationState();

/** Which slot is this character's, from `new_battle`; null until a name matched */
let ownIndex = null;

/** The battle the counters belong to; a change is a different set of units */
let battleId = null;

/** @returns {Object} `abilityDetailMap`, or an empty map before client data lands */
function detailMap() {
    return dataManager.getInitClientData?.()?.abilityDetailMap || {};
}

/**
 * The equipped kit as the character data holds it — the fallback for a fight
 * joined mid-way (no `new_battle` seen yet) and for a battle message that
 * happens not to carry the bar, so the ability list is on the tab from the
 * moment it opens instead of after the next fight starts.
 * @returns {Array|null}
 */
function equippedKit() {
    const kit = dataManager.characterData?.combatUnit?.combatAbilities;
    return Array.isArray(kit) && kit.length ? kit : null;
}

/** Note the character's own kit on both scopes, when one is known */
function seedKit(kit = equippedKit()) {
    if (!kit) return;
    noteRotationKit(fight, kit, detailMap());
    noteRotationKit(session, kit, detailMap());
}

/** Forget everything and measure again from here */
export function resetRotationAudit() {
    state = newAttributionState();
    fight = newRotationState();
    session = newRotationState();
    ownIndex = null;
    battleId = null;
}

/**
 * The audit as it stands.
 *
 * @returns {{fight: Object, session: Object, tracking: boolean}} Two summaries from
 *   `summariseRotation`, and whether this character's slot has been identified —
 *   which is the difference between "nothing has happened" and "nothing is being
 *   watched", and the panel says which
 */
export function rotationAudit() {
    return { fight: summariseRotation(fight), session: summariseRotation(session), tracking: ownIndex !== null };
}

let onNewBattle = null;
let onBattleUpdated = null;
let onCharacterSwitching = null;
let onCharacterInitialized = null;

/**
 * Start watching. Idempotent — a second call while running does nothing.
 *
 * Driven by the DPS panel's own setting rather than one of its own: the tab is
 * the only thing that reads this, so a tracker running with the panel off would
 * be a subscription nobody could see.
 */
export function startRotationTracker() {
    if (onBattleUpdated) return;

    onNewBattle = (data) => {
        try {
            const players = data?.players || {};
            const own = dataManager.getCurrentCharacterName?.() || null;

            // Re-resolved every battle: the seat is per fight, and a stale index
            // reads somebody else's mana as yours
            ownIndex = null;
            for (const [index, player] of Object.entries(players)) {
                const name = player?.name || player?.character?.name || null;
                if (own && name === own) ownIndex = index;
            }

            noteActions(state, players);

            // The fight on screen is a new one, so what was measured belongs to
            // the last one. The session keeps both.
            fight = newRotationState();
            noteRotationFight(fight);
            noteRotationFight(session);

            // The bar this battle states for our seat; the character's equipped
            // kit when the message does not carry one
            const stated = ownIndex !== null ? players[ownIndex]?.combatDetails?.combatAbilities : null;
            seedKit(Array.isArray(stated) && stated.length ? stated : equippedKit());
        } catch (error) {
            console.error('[RotationTracker] Reading a new battle failed:', error);
        }
    };

    onBattleUpdated = (data) => {
        try {
            if (data?.battleId !== battleId) {
                battleId = data?.battleId;
                state.monstersHP = {};
                state.monstersMaxHP = {};
                state.dmgCounter = {};
                state.critCounter = {};
            }

            if (ownIndex === null) return;
            const player = data?.pMap?.[ownIndex];
            if (!player) return;

            // What was being prepared *going into* this tick, before `noteActions`
            // overwrites it with what is being prepared for the next one — the
            // same ordering the damage tracker keeps, and for the same reason
            const action = state.actions?.[ownIndex] || 'idle';
            const events = attributeTick(data, state).filter((event) => event.playerIndex === ownIndex);
            noteActions(state, data?.pMap);

            const tick = { at: Date.now(), player, action, events, detailMap: detailMap() };
            foldRotationTick(fight, tick);
            foldRotationTick(session, tick);
        } catch (error) {
            console.error('[RotationTracker] Reading a combat tick failed:', error);
        }
    };

    // A session scope is "what this run says about *this* build". Carrying it
    // across a character switch mixes two bars, two mana pools and two sets of
    // fights into one set of rows, and the rows are unlabelled — so the switch
    // starts the measurement again rather than quietly averaging two characters
    //
    // Nothing is seeded here: `character_switching` fires while
    // `dataManager.characterData` still holds the *departing* character, so a
    // seed on this event would fill the fresh scopes with the bar of the
    // character being left. The arriving character's bar is picked up below.
    onCharacterSwitching = () => {
        try {
            resetRotationAudit();
        } catch (error) {
            console.error('[RotationTracker] Resetting on a character switch failed:', error);
        }
    };

    // The re-seed, and the reason the reset above is safe on its own.
    //
    // `character_switched` is the wrong event for it: the data manager emits it
    // after clearing the old character and *before* assigning the new one, so
    // `characterData` is null and there is no bar to read. `character_initialized`
    // is emitted once the new character's data is in place, which is the first
    // moment the arriving bar exists. This used to be correct only because the
    // panel's own lifecycle happened to re-seed after a switch; now the tracker
    // does not depend on anything reopening it.
    onCharacterInitialized = () => {
        try {
            seedKit();
        } catch (error) {
            console.error('[RotationTracker] Seeding the new character’s bar failed:', error);
        }
    };

    webSocketHook.on('new_battle', onNewBattle);
    webSocketHook.on('battle_updated', onBattleUpdated);
    dataManager.on?.('character_switching', onCharacterSwitching);
    dataManager.on?.('character_initialized', onCharacterInitialized);
    // A panel opened in the middle of a run should list the kit at once
    seedKit();
}

/** Stop watching and forget the run */
export function stopRotationTracker() {
    if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
    if (onBattleUpdated) webSocketHook.off('battle_updated', onBattleUpdated);
    if (onCharacterSwitching) dataManager.off?.('character_switching', onCharacterSwitching);
    if (onCharacterInitialized) dataManager.off?.('character_initialized', onCharacterInitialized);
    onNewBattle = null;
    onBattleUpdated = null;
    onCharacterInitialized = null;
    onCharacterSwitching = null;
    resetRotationAudit();
}
