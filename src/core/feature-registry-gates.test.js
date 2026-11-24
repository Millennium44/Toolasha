/**
 * Guard for the registry's live on/off: every entry in `registerFeatures()` (src/entrypoint.js) is either
 * gated on a setting the registry can read, or is on the allowlist below with the reason it needs no gate.
 *
 * Why it matters: `config.isFeatureEnabled(key)` answers true for a key that is neither a schema setting nor
 * a `config.features` key with a schema `settingKey`. A module whose initialize() bails on its own setting
 * was then recorded as started at login and never started again, so switching the setting on mid-session did
 * nothing until a reload (popOutChat, mentionTracker, alchemyProfitDisplay and others).
 */

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import config from './config.js';
import { getSettingDefinition } from './settings-schema.js';

/**
 * Entries with no setting gate. Each needs a one-line reason; a module that reads its setting only at
 * runtime (when it draws) or restarts itself from its own onSettingChange listener belongs here, one that
 * returns early from initialize() does not (give it `setting:` instead).
 */
const NO_GATE_NEEDED = {
    autoFillPrice: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    autoClickMax: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    tradeHistory: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    tradeLedgerStore: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    tradeLedgerView: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    staleCapitalView: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    marketVolumeStats: 'Registers its own onSettingChange listeners at import and starts or stops itself on them.',
    transmuteRates: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    characterCardButton: 'Registers its own onSettingChange listener at import and starts or stops itself on it.',
    actionCountdown: 'Registers its own onSettingChange listener before its setting check, so it restarts itself.',
    maxProduceable: 'initialize() never bails; it reads its settings when it draws and redraws on their listeners.',
    missingMaterialsButton: 'initialize() never bails; the button reads its setting each time a panel is processed.',
    costSummary: 'initialize() never bails; the summary reads its setting each time a panel updates.',
    scrollSimulatorUI: 'initialize() never bails; the button and its redraw follow the setting at runtime.',
    teaRecommendation: 'No setting switches it; its button is always offered and the settings tune the result.',
    estimatedListingAge: 'No setting switches it; it only records order-book history other features read.',
    inventoryBadgeManager: 'Shared infrastructure for the inventory badge features; no setting of its own.',
    chatBlockList: 'Mirrors the game block list for other chat features; no setting of its own.',
    housePanelObserver: 'Feeds the house cost display, which has no setting of its own to switch it.',
    metzPartyLoadoutPublisher: 'No setting of its own, like the loadout capture it reads (see the entry comment).',
    characterActivityStatus: 'Records the character activity projection other features read; no setting.',
};

/** Every `{ key, name, ... }` entry of registerFeatures(), with its source text. */
function readRegistryEntries() {
    const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'entrypoint.js'), 'utf8');
    const start = source.indexOf('function registerFeatures()');
    const end = source.indexOf('featureRegistry.replaceFeatures(features)');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const hits = [...body.matchAll(/key: '([A-Za-z0-9_]+)',\s*name:/g)];
    return hits.map((hit, n) => ({
        key: hit[1],
        text: body.slice(hit.index, n + 1 < hits.length ? hits[n + 1].index : undefined),
    }));
}

/** True when `config.isFeatureEnabled(key)` can say false for this key. */
function hasSettingSwitch(key) {
    if (getSettingDefinition(key)) return true;
    const feature = config.features?.[key];
    return Boolean(feature?.settingKey && getSettingDefinition(feature.settingKey));
}

/** The schema ids an entry's `setting:` field names (a string or an any-of array), or null when it has none. */
function settingIdsOf(entry) {
    const hit = /\bsetting: (?:'([^']+)'|\[([^\]]*)\])/.exec(entry.text);
    if (!hit) return null;
    return hit[1] ? [hit[1]] : [...hit[2].matchAll(/'([^']+)'/g)].map((id) => id[1]);
}

function isSelfGated(entry) {
    return /\bcustomCheck:/.test(entry.text) || /\bisRunning:/.test(entry.text) || settingIdsOf(entry) !== null;
}

/**
 * Entries gated on a settings-schema id that neither state `liveStop: true` nor tag every gating setting
 * `requiresRefresh: true`: the module follows its own setting live from an onSettingChange listener (registered at
 * import or in its first initialize()) that removes what it drew, so the registry's stop is not needed. Each reason
 * names that listener; a module whose listener does not tear down belongs in neither list (tag the setting).
 */
const LIVE_BY_OWN_LISTENER = {
    market_listingDragOrder: 'Its own onSettingChange listener calls cleanup() when switched off.',
    market_enhanceProfitPerHour: 'Its own onSettingChange listener calls disable() when switched off.',
    sellQueue: 'Its own onSettingChange listener calls cleanup() when switched off.',
    offlineProgressEconomics: 'Its own onSettingChange listener calls disable() when switched off.',
    inventorySort: 'Its own invSort listener calls disable() when switched off.',
    inventoryBadgePrices: 'Its own listener on the badge-mode select calls disable() when no price badge is wanted.',
    abilityBookCalculator: 'Its own skillbook listener calls disable() when switched off.',
    eliteAchievementReminder: 'Its own onSettingChange listener calls disable() when switched off.',
    loadoutEnhancementDisplay:
        'Its own listener removes the overlays when switched off, and drawing checks the setting.',
    loadoutTalismanCheck: 'Its own listener re-runs annotate(), which removes the markers once the setting is off.',
    zoneIndices: 'Gated on two settings (mapIndex, taskMapIndex); its own listeners enable or disable it on either.',
    skillExperiencePercentage: 'Its own expPercentage listener calls disable() when switched off.',
    combatLevelProgress: 'Its own onSettingChange listener calls disable() when switched off.',
    altClickNavigation: 'Its own onSettingChange listener calls disable() when switched off.',
    taskStatistics: 'Its own onSettingChange listener calls disable() when switched off.',
    taskClaimToast: 'Its own onSettingChange listener calls disable() when switched off.',
    taskRerollSpendBadge: 'Its own onSettingChange listener calls disable() when switched off.',
    riskOfRuin: 'Its own onSettingChange listener calls disable() when switched off.',
    actionTimingMonitor: 'Its own onSettingChange listener calls cleanup() when switched off.',
    labyrinthMonsterStatCheck: 'Its own listener calls disable() when switched off; isRunning() restarts it.',
    lootLogStats: 'Follows both of its settings live through syncParts() (explicit liveStop: false).',
    labyrinthClearRate: 'Follows both of its settings live through watchHalfSettings (explicit liveStop: false).',
    combatScale: 'apply() removes its stylesheet when the setting is off, and a listener on the setting re-runs it.',
};

/**
 * The schema ids that gate an entry: its `setting:` ids, else its key when that is a schema id, else the schema id
 * behind a `config.features` key. Null for a `customCheck:` entry (no setting names its gate) and for an entry
 * nothing gates.
 */
function gatingIdsOf(entry) {
    if (/\bcustomCheck:/.test(entry.text)) return null;
    const named = settingIdsOf(entry);
    if (named) return named;
    if (getSettingDefinition(entry.key)) return [entry.key];
    const feature = config.features?.[entry.key];
    return feature?.settingKey && getSettingDefinition(feature.settingKey) ? [feature.settingKey] : null;
}

/** True when the entry stops live, or every setting that gates it says a reload is needed. */
function honorsItsSwitch(entry) {
    if (/\bliveStop: true\b/.test(entry.text)) return true;
    const ids = gatingIdsOf(entry);
    return ids.every((id) => getSettingDefinition(id)?.requiresRefresh === true);
}

describe('feature registry gates', () => {
    const entries = readRegistryEntries();

    test('the scan finds the registry entries', () => {
        expect(entries.length).toBeGreaterThan(150);
        expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
    });

    test('every entry is gated on a setting, has a customCheck/isRunning, or is on the allowlist', () => {
        const ungated = entries
            .filter((entry) => !hasSettingSwitch(entry.key) && !isSelfGated(entry))
            .map((entry) => entry.key)
            .filter((key) => !Object.hasOwn(NO_GATE_NEEDED, key));
        expect(
            ungated,
            `Registry entries with no switch: ${ungated.join(', ')}. isFeatureEnabled() answers true for a key that is ` +
                `not a settings-schema id, so the registry starts the feature at login and never again. If the module ` +
                `returns early from initialize() on a setting, add \`setting: '<setting id>'\` (or an array of ids, any ` +
                `one on opens the gate) and \`liveStop: true|false\` (true when disable()/cleanup() removes everything) ` +
                `to its entry in ` +
                `src/entrypoint.js. If it reads its setting only when it draws, or restarts itself from its own ` +
                `onSettingChange listener, add the key to NO_GATE_NEEDED in this file with a one-line reason.`
        ).toEqual([]);
    });

    // disable()/cleanup() of each removes everything it drew and resets its init flag, so a setting switched
    // off mid-session stops it live (read from each module when this list was made)
    const LIVE_STOP = [
        'tokenShopShortcuts',
        'collectionNavigation',
        'enhancementXPH',
        'enhancementItemPins',
        'itemTooltip_wheelScroll',
        'inventoryTooltipBeside',
        'dungeonTokenTooltips',
        'dungeonShopPlanner',
        'marketFilter',
        'marketItemHop',
        'hideLabyrinthBadge',
        'hideGuildBadge',
        'externalLinks',
        'tabReorder',
        'draggableModals',
        'equipmentMismatchWarning',
        'taskClaimCollector',
        'autoAllButton',
        'panelSizeMemory',
        'combatDps',
        'popOutChat',
        'mentionTracker',
        'outputTotals',
        'craftingPlan',
        'alchemyProfitDisplay',
        'marketplaceBadgeFilter',
        'queueLengthEstimator',
        'tradeHistoryDisplay',
        'gatheringStats',
        'invCategoryTotals',
        'tooltipConsumables',
        'actionPanelLayout',
        'alchemyItemPins',
        'alchemyItemSort',
        'alchemyCatalystMark',
        'chestKeyMarketButton',
        'combatBattleCounter',
        'combatBossEta',
        'combatSummary',
        'portraitDps',
        'combatUnitBadges',
        'combatUnitBuffBars',
        'combatConsumableRunway',
        'labyrinthShopPrices',
        'combatSim',
        'labSim',
        'alchemyItemDimming',
        'talismanWindowValues',
        'talismanRerollAdvisor',
        'alchemy_transmuteHistory',
        'alchemy_coinifyHistory',
        'alchemy_decomposeHistory',
        'leaderboardXPTracker',
        'leaderboardXPDisplay',
        'taskIcons',
        'taskRerollProtection',
        'labyrinthTracker',
    ];

    test.each(LIVE_STOP)('%s stops live when its setting is switched off', (key) => {
        const entry = entries.find((candidate) => candidate.key === key);
        expect(entry, key).toBeTruthy();
        expect(entry.text, key).toMatch(/liveStop: true/);
    });

    // initialize() of each returns early on its own setting, which is not the registry key
    test.each([
        ['popOutChat', 'chat_popOut'],
        ['mentionTracker', 'chat_mentionTracker'],
        ['alchemyProfitDisplay', 'alchemy_profitDisplay'],
        ['outputTotals', 'actionPanel_outputTotals'],
        ['craftingPlan', 'actionPanel_bestCraftingPlan'],
        ['marketplaceBadgeFilter', 'market_badgeOnlyWhenFinished'],
        ['marketplaceBadgeFilter', 'notifications_marketListingFilled'],
        ['queueLengthEstimator', 'market_showQueueLength'],
        ['tradeHistoryDisplay', 'market_tradeHistory'],
        ['externalLinks', 'ui_externalLinks'],
        ['gatheringStats', 'actionPanel_showProfitPerHour_gathering'],
    ])('%s is gated on %s, the setting its module reads', (key, setting) => {
        const entry = entries.find((candidate) => candidate.key === key);
        expect(getSettingDefinition(setting), setting).toBeTruthy();
        const named = [
            ...(settingIdsOf(entry) ?? []),
            ...[...entry.text.matchAll(/getSetting\('([^']+)'/g)].map((m) => m[1]),
        ];
        expect(named, key).toContain(setting);
    });

    test('every `setting:` names existing schema ids, is not combined with customCheck, and states its liveStop', () => {
        const withSetting = entries.filter((entry) => settingIdsOf(entry) !== null);
        expect(withSetting.length).toBeGreaterThan(40);
        for (const entry of withSetting) {
            const ids = settingIdsOf(entry);
            expect(ids.length, `${entry.key}: empty setting array`).toBeGreaterThan(0);
            for (const id of ids) {
                expect(getSettingDefinition(id), `${entry.key}: '${id}' is not a settings-schema id`).toBeTruthy();
            }
            expect(entry.text, `${entry.key}: use setting: or customCheck:, not both`).not.toMatch(/\bcustomCheck:/);
            expect(
                entry.text,
                `${entry.key}: state \`liveStop: true\` (its disable()/cleanup() removes everything it drew and resets ` +
                    `its init flag, so the registry stops it when the setting goes off) or \`liveStop: false\`. The ` +
                    `registry does not default it: a teardown that leaves something behind must not be stopped live.`
            ).toMatch(/\bliveStop: (true|false)\b/);
        }
    });

    test('the allowlist names only entries that exist and still have no gate', () => {
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        for (const key of Object.keys(NO_GATE_NEEDED)) {
            const entry = byKey.get(key);
            expect(entry, `${key} is allowlisted but is not a registry entry; remove it`).toBeTruthy();
            expect(
                hasSettingSwitch(key) || isSelfGated(entry),
                `${key} is allowlisted but is now gated; remove it from NO_GATE_NEEDED`
            ).toBe(false);
        }
    });

    test('each reason on the allowlist is a sentence', () => {
        for (const [key, reason] of Object.entries(NO_GATE_NEEDED)) {
            expect(reason.length, key).toBeGreaterThan(15);
        }
    });

    test('every entry gated on a setting stops live, or its setting says a reload is needed', () => {
        const gated = entries.filter((entry) => gatingIdsOf(entry) !== null);
        expect(gated.length).toBeGreaterThan(100);
        const silent = gated
            .filter((entry) => !honorsItsSwitch(entry))
            .map((entry) => entry.key)
            .filter((key) => !Object.hasOwn(LIVE_BY_OWN_LISTENER, key));
        expect(
            silent,
            `Entries that keep running after their setting is switched off, with no "refresh to apply" tag: ` +
                `${silent.join(', ')}. The registry starts a feature when its setting goes on but stops it only with ` +
                `\`liveStop: true\`. Read the module's disable()/cleanup(): if it removes everything it drew and resets ` +
                `its init flag, add \`liveStop: true\` (and list the key in LIVE_STOP here); if not, tag the setting ` +
                `\`requiresRefresh: true\` in settings-schema.js; if the module stops itself from its own ` +
                `onSettingChange listener, name it in LIVE_BY_OWN_LISTENER with the reason.`
        ).toEqual([]);
    });

    test('LIVE_BY_OWN_LISTENER names only gated entries that still need it', () => {
        const byKey = new Map(entries.map((entry) => [entry.key, entry]));
        for (const key of Object.keys(LIVE_BY_OWN_LISTENER)) {
            const entry = byKey.get(key);
            expect(entry, `${key} is listed but is not a registry entry; remove it`).toBeTruthy();
            expect(gatingIdsOf(entry), `${key} is listed but no setting gates it`).not.toBeNull();
            expect(
                honorsItsSwitch(entry),
                `${key} now stops live or is tagged; remove it from LIVE_BY_OWN_LISTENER`
            ).toBe(false);
        }
    });

    test('an entry that stops live is not gated only by settings tagged requiresRefresh', () => {
        // Any-of entries may share one tagged setting with a sibling that does not stop (craftingPlan and the merged walk)
        for (const entry of entries.filter((candidate) => /liveStop: true/.test(candidate.text))) {
            const ids = gatingIdsOf(entry) ?? [];
            const allTagged = ids.length > 0 && ids.every((id) => getSettingDefinition(id)?.requiresRefresh === true);
            expect(allTagged, entry.key + ' stops live, so its setting should not say refresh to apply').toBe(false);
        }
    });
});
