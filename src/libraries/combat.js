/**
 * Combat Library
 * Combat, abilities, and combat stats features
 *
 * Exports to: window.Toolasha.Combat
 */

// Core
import dataManager from '../core/data-manager.js';

// Combat features
import zoneIndices from '../features/combat/zone-indices.js';
import loadoutEnhancementDisplay from '../features/combat/loadout-enhancement-display.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import combatRecorder from '../features/combat/combat-recorder.js';
import scrollSimulator from '../features/combat/scroll-simulator.js';
import scrollSimulatorUI from '../features/combat/scroll-simulator-ui.js';
import dungeonTracker from '../features/combat/dungeon-tracker.js';
import dungeonTrackerStorage from '../features/combat/dungeon-tracker-storage.js';
import dungeonTrackerUI from '../features/combat/dungeon-tracker-ui.js';
import dungeonTrackerChatAnnotations from '../features/combat/dungeon-tracker-chat-annotations.js';
import combatSummary from '../features/combat/combat-summary.js';
import combatBattleCounter from '../features/combat/combat-battle-counter.js';
import combatBossEta from '../features/combat/combat-boss-eta.js';
import combatDropLuck from '../features/combat/combat-drop-luck.js';
import { partyLuckPanel } from '../features/combat/party-luck-panel.js';
import combatDPS from '../features/combat/combat-dps.js';
import portraitDps from '../features/combat/portrait-dps.js';
import combatUnitBadges from '../features/combat/combat-unit-badges.js';
import combatDpsPanel from '../features/combat/combat-dps-panel.js';
import partyProfileButton from '../features/combat/party-profile-button.js';
// Side-effect import: registers the Build Score overlay row
import '../features/profile/build-score-row.js';
// Registers the Sim Accuracy overlay row and its panel; the instance is read
// by the zone uptime harness for the sim result the check retained
import replayCheck from '../features/combat/combat-replay-check.js';
import {
    waveHridsOf,
    nonDamagingByHrid,
    extractWaveIncoming,
    mergeWaveIncoming,
    compareZoneIncoming,
    zoneUptimeMismatches,
} from '../features/combat/zone-uptime-harness.js';
import { buildGameDataPayload } from '../features/combat-sim/combat-sim-adapter.js';
import labyrinthTracker from '../features/combat/labyrinth-tracker.js';
import labyrinthRunLedger from '../features/combat/labyrinth-run-ledger.js';
import labyrinthBestLevel from '../features/combat/labyrinth-best-level.js';
import labyrinthShopPrices from '../features/combat/labyrinth-shop-prices.js';
import labyrinthClearRate from '../features/combat/labyrinth-clear-rate.js';
import monsterStatCheckUI from '../features/combat/monster-stat-check-ui.js';
import labyrinthRoomLogs from '../features/combat/labyrinth-room-logs.js';
import labyrinthCapture from '../features/combat/labyrinth-capture.js';
import { captureFile } from '../features/combat/labyrinth-tick-capture.js';
import * as combatSimIntegration from '../features/combat/combat-sim-integration.js';
import { constructExportObject } from '../features/combat/combat-sim-export.js';
import { constructMilkonomyExport } from '../features/combat/milkonomy-export.js';
import combatSim from '../features/combat-sim/combat-sim.js';
import labSim from '../features/combat-sim/lab-sim.js';

// Combat stats
import combatStats from '../features/combat-stats/combat-stats.js';
import combatStatsDataCollector from '../features/combat-stats/combat-stats-data-collector.js';
import * as combatStatsCalculator from '../features/combat-stats/combat-stats-calculator.js';

// Abilities
import abilityBookCalculator from '../features/abilities/ability-book-calculator.js';
import manaTracker from '../features/combat/mana-tracker.js';
// Namespaces, not default exports: both are in rollup's externals map, so
// another bundle importing `{ damageBreakdown }` from one of them compiles to
// `Toolasha.Combat.damageTracker.damageBreakdown` — which is undefined unless
// what sits at that global is the module itself
import * as damageTracker from '../features/combat/damage-tracker.js';
import * as damageTakenTracker from '../features/combat/damage-taken-tracker.js';
import abilityDictionaryButton from '../features/abilities/ability-dictionary-button.js';
import chestKeyMarketButton from '../features/inventory/chest-key-market-button.js';

// Profile (combat score)
import combatScore from '../features/profile/combat-score.js';
import characterCardButton from '../features/profile/character-card-button.js';
import eliteAchievementReminder from '../features/profile/elite-achievement-reminder.js';

// Guild
import guildXPTracker from '../features/guild/guild-xp-tracker.js';
import guildXPDisplay from '../features/guild/guild-xp-display.js';
import guildCreditValue from '../features/guild/guild-credit-value.js';
import * as guildTokenExchangeCapture from '../features/guild/guild-token-exchange-capture.js';
import guildRosterView from '../features/guild/guild-roster-view.js';
import guildTrials, { guildTrials as guildTrialsStore } from '../features/guild/guild-trials.js';
import * as guildTrialExport from '../features/guild/guild-trial-recorder.js';
import guildTrialScoreboard from '../features/guild/guild-trial-scoreboard.js';
import guildTrialLedgerView from '../features/guild/guild-trial-ledger-view.js';
// Side-effect import: registers the Guild Trials overlay row
import '../features/guild/guild-trials-row.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Combat = {
    zoneIndices,
    loadoutEnhancementDisplay,
    loadoutSnapshot,
    combatRecorder,
    scrollSimulator,
    scrollSimulatorUI,
    dungeonTracker,
    dungeonTrackerStorage,
    dungeonTrackerUI,
    dungeonTrackerChatAnnotations,
    combatSummary,
    combatBattleCounter,
    combatBossEta,
    combatDropLuck,
    partyLuckPanel,
    combatDPS,
    portraitDps,
    combatUnitBadges,
    combatDpsPanel,
    partyProfileButton,
    labyrinthTracker,
    labyrinthRunLedger,
    labyrinthBestLevel,
    labyrinthShopPrices,
    labyrinthClearRate,
    monsterStatCheckUI,
    labyrinthRoomLogs,
    labyrinthCapture,
    combatSimIntegration,
    combatSimExport: {
        constructExportObject,
        constructMilkonomyExport,
    },
    combatStats,
    combatStatsDataCollector,
    combatStatsCalculator,
    abilityBookCalculator,
    manaTracker,
    damageTracker,
    damageTakenTracker,
    abilityDictionaryButton,
    chestKeyMarketButton,
    combatScore,
    characterCardButton,
    eliteAchievementReminder,
    combatSim,
    labSim,
    guildXPTracker,
    guildXPDisplay,
    guildCreditValue,
    // Shared so guild-token-value (runs live in the sim and ui bundles) reads
    // the Guild Shop exchange rate captured/hydrated here in the combat bundle
    guildTokenExchangeCapture,
    guildRosterView,
    guildTrials,
    // The trials singleton (guildName + record) and the recorder's export
    // builder, shared so the exportTrialData console helper in the ui bundle
    // gathers from the live combat copies instead of empty duplicates
    guildTrialsStore,
    guildTrialExport,
    guildTrialScoreboard,
    guildTrialLedgerView,
};

// Console-driven debug tools, kept out of the feature namespaces because
// nothing registers or schedules them — they only run when typed
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    ...labyrinthCapture,
    labAccuracy: () => labyrinthClearRate.labAccuracy(),
    labRooms: () => labyrinthClearRate.labRooms(),
    monsterStatCheck: () => monsterStatCheckUI.dumpLast(),
    monsterStatCheckLog: () => monsterStatCheckUI.logEntries(),
    // Decompose the monster's incoming damage per ability, captured fight vs sim,
    // to localise a timing/uptime gap. Arm a tick capture, fight, then run this.
    uptimeHarness: async () => {
        const capture = captureFile();
        if (!capture?.ticks?.length) {
            console.warn('[UptimeHarness] No tick capture — arm a capture and fight the monster first.');
            return null;
        }
        const { monsterHrid, roomLevel } = capture.context || {};
        if (!monsterHrid) {
            console.warn('[UptimeHarness] The capture has no monster context.');
            return null;
        }
        const result = await labyrinthClearRate.uptimeHarness(monsterHrid, roomLevel ?? 0, capture.ticks);
        if (result) {
            const tableRows = (rows) =>
                rows.map((row) => ({
                    ability: row.ability,
                    'real cast%': row.real ? Math.round(row.real.castSharePct) : '—',
                    'sim cast%': row.sim ? Math.round(row.sim.castSharePct) : '—',
                    'real dmg%': row.real ? Math.round(row.real.dmgSharePct) : '—',
                    'sim dmg%': row.sim ? Math.round(row.sim.dmgSharePct) : '—',
                    'real mean': row.real ? Math.round(row.real.meanDmgPerCast) : '—',
                    'sim mean': row.sim ? Math.round(row.sim.meanDmgPerCast) : '—',
                    verdict: row.verdict,
                }));
            console.log(`[UptimeHarness] ${monsterHrid} room ${roomLevel} — incoming damage per ability, real vs sim`);
            console.table(tableRows(result.comparison.rows));
            if (result.outgoing?.comparison?.rows) {
                console.log(
                    `[UptimeHarness] ${monsterHrid} room ${roomLevel} — YOUR outgoing damage per ability, real vs sim`
                );
                console.table(tableRows(result.outgoing.comparison.rows));
            }
        }
        return result;
    },
    // Run the Sim Accuracy check from the console — the same run the panel's
    // Check button starts, retained sim result included. The zone uptime
    // harness below needs one to have run.
    simAccuracyCheck: async () => {
        const comparison = await replayCheck.check();
        if (!comparison) {
            console.warn(`[SimAccuracy] ${replayCheck.error || 'The check could not run.'}`);
            return null;
        }
        console.table(
            comparison.metrics.map((metric) => ({
                metric: metric.label ?? metric.key,
                real: typeof metric.real === 'number' ? Number(metric.real.toFixed(2)) : (metric.real ?? '—'),
                sim:
                    typeof metric.predicted === 'number'
                        ? Number(metric.predicted.toFixed(2))
                        : (metric.predicted ?? '—'),
                'dev%': metric.deviationPct === null ? '—' : Number(metric.deviationPct.toFixed(1)),
                verdict: metric.verdict,
            }))
        );
        return comparison;
    },
    // The zone edition: decompose a recorded zone session's incoming damage per
    // monster and per ability, against the sim the Sim Accuracy check already
    // ran. Record zone combat, run the panel check, then type this.
    zoneUptimeHarness: async () => {
        const session = combatRecorder.sessionFile();
        const segments = (session?.segments || []).filter((entry) => entry.ticksIncluded && entry.ticks?.length);
        if (!segments.length) {
            console.warn('[ZoneUptime] No recorded ticks — press Record during zone combat first.');
            return null;
        }
        const simResult = replayCheck.lastSimResult;
        if (!simResult) {
            console.warn('[ZoneUptime] No sim on hand — run the Sim Accuracy check first, then this.');
            return null;
        }

        const gameData = buildGameDataPayload();
        const hrids = new Set();
        for (const entry of segments) {
            for (const hrid of waveHridsOf(entry.ticks)) hrids.add(hrid);
        }
        const nonDamaging = nonDamagingByHrid(gameData, hrids);
        const real = mergeWaveIncoming(segments.map((entry) => extractWaveIncoming(entry.ticks, { nonDamaging })));
        if (!real.usable) {
            console.warn(`[ZoneUptime] The recording cannot be decomposed: ${real.reason}`);
            return null;
        }

        const zoneHrid = replayCheck.observed()?.zoneHrid || null;
        const mismatches = zoneUptimeMismatches(real, {
            zoneHrid,
            gameData,
            segmentLoadouts: segments.map((entry) => entry.loadout ?? null),
        });
        if (mismatches.length) {
            console.warn(
                `[ZoneUptime] Recording and sim do not describe the same fight (${mismatches.join(', ')}) — not comparing.`
            );
            return { real, mismatches };
        }

        const result = compareZoneIncoming(real, simResult);
        const fightsLabel = `${real.fights} fight${real.fights === 1 ? '' : 's'}${real.partialFights ? ` (+${real.partialFights} partial excluded)` : ''}`;
        console.log(`[ZoneUptime] ${zoneHrid} — incoming damage per monster per ability, real vs sim (${fightsLabel})`);
        const tableRow = (row) => ({
            ability: row.ability,
            'real cast%': row.real?.castSharePct != null ? Math.round(row.real.castSharePct) : '—',
            'sim cast%': row.sim?.castSharePct != null ? Math.round(row.sim.castSharePct) : '—',
            'real dmg%': row.real ? Math.round(row.real.dmgSharePct) : '—',
            'sim dmg%': row.sim ? Math.round(row.sim.dmgSharePct) : '—',
            'real mean': row.real ? Math.round(row.real.meanDmgPerCast ?? row.real.meanPerTick) : '—',
            'sim mean': row.sim ? Math.round(row.sim.meanDmgPerCast ?? row.sim.meanPerTick) : '—',
            verdict: row.verdict,
        });
        for (const section of result.sections) {
            console.log(
                `[ZoneUptime] ${section.monsterHrid} — ${section.fights} fight${section.fights === 1 ? '' : 's'}`
            );
            console.table(section.rows.map(tableRow));
        }
        if (result.dotRow) {
            console.log('[ZoneUptime] Damage over time (wave-level — the feed cannot say whose bleed):');
            console.table([tableRow(result.dotRow)]);
        }
        if (result.simOnlyHrids.length) {
            console.log(
                `[ZoneUptime] Sim-only monsters (not seen in this recording's waves): ${result.simOnlyHrids.join(', ')}`
            );
        }
        return { real, ...result };
    },
    // Dump a monster's raw ability kit from live game data — the cast order, each
    // ability's cooldown, and its defaultCombatTriggers (the gates that decide
    // when it fires) — so a cadence gap (sim over/under-casting an ability vs the
    // real fight) can be traced to the data. Pass a monster hrid, or omit it to
    // use the last tick-capture's monster.
    monsterAbilityData: (monsterHrid) => {
        const hrid = monsterHrid || captureFile()?.context?.monsterHrid;
        if (!hrid) {
            console.warn('[MonsterAbilityData] Pass a monster hrid, or arm a capture first.');
            return null;
        }
        const gameData = dataManager.getInitClientData();
        const monster = gameData?.combatMonsterDetailMap?.[hrid];
        const abilityMap = gameData?.abilityDetailMap || {};
        if (!monster) {
            console.warn('[MonsterAbilityData] No monster found for hrid:', hrid);
            return null;
        }
        // The array order IS the sim's cast priority (first eligible ability wins).
        const abilities = (monster.abilities || []).map((entry, index) => {
            const detail = abilityMap[entry.abilityHrid] || {};
            return {
                order: index,
                abilityHrid: entry.abilityHrid,
                level: entry.level,
                minDifficultyTier: entry.minDifficultyTier,
                cooldownSec: detail.cooldownDuration ? detail.cooldownDuration / 1e9 : null,
                castSec: detail.castDuration ? detail.castDuration / 1e9 : null,
                // The gates the sim reads (ability.js falls back to these for
                // monsters — no per-monster override is applied).
                defaultCombatTriggers: detail.defaultCombatTriggers || [],
                // Anything the game hangs on the monster's own ability entry that
                // the sim ignores (only abilityHrid/level/minDifficultyTier are read).
                entryExtraKeys: Object.keys(entry).filter(
                    (k) => !['abilityHrid', 'level', 'minDifficultyTier'].includes(k)
                ),
                buffUniqueHrids: (detail.abilityEffects || [])
                    .flatMap((e) => e.buffs || [])
                    .map((b) => b?.uniqueHrid)
                    .filter(Boolean),
                // The damage shape per effect — so a magnitude gap (sim over/under-
                // damaging an ability vs the real fight) can be told apart from a
                // cadence gap. baseDamageRatio ~0 with only buffs = a utility cast.
                damageEffects: (detail.abilityEffects || []).map((e) => ({
                    effectType: e.effectType,
                    damageType: e.damageType,
                    baseDamageRatio: e.baseDamageRatio,
                    baseDamageFlat: e.baseDamageFlat,
                    damageOverTimeRatio: e.damageOverTimeRatio,
                    damageOverTimeDuration: e.damageOverTimeDuration ? e.damageOverTimeDuration / 1e9 : 0,
                    hpDrainRatio: e.hpDrainRatio,
                    bonusAccuracyRatio: e.bonusAccuracyRatio,
                })),
            };
        });
        const out = { monsterHrid: hrid, abilities };
        console.log('[MonsterAbilityData]', hrid, '— cast order, cooldowns, and trigger gates:');
        console.log(JSON.stringify(out, null, 2));
        return out;
    },
    // Raw tick trace of the armed capture — per tick: the monster's prepared
    // abilityHrid, its attack counter, the player's HP, and the HP drop. Lets you
    // see where a hit actually lands relative to the ability label, to check the
    // uptime harness's real-side attribution (which names a hit by the previous
    // tick's abilityHrid — wrong if a hit lands as the label flips to the next
    // cast). Rows where the attack counter rises are flagged.
    uptimeTrace: (opts = {}) => {
        const capture = captureFile();
        const ticks = capture?.ticks;
        if (!ticks?.length) {
            console.warn('[UptimeTrace] No tick capture — arm a capture and fight the monster first.');
            return null;
        }
        const mi = opts.monsterIndex ?? '0';
        const pi = opts.playerIndex ?? '0';
        const short = (h) => (h ? h.slice(h.lastIndexOf('/') + 1) : '');
        let prevAtk;
        let prevPHP;
        let firstAt;
        const rows = ticks.map((tick, i) => {
            const at = tick?.at;
            if (firstAt === undefined && Number.isFinite(at)) firstAt = at;
            const monster = tick?.payload?.mMap?.[mi];
            const player = tick?.payload?.pMap?.[pi];
            const atk = monster ? Number(monster.atkCounter) : null;
            const php = player && Number.isFinite(Number(player.cHP)) ? Number(player.cHP) : null;
            const drop = prevPHP != null && php != null ? prevPHP - php : 0;
            const atkRose = prevAtk != null && atk != null && atk > prevAtk;
            const row = {
                i,
                ms: Number.isFinite(at) && firstAt !== undefined ? at - firstAt : null,
                preparing: monster ? short(monster.abilityHrid) : '(gone)',
                atk,
                atkRose: atkRose ? `+${atk - prevAtk}` : '',
                playerHP: php,
                drop: drop > 0 ? drop : '',
            };
            if (monster && atk != null) prevAtk = atk;
            else prevAtk = undefined;
            if (php != null) prevPHP = php;
            return row;
        });
        console.log(
            `[UptimeTrace] ${capture.context?.monsterHrid || '?'} — ${rows.length} ticks (attack rises flagged):`
        );
        console.table(rows);
        return rows;
    },
    guildXp: () => guildXPTracker.debugState(),
};

console.log('[Toolasha] Combat library loaded');
