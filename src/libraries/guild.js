/**
 * Guild Library
 * Guild XP, credits, roster, trials and the Guild Trial Simulator
 *
 * Loads after the combat library and before the ui library. It was split out of
 * the combat bundle (and the trial simulator out of the sim bundle) when both sat
 * near the 2 MB @require ceiling.
 *
 * Exports to: window.Toolasha.Guild
 */

// Guild
import guildXPTracker, { guildXPTracker as guildXPTrackerInstance } from '../features/guild/guild-xp-tracker.js';
// Namespace-imported for the ui bundle's chat commands, which used to inline a
// private copy of the whole guild graph through these five roots — the
// externals map (rollup.config.js) now points its imports here instead
import * as guildTokenValue from '../features/guild/guild-token-value.js';
import * as guildTrialStore from '../features/guild/guild-trials-store.js';
import * as guildTrialsModule from '../features/guild/guild-trials.js';
import guildXPDisplay from '../features/guild/guild-xp-display.js';
import guildCreditValue from '../features/guild/guild-credit-value.js';
import * as guildTokenExchangeCapture from '../features/guild/guild-token-exchange-capture.js';
import guildRosterView from '../features/guild/guild-roster-view.js';
import guildTrials, { guildTrials as guildTrialsStore } from '../features/guild/guild-trials.js';
import * as guildTrialExport from '../features/guild/guild-trial-recorder.js';
import guildTrialScoreboard from '../features/guild/guild-trial-scoreboard.js';
import guildTrialLedgerView from '../features/guild/guild-trial-ledger-view.js';
import guildMemberSkills from '../features/guild/guild-member-skills.js';
// The live trial stream, read by the combat bundle's unit badges and monster stat check through the
// stand-in singletonOwnership gives them (rollup.config.js)
import guildTrialDamage from '../features/guild/guild-trial-damage.js';
// Side-effect import: registers the Guild Trials overlay row
import '../features/guild/guild-trials-row.js';

// Guild Trial Simulator (it reaches the sim engine through Toolasha.Sim)
import guildTrialSim from '../features/combat-sim/guild-trial-sim.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Guild = {
    guildXPTracker,
    // The live tracker (roster, sign-ups, week): guildXPTracker above is only its registration record
    guildXPTrackerInstance,
    guildXPDisplay,
    guildCreditValue,
    // Shared so guild-token-value (runs live in the sim and ui bundles) reads
    // the Guild Shop exchange rate captured/hydrated here in the guild bundle
    guildTokenExchangeCapture,
    guildRosterView,
    guildTrials,
    // The trials singleton (guildName + record) and the recorder's export
    // builder, shared so the exportTrialData console helper in the ui bundle
    // gathers from the live guild copies instead of empty duplicates
    guildTrialsStore,
    guildTrialExport,
    guildTokenValue,
    guildTrialStore,
    guildTrialsModule,
    guildTrialScoreboard,
    guildTrialLedgerView,
    // Read by the Trial Sim's skilling assignment for members' captured skill levels
    guildMemberSkills,
    guildTrialDamage,
    guildTrialSim,
};

// Console-driven debug tools, kept out of the feature namespaces because
// nothing registers or schedules them — they only run when typed
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    guildXp: () => guildXPTracker.debugState(),
};

console.log('[Toolasha] Guild library loaded');
