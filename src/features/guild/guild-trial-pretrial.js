/**
 * Checking loadouts before a trial starts.
 *
 * The game keeps ONE combat trial loadout per character and answers a View Loadout
 * request (`kind: 'combat'`) with it whichever combat trial is asked about
 * (measured on the test server, 2026-09-29: Badger and Swarm requests were
 * byte-identical in shape, and the replies carry no trial field). So checking
 * "both trials" is one capture per player compared against each trial's section of
 * the plan — never one capture per trial.
 *
 * Who to check comes from the week's sign-ups, the same source the trials panel
 * reads: a guild character carries `signedUpCombatTrialHrid`, valid only while its
 * `signupWeekStartAt` is the current week. Nothing here reads or writes the live
 * trial session, so a trial going live cannot wipe what was checked beforehand; the
 * captures themselves live in `utils/view-loadout.js`'s in-memory store.
 */

import { comparePlan, trialKeyFromName } from './guild-trial-plan.js';

/**
 * One member's sign-up metadata, or null when the sign-up is not this week's.
 * @param {Object} meta - Tracker member metadata
 * @param {string|null} currentWeek - `getCurrentWeekStartAt()`
 * @returns {string|null} The combat trial hrid signed up for
 */
function combatSignup(meta, currentWeek) {
    if (!meta?.signedUpCombatTrialHrid) return null;
    if (currentWeek && meta.signupWeekStartAt !== currentWeek) return null;
    return meta.signedUpCombatTrialHrid;
}

/**
 * The combat trials this week's sign-ups name.
 * @param {Object} tracker - The XP tracker (`getMemberList`, `getCurrentWeekStartAt`)
 * @returns {Array<{hrid: string, key: string, name: string, count: number}>} One per trial, most
 *   signed-up first; `name` is the boss as a title (`Badger`)
 */
export function combatTrialsThisWeek(tracker) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const byHrid = new Map();
    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        const hrid = combatSignup(meta, currentWeek);
        if (hrid) byHrid.set(hrid, (byHrid.get(hrid) || 0) + 1);
    }
    return [...byHrid.entries()]
        .map(([hrid, count]) => {
            const key = trialKeyFromName(hrid) || hrid;
            return { hrid, key, name: key[0].toUpperCase() + key.slice(1), count };
        })
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Members signed up for one combat trial this week.
 * @param {Object} tracker - The XP tracker
 * @param {string} hrid - `/guild_combat/<boss>`
 * @returns {Array<{characterId: string, name: string}>} Sorted by name
 */
export function signedUpForCombatTrial(tracker, hrid) {
    const currentWeek = tracker?.getCurrentWeekStartAt?.() || null;
    const roster = [];
    for (const member of tracker?.getMemberList?.() || []) {
        const meta = tracker?.getMemberMeta?.(member.characterID) || member;
        if (combatSignup(meta, currentWeek) !== hrid) continue;
        const name = meta?.name || member?.name || null;
        if (name) roster.push({ characterId: String(member.characterID), name });
    }
    return roster.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Participant rows for a pre-trial roster, in the shape `comparePlan` reads.
 *
 * @param {Array<{characterId: string, name: string}>} roster - From {@link signedUpForCombatTrial}
 * @param {(member: Object) => Object|null} lookup - A member's captured combat trial snapshot
 *   (the `recordCapture` shape), or null when none
 * @returns {Array<Object>} `{characterId, name, capture, captured}` per member
 */
export function pretrialRows(roster, lookup) {
    return roster.map((member) => {
        const snapshot = lookup(member);
        const capture = snapshot
            ? {
                  characterId: snapshot.characterId ?? member.characterId,
                  name: snapshot.name || member.name,
                  capturedAt: snapshot.at ?? null,
                  source: snapshot.source ?? null,
                  abilities: snapshot.abilities || [],
                  abilitiesAuthoritative: snapshot.abilitiesAuthoritative === true,
              }
            : null;
        return {
            characterId: member.characterId,
            name: member.name,
            capture,
            captured: capture?.abilitiesAuthoritative === true,
        };
    });
}

/**
 * The pre-trial view of one trial: sign-ups joined against captures and the trial's plan section.
 *
 * @param {Object} options
 * @param {Object} options.tracker - The XP tracker
 * @param {{hrid: string, key: string}} options.trial - From {@link combatTrialsThisWeek}
 * @param {(member: Object) => Object|null} options.lookup - See {@link pretrialRows}
 * @param {Object} options.plan - From `guildTrialPlan.parsed`
 * @param {Object} [options.abilityDetailMap] - Game data
 * @returns {{participants: Array<Object>, outstanding: Array<Object>, rosterCount: number,
 *   capturedCount: number, complete: boolean, planCompare: Object}}
 */
export function pretrialState({ tracker, trial, lookup, plan, abilityDetailMap = {} }) {
    const participants = pretrialRows(signedUpForCombatTrial(tracker, trial.hrid), lookup);
    const outstanding = participants.filter((row) => !row.captured);
    return {
        participants,
        outstanding,
        rosterCount: participants.length,
        capturedCount: participants.length - outstanding.length,
        complete: participants.length > 0 && outstanding.length === 0,
        startedAt: null,
        planCompare: comparePlan(plan, participants, abilityDetailMap, trial.key),
    };
}
