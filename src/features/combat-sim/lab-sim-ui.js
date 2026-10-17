/**
 * Lab Sim UI
 * Floating panel for configuring and running labyrinth simulations.
 * Four tabs: Configure (editor + crate selectors), Single Sim, Upgrade, Skilling.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { onSyncPullApplied } from '../../utils/sync-merge-registry.js';
import { SKILLING_LOADOUTS_KEY } from './lab-skilling-loadouts.js';
import { LAB_SIM_KEYS, StoredValueMemo, pulledNames } from './sim-sync-keys.js';
import {
    buildGameDataPayload,
    buildAllPlayerDTOs,
    getCombatZones,
    getCommunityBuffs,
    getLabyrinthMonsters,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
} from './combat-sim-adapter.js';
import { runLabyrinthSimulation, cancelActiveSimulations } from './combat-sim-runner.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { wilsonInterval } from './engine/wilson.js';
import { findMaxLabyrinthLevel, defaultThreshold } from './labyrinth-level-finder.js';
import {
    runLabyrinthUpgradeAnalysis,
    runLabyrinthAllFightsAnalysis,
    computeSkillingClearRatesFromEditor,
    runSkillingUpgradeAnalysis,
    getStyleExcludedSkills,
    planWithinBudget,
    goldPerPercent,
    runLabyrinthCombinationCheck,
    generateCandidates,
    generateHouseCandidates,
    describeHouseScan,
    houseRoomMovesWinRate,
    MAX_HOUSE_LEVEL,
    MAX_GUILD_SHRINE_LEVEL,
    candidateAssignmentKey,
} from './upgrade-advisor.js';
import {
    configureFightGroup,
    estimateLabTriggerRun,
    groupFightsForScope,
    runLabTriggerOptimization,
} from './lab-trigger-optimizer.js';
import {
    describeLabTriggerEstimate,
    labTriggerLoadoutsHtml,
    labTriggerOptionsHtml,
    countLabTriggerChanges,
    renderLabTriggerResultsHtml,
    summarizeLabTriggerRun,
    sanitizeLabTriggerChoices,
    verifyChipHtml,
} from './lab-trigger-view.js';
import {
    VERIFY_DEFAULTS,
    canVerifyTriggerResult,
    isCloseCall,
    verifyLabCandidates,
    verifyTriggerChanges,
} from './verify-runner.js';
import {
    LAB_COMPARISON_BASELINE_KEY,
    LAB_COMPARISON_KEY,
    LabComparisonStore,
    makeLabRunEntry,
    renderLabComparisonPanel,
    wireLabComparisonPanel,
} from './lab-sim-comparison.js';
import {
    LAB_UPGRADE_DIMENSIONS,
    LAB_SCOPES,
    LAB_LEVEL_SOURCES,
    sanitizeLabUpgradeSelection,
    sanitizeLabLevelSource,
    resolveLabTargetLevel,
    labScopeTargetCount,
    labDimensionAvailability,
    labAbilityLevelTypeAvailability,
    estimateLabUpgradeSims,
    planLabUpgradeRun,
} from './lab-sim-upgrade-modes.js';
import {
    LAB_TOKEN_BUFF_GROUPS,
    MAX_LAB_TOKEN_LEVEL,
    readLiveTokenLevels,
    sanitizeTokenLevels,
    resolveTokenLevels,
    buildLabyrinthCombatBuffs,
    describeTokenOverrides,
} from './lab-token-buffs.js';
import { scopeEquipmentToSkill } from './skilling-gear-candidates.js';
import { collapseHeaderHtml, enhanceCollapsibles } from './collapsible-sections.js';
import {
    MAX_SWAP_LEVEL,
    MAX_ABILITY_SWAP_LEVEL,
    MAX_QUEUED_SWAPS,
    extractAbilityOrderSection,
    buildCombatAbilityCheck,
    buildCombatAbilityOrderCandidates,
    buildCombatSwapCandidate,
    checkedSwapKey,
    clampLevelFor,
    describeCheckedSwap,
    evaluateSkillingSwaps,
    groupFightsByLoadout,
    isAbilitySwap,
    mergeCheckedAbilityRows,
    resolveEquipmentHrid,
    resolveSwapHrid,
    sanitizeSwapOptions,
    sanitizeSwapQueues,
    searchAbilities,
    searchEquipmentItems,
} from './lab-swap-check.js';
import { generateSkillingCommunityBuffCandidates, MAX_COMMUNITY_BUFF_LEVEL } from './skilling-sim-helpers.js';
// The upgrade-row vocabulary — what a row would have you buy, and the handoff
// buttons for it — belongs to the combat sim panel; a labyrinth pick is the same
// candidate shape, so it gets the same two buttons rather than a second pair.
//
// Through the default export rather than as named imports: this file is reached
// by a bundle that does not own the combat sim panel, and a cross-bundle named
// import compiles to a property read off a global that carries only the default.
import combatSimUI from './combat-sim-ui.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront } from '../../utils/panel-z-index.js';
import { makeDraggable } from '../../utils/floating-panel.js';
import {
    createMaterialTab,
    removeMaterialTabs,
    visibleTabsContainer,
    navigateToMarketplace,
    ensureClearAllTabsControl,
    setupMarketplaceCleanupObserver,
    watchTabForAcquisition,
} from '../../utils/marketplace-tabs.js';
import { restoreGeometry, saveGeometry, saveOpenState, reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { saveUpgradeResults, loadUpgradeResults, clearUpgradeResults } from './upgrade-results-store.js';
import { formatWithSeparator, formatKMB, parseKMB } from '../../utils/formatters.js';
import { createEtaTracker } from '../../utils/progress-eta.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { SimEditor } from './sim-editor.js';
import bundledLabyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import { labyrinthFloorClearLevel } from '../combat/labyrinth-formulas.js';
import { ROOM_LEVEL_SHORTLIST_SIZE, measureRoomLevelGains } from './labyrinth-upgrade-levels.js';
import {
    createRowLevelMeasure,
    createSetupLevelSearch,
    createSkillingEvaluator,
    goalLevelForFloor,
    includedSkills,
    planSkillingGoal,
    renderCombinationHtml,
    annotateRoomsReached,
    mergeMultiSkillGearRows,
    renderPlanHtml,
    applySkillingCandidate,
    renderSkillBreakdownHtml,
    skillBreakdown,
    shortlistSkillingForRoomLevels,
    simulateCombination,
    uniformRoomLevels,
} from './lab-skilling-goals.js';
import { labyrinthClearRate, loadoutSnapshot } from '../../utils/bundle-bridge.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';

const PANEL_ID = 'mwi-lab-sim-panel';

/**
 * Where this panel was left, in the shared panel-geometry store.
 *
 * Geometry *and* the open flag. This deliberately went the other way once — the
 * argument being that a simulator is opened when you have a question, so
 * reopening it on every load would be in the way. In practice the question
 * outlives the page: a refresh mid-analysis, or the game reloading itself,
 * closed a panel that was being read and lost where you were in it. A panel you
 * left open is a panel you were using, and closing it says so.
 */
const GEOMETRY_KEY = 'labSimPanel';

/**
 * Storage key for the last Upgrade-tab results, remembered across refreshes
 * (opt-in). The `-fullkit` suffix orphans results persisted before lab sims
 * defaulted to the monster's full ability kit — a baseline computed against a
 * tier-0 subset monster must not be re-shown beside full-kit runs.
 */
const LAB_UPGRADE_RESULTS_KEY = 'labSimUpgradeResults-fullkit';

/** Floor sizes the resize grips will not take the panel below. */
const MIN_PANEL_WIDTH = 400;
const MIN_PANEL_HEIGHT = 300;

/**
 * The swaps queued under "Check a swap", per tab: `{ combat: [{hrid, level}], skilling: [...] }`.
 * Per character, since what is worth checking depends on what that character wears.
 */
const CHECKED_SWAPS_KEY = 'labSimCheckedSwaps';
/** The Tune triggers section's choices (open, include, precision, unticked loadouts), per character */
const TRIGGER_CHOICES_KEY = 'labSimTriggerChoices';

/** Which candidate sets the Upgrade tab has checked. */
const UPGRADE_DIMENSIONS_KEY = 'labSimUpgradeDimensions';

/** Which fights the Upgrade tab is weighing them for: `{ mode, monsters }`. */
const UPGRADE_SCOPE_KEY = 'labSimUpgradeScope';

/** Where the Configure-fight scope takes its room level from. */
const UPGRADE_LEVEL_SOURCE_KEY = 'labSimUpgradeLevelSource';

/**
 * Whether Ability Swaps is narrowed to the build guide's signature swaps.
 *
 * Remembered with the rest of the selection, and for the same reason: it is how
 * swaps should be ranked rather than something about one particular run, and an
 * unremembered narrowing means the next Analyze quietly costs several times as
 * much across a whole labyrinth.
 */
const UPGRADE_SWAP_AURA_KEY = 'labSimSwapAuraOnly';

/**
 * Whether the Guild Shrine set is capped to what the guild's own shrine
 * buildings can sell. Its own key, independent of Combat Sim's — the two
 * panels remember this choice separately. Defaults on: a shrine level the
 * guild cannot sell is not an upgrade anyone can buy.
 */
const SHRINE_CAP_GUILD_KEY = 'labSimShrineCapToGuild';

/**
 * Whether the Upgrade tab follows its win-rate pass with the room-level search.
 *
 * Off until asked for: the search is a binary search of simulations per
 * shortlisted candidate on top of what is already the panel's dearest run, and
 * the table it adds to is exactly today's while it is off.
 */
const UPGRADE_ROOM_LEVELS_KEY = 'labSimUpgradeRoomLevels';

/** The floor the room-level pass is aiming at, 0 for none. */
const UPGRADE_TARGET_FLOOR_KEY = 'labSimUpgradeTargetFloor';

/**
 * The Skilling tab's counterparts: whether its Analyze Upgrades follows up with
 * the room-level search, the clear-rate bar that search and the goal planner
 * aim at, and the floor they are trying to finish. Per character, with the rest
 * of the tab's inputs.
 */
const SKILLING_ROOM_LEVELS_KEY = 'labSimSkillingRoomLevels';
const SKILLING_TARGET_CLEAR_KEY = 'labSimSkillingTargetClear';
const SKILLING_TARGET_FLOOR_KEY = 'labSimSkillingTargetFloor';

/**
 * Labyrinth token levels the Configure tab is simulating under.
 *
 * Only the ones typed over the live run are stored, so a character who buys the
 * level they were exploring stops being told they differ from themselves — an
 * override equal to what is owned is simply an override that no longer shows.
 * Scoped per character alongside the rest of this tab's configuration, because
 * the tokens are a character's own and an alt has bought different ones.
 */
const TOKEN_BUFF_LEVELS_KEY = 'labSimTokenBuffLevels';

/**
 * The retired single `Mode` dropdown's value.
 *
 * Read once, on the way to the new keys, so anyone who had a mode remembered
 * lands on the equivalent dimension-and-scope selection instead of on the
 * defaults. Never written.
 */
const LEGACY_UPGRADE_MODE_KEY = 'labSimUpgradeMode';

/**
 * The fight budget a capped run stops at.
 *
 * Was two settings — one for Single Sim, one for Upgrade — both defaulting to
 * this number, and both describing the same standard budget the floor map and
 * the Automation tab take from `MAX_SIM_TRIALS` in `labyrinth-sim-cache.js`.
 * Kept as a local constant rather than imported from there: this panel is in a
 * different production bundle, and reaching across for one integer would pull
 * that module's whole sim graph in with it.
 */
const LAB_SIM_MAX_FIGHTS = 20000;
/** Schema default for `labyrinthSimMaxHours` */
const DEFAULT_LAB_SIM_MAX_HOURS = 24;

/** What a skilling upgrade row is actually paid for with, for the CSV column. */
const CSV_PAID_IN = {
    token: 'tokens',
    guild: 'credits + tokens',
    community: 'donated cowbells',
    gold: 'gold',
};

/** The skills the labyrinth runs a skilling room for, in the tab's own order. */
const SKILLING_SKILL_HRIDS = [
    '/skills/milking',
    '/skills/foraging',
    '/skills/woodcutting',
    '/skills/cheesesmithing',
    '/skills/crafting',
    '/skills/tailoring',
    '/skills/cooking',
    '/skills/brewing',
    '/skills/alchemy',
    '/skills/enhancing',
];

/**
 * The house-room option every labyrinth analysis passes.
 *
 * This tab ranks one number — the share of attempts that end in a clear — so the
 * rooms it can weigh are the rooms whose buffs can change a fight's outcome.
 * Every house room grants a global experience and rare-find buff for existing at
 * all, and admitting a room on those put all ten skilling rooms in a combat
 * table with nothing but the baseline's sampling noise to report.
 */
const HOUSE_WIN_RATE_ONLY = { winRateOnly: true };

/**
 * What to call an item, falling back to a readable form of its own hrid.
 * @param {string} hrid - Item hrid
 * @returns {string} Display name
 */
function itemName(hrid) {
    return (
        dataManager.getItemDetails?.(hrid)?.name ||
        String(hrid || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
    );
}

/**
 * Make text safe to sit inside a double-quoted HTML attribute.
 * Item names come from game data, and one apostrophe would end the attribute.
 * @param {string} value - Raw text
 * @returns {string} Escaped text
 */
function escapeHtmlAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Why a forced labyrinth armor swap does not credit the resale of what it
 * replaces: the run wants every element available, so the replaced set is kept.
 * A setting exists because these two really are alternatives.
 */
const KEPT_REASON_LABYRINTH =
    'since the labyrinth needs every set. Turn off "Keep gear the forced armor swaps replace" in settings to ' +
    'price these as straight swaps.';

/**
 * Why a *skilling* piece does not credit it. Different answer, and deliberately
 * not a setting: the body slot holds a plate while you fight and an outfit while
 * you chop, and nobody sells the plate to buy the outfit — so there is no second
 * position to switch to.
 */
const KEPT_REASON_SKILLING =
    'since it is combat gear you keep in a loadout — selling it to fund skilling gear is not a trade anybody makes.';

/**
 * Why a hand-checked swap does not credit a piece: a loadout the swap does not
 * reach still wears it. No setting changes this — only checking "All loadouts".
 */
const KEPT_REASON_CHECKED = 'since a loadout this swap does not reach still wears it.';

/** The same for a checked skilling swap: a skill kit the swap does not reach still wears the piece. */
const KEPT_REASON_CHECKED_SKILLING = 'since a skill kit this swap does not reach still wears it.';

/**
 * The sentence about a kept piece's uncredited resale. A piece worth nothing has no
 * resale to disclaim, so it earns no sentence; one with no price at all says so.
 * @param {Array<{name: string, enhancementLevel: number, priced?: boolean}>} kept - Pieces kept
 * @param {number} keptValue - Their summed resale
 * @param {string} reason - Why it is not credited
 * @param {(value: number) => string} money - Formats a coin figure
 * @returns {string} The sentence without its Keeping prefix, empty for nothing to say
 */
function keptResaleText(kept, keptValue, reason, money) {
    const names = kept.map((k) => `${k.name} +${k.enhancementLevel}`).join(', ');
    if (Number.isFinite(keptValue) && keptValue > 0) {
        return `Keeping ${names} — resale of ${money(keptValue)} deliberately not credited, ${reason}`;
    }
    if (kept.some((k) => k.priced === false)) return `Keeping ${names} — resale not credited (no price), ${reason}`;
    return '';
}

/**
 * Why a skilling row's kept pieces are kept: combat armor goes back in its
 * loadout, and a checked swap leaves a piece another kit still wears.
 * @param {Object} [candidate] - The row's candidate
 * @returns {string} The reason, as the tail of a sentence
 */
function skillingKeptReason(candidate) {
    if (!candidate?.keptUnreached) return KEPT_REASON_SKILLING;
    if (!candidate.keptCombat) return KEPT_REASON_CHECKED_SKILLING;
    return 'since it is combat gear you keep in a loadout, or a skill kit this swap does not reach still wears it.';
}

/**
 * The Cost cell of a gold row, in the wording the all-fights table uses.
 *
 * Four different things used to render as the same em dash or as a bare
 * negative number: a price, a free row, a row funded by its own resale, and a
 * row nobody could price. `cost ? formatWithSeparator(cost) : '—'` blanked the
 * free ones and printed the credit-funded ones as "-17,700,000", which reads as
 * a cost rather than as money coming back.
 *
 * @param {number|null|undefined} cost - Net coin cost; negative is a credit
 * @returns {string} Cell text
 */
function goldCostCell(cost) {
    if (cost > 0) return formatWithSeparator(cost);
    if (cost === 0) return 'free';
    return Number.isFinite(cost) ? `+${formatKMB(-cost)} back` : '—';
}

/**
 * The Gold/1% cell for a row, alongside the figure it sorts on.
 *
 * @param {number|null|undefined} cost - Net coin cost
 * @param {number} deltaPct - Improvement in percentage points
 * @returns {string} Cell text
 */
function goldPerPctCell(cost, deltaPct) {
    const value = goldPerPercent(cost, deltaPct);
    if (!Number.isFinite(value)) return '—';
    return value <= 0 ? 'pays for itself' : formatWithSeparator(value);
}

/**
 * Some text as one short line, for a collapsed section header.
 * @param {string} text - Any text
 * @param {number} [max=90] - Longest result
 * @returns {string}
 */
function oneLine(text, max = 90) {
    const flat = String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Orders shown per loadout before "Show all" in the Upgrade tab's Ability order section */
const LAB_ABILITY_ORDER_TOP = 5;
const ACCENT = '#4a9eff';
const ACCENT_BORDER = 'rgba(74, 158, 255, 0.5)';
const ACCENT_BG = 'rgba(74, 158, 255, 0.12)';
const ACCENT_BTN_BG = 'rgba(74, 158, 255, 0.2)';
const ACCENT_BTN_BORDER = 'rgba(74, 158, 255, 0.4)';

/** Shared styling for the small inputs and buttons inside an upgrade chip. */
const CHIP_INPUT_STYLE =
    'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:3px 5px; font-size:12px;';
const CHIP_BUTTON_STYLE =
    'background:rgba(255,255,255,0.06); border:1px solid #444; color:#aaa; padding:3px 8px; border-radius:4px; ' +
    'font-size:11px; cursor:pointer; font-family:inherit;';

/**
 * Options that belong to one candidate set, drawn inside that set's chip.
 *
 * Same arrangement as the combat sim panel: an option sits with the checkbox it
 * modifies, so it is never ambiguous which box the +Levels box is about. They
 * stay in the DOM while their set is unchecked and are hidden by
 * `_onUpgradeSelectionChanged`.
 */
const LAB_MODE_OPTIONS = {
    ability_level: `
        <span id="mwi-labsim-upgrade-level-group" data-lab-mode-options="ability_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <select class="toolasha-select" id="mwi-labsim-upgrade-level-type" style="${CHIP_INPUT_STYLE}">
                <option value="increment">+Levels</option>
                <option value="target">Target Lv</option>
            </select>
            <input id="mwi-labsim-upgrade-target-level" type="number" min="1" max="200" value="5" style="
                width:55px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Number of levels to add to each ability">
            <button id="mwi-labsim-ability-targets-toggle" title="Set a desired target level per ability instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    ability_swap: `
        <span id="mwi-labsim-swap-group" data-lab-mode-options="ability_swap" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <label id="mwi-labsim-swap-aura-label" title="Sim only the aura swap: the guide's aura group for the loadout's archetype, both sides of its OR — Critical Aura or Mystic Aura for magic, Critical Aura or Fierce Aura for melee/ranged, Invincible for a wark. Everything else in the guide's set is left out, which is most of the run. Across several fights each loadout is read for its own archetype, so a labyrinth mixing a melee and a magic loadout gets each build's own aura choice." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-labsim-swap-aura-only" style="margin:0; cursor:pointer;">
                Aura only
            </label>
        </span>`,
    combat_level: `
        <span id="mwi-labsim-combat-group" data-lab-mode-options="combat_level" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <button id="mwi-labsim-combat-targets-toggle" title="Set a desired target level per skill instead of a uniform boost" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    house: `
        <span id="mwi-labsim-house-group" data-lab-mode-options="house" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-house-target-level" type="number" min="1" max="${MAX_HOUSE_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Buy every room up to this level in one row — Lv2 → Lv5 is costed at levels 3, 4 and 5 together. Blank means one level up. Capped at ${MAX_HOUSE_LEVEL}.">
            <button id="mwi-labsim-house-targets-toggle" title="Set a target level per room instead of one number for all of them" style="${CHIP_BUTTON_STYLE}">Targets</button>
        </span>`,
    guild_shrine: `
        <span id="mwi-labsim-shrine-group" data-lab-mode-options="guild_shrine" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-shrine-target-level" type="number" min="1" max="${MAX_GUILD_SHRINE_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Buy every shrine buff up to this level in one row, costed at every level in between. Blank means one level up. Capped at each buff's own maximum.">
            <button id="mwi-labsim-shrine-targets-toggle" title="Set a target level per shrine instead of one number for all of them" style="${CHIP_BUTTON_STYLE}">Targets</button>
            <label id="mwi-labsim-shrine-cap-label" title="Only rank shrine levels your guild's shrine buildings can actually sell you: a shrine the guild has not built is left out entirely, and one built to Lv4 stops at Lv4. Uncheck to plan against shrines the guild would have to upgrade first — those rows say so." style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                <input type="checkbox" id="mwi-labsim-shrine-cap-guild" checked style="margin:0; cursor:pointer;">
                Guild-allowed only
            </label>
        </span>`,
    community_buff: `
        <span id="mwi-labsim-community-group" data-lab-mode-options="community_buff" style="display:none; align-items:center; gap:4px;">
            <span style="color:#2a2a4a;">|</span>
            <input id="mwi-labsim-community-target-level" type="number" min="1" max="${MAX_COMMUNITY_BUFF_LEVEL}" placeholder="Lv" style="
                width:48px; text-align:center; ${CHIP_INPUT_STYLE}"
                title="Sim the buff at this level rather than one level up — Lv3 → Lv8 in one row. Capped at ${MAX_COMMUNITY_BUFF_LEVEL}, which is what the game calls max. The cowbell figure is per minute of uptime either way; a level has no price of its own.">
        </span>`,
};

/**
 * Display name for a guild shrine, from its hrid.
 *
 * The same reading `generateGuildShrineCandidates` gives its rows, so a target
 * input and the row it produces name the same shrine the same way.
 * @param {string} shrineHrid - e.g. `/guild_shrines/force`
 * @returns {string} e.g. `Force`
 */
function shrineDisplayName(shrineHrid) {
    const slug = String(shrineHrid || '')
        .split('/')
        .filter(Boolean)
        .pop();
    if (!slug) return 'Shrine';
    return slug
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(0);
    return `${m}m ${s}s`;
}

/**
 * The purchases a budget plan comes to, deduplicated.
 *
 * Two picks can name the same item at the same enhancement — a plan covering
 * several loadouts often does — and a shopping list with the same tab twice is
 * a shopping list nobody trusts.
 *
 * @param {Array<Object>} picks - Picks from `planWithinBudget`
 * @returns {Array<Object>} From `upgradeRowPurchase`, in plan order
 */
function planPurchases(picks) {
    const seen = new Set();
    const items = [];

    for (const pick of picks || []) {
        const buy = combatSimUI.upgradeRowPurchase(pick);
        // A cape or quiver is enhanced at your own bench, never listed, so it
        // has no place on a marketplace trip; its row carries an Enhance button
        if (!buy || buy.selfEnhance) continue;

        const key = `${buy.itemHrid}+${buy.enhancementLevel}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(buy);
    }

    return items;
}

/**
 * Tabs `openPlanInMarketplace` has pinned to the marketplace, so the cleanup
 * observer below has something to watch. Cleared (not reassigned) whenever the
 * tabs themselves are cleared, so the observer's reference to this array stays
 * valid.
 */
const marketPlanTabs = [];

/**
 * This panel's owner id for the marketplace tabs it pins, passed to
 * `createMaterialTab` / `ensureClearAllTabsControl` and to
 * `removeMaterialTabs({ owner })`, so clearing a budget plan's tabs never
 * sweeps up another feature's pinned tabs.
 */
const TAB_OWNER = 'lab-sim';

/** Whether `setupMarketplaceCleanupObserver` has been started for `marketPlanTabs`. */
let marketPlanCleanupStarted = false;

/**
 * Drop every tab this panel pinned, and the bookkeeping array alongside them —
 * called both when the marketplace is closed out from under them and when the
 * user clears them by hand, so neither path leaves the other thinking tabs are
 * still live.
 */
function clearMarketPlanTabs() {
    removeMaterialTabs({ owner: TAB_OWNER });
    marketPlanTabs.length = 0;
}

/**
 * Wait for the marketplace's own tab bar to exist.
 *
 * Polled rather than observed: `handleGoToMarketplace` renders asynchronously
 * and the bar we want is whichever one is on screen, which only
 * `visibleTabsContainer` can decide — and it can only decide it once.
 *
 * @param {number} [attempts] - How many 100 ms tries before giving up
 * @returns {Promise<HTMLElement|null>} The visible tab bar, or null
 */
async function waitForMarketplaceTabs(attempts = 30) {
    for (let i = 0; i < attempts; i++) {
        const container = visibleTabsContainer();
        if (container) return container;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
}

/**
 * Put the whole budget plan on the marketplace as tabs.
 *
 * The same machinery the missing-materials list uses: open the market on the
 * first item so the tab bar exists, then clone one tab per purchase, each of
 * which jumps to its own item. A plan is a shopping trip, and a shopping trip
 * with eight items should not be eight round trips through this panel.
 *
 * @param {Array<Object>} picks - Picks from `planWithinBudget`
 * @returns {Promise<number>} How many tabs were added
 */
async function openPlanInMarketplace(picks) {
    const items = planPurchases(picks);
    if (!items.length) return 0;

    navigateToMarketplace(items[0].itemHrid, items[0].enhancementLevel);

    const container = await waitForMarketplaceTabs();
    const reference = container
        ? Array.from(container.children).find((tab) => tab.textContent?.includes('My Listings'))
        : null;
    if (!reference) return 0;

    // Ours are the only custom tabs the market should be carrying
    clearMarketPlanTabs();
    container.style.flexWrap = 'wrap';

    for (const item of items) {
        const material = {
            // One of each is what a plan buys, so "missing 1" is literally the
            // count this list is asking you to acquire
            itemHrid: item.itemHrid,
            itemName: item.name,
            missing: 1,
            required: 1,
            isTradeable: true,
        };
        const tab = createMaterialTab(
            material,
            reference,
            () => navigateToMarketplace(item.itemHrid, item.enhancementLevel),
            {
                owner: TAB_OWNER,
                onDismiss: () => {
                    const idx = marketPlanTabs.indexOf(tab);
                    if (idx !== -1) marketPlanTabs.splice(idx, 1);
                },
            }
        );
        container.appendChild(tab);
        marketPlanTabs.push(tab);

        // Retire the tab on its own once the item is in inventory, instead of
        // leaving "missing: 1" pinned forever — see watchTabForAcquisition for
        // the enhancement-level matching this relies on.
        watchTabForAcquisition(tab, {
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel,
            requiredCount: 1,
            itemName: item.name,
            onRetire: () => {
                const idx = marketPlanTabs.indexOf(tab);
                if (idx !== -1) marketPlanTabs.splice(idx, 1);
            },
        });
    }

    ensureClearAllTabsControl(
        container,
        reference,
        () => {
            marketPlanTabs.length = 0;
        },
        { owner: TAB_OWNER }
    );

    // Started once, lazily — it only acts once `marketPlanTabs` is non-empty, so
    // there is nothing to watch before the first plan is ever opened.
    if (!marketPlanCleanupStarted) {
        marketPlanCleanupStarted = true;
        setupMarketplaceCleanupObserver(clearMarketPlanTabs, marketPlanTabs);
    }

    return items.length;
}

/**
 * The room-level cells one result row contributes, or null when the pass was
 * not run.
 *
 * A measured row reads `+0` rather than a blank or a dash: "we looked and it
 * does nothing" is the answer for most upgrades and is the one thing a ranking
 * in room levels must not hide.
 *
 * "We did not look" is a different answer, and only the shortlist is looked at
 * — so an unmeasured row reads as a muted dash instead, the same mark this
 * table already uses for a cell with no number in it. Printing `+0` there made
 * the two indistinguishable at a glance, which quietly turned "unranked" into
 * "worthless". Both keep the tooltip that spells out which they are.
 *
 * @param {Object} result - One result row, annotated by `measureRoomLevelGains`
 * @param {Object} roomLevels - The analysis's `roomLevels` summary
 * @returns {{delta: number, deltaStr: string, deltaColor: string, floor: number,
 *   floorStr: string, title: string, reachesTarget: boolean}}
 */
function roomLevelCells(result, roomLevels) {
    const delta = Math.round(Number(result.roomLevelDelta) || 0);
    const measured = Boolean(result.roomLevelMeasured);
    const baselineFloor = roomLevels?.baselineFloor || 0;
    const floor = measured ? result.floorReached || 0 : baselineFloor;
    const targetFloor = Math.max(0, Math.floor(Number(roomLevels?.targetFloor) || 0));
    const level = measured ? result.maxRoomLevel : roomLevels?.baselineLevel || 0;
    return {
        delta,
        // `delta` above is still 0 for an unmeasured row, so the ranking is
        // unchanged; only what the cell says about it is.
        deltaStr: measured ? (delta >= 0 ? '+' : '') + delta : '—',
        deltaColor: !measured ? '#666' : delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888',
        floor,
        floorStr: floor > 0 ? `F${floor}` : '\u2014',
        reachesTarget: targetFloor > 0 && floor >= targetFloor,
        title: measured
            ? `Clears room level ${level}, which finishes floor ${floor} (its exit room is level ` +
              `${labyrinthFloorClearLevel(floor)}).`
            : 'Not searched — this upgrade did not rank inside the measured shortlist, so it has no ' +
              'level figure at all. A dash here is not a measured zero.',
    };
}

/**
 * Hours of grind per expected attempt a combat level saves: the combat-level
 * counterpart of the gear table's Per 1M. Lower is better. Infinity where the
 * levels save nothing (or make things worse) or no XP accrues to time them,
 * which the table draws as a dash and scores as nothing.
 * @param {Object} row - A combat-level result row
 * @returns {number} Hours, or Infinity
 */
export function levelHoursPerAttemptSaved(row) {
    const saved = -row?.attemptsDelta;
    if (!Number.isFinite(row?.levelTimeHours) || !(saved > 0)) return Infinity;
    return row.levelTimeHours / saved;
}

/** True for a result row whose candidate is a combat level. */
function isLevelRow(row) {
    return row?.candidate?.type === 'combat_level';
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * What the Combat levels table scores on: hours per attempt saved (lower is
 * better) and the average win-rate change (higher is better), counted equally.
 * A row whose change is inside the sims' noise has no figure in either, so a
 * lucky sample cannot top the default sort.
 */
const measuredOnly = (row, value) => (row?.significant === false ? null : value);
const LEVEL_SCORE_METRICS = [
    {
        key: 'hoursPer',
        label: 'Hours per attempt saved',
        lowerIsBetter: true,
        value: (row) => measuredOnly(row, levelHoursPerAttemptSaved(row)),
    },
    {
        key: 'avgWinDelta',
        label: 'Avg \u0394Win',
        lowerIsBetter: false,
        value: (row) => measuredOnly(row, row.avgWinDelta),
    },
];

/** What each Combat levels column sorts by, and which way is the good news. */
const LEVEL_SORTS = {
    skill: { get: (r) => r.candidate?.description || '', dir: 'asc' },
    time: { get: (r) => r.levelTimeHours, dir: 'asc' },
    attemptsDelta: { get: (r) => r.attemptsDelta, dir: 'asc' },
    hoursPer: { get: (r) => levelHoursPerAttemptSaved(r), dir: 'asc' },
    rooms: { get: (r) => r.appliedFights ?? r.fights.length, dir: 'desc' },
    avgWinDelta: { get: (r) => r.avgWinDelta, dir: 'desc' },
    // A row that scored nothing has no figure, so it stays last either way
    score: { get: (r) => (r.score > 0 ? r.score : null), dir: 'desc' },
};
const LEVEL_SORT_DEFAULT = { key: 'score', dir: 'desc' };

class LabSimUI {
    constructor() {
        this.panel = null;
        this._editor = null;
        this._skillingEditor = null;
        this.isRunning = false;
        this._runStarting = false;
        this._runStartToken = 0;
        this._detachDrag = null;
        this.elapsedTimer = null;
        this._activeTab = 'configure';
        this._maxLevel = null;
        // Monster hrid → the level its last Find Max search cleared at. Per
        // monster because a max level belongs to a fight, not to the panel.
        this._maxLevelByMonster = {};
        this._labyFindMaxMode = false;
        this._labyResults = null;
        this._upgradeAborted = false;
        // Guards _onUpgradeAnalyze against a second click landing while the
        // first is still in the async window before the Run button is hidden
        // (e.g. the editor isn't ready yet and buildAllPlayerDTOs is awaited) —
        // without it, two concurrent runs share _upgradeAborted and both write
        // resultsEl/saveUpgradeResults, so the loser's Stop silently no-ops and
        // its results vanish under the winner's.
        this._upgradeRunning = false;
        this._skillingAborted = false;
        this._skillingRunning = false;
        // The last Analyze Upgrades run, with everything the planner and the
        // combine button need to re-sim against it, and the rows ticked for
        // Sim together (indexes into its results, in the order they were ticked).
        this._skillingAnalysis = null;
        this._skillingChecked = [];
        this._skillingGoalKey = null;
        // The "Check a swap" queues, one per tab, and the sort the checked combat
        // table is in (kept apart from the generated table's)
        this._checkedSwaps = { combat: [], skilling: [] };
        this._swapOptions = sanitizeSwapOptions(null);
        // The Upgrade tab's Ability order section (the Include option's last result), kept so Show all can redraw it
        this._upgradeOrderSection = null;
        // Verify verdicts, the live analyses they can run against, and a token that retires a run in flight
        this._verifyToken = 0;
        this._verify = this._freshVerify();
        this._verifyLive = { all: null, order: null, trigger: null };
        // The Tune triggers section's choices; read back from storage on each build
        this._triggerChoices = sanitizeLabTriggerChoices(null);
        // The fights the section last listed (the Upgrade tab's target scope applied), and a counter that
        // lets only the newest asynchronous refresh draw
        this._triggerTargets = { scopeMode: 'current', groups: [], note: '' };
        // What the last result found, shown on the Tune triggers header while it is collapsed
        this._triggerSummary = '';
        // Bumped by every scope change, so a tuning run can tell the scope moved while it ran
        this._triggerScopeGen = 0;
        // What the Configure editor's DTOs looked like when a tuning run started or last changed, and the
        // timer that checks them after an editor event
        this._editorEditSig = null;
        this._editorEditTimer = null;
        this._triggerRefreshSeq = 0;
        this._checkedSwapSort = null;
        this._skillingSwapSortHandler = null;
        this._skillLoadouts = {};
        /**
         * The scoped key `_skillLoadouts` was read from, i.e. whose loadout
         * assignments are in memory. Null until the Skilling tab first loads
         * them; every write goes back to this key rather than to whoever is
         * current at the moment of the write.
         * @type {string|null}
         */
        this._skillLoadoutsKey = null;
        this._loadoutsCollapsed = true;
        // The singleton lives for the page, so this is never unsubscribed
        onSyncPullApplied((written) => this._adoptPulledSkillLoadouts(written));
        // The rest of the panel's remembered choices, re-read when a pull brings them
        onSyncPullApplied((written) => this._adoptPulledSettings(written));
        // What the grouped saves last saw stored, so each writes only the key that changed
        this._storedValues = new StoredValueMemo();
        this._upgradeSortHandler = null;
        this._skillingSortHandler = null;
        // Recorded single-target runs, so a fight can be read against the last
        // time it was asked rather than only against itself
        this._comparison = new LabComparisonStore();
        // Which labyrinth fights the target picker was last built from
        this._upgradeTargetHrids = null;
        // Labyrinth token levels typed over the live run's, buffKey → level.
        // Only the ones deliberately set: an empty object is "simulate what this
        // character actually owns", which is where every panel starts.
        this._tokenBuffOverrides = {};
        // Bumped by every save of the store it names. A restore captures it before its read and adopts nothing if
        // it moved: an edit made while the read was in flight is already saved, and the read holds the older value
        this._tokenBuffEdits = 0;
        this._swapEdits = 0;
        // Whether this character's stored queues have been read back; until then an option toggle must not write
        this._swapsLoaded = false;
        // Option paths toggled before then, laid over the stored options once they arrive
        this._optionEdits = [];
    }

    buildPanel() {
        if (this.panel) return;

        // Labyrinth tile right-clicks request a preconfigured open via this event
        this._openRequestHandler = (e) => {
            this.openPreconfigured(e.detail || {});
        };
        document.addEventListener('mwi-labsim-open', this._openRequestHandler);

        this.panel = document.createElement('div');
        this.panel.id = PANEL_ID;
        this.panel.style.cssText = `
            position: fixed;
            top: 60px;
            right: 60px;
            z-index: ${config.Z_FLOATING_PANEL};
            background: rgba(10, 10, 20, 0.97);
            border: 2px solid ${ACCENT_BORDER};
            border-radius: 10px;
            width: min(900px, 96vw);
            height: min(700px, 84vh);
            min-width: min(400px, 92vw);
            min-height: 300px;
            max-width: 90vw;
            max-height: 90vh;
            display: none;
            flex-direction: column;
            font-family: 'Segoe UI', sans-serif;
            color: #e0e0e0;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            cursor: grab;
            background: ${ACCENT_BG};
            border-bottom: 1px solid ${ACCENT_BORDER};
            border-radius: 8px 8px 0 0;
            flex-shrink: 0;
        `;
        header.innerHTML = `
            <span style="font-weight:700; font-size:14px; color:${ACCENT}; flex:1;">Lab Simulator</span>
            <button id="mwi-labsim-close" style="
                background:none; border:none; color:#aaa; font-size:22px;
                cursor:pointer; padding:0; line-height:1;">\u00d7</button>
        `;
        this._setupDrag(header);

        // Tab bar
        const tabBar = document.createElement('div');
        tabBar.id = 'mwi-labsim-tabbar';
        tabBar.style.cssText = 'display:flex; gap:0; padding:0; flex-shrink:0; border-bottom:1px solid #222;';
        const tabStyle = (active) => `
            flex: 1;
            padding: 7px 0;
            text-align: center;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            border: none;
            font-family: inherit;
            transition: all 0.1s;
            background: ${active ? ACCENT_BG : 'transparent'};
            color: ${active ? ACCENT : '#888'};
            border-bottom: 2px solid ${active ? ACCENT : 'transparent'};
        `;
        tabBar.innerHTML = `
            <button id="mwi-labsim-tab-configure" style="${tabStyle(true)}">Configure</button>
            <button id="mwi-labsim-tab-maxlevel" style="${tabStyle(false)}">Single Sim</button>
            <button id="mwi-labsim-tab-upgrade" style="${tabStyle(false)}">Upgrade</button>
            <button id="mwi-labsim-tab-skilling" style="${tabStyle(false)}">Skilling</button>
        `;

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; flex:1; min-width:0;';
        const inputStyle =
            'width:60px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px; text-align:center;';

        // ── Configure tab ──
        const configureContent = document.createElement('div');
        configureContent.id = 'mwi-labsim-configure-content';
        // Each tab scrolls as a whole: no section is capped with a scroll of its own
        configureContent.style.cssText =
            'display:flex; flex-direction:column; flex:1; overflow-y:auto; overflow-x:hidden;';

        const configureControls = document.createElement('div');
        configureControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        configureControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Monster</label>
            <select class="toolasha-select" id="mwi-labsim-monster" style="${selectStyle}"></select>
            <label style="color:#888; font-size:12px;">Level</label>
            <input id="mwi-labsim-level" type="number" min="1" max="1300" value="100" style="${inputStyle}">
        `;

        const crateRow = document.createElement('div');
        crateRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px 14px;
            border-bottom: 1px solid #222;
            flex-shrink: 0;
            font-size: 12px;
        `;
        const crateSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        crateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select class="toolasha-select" id="mwi-labsim-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Coffee</label>
            <select class="toolasha-select" id="mwi-labsim-coffee" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_coffee_crate">Basic</option>
                <option value="/items/advanced_coffee_crate">Advanced</option>
                <option value="/items/expert_coffee_crate" selected>Expert</option>
            </select>
            <label style="color:#888;">Food</label>
            <select class="toolasha-select" id="mwi-labsim-food" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_food_crate">Basic</option>
                <option value="/items/advanced_food_crate">Advanced</option>
                <option value="/items/expert_food_crate" selected>Expert</option>
            </select>
        `;

        const editorArea = document.createElement('div');
        editorArea.id = 'mwi-labsim-editor';
        editorArea.style.cssText = 'flex:0 0 auto; padding:10px 14px;';
        editorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        this._editor = new SimEditor({
            editorEl: editorArea,
            labMode: true,
            onRender: () => this._scheduleEditorEditCheck(),
        });
        // Most of the editor's inputs write straight into its DTOs without redrawing, so the edits that
        // matter to the Configure-fight trigger tuning are caught as events bubbling out of the editor
        for (const type of ['change', 'input', 'click']) {
            editorArea.addEventListener(type, () => this._scheduleEditorEditCheck());
        }

        configureContent.appendChild(
            this._makeSection('configure-setup', 'Setup', [configureControls, crateRow], {
                empty: 'monster, level and crates',
                summary: () => {
                    const select = this.panel?.querySelector('#mwi-labsim-monster');
                    const name = select?.selectedOptions?.[0]?.textContent || '';
                    const level = this.panel?.querySelector('#mwi-labsim-level')?.value;
                    return name ? `${name} · L${level}` : '';
                },
            })
        );

        // Collapsible Labyrinth Buffs section
        const buffsSection = document.createElement('div');
        buffsSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';

        const buffsHeader = document.createElement('div');
        buffsHeader.id = 'mwi-labsim-buffs-header';
        buffsHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        buffsHeader.innerHTML = `
            <span>Labyrinth Buffs</span>
            <span style="display:inline-flex; align-items:center; gap:8px;">
                <span id="mwi-labsim-buffs-note" style="color:#ffb74d; font-size:11px;"></span>
                <span id="mwi-labsim-buffs-toggle" style="font-size:10px;">\u25B6</span>
            </span>
        `;

        const buffsBody = document.createElement('div');
        buffsBody.id = 'mwi-labsim-buffs-body';
        buffsBody.style.cssText = 'display:none; padding:4px 14px 8px; font-size:11px;';

        buffsHeader.addEventListener('click', () => {
            const isOpen = buffsBody.style.display !== 'none';
            buffsBody.style.display = isOpen ? 'none' : 'block';
            this.panel.querySelector('#mwi-labsim-buffs-toggle').textContent = isOpen ? '\u25B6' : '\u25BC';
            if (!isOpen) this._renderBuffsSection();
        });

        buffsSection.appendChild(buffsHeader);
        buffsSection.appendChild(buffsBody);
        configureContent.appendChild(buffsSection);

        configureContent.appendChild(
            this._makeSection('configure-editor', 'Loadout editor', [editorArea], {
                empty: 'loadout, abilities and house',
                summary: () => 'loadout, abilities and house',
            })
        );

        // ── Max Level tab ──
        const maxLevelContent = document.createElement('div');
        maxLevelContent.id = 'mwi-labsim-maxlevel-content';
        maxLevelContent.style.cssText =
            'display:none; flex-direction:column; flex:1; overflow-y:auto; overflow-x:hidden;';

        const maxLevelControls = document.createElement('div');
        maxLevelControls.style.cssText = `
            display: flex; align-items: center; gap: 12px;
            padding: 8px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        maxLevelControls.innerHTML = `
            <button id="mwi-labsim-run" style="
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;">Simulate</button>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Binary search for highest beatable level at the specified win rate threshold">
                <input type="checkbox" id="mwi-labsim-findmax" style="margin:0; cursor:pointer;">
                Find Max \u2265
            </label>
            <input id="mwi-labsim-threshold" type="number" min="1" max="100" value="${config.getSettingValue('labyrinthRecommendTargetRate', 70)}" style="width:44px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            <span style="color:#888; font-size:12px;">%</span>
            <span style="width:1px; height:16px; background:#333; margin:0 2px;"></span>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="How tightly to pin each fight's win rate down before its sim stops, in percentage points. A settled fight reaches it in a few hundred trials; one near a coin toss needs thousands. Lower is more accurate but slower.">
                Precision ±
                <input id="mwi-labsim-precision" type="number" min="0.1" max="10" step="0.5" value="${Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1))))}" style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
                <span style="font-size:12px;">%</span>
            </label>
            <span style="width:1px; height:16px; background:#333; margin:0 2px;"></span>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Simulated-time ceiling for the run, in hours — the fight clock inside the sim, not how long you wait. Precision usually ends it first. Tick Uncapped to ignore it. Shared with every other labyrinth sim and with Settings.">
                Max hrs
                <input id="mwi-labsim-maxhours" type="number" min="1" step="1" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthSimMaxHours', DEFAULT_LAB_SIM_MAX_HOURS)) || DEFAULT_LAB_SIM_MAX_HOURS)}" style="width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Ignore the fight budget and the time ceiling and run until the precision target is met. One stopping rule for every labyrinth sim — the floor map and the Automation tab follow it too.">
                <input type="checkbox" id="mwi-labsim-uncapped" style="margin:0; cursor:pointer;"${config.getSettingValue('labyrinthSimCaps', 'capped') === 'precision' ? ' checked' : ''}>
                Uncapped
            </label>
        `;

        const maxLevelProgress = document.createElement('div');
        maxLevelProgress.id = 'mwi-labsim-progress';
        maxLevelProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        maxLevelProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0%</span>
                </div>
                <button id="mwi-labsim-stop" style="
                    background:rgba(255,80,80,0.2); color:#f44; border:1px solid rgba(255,80,80,0.4);
                    border-radius:4px; padding:2px 10px; font-size:11px; cursor:pointer; font-weight:600;">Stop</button>
            </div>
        `;

        const maxLevelResults = document.createElement('div');
        maxLevelResults.id = 'mwi-labsim-results';
        maxLevelResults.style.cssText = 'flex:0 0 auto; padding:10px 14px;';

        maxLevelContent.appendChild(maxLevelControls);
        maxLevelContent.appendChild(maxLevelProgress);
        maxLevelContent.appendChild(
            this._makeSection('single-results', 'Results', [maxLevelResults], { empty: 'no results yet' })
        );

        // ── Upgrade tab ──
        const upgradeContent = document.createElement('div');
        upgradeContent.id = 'mwi-labsim-upgrade-content';
        // The tab scrolls as a whole: no results box is capped with a scroll of its own
        upgradeContent.style.cssText =
            'display:none; flex-direction:column; flex:1; overflow-y:auto; overflow-x:hidden;';

        const upgradeControls = document.createElement('div');
        upgradeControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        // The shared select style is `flex:1; min-width:0`, which is right for a
        // row of two and wrong for this one: seven controls sharing the width
        // squeezed Player and Mode down to a caret and nothing else. These size
        // to their content with a floor, and the row wraps instead of crushing.
        const upgradeSelectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; ' +
            'padding:3px 6px; font-size:12px; flex:0 1 auto; min-width:150px; max-width:100%;';
        upgradeControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Player</label>
            <select class="toolasha-select" id="mwi-labsim-upgrade-player" style="${upgradeSelectStyle}"></select>
            <label style="color:#888; font-size:12px;">Include</label>
            ${LAB_UPGRADE_DIMENSIONS.map(
                (dimension) => `
            <span data-lab-mode-chip="${dimension.key}" style="display:inline-flex; align-items:center; gap:6px;
                padding:3px 8px; border:1px solid #2a2a4a; border-radius:6px;">
                <label data-lab-mode-label="${dimension.key}" title="${dimension.title.replace(/"/g, '&quot;')}"
                    style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;">
                    <input type="checkbox" data-lab-upgrade-dimension="${dimension.key}" style="margin:0; cursor:pointer;"${
                        dimension.defaultOn ? ' checked' : ''
                    }>
                    ${dimension.label}
                </label>
                ${LAB_MODE_OPTIONS[dimension.key] || ''}
            </span>`
            ).join('')}
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="How tightly to pin each comparison's win rate down before its baseline sim stops, in percentage points. Lower is more accurate but slower. Shared with the Single Sim tab and Settings.">
                Precision ±
                <input id="mwi-labsim-upgrade-precision" type="number" min="0.1" max="10" step="0.5" value="${Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1))))}" style="width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
                <span style="font-size:12px;">%</span>
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888;" title="Simulated-time ceiling for each comparison sim, in hours — the fight clock inside the sim, not how long you wait. Precision usually ends it first. Tick Uncapped to ignore it. Shared with every other labyrinth sim and with Settings.">
                Max hrs
                <input id="mwi-labsim-upgrade-maxhours" type="number" min="1" step="1" value="${Math.max(1, parseInt(config.getSettingValue('labyrinthSimMaxHours', DEFAULT_LAB_SIM_MAX_HOURS)) || DEFAULT_LAB_SIM_MAX_HOURS)}" style="width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px; text-align:center;">
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; cursor:pointer;" title="Ignore the fight budget and the time ceiling and run each comparison's baseline to the precision target. One stopping rule for every labyrinth sim — the floor map and the Automation tab follow it too.">
                <input type="checkbox" id="mwi-labsim-upgrade-uncapped" style="margin:0; cursor:pointer;"${config.getSettingValue('labyrinthSimCaps', 'capped') === 'precision' ? ' checked' : ''}>
                Uncapped
            </label>
            <button id="mwi-labsim-upgrade-run" style="
                margin-left: auto; flex-shrink: 0;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Analyze</button>
            <button id="mwi-labsim-upgrade-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        // Which fights the checked candidate sets are weighed for. Orthogonal to
        // the sets themselves, which is why it is its own row rather than more
        // entries in a mode list.
        const upgradeScopeRow = document.createElement('div');
        upgradeScopeRow.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        upgradeScopeRow.innerHTML = `
            <label style="color:#888; font-size:12px;">Targets</label>
            <select class="toolasha-select" id="mwi-labsim-upgrade-scope" style="${upgradeSelectStyle}">
                ${LAB_SCOPES.map(
                    (scope) =>
                        `<option value="${scope.key}" title="${scope.title.replace(/"/g, '&quot;')}">${scope.label}</option>`
                ).join('')}
            </select>
            <label id="mwi-labsim-allfights-useskip-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="Sim each fight at its automation skip level (effective combat level + skip − 1) instead of the current run's live room levels">
                <input type="checkbox" id="mwi-labsim-allfights-useskip" checked style="margin:0; cursor:pointer;">
                Use Skip Levels
            </label>
            <label id="mwi-labsim-level-source-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="Which level the Configure fight is analysed at. The other scopes take each fight's own room level from the automation table.">
                At
                <select class="toolasha-select" id="mwi-labsim-level-source" style="${upgradeSelectStyle}">
                    ${LAB_LEVEL_SOURCES.map(
                        (levelSource) =>
                            `<option value="${levelSource.key}" title="${levelSource.title.replace(/"/g, '&quot;')}">${levelSource.label}</option>`
                    ).join('')}
                </select>
                <span id="mwi-labsim-level-source-resolved" style="color:#666; font-size:11px; white-space:nowrap;"></span>
            </label>
            <label id="mwi-labsim-room-levels-label" style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="After the win-rate pass, measure the top ${ROOM_LEVEL_SHORTLIST_SIZE} upgrades in room levels: how much deeper this character clears at the Target Win % bar, and which floor that reaches. Floor N runs levels 20N to 20N+20, and reaching a floor means clearing the TOP of its band — the exit sits in the far corner, so a floor you cannot finish is a floor you have not got. Configure-fight scope only, and it adds a binary search of sims per measured upgrade.">
                <input type="checkbox" id="mwi-labsim-upgrade-room-levels" style="margin:0; cursor:pointer;">
                Room levels
            </label>
            <label id="mwi-labsim-target-floor-label" style="display:none; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="The floor you are trying to finish. Its requirement is the top of its own band — floor N needs room level 20N+20, the exit room — and the rows say which upgrades reach it.">
                Floor
                <input id="mwi-labsim-upgrade-target-floor" type="number" min="1" step="1" placeholder="—" style="
                    width:48px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                    border-radius:4px; padding:3px 4px; font-size:12px;">
            </label>
            <span id="mwi-labsim-scope-summary" style="color:#666; font-size:11px;"></span>
        `;

        // The subset picker itself: one checkbox per labyrinth fight, filled in
        // when the tab is opened because game data is not loaded when the panel
        // is built
        const labTargetList = document.createElement('div');
        labTargetList.id = 'mwi-labsim-target-list';
        labTargetList.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:6px 14px; flex-wrap:wrap; align-items:center; border-left:3px solid ' +
            ACCENT_BTN_BORDER +
            ';';

        // Per-ability target levels for Ability Levels / combined modes
        // (hidden until toggled; inputs built from equipped abilities on open)
        const labAbilityTargets = document.createElement('div');
        labAbilityTargets.id = 'mwi-labsim-ability-targets';
        labAbilityTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        // Per-skill target levels for the Combat Levels modes (hidden until toggled)
        const labCombatTargets = document.createElement('div');
        labCombatTargets.id = 'mwi-labsim-combat-targets';
        labCombatTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';
        labCombatTargets.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level skips the skill; used instead of the +Levels boost while open):</span>' +
            [
                ['staminaLevel', 'Stamina'],
                ['intelligenceLevel', 'Int'],
                ['attackLevel', 'Attack'],
                ['meleeLevel', 'Melee'],
                ['defenseLevel', 'Defense'],
                ['rangedLevel', 'Ranged'],
                ['magicLevel', 'Magic'],
            ]
                .map(
                    ([key, label]) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${label}</label>
                    <input type="number" min="1" max="200" data-lab-combat-target="${key}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');

        // Per-room house target levels (hidden until toggled; built from the
        // rooms that can move a win rate when it is opened)
        const labHouseTargets = document.createElement('div');
        labHouseTargets.id = 'mwi-labsim-house-targets';
        labHouseTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        // Per-shrine target levels, on exactly the House grid's terms: a shrine
        // sitting at Lv2 and one sitting at Lv14 have no business sharing a
        // single Lv box, which is what the one spinner made them do
        const labShrineTargets = document.createElement('div');
        labShrineTargets.id = 'mwi-labsim-shrine-targets';
        labShrineTargets.style.cssText =
            'display:none; padding:4px 14px 8px; flex-shrink:0; gap:8px 14px; flex-wrap:wrap; align-items:center;';

        const upgradeProgress = document.createElement('div');
        upgradeProgress.id = 'mwi-labsim-upgrade-progress';
        upgradeProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        upgradeProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-upgrade-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-upgrade-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        // "Check a swap": a piece chosen by hand, run through the same analysis as
        // the generated rows. Its table sits above theirs and is not cleared by
        // an Analyze run, so a checked swap stays put while the generated list
        // is re-run beside it.
        const swapBarCombat = this._buildSwapBar('combat');
        const swapResultsCombat = document.createElement('div');
        swapResultsCombat.id = 'mwi-labsim-swap-results';
        swapResultsCombat.style.cssText = 'display:none; flex:0 0 auto; padding:10px 14px;';

        // Tune triggers: its results sit inside the section, below its controls, kept apart from both tables
        // so neither run clears the other
        const triggerBar = this._buildTriggerBar();

        const upgradeResults = document.createElement('div');
        upgradeResults.id = 'mwi-labsim-upgrade-results';
        upgradeResults.style.cssText = 'flex:1 0 auto; padding:10px 14px;';

        // The Ability order Include option's section: its own box, so a table redraw leaves it be
        const upgradeOrderResults = document.createElement('div');
        upgradeOrderResults.id = 'mwi-labsim-upgrade-order';
        upgradeOrderResults.style.cssText = 'display:none; flex:0 0 auto; padding:0 14px 10px;';

        upgradeContent.appendChild(upgradeControls);
        upgradeContent.appendChild(upgradeScopeRow);
        upgradeContent.appendChild(labTargetList);
        upgradeContent.appendChild(labAbilityTargets);
        upgradeContent.appendChild(labCombatTargets);
        upgradeContent.appendChild(labHouseTargets);
        upgradeContent.appendChild(labShrineTargets);
        upgradeContent.appendChild(swapBarCombat);
        upgradeContent.appendChild(triggerBar);
        upgradeContent.appendChild(upgradeProgress);
        upgradeContent.appendChild(swapResultsCombat);
        upgradeContent.appendChild(this._buildUpgradesHeader('combat'));
        upgradeContent.appendChild(upgradeResults);
        upgradeContent.appendChild(upgradeOrderResults);

        // ── Skilling tab ──
        const skillingContent = document.createElement('div');
        skillingContent.id = 'mwi-labsim-skilling-content';
        // The whole tab scrolls as one page so expanded sections (Player Setup,
        // loadouts) are never clipped by their own tiny scroll areas
        skillingContent.style.cssText = 'display:none; flex-direction:column; flex:1; overflow-y:auto;';

        const skillingControls = document.createElement('div');
        skillingControls.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
            padding: 10px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        skillingControls.innerHTML = `
            <label style="color:#888; font-size:12px;">Room Level</label>
            <input id="mwi-labsim-skilling-level" type="number" min="1" max="1300" value="100" disabled style="${inputStyle}">
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="Use each skill's automation skip level to derive its room level (effective level + skip - 1)">
                <input type="checkbox" id="mwi-labsim-skilling-useskip" checked style="margin:0; cursor:pointer;">
                Use Skip Levels
            </label>
            <label style="color:#888; font-size:12px;">Skill</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-filter" title="Restrict calculations, upgrade analysis, and the loadout table to one skill" style="
                background:#1a1a2e;
                color:#e0e0e0;
                border:1px solid #444;
                border-radius:4px;
                padding:4px 6px;
                font-size:11px;
                font-family:inherit;">
                <option value="">All Skills</option>
                <option value="/skills/woodcutting">Woodcutting</option>
                <option value="/skills/foraging">Foraging</option>
                <option value="/skills/milking">Milking</option>
                <option value="/skills/cooking">Cooking</option>
                <option value="/skills/brewing">Brewing</option>
                <option value="/skills/cheesesmithing">Cheesesmithing</option>
                <option value="/skills/crafting">Crafting</option>
                <option value="/skills/tailoring">Tailoring</option>
                <option value="/skills/alchemy">Alchemy</option>
                <option value="/skills/enhancing">Enhancing</option>
            </select>
            <label style="color:#888; font-size:12px;">Community Lv</label>
            <input id="mwi-labsim-skilling-community-level" type="number" min="1" max="${MAX_COMMUNITY_BUFF_LEVEL}"
                placeholder="Lv" title="Sim each community buff at this level rather than one level up — Lv3 → Lv8 in one row. Capped at ${MAX_COMMUNITY_BUFF_LEVEL}, which the game calls max. The cowbell figure is per minute of uptime either way; a level has no price of its own." style="
                width:52px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                border-radius:4px; padding:4px 6px; font-size:11px; font-family:inherit;">
            <button id="mwi-labsim-skilling-calc" style="
                margin-left: auto;
                background: ${ACCENT_BTN_BG};
                color: ${ACCENT};
                border: 1px solid ${ACCENT_BTN_BORDER};
                border-radius: 6px;
                padding: 5px 14px;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                font-family: inherit;">Calculate</button>
            <button id="mwi-labsim-skilling-upgrade" title="Sims token upgrades one level up and each equipment piece at its next enhancement breakpoint — when a breakpoint doesn't move the clear rate, the target keeps ticking up one level at a time until it has a positive impact (which is why some rows show a higher level than the next breakpoint)" style="
                background: rgba(255,255,255,0.04);
                border: 1px solid #333;
                color: #aaa;
                border-radius: 6px;
                padding: 5px 10px;
                font-size: 12px;
                cursor: pointer;
                font-family: inherit;">Analyze Upgrades</button>
            <button id="mwi-labsim-skilling-stop" style="
                display:none;
                background:rgba(244, 67, 54, 0.2);
                border:1px solid rgba(244, 67, 54, 0.4);
                color:#f44336;
                border-radius:4px;
                padding:5px 10px;
                font-size:12px;
                font-weight:600;
                cursor:pointer;
                font-family:inherit;">Stop</button>
        `;

        // Room levels, the clear-rate bar, the floor, and the two actions that
        // work from them. The bar is the tab's own: it averages over several
        // rooms, which the Target Win % the combat tabs share does not mean.
        const skillingGoalRow = document.createElement('div');
        skillingGoalRow.style.cssText = `
            display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0;
        `;
        const goalInputStyle =
            'width:48px; text-align:center; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 4px; font-size:12px;';
        const goalButtonStyle = `background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa; border-radius:6px; padding:4px 10px; font-size:12px; cursor:pointer; font-family:inherit;`;
        skillingGoalRow.innerHTML = `
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                title="After Analyze Upgrades, measure the top ${ROOM_LEVEL_SHORTLIST_SIZE} upgrades in room levels: the deepest room that still clears at the Target clear % bar, and which floor that finishes. Floor N needs room level 20N+20, its exit room. A skilling room is cheap to simulate, so this adds little time.">
                <input type="checkbox" id="mwi-labsim-skilling-room-levels" style="margin:0; cursor:pointer;">
                Room levels
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="The average clear rate over the chosen skills that a room level, or the goal planner, has to reach. All Skills averages every skilling room, exactly like the baseline row; one skill measures just that skill.">
                Target clear
                <input id="mwi-labsim-skilling-target-clear" type="number" min="1" max="100" value="${Math.min(100, Math.max(1, Math.floor(Number(config.getSettingValue('labyrinthRecommendTargetRate', 70)) || 70)))}" style="${goalInputStyle}">
                <span>%</span>
            </label>
            <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px;"
                title="The floor to finish. Floor N needs room level 20N+20, its exit room. Rows that reach it are marked, and Plan to goal buys toward it. Leave empty to plan for the Target clear % at the Room Level above.">
                Floor
                <input id="mwi-labsim-skilling-target-floor" type="number" min="1" step="1" placeholder="—" style="${goalInputStyle}">
            </label>
            <button id="mwi-labsim-skilling-plan" title="Needs Analyze Upgrades first. From today's setup, repeatedly takes the upgrade with the best cost per point of clear rate (simmed together with the ones already taken) until the goal is met or nothing helps." style="${goalButtonStyle}">Plan to goal</button>
            <button id="mwi-labsim-skilling-combine" title="Sims every checked row at once, one upgrade per slot (a later pick replaces an earlier one for the same slot)." style="${goalButtonStyle}">Sim together</button>
            <span id="mwi-labsim-skilling-checked-count" style="color:#666; font-size:11px;"></span>
        `;

        const skillingCrateRow = document.createElement('div');
        skillingCrateRow.style.cssText = `
            display: flex; align-items: center; gap: 10px;
            padding: 6px 14px; border-bottom: 1px solid #222; flex-shrink: 0; font-size: 12px;
        `;
        skillingCrateRow.innerHTML = `
            <label style="color:#888;">Tea</label>
            <select class="toolasha-select" id="mwi-labsim-skilling-tea" style="${crateSelectStyle}">
                <option value="">None</option>
                <option value="/items/basic_tea_crate">Basic</option>
                <option value="/items/advanced_tea_crate">Advanced</option>
                <option value="/items/expert_tea_crate" selected>Expert</option>
            </select>
            <span style="color:#666;">Only the tea crate applies in skilling rooms</span>
        `;

        const skillingLoadoutArea = document.createElement('div');
        skillingLoadoutArea.id = 'mwi-labsim-skilling-loadouts';
        skillingLoadoutArea.style.cssText = 'padding:8px 14px; border-bottom:1px solid #222; flex-shrink:0;';

        // Player setup (skill levels, house rooms, token upgrades, community
        // buffs) is collapsed by default to keep the tab compact — it's only
        // needed when overriding the live character's values
        const skillingEditorSection = document.createElement('div');
        skillingEditorSection.style.cssText = 'border-bottom:1px solid #222; flex-shrink:0;';
        const skillingEditorHeader = document.createElement('div');
        skillingEditorHeader.style.cssText =
            'display:flex; align-items:center; justify-content:space-between; padding:6px 14px; cursor:pointer; color:#888; font-size:12px;';
        skillingEditorHeader.innerHTML = `
            <span>Player Setup</span>
            <span id="mwi-labsim-skilling-editor-toggle" style="font-size:10px;">▶</span>
        `;

        const skillingEditorArea = document.createElement('div');
        skillingEditorArea.id = 'mwi-labsim-skilling-editor';
        skillingEditorArea.style.cssText = 'display:none; padding:10px 14px; flex-shrink:0;';
        skillingEditorArea.innerHTML =
            '<div style="color:#555; font-size:12px; text-align:center; padding:20px 0;">Loading loadout...</div>';

        skillingEditorHeader.addEventListener('click', () => {
            const isOpen = skillingEditorArea.style.display !== 'none';
            skillingEditorArea.style.display = isOpen ? 'none' : 'block';
            skillingEditorHeader.querySelector('#mwi-labsim-skilling-editor-toggle').textContent = isOpen ? '▶' : '▼';
        });
        skillingEditorSection.appendChild(skillingEditorHeader);
        skillingEditorSection.appendChild(skillingEditorArea);

        this._skillingEditor = new SimEditor({ editorEl: skillingEditorArea, labMode: true, skillingMode: true });

        const skillingProgress = document.createElement('div');
        skillingProgress.id = 'mwi-labsim-skilling-progress';
        skillingProgress.style.cssText = 'display:none; padding:6px 14px; flex-shrink:0;';
        skillingProgress.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <div style="flex:1; background:#1a1a2e; border-radius:4px; height:18px; overflow:hidden; position:relative; border:1px solid #333;">
                    <div id="mwi-labsim-skilling-progress-fill" style="height:100%; width:0%; background:linear-gradient(90deg, ${ACCENT_BTN_BG}, ${ACCENT}); border-radius:3px; transition:width 0.2s ease;"></div>
                    <span id="mwi-labsim-skilling-progress-text" style="position:absolute; top:0; left:0; right:0; text-align:center; font-size:11px; line-height:18px; color:#e0e0e0; font-weight:600;">0 / 0</span>
                </div>
            </div>
        `;

        const swapBarSkilling = this._buildSwapBar('skilling');
        const swapResultsSkilling = document.createElement('div');
        swapResultsSkilling.id = 'mwi-labsim-skilling-swap-results';
        swapResultsSkilling.style.cssText = 'display:none; padding:10px 14px; flex-shrink:0;';

        const skillingResults = document.createElement('div');
        skillingResults.id = 'mwi-labsim-skilling-results';
        skillingResults.style.cssText = 'padding:10px 14px; flex-shrink:0;';
        // The planner's steps and the combined-upgrade result, kept apart from
        // the tables so a re-sort (which rebuilds them) does not wipe an answer
        const skillingGoalResults = document.createElement('div');
        skillingGoalResults.id = 'mwi-labsim-skilling-goal-results';
        skillingGoalResults.style.cssText = 'padding:0 14px 10px; flex-shrink:0;';

        skillingContent.appendChild(skillingControls);
        skillingContent.appendChild(skillingGoalRow);
        skillingContent.appendChild(skillingCrateRow);
        skillingContent.appendChild(skillingLoadoutArea);
        skillingContent.appendChild(skillingEditorSection);
        skillingContent.appendChild(swapBarSkilling);
        skillingContent.appendChild(skillingProgress);
        skillingContent.appendChild(swapResultsSkilling);
        skillingContent.appendChild(this._buildUpgradesHeader('skilling'));
        skillingContent.appendChild(skillingResults);
        skillingContent.appendChild(
            this._makeSection('skilling-goals', 'Room level goals', [skillingGoalResults], {
                empty: 'nothing planned yet',
            })
        );

        // Status bar
        const status = document.createElement('div');
        status.id = 'mwi-labsim-status';
        status.style.cssText =
            'padding:6px 14px; color:#555; font-size:11px; border-top:1px solid #1a1a1a; flex-shrink:0; text-align:center;';
        status.textContent = 'Select a monster in Configure, then use Single Sim or Upgrade to simulate.';

        // Assemble
        this.panel.appendChild(header);
        this.panel.appendChild(tabBar);
        this.panel.appendChild(configureContent);
        this.panel.appendChild(maxLevelContent);
        this.panel.appendChild(upgradeContent);
        this.panel.appendChild(skillingContent);
        this.panel.appendChild(status);

        // Both crate dropdown trios (combat + skilling) default to the character's
        // equipped labyrinth crates rather than a hardcoded Expert — see
        // _applyEquippedCratesTo. A manual pick opts that trio out, so "what if I
        // ran Expert" still works.
        for (const id of ['#mwi-labsim-skilling-tea']) {
            this.panel.querySelector(id)?.addEventListener('change', () => {
                this._skillingCratesUserSet = true;
            });
        }
        for (const id of ['#mwi-labsim-tea', '#mwi-labsim-coffee', '#mwi-labsim-food']) {
            this.panel.querySelector(id)?.addEventListener('change', () => {
                this._combatCratesUserSet = true;
            });
        }
        this._applyEquippedSkillingCrates();
        this._applyEquippedCombatCrates();

        // Both bottom corners: a panel docked against the right of the screen
        // can only be widened by dragging its left edge, and the right-hand grip
        // just pushes it off the screen
        const grip = (corner) => {
            const handle = document.createElement('div');
            handle.className = 'toolasha-resize-grip';
            const onLeft = corner === 'left';
            handle.style.cssText = `
                position: absolute;
                bottom: 0;
                ${onLeft ? 'left' : 'right'}: 0;
                width: 16px;
                height: 16px;
                cursor: ${onLeft ? 'nesw-resize' : 'nwse-resize'};
                background: linear-gradient(${onLeft ? '225deg' : '135deg'}, transparent 50%, rgba(74, 158, 255, 0.4) 50%);
                border-radius: ${onLeft ? '0 0 0 8px' : '0 0 8px 0'};
                z-index: 1;
            `;
            this.panel.appendChild(handle);
            this._setupResize(handle, corner);
        };
        grip('right');
        grip('left');

        document.body.appendChild(this.panel);
        registerFloatingPanel(this.panel);
        // Over the top-right default above, once storage answers
        this._restorePanelGeometry();

        // Minimize: fold the whole panel to its header, remembering the state.
        // Every non-header child is a content sibling to hide.
        this.minimizeCtl = attachMinimize({
            panel: this.panel,
            header,
            body: [tabBar, configureContent, maxLevelContent, upgradeContent, skillingContent, status],
            panelKey: GEOMETRY_KEY,
            beforeEl: header.querySelector('#mwi-labsim-close'),
            accent: '#aaa',
        });

        // Event listeners
        this.panel.querySelector('#mwi-labsim-close').addEventListener('click', () => this.hide());
        this.panel.addEventListener('mousedown', () => bringPanelToFront(this.panel));

        // Tab switching
        this.panel
            .querySelector('#mwi-labsim-tab-configure')
            .addEventListener('click', () => this._switchTab('configure'));
        this.panel
            .querySelector('#mwi-labsim-tab-maxlevel')
            .addEventListener('click', () => this._switchTab('maxlevel'));
        this.panel.querySelector('#mwi-labsim-tab-upgrade').addEventListener('click', () => this._switchTab('upgrade'));
        this.panel
            .querySelector('#mwi-labsim-tab-skilling')
            .addEventListener('click', () => this._switchTab('skilling'));

        // Configure listeners
        this.panel.querySelector('#mwi-labsim-monster').addEventListener('change', (e) => {
            this._onMonsterChange(e.target.value);
            // Every level source is per monster, so the readout is stale the
            // moment the fight changes
            this._refreshLevelSourceReadout();
            // The Configure fight is the trigger tuning's fight under that scope
            this._onTriggerScopeChanged();
        });
        this.panel.querySelector('#mwi-labsim-level').addEventListener('change', () => {
            this._refreshLevelSourceReadout();
            this._onTriggerScopeChanged();
        });

        // Max Level listeners
        this.panel.querySelector('#mwi-labsim-run').addEventListener('click', () => this._onSimulate());
        this.panel.querySelector('#mwi-labsim-stop').addEventListener('click', () => {
            // Stops the run, keeps the warm workers - see the Combat Sim Stop
            cancelActiveSimulations();
            this.isRunning = false;
            this._setStatus('Labyrinth simulation cancelled.');
            this.panel.querySelector('#mwi-labsim-progress').style.display = 'none';
        });
        this.panel.querySelector('#mwi-labsim-findmax').addEventListener('change', (e) => {
            this._labyFindMaxMode = e.target.checked;
            const levelInput = this.panel.querySelector('#mwi-labsim-level');
            levelInput.disabled = e.target.checked;
            levelInput.style.opacity = e.target.checked ? '0.4' : '1';
        });
        // Precision is read live from the setting at sim time (see _onSimulate),
        // so persisting the input's value is all it takes for the next run — and
        // the same knob in Settings and the labyrinth tile calculator stays in
        // step, since all three read and write the one setting.
        this.panel.querySelector('#mwi-labsim-precision').addEventListener('change', (e) => {
            const n = Math.min(10, Math.max(0.1, Number(e.target.value) || 1));
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimPrecision', n);
        });
        // Max hours / Uncapped are read live at sim time (see _onSimulate).
        // Persist so the choice survives a refresh — and both are shared with
        // every other labyrinth sim, so the twin box on the Upgrade tab is kept
        // in step the way the precision inputs already are.
        this.panel.querySelector('#mwi-labsim-maxhours').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || DEFAULT_LAB_SIM_MAX_HOURS);
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimMaxHours', n);
            const twin = this.panel.querySelector('#mwi-labsim-upgrade-maxhours');
            if (twin) twin.value = String(n);
        });
        this.panel.querySelector('#mwi-labsim-uncapped').addEventListener('change', (e) => {
            config.setSettingValue('labyrinthSimCaps', e.target.checked ? 'precision' : 'capped');
            const twin = this.panel.querySelector('#mwi-labsim-upgrade-uncapped');
            if (twin) twin.checked = e.target.checked;
        });

        // Upgrade listeners
        this.panel.querySelector('#mwi-labsim-upgrade-run').addEventListener('click', () => this._onUpgradeAnalyze());
        // Remember the chosen player by name so a tab switch (which rebuilds the
        // dropdown) restores it instead of snapping back to the first entry.
        this.panel.querySelector('#mwi-labsim-upgrade-player').addEventListener('change', (e) => {
            const opt = e.target.selectedOptions?.[0];
            this._upgradePlayerName = opt?.dataset?.name || opt?.textContent || null;
            this._onTriggerScopeChanged();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-precision').addEventListener('change', (e) => {
            const n = Math.min(10, Math.max(0.1, Number(e.target.value) || 1));
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimPrecision', n);
            // Keep the Single Sim tab's precision box in step — they share one setting
            const twin = this.panel.querySelector('#mwi-labsim-precision');
            if (twin) twin.value = String(n);
        });
        this.panel.querySelector('#mwi-labsim-upgrade-maxhours').addEventListener('change', (e) => {
            const n = Math.max(1, parseInt(e.target.value) || DEFAULT_LAB_SIM_MAX_HOURS);
            e.target.value = String(n);
            config.setSettingValue('labyrinthSimMaxHours', n);
            const twin = this.panel.querySelector('#mwi-labsim-maxhours');
            if (twin) twin.value = String(n);
        });
        this.panel.querySelector('#mwi-labsim-upgrade-uncapped').addEventListener('change', (e) => {
            config.setSettingValue('labyrinthSimCaps', e.target.checked ? 'precision' : 'capped');
            const twin = this.panel.querySelector('#mwi-labsim-uncapped');
            if (twin) twin.checked = e.target.checked;
        });
        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            box.addEventListener('change', () => {
                this._onUpgradeSelectionChanged();
                void this._saveUpgradeSelection();
            });
        });
        this.panel.querySelector('#mwi-labsim-upgrade-scope').addEventListener('change', () => {
            this._populateUpgradeTargets();
            this._onUpgradeSelectionChanged();
            void this._saveUpgradeSelection();
            // The Tune triggers section tunes the fights this scope names
            this._onTriggerScopeChanged();
        });
        this.panel.querySelector('#mwi-labsim-allfights-useskip').addEventListener('change', () => {
            this._populateUpgradeTargets(this._getChosenTargets());
            this._onUpgradeSelectionChanged();
            // The trigger tuning's fights take their room levels from the same box
            this._onTriggerScopeChanged();
        });
        this.panel.querySelector('#mwi-labsim-level-source').addEventListener('change', () => {
            this._refreshLevelSourceReadout();
            void this._saveUpgradeSelection();
            this._onTriggerScopeChanged();
        });
        this.panel.querySelector('#mwi-labsim-swap-aura-only')?.addEventListener('change', () => {
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-shrine-cap-guild')?.addEventListener('change', () => {
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-room-levels')?.addEventListener('change', () => {
            this._refreshRoomLevelControls();
            void this._saveUpgradeSelection();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-target-floor')?.addEventListener('change', (e) => {
            const floor = Math.max(0, parseInt(e.target.value, 10) || 0);
            e.target.value = floor ? String(floor) : '';
            void this._saveUpgradeSelection();
        });
        void this._restoreUpgradeSelection();
        void this._restoreTokenBuffLevels();
        void this._restoreUpgradeResults();
        this._wireSwapBars();
        this._wireLabSections();
        void this._restoreCheckedSwaps();
        this._wireTriggerBar();
        void this._restoreTriggerChoices();
        this.panel.querySelector('#mwi-labsim-ability-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-ability-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillAbilityTargets(grid, '#mwi-labsim-upgrade-player', '#mwi-labsim-upgrade-target-level');
            }
        });
        this.panel.querySelector('#mwi-labsim-combat-targets-toggle').addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) {
                this._prefillLabCombatTargets();
            }
        });
        this.panel.querySelector('#mwi-labsim-house-targets-toggle')?.addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-house-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) this._buildLabHouseTargets();
        });
        this.panel.querySelector('#mwi-labsim-shrine-targets-toggle')?.addEventListener('click', () => {
            const grid = this.panel.querySelector('#mwi-labsim-shrine-targets');
            const opening = grid.style.display === 'none';
            grid.style.display = opening ? 'flex' : 'none';
            if (opening) this._buildLabShrineTargets();
        });
        this.panel.querySelector('#mwi-labsim-upgrade-stop').addEventListener('click', () => {
            this._upgradeAborted = true;
            // The flag alone only ends the run BETWEEN sims: the analysis polls
            // `abortSignal` between one simulation and the next, so whatever is
            // already in flight still runs to completion. With Uncapped ticked
            // that sim has a million-hour budget and no trial cap, so Stop looked
            // dead — it had in fact been honoured and was waiting on a sim that
            // was never going to end. Terminating the workers is what actually
            // stops it, which is what the Single Sim and Skilling Stop buttons
            // have always done.
            cancelActiveSimulations();
            this.panel.querySelector('#mwi-labsim-upgrade-progress')?.style.setProperty('display', 'none');
            this._setStatus('Upgrade analysis cancelled.');
        });

        // Skilling listeners
        this.panel
            .querySelector('#mwi-labsim-skilling-calc')
            .addEventListener('click', () => this._onSkillingCalculate());
        this.panel
            .querySelector('#mwi-labsim-skilling-upgrade')
            .addEventListener('click', () => this._onSkillingUpgradeAnalyze());
        this.panel.querySelector('#mwi-labsim-skilling-useskip').addEventListener('change', (e) => {
            const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
            if (levelInput) levelInput.disabled = e.target.checked;
        });
        this.panel.querySelector('#mwi-labsim-skilling-stop').addEventListener('click', () => {
            this._skillingAborted = true;
        });
        this.panel.querySelector('#mwi-labsim-skilling-filter').addEventListener('change', () => {
            this._renderSkillLoadoutTable();
        });
        this.panel.querySelector('#mwi-labsim-skilling-plan').addEventListener('click', () => this._onSkillingPlan());
        this.panel
            .querySelector('#mwi-labsim-skilling-combine')
            .addEventListener('click', () => this._onSkillingCombine());
        for (const id of ['room-levels', 'target-clear', 'target-floor']) {
            this.panel
                .querySelector(`#mwi-labsim-skilling-${id}`)
                .addEventListener('change', () => this._onSkillingGoalInputsChanged());
        }

        this._populateMonsters();
        // Recorded runs outlive the session, so they are read back as the panel
        // is built rather than when the first one is added
        void this._comparison.load();
        // Here rather than at module scope, where the other panels ask: this one
        // is built by its feature module and only if the setting is on, so
        // asking any earlier would be asking about a panel that does not exist
        this.restore();
    }

    /** @private */
    _populateMonsters() {
        const select = this.panel?.querySelector('#mwi-labsim-monster');
        if (!select) return;

        const monsters = getLabyrinthMonsters();
        select.innerHTML = '';
        for (const monster of monsters) {
            const option = document.createElement('option');
            option.value = monster.hrid;
            option.textContent = monster.name;
            select.appendChild(option);
        }
    }

    /** @private */
    _onMonsterChange(monsterHrid) {
        if (!monsterHrid || !this._editor?.isInitialized()) return;
        const monsterId = monsterHrid.split('/').pop();
        const pascal = monsterId
            .split('_')
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join('');
        const loadoutId = dataManager.characterData?.characterSetting?.[`labyrinthLoadout${pascal}`];
        if (!loadoutId) return;
        const snapshot = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots[loadoutId];
        if (!snapshot?.name) return;
        this._editor.applyLoadoutByName(snapshot.name);
    }

    /** @private */
    _populateUpgradePlayerSelector() {
        const select = this.panel?.querySelector('#mwi-labsim-upgrade-player');
        if (!select) return;

        const playerInfo = this._editor?.getPlayerInfo() || [];
        select.innerHTML = '';
        playerInfo.forEach((p, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = p.name || `Player ${i + 1}`;
            option.dataset.name = p.name || '';
            select.appendChild(option);
        });

        if (playerInfo.length === 0) {
            const option = document.createElement('option');
            option.value = 0;
            option.textContent = 'Player 1';
            select.appendChild(option);
            return;
        }

        // Restore the remembered pick (so switching tabs does not reset it),
        // else default to the local character rather than whichever party member
        // happens to be first, else the first entry.
        const nameIndex = (name) =>
            name ? playerInfo.findIndex((p) => (p.name || '').toLowerCase() === String(name).toLowerCase()) : -1;
        let index = nameIndex(this._upgradePlayerName);
        if (index < 0) index = nameIndex(dataManager.getCurrentCharacterName?.());
        if (index < 0) index = 0;
        select.value = String(index);
        // Pin what we landed on so the next rebuild keeps it.
        this._upgradePlayerName = playerInfo[index]?.name || null;
    }

    /**
     * What the Configure tab's Level box holds.
     * @returns {number} 0 when it holds nothing usable
     * @private
     */
    _configureLevel() {
        return Math.max(0, Math.floor(Number(this.panel?.querySelector('#mwi-labsim-level')?.value) || 0));
    }

    /**
     * The room level this monster's skip threshold sends the character to.
     *
     * A Recommend run's answer when there is one — that is the threshold with an
     * objective behind it, the highest one whose rooms still clear at the Target
     * Win % — and the threshold actually configured in the automation table
     * otherwise.
     * @param {string} monsterHrid - Labyrinth monster
     * @returns {number} 0 when neither resolves
     * @private
     */
    _skipRoomLevel(monsterHrid) {
        if (!monsterHrid) return 0;
        const recommended =
            (labyrinthClearRate() || bundledLabyrinthClearRate).getRecommendedCombatRoomLevel?.(monsterHrid) || 0;
        return (
            recommended || (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatSkipRoomLevel(monsterHrid) || 0
        );
    }

    /**
     * Which level the Configure-fight scope is being analysed at, resolved.
     *
     * The Sim max figure is whatever the last Find Max run produced for this
     * monster, kept per monster for the life of the panel — it is a property of
     * the fight rather than of the panel, and the box it used to be written into
     * was overwritten by the next monster's search. It is not persisted: a max
     * level is a statement about the gear it was searched with, and gear changes
     * between sessions far more often than it does inside one.
     *
     * @param {string} [monsterHrid] - Defaults to the Configure tab's monster
     * @returns {{level: number, usedSource: string, label: string, fellBack: boolean}}
     * @private
     */
    _resolveTargetLevel(monsterHrid = this.panel?.querySelector('#mwi-labsim-monster')?.value || '') {
        return resolveLabTargetLevel({
            source: this._getLevelSource(),
            simMaxLevel: this._maxLevelByMonster[monsterHrid] || 0,
            skipLevel: this._skipRoomLevel(monsterHrid),
            configureLevel: this._configureLevel(),
        });
    }

    /**
     * Which of the three level sources the Configure-fight scope is set to.
     * @returns {string} A key from `LAB_LEVEL_SOURCES`
     * @private
     */
    _getLevelSource() {
        return this.panel?.querySelector('#mwi-labsim-level-source')?.value || 'configure';
    }

    /**
     * Show the level the current source comes to, beside the source itself.
     *
     * The whole point of the control is that the number it produces is visible
     * before Analyze is pressed — a scope that quietly ran at 100 because that
     * is what the Level box opens on is what it replaces.
     * @private
     */
    _refreshLevelSourceReadout() {
        const label = this.panel?.querySelector('#mwi-labsim-level-source-label');
        const readout = this.panel?.querySelector('#mwi-labsim-level-source-resolved');
        if (!label || !readout) return;

        label.style.display = this._getUpgradeScopeMode() === 'current' ? 'inline-flex' : 'none';

        const source = this._getLevelSource();
        const resolved = this._resolveTargetLevel();
        if (source === 'sim_max' && resolved.usedSource !== 'sim_max') {
            // Not "unavailable": Analyze runs the search itself. Saying which
            // level it would use instead would be a promise it does not keep.
            readout.textContent = 'not simmed yet — Analyze will search';
            readout.title = 'Find Max has not run for this monster this session. Analyze runs it before the analysis.';
            return;
        }
        readout.textContent = resolved.level ? `= L${resolved.level}` : 'no level resolves';
        readout.title = resolved.fellBack
            ? `${resolved.label} — the level you asked for has no value, so this is what will be used.`
            : resolved.label;
    }

    /**
     * The candidate sets currently checked on the Upgrade tab.
     * @returns {string[]}
     * @private
     */
    _getUpgradeDimensions() {
        return [...(this.panel?.querySelectorAll('[data-lab-upgrade-dimension]') || [])]
            .filter((box) => box.checked && !box.disabled)
            .map((box) => box.getAttribute('data-lab-upgrade-dimension'));
    }

    /**
     * Which fights the Upgrade tab is weighing them for.
     * @returns {string} `current` | `all` | `selected`
     * @private
     */
    _getUpgradeScopeMode() {
        return this.panel?.querySelector('#mwi-labsim-upgrade-scope')?.value || 'current';
    }

    /**
     * The monsters ticked in the subset picker.
     * @returns {string[]}
     * @private
     */
    _getChosenTargets() {
        return [...(this.panel?.querySelectorAll('[data-lab-target]') || [])]
            .filter((box) => box.checked)
            .map((box) => box.getAttribute('data-lab-target'));
    }

    /**
     * Every labyrinth fight the current Use Skip Levels setting can resolve.
     *
     * Served from what the picker was last built with rather than recollected:
     * collecting fights builds a player DTO per monster, and this is asked once
     * per checkbox click.
     * @returns {string[]} Monster hrids, in labyrinth order
     * @private
     */
    _allUpgradeTargets() {
        if (!this._upgradeTargetHrids) {
            const useSkipLevels = this.panel?.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
            this._upgradeTargetHrids = this._collectLabyrinthFights(useSkipLevels).map((fight) => fight.monsterHrid);
        }
        return this._upgradeTargetHrids;
    }

    /**
     * How many fights the current scope comes to — what the availability rules
     * and the summary line are both asking about.
     * @returns {number}
     * @private
     */
    _upgradeTargetCount() {
        return labScopeTargetCount(
            this._getUpgradeScopeMode(),
            this._allUpgradeTargets().length,
            this._getChosenTargets().length
        );
    }

    /**
     * Build the subset picker from the labyrinth's own fight list.
     *
     * Called on the way into the tab and whenever the scope changes, because
     * game data — and the player's skip thresholds — are not available when the
     * panel is built. Ticks are preserved across rebuilds; a fight that has
     * stopped resolving simply drops out.
     * @param {string[]} [preselect] - Monsters to tick, defaulting to whatever
     *   is ticked now
     * @private
     */
    _populateUpgradeTargets(preselect = null) {
        const grid = this.panel?.querySelector('#mwi-labsim-target-list');
        if (!grid) return;

        const previouslyChosen = new Set(preselect || this._getChosenTargets());
        const useSkipLevels = this.panel.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
        const fights = this._collectLabyrinthFights(useSkipLevels);
        this._upgradeTargetHrids = fights.map((fight) => fight.monsterHrid);

        if (!fights.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No labyrinth fights resolve to a room level yet — ' +
                'set combat skip levels in the game, or enter the labyrinth.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Rooms to weigh — leave out the ones you ' +
            'already clear comfortably:</span>' +
            '<span style="display:inline-flex; gap:6px; flex-basis:100%; margin-bottom:2px;">' +
            `<button data-lab-target-all="1" style="${CHIP_BUTTON_STYLE}">All</button>` +
            `<button data-lab-target-none="1" style="${CHIP_BUTTON_STYLE}">None</button>` +
            '</span>' +
            fights
                .map(
                    (fight) => `
                <label style="display:inline-flex; align-items:center; gap:4px; color:#aaa; font-size:11px; cursor:pointer;"
                    title="${fight.loadoutName} · room level ${fight.roomLevel}">
                    <input type="checkbox" data-lab-target="${fight.monsterHrid}" style="margin:0; cursor:pointer;"${
                        previouslyChosen.has(fight.monsterHrid) ? ' checked' : ''
                    }>
                    ${fight.monsterName} <span style="color:#666;">L${fight.roomLevel}</span>
                </label>`
                )
                .join('');

        grid.querySelectorAll('[data-lab-target]').forEach((box) => {
            box.addEventListener('change', () => {
                this._onUpgradeSelectionChanged();
                void this._saveUpgradeSelection();
                this._onTriggerScopeChanged();
            });
        });
        const setAll = (checked) => {
            grid.querySelectorAll('[data-lab-target]').forEach((box) => {
                box.checked = checked;
            });
            this._onUpgradeSelectionChanged();
            void this._saveUpgradeSelection();
            this._onTriggerScopeChanged();
        };
        grid.querySelector('[data-lab-target-all]')?.addEventListener('click', () => setAll(true));
        grid.querySelector('[data-lab-target-none]')?.addEventListener('click', () => setAll(false));
    }

    /**
     * Show only the controls the current selection actually uses, and grey out
     * the ones this target scope cannot answer.
     *
     * A checkbox that would be quietly ignored is worse than one that is
     * visibly unavailable and says why, so an unavailable dimension is
     * disabled with the reason on its tooltip rather than dropped at run time.
     * @private
     */
    _onUpgradeSelectionChanged() {
        if (!this.panel) return;

        const scopeMode = this._getUpgradeScopeMode();
        const targetCount = this._upgradeTargetCount();
        const availability = labDimensionAvailability(scopeMode, targetCount);

        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            const key = box.getAttribute('data-lab-upgrade-dimension');
            const state = availability[key] || { enabled: true, reason: '' };
            box.disabled = !state.enabled;
            const label = this.panel.querySelector(`[data-lab-mode-label="${key}"]`);
            // Restored rather than left behind when the reason no longer
            // applies: a set refused for one scope kept explaining itself in
            // every other scope, where the explanation was untrue
            if (label) {
                label.title = state.reason || LAB_UPGRADE_DIMENSIONS.find((d) => d.key === key)?.title || '';
            }
        });

        const dimensions = new Set(this._getUpgradeDimensions());
        const isLevelMode = dimensions.has('ability_level');
        const isCombatLevelMode = dimensions.has('combat_level');

        this.panel.querySelectorAll('[data-lab-mode-chip]').forEach((chip) => {
            const key = chip.getAttribute('data-lab-mode-chip');
            const on = dimensions.has(key);
            const usable = availability[key]?.enabled !== false;
            chip.style.borderColor = on ? ACCENT_BTN_BORDER : '#2a2a4a';
            chip.style.background = on ? ACCENT_BG : 'transparent';
            chip.style.opacity = usable ? '1' : '0.45';
            const label = chip.querySelector('label');
            if (label) label.style.color = on ? '#e0e0e0' : '#888';
        });
        this.panel.querySelectorAll('[data-lab-mode-options]').forEach((group) => {
            group.style.display = dimensions.has(group.getAttribute('data-lab-mode-options')) ? 'inline-flex' : 'none';
        });

        // Combat Levels borrows the Ability Lv boost box when Ability Lv is off,
        // since one number drives both — same arrangement as the combat sim
        const levelGroup = this.panel.querySelector('#mwi-labsim-upgrade-level-group');
        if (levelGroup) levelGroup.style.display = isLevelMode || isCombatLevelMode ? 'inline-flex' : 'none';

        const levelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type');
        const levelInput = this.panel.querySelector('#mwi-labsim-upgrade-target-level');
        const levelTypeState = labAbilityLevelTypeAvailability(scopeMode, targetCount);
        if (levelType) {
            levelType.style.display = isLevelMode ? '' : 'none';
            levelType.disabled = !levelTypeState.enabled;
            levelType.title = levelTypeState.reason;
            if (!levelTypeState.enabled) levelType.value = 'increment';
        }
        if (levelInput) {
            levelInput.title =
                isLevelMode && isCombatLevelMode
                    ? 'Levels added to each ability and each combat skill'
                    : isCombatLevelMode
                      ? 'Levels added to each combat skill'
                      : 'Number of levels to add to each ability';
            if (isCombatLevelMode && !parseInt(levelInput.value, 10)) levelInput.value = '5';
        }

        const abilityGrid = this.panel.querySelector('#mwi-labsim-ability-targets');
        if (!isLevelMode) abilityGrid.style.display = 'none';
        if (!isCombatLevelMode) this.panel.querySelector('#mwi-labsim-combat-targets').style.display = 'none';

        // The grid lists whatever the target scope covers, so a scope change is
        // a change to the list — leaving it showing one loadout's abilities
        // after the scope grew to ten fights is exactly the bug it had
        if (isLevelMode && abilityGrid.style.display !== 'none') {
            this._prefillAbilityTargets(abilityGrid, '#mwi-labsim-upgrade-player', '#mwi-labsim-upgrade-target-level');
        }

        // Scope row: the subset picker and the skip-level rule only mean
        // something once the analysis is walking the labyrinth's own fight list
        const targetList = this.panel.querySelector('#mwi-labsim-target-list');
        const useSkipLabel = this.panel.querySelector('#mwi-labsim-allfights-useskip-label');
        if (targetList) targetList.style.display = scopeMode === 'selected' ? 'flex' : 'none';
        if (useSkipLabel) useSkipLabel.style.display = scopeMode === 'current' ? 'none' : 'flex';

        this._refreshLevelSourceReadout();

        const summary = this.panel.querySelector('#mwi-labsim-scope-summary');
        if (summary) {
            summary.textContent =
                scopeMode === 'current'
                    ? 'One fight, from the Configure tab — the only scope that also ranks labyrinth token buffs.'
                    : targetCount === 0
                      ? 'No fights resolve to a room level yet.'
                      : `${targetCount} fight${targetCount === 1 ? '' : 's'}, each with its assigned loadout.`;
        }
    }

    /**
     * The analysis the Upgrade tab's controls currently describe.
     *
     * The whole point of splitting the old Mode dropdown in two is that the
     * combination is worked out rather than enumerated, so this is the one
     * place that reads the controls and the only thing Analyze consults.
     * @returns {Object} From `planLabUpgradeRun`
     * @private
     */
    _planFromControls() {
        return planLabUpgradeRun({
            dimensions: this._getUpgradeDimensions(),
            scopeMode: this._getUpgradeScopeMode(),
            chosenMonsters: this._getChosenTargets(),
            allMonsters: this._allUpgradeTargets(),
            configureMonsterHrid: this.panel?.querySelector('#mwi-labsim-monster')?.value || '',
        });
    }

    /**
     * Persist the checked sets and the target scope so the next Analyze starts
     * where the last one left off.
     * @private
     */
    async _saveUpgradeSelection() {
        try {
            // Issued together rather than awaited one after another. Each
            // `writeScoped` resolves its key as it is called, but a
            // non-immediate `storage.set` resolves only when its debounce fires
            // — seconds later — so awaiting between them let a character switch
            // land in the middle and split one selection across two characters:
            // the arriving character keeping their own checked sets while
            // inheriting the departing character's target scope, which is a
            // combination neither of them ever chose.
            // Only the keys whose value moved are written (see `_writeScopedIfChanged`).
            const values = this._upgradeSelectionValues();
            await Promise.all([
                this._writeScopedIfChanged(UPGRADE_DIMENSIONS_KEY, values[UPGRADE_DIMENSIONS_KEY]),
                this._writeScopedIfChanged(UPGRADE_SCOPE_KEY, values[UPGRADE_SCOPE_KEY]),
                this._writeScopedIfChanged(UPGRADE_LEVEL_SOURCE_KEY, values[UPGRADE_LEVEL_SOURCE_KEY]),
                this._writeScopedIfChanged(UPGRADE_SWAP_AURA_KEY, values[UPGRADE_SWAP_AURA_KEY]),
                this._writeScopedIfChanged(SHRINE_CAP_GUILD_KEY, values[SHRINE_CAP_GUILD_KEY]),
                this._writeScopedIfChanged(UPGRADE_ROOM_LEVELS_KEY, values[UPGRADE_ROOM_LEVELS_KEY]),
                this._writeScopedIfChanged(UPGRADE_TARGET_FLOOR_KEY, values[UPGRADE_TARGET_FLOOR_KEY]),
            ]);
        } catch (error) {
            console.error('[LabSimUI] Failed to save upgrade selection:', error);
        }
    }

    /**
     * What the Upgrade tab's controls hold, by the unscoped key each is saved under.
     * @returns {Record<string, *>}
     * @private
     */
    _upgradeSelectionValues() {
        return {
            [UPGRADE_DIMENSIONS_KEY]: this._getUpgradeDimensions(),
            [UPGRADE_SCOPE_KEY]: { mode: this._getUpgradeScopeMode(), monsters: this._getChosenTargets() },
            [UPGRADE_LEVEL_SOURCE_KEY]: this._getLevelSource(),
            // The box's own state, not the gated answer below: unchecking
            // Ability Swaps would otherwise save a false over the tick and
            // lose it the moment the set is checked again
            [UPGRADE_SWAP_AURA_KEY]: Boolean(this.panel?.querySelector('#mwi-labsim-swap-aura-only')?.checked),
            // The box's own state too — gating it on whether Guild Shrine is
            // checked would save a stale true over an unchecking that happened
            // while the set itself was off
            [SHRINE_CAP_GUILD_KEY]: Boolean(this.panel?.querySelector('#mwi-labsim-shrine-cap-guild')?.checked),
            [UPGRADE_ROOM_LEVELS_KEY]: this._getRankByRoomLevels(),
            [UPGRADE_TARGET_FLOOR_KEY]: this._getTargetFloor(),
        };
    }

    /**
     * Note what the controls hold, just restored from storage, as what each key stores.
     *
     * The controls are the stored values as read — or the defaults a missing or retired value
     * reads as, which is the same thing to every reader — so a save after this writes only
     * what the player then changes, and never a default over a value a sync pull brings.
     * @param {Record<string, *>} values - From `_upgradeSelectionValues` or `_skillingGoalValues`
     * @param {Record<string, string>} keys - Unscoped key → the scoped key it was read from
     * @private
     */
    _rememberRestored(values, keys) {
        for (const [base, value] of Object.entries(values)) {
            if (keys[base]) this._storedValues.remember(keys[base], value);
        }
    }

    /**
     * Write one key of a grouped save, if its value differs from what this page last saw stored.
     *
     * A group save reads every control, so writing them all put this page's copy of every
     * other key back over one a sync pull had just changed. Only the key the player changed
     * differs from what was last read or written, so only it is written. The key is resolved
     * as this is called, so the calls of one save, made together, cannot split across a
     * character switch.
     * @param {string} base - Unscoped key
     * @param {*} value - The value the controls hold
     * @returns {Promise<*>} The write, or nothing when there is none
     * @private
     */
    _writeScopedIfChanged(base, value) {
        const scopedKey = characterKey(base);
        if (!this._storedValues.differs(scopedKey, value)) return Promise.resolve();
        // Noted as stored only while the write holds: one that fails is tried again by the next save
        return this._storedValues.track(scopedKey, value, writeScoped(base, value, 'settings'));
    }

    /**
     * Re-read whatever of this panel's remembered choices a sync pull wrote, for the
     * character on screen, into memory and the controls. The keys are registered live-safe
     * in `sim-sync-keys.js`; without this the page would keep showing — and the next save
     * would write back — the copy from before the pull.
     * @param {Record<string, Array<string>>} written - The keys the pull wrote, by store
     * @returns {Promise<void>}
     * @private
     */
    async _adoptPulledSettings(written) {
        if (!this.panel) return;
        try {
            const settings = pulledNames(written, 'settings', {
                ...Object.fromEntries(Object.entries(LAB_SIM_KEYS).map(([name, base]) => [name, characterKey(base)])),
                comparisonRuns: characterKey(LAB_COMPARISON_KEY),
                comparisonBaseline: characterKey(LAB_COMPARISON_BASELINE_KEY),
            });
            const results = pulledNames(written, 'combatExport', {
                upgradeResults: characterKey(LAB_UPGRADE_RESULTS_KEY),
            });
            const has = (...names) => names.some((name) => settings.has(name));
            const work = [];
            if (
                has(
                    'upgradeDimensions',
                    'upgradeScope',
                    'upgradeLevelSource',
                    'swapAuraOnly',
                    'shrineCapToGuild',
                    'upgradeRoomLevels',
                    'upgradeTargetFloor',
                    'legacyUpgradeMode'
                )
            ) {
                work.push(this._restoreUpgradeSelection());
            }
            // Only once the Skilling tab has put them on screen; until then its first showing reads them
            if (
                has('skillingRoomLevels', 'skillingTargetClear', 'skillingTargetFloor') &&
                this._skillingGoalKey === characterKey(SKILLING_ROOM_LEVELS_KEY)
            ) {
                this._skillingGoalKey = null;
                work.push(this._restoreSkillingGoalInputs());
            }
            if (has('tokenBuffLevels')) work.push(this._restoreTokenBuffLevels());
            if (has('checkedSwaps')) work.push(this._restoreCheckedSwaps({ replace: true }));
            if (has('triggerChoices')) work.push(this._restoreTriggerChoices());
            if (has('comparisonRuns', 'comparisonBaseline')) {
                work.push(
                    (async () => {
                        await this._comparison.reload();
                        // Drawn only where a table already is: the section appears with a run
                        if (this.panel?.querySelector('#mwi-labsim-comparison')?.childElementCount) {
                            this._renderComparisonSection();
                        }
                    })()
                );
            }
            // A table on screen here is a restored one, so the pulled set (or a pulled clear) takes its place.
            // Never while a run is going or once one has run here: the remembered set would land in its place
            if (results.has('upgradeResults') && !this._upgradeRunning && !this._upgradeRunStarted) {
                work.push(this._restoreUpgradeResults({ replace: true }));
            }
            await Promise.all(work);
        } catch (error) {
            console.error('[LabSimUI] Adopting pulled settings failed:', error);
        }
    }

    /**
     * Whether Ability Swaps is narrowed to the guide's signature swaps.
     *
     * False whenever the set itself is unchecked: the flag only ever qualifies
     * swaps, and a remembered tick sitting behind an unchecked box should not
     * read as an instruction to anything.
     * @returns {boolean}
     * @private
     */
    _getAuraSwapsOnly() {
        if (!this._getUpgradeDimensions().includes('ability_swap')) return false;
        return Boolean(this.panel?.querySelector('#mwi-labsim-swap-aura-only')?.checked);
    }

    /**
     * Whether the Upgrade tab should measure room levels after ranking win rates.
     * @returns {boolean}
     * @private
     */
    _getRankByRoomLevels() {
        return Boolean(this.panel?.querySelector('#mwi-labsim-upgrade-room-levels')?.checked);
    }

    /**
     * The floor the room-level pass is aiming at, 0 when none is set.
     * @returns {number}
     * @private
     */
    _getTargetFloor() {
        return Math.max(0, parseInt(this.panel?.querySelector('#mwi-labsim-upgrade-target-floor')?.value, 10) || 0);
    }

    /**
     * Show the target-floor box only while the room-level pass is on — the floor
     * is read off that measurement and means nothing without it.
     * @private
     */
    _refreshRoomLevelControls() {
        const label = this.panel?.querySelector('#mwi-labsim-target-floor-label');
        if (label) label.style.display = this._getRankByRoomLevels() ? 'flex' : 'none';
    }

    /**
     * Restore the remembered selection, migrating anyone still carrying the
     * retired single-mode value.
     * @private
     */
    async _restoreUpgradeSelection() {
        let selection;
        let savedLevelSource = null;
        let savedAuraOnly = false;
        // Defaults on: a shrine level the guild's shrine building cannot sell
        // is not an upgrade the character can buy, however well it would rank
        let savedShrineCapGuild = true;
        let savedRoomLevels = false;
        let savedTargetFloor = 0;
        let readOk = false;
        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();
        // The scoped keys this restore reads, resolved before the first await
        const keys = Object.fromEntries(
            [
                UPGRADE_DIMENSIONS_KEY,
                UPGRADE_SCOPE_KEY,
                UPGRADE_LEVEL_SOURCE_KEY,
                UPGRADE_SWAP_AURA_KEY,
                SHRINE_CAP_GUILD_KEY,
                UPGRADE_ROOM_LEVELS_KEY,
                UPGRADE_TARGET_FLOOR_KEY,
            ].map((base) => [base, characterKey(base)])
        );
        try {
            // Every key resolved before the first await, for the same reason
            // the save issues its writes together: read one at a time, a switch
            // between two of them restored half of one character's selection
            // over half of another's — and the next change to any box saved
            // that mixture back over whichever character was current.
            let savedDimensions;
            let savedScope;
            [
                savedDimensions,
                savedScope,
                savedLevelSource,
                savedAuraOnly,
                savedShrineCapGuild,
                savedRoomLevels,
                savedTargetFloor,
            ] = await Promise.all([
                readScoped(UPGRADE_DIMENSIONS_KEY, 'settings', null),
                readScoped(UPGRADE_SCOPE_KEY, 'settings', null),
                readScoped(UPGRADE_LEVEL_SOURCE_KEY, 'settings', null),
                readScoped(UPGRADE_SWAP_AURA_KEY, 'settings', false),
                readScoped(SHRINE_CAP_GUILD_KEY, 'settings', true),
                readScoped(UPGRADE_ROOM_LEVELS_KEY, 'settings', false),
                readScoped(UPGRADE_TARGET_FLOOR_KEY, 'settings', 0),
            ]);
            savedAuraOnly = Boolean(savedAuraOnly);
            savedShrineCapGuild = Boolean(savedShrineCapGuild);
            const legacyMode =
                savedDimensions === null && savedScope === null
                    ? await readScoped(LEGACY_UPGRADE_MODE_KEY, 'settings', null)
                    : null;
            selection = sanitizeLabUpgradeSelection(savedDimensions ?? legacyMode, savedScope);
            readOk = true;
        } catch (error) {
            console.error('[LabSimUI] Failed to restore upgrade selection:', error);
            selection = sanitizeLabUpgradeSelection(null, null);
        }

        // A switch during the read rebuilt the panel for the arriving character, whose own restore fills it:
        // the departing character's selection put on its controls would be saved under the arriving one
        if (!this.panel || !this._stillSameCharacter(ownerId)) return;
        const wanted = new Set(selection.dimensions);
        const appliedDimensions = [];
        this.panel.querySelectorAll('[data-lab-upgrade-dimension]').forEach((box) => {
            const dimension = box.getAttribute('data-lab-upgrade-dimension');
            box.checked = wanted.has(dimension);
            if (box.checked) appliedDimensions.push(dimension);
        });
        const scopeSelect = this.panel.querySelector('#mwi-labsim-upgrade-scope');
        if (scopeSelect) scopeSelect.value = selection.scopeMode;
        // Nothing saved falls to the rule rather than to a fixed option: a Level
        // box left on its default means Sim max, a Level box that was typed into
        // means the number that was typed
        const levelSource = sanitizeLabLevelSource(savedLevelSource, this._configureLevel());
        const levelSourceSelect = this.panel.querySelector('#mwi-labsim-level-source');
        if (levelSourceSelect) levelSourceSelect.value = levelSource;
        const signatureBox = this.panel.querySelector('#mwi-labsim-swap-aura-only');
        if (signatureBox) signatureBox.checked = savedAuraOnly;
        const shrineCapBox = this.panel.querySelector('#mwi-labsim-shrine-cap-guild');
        if (shrineCapBox) shrineCapBox.checked = savedShrineCapGuild;
        const roomLevelsBox = this.panel.querySelector('#mwi-labsim-upgrade-room-levels');
        if (roomLevelsBox) roomLevelsBox.checked = Boolean(savedRoomLevels);
        const floor = Math.max(0, Math.floor(Number(savedTargetFloor) || 0));
        const targetFloorInput = this.panel.querySelector('#mwi-labsim-upgrade-target-floor');
        if (targetFloorInput) targetFloorInput.value = floor ? String(floor) : '';
        this._refreshRoomLevelControls();
        this._populateUpgradeTargets(selection.monsters);
        this._onUpgradeSelectionChanged();
        // What this restore read and put on the controls — the stored values, or the defaults a missing or
        // retired value reads as — is noted as what each key stores. The targets are the ones the grid just
        // drawn from the read selection offers. A failed read noted nothing, so the next save writes the
        // whole group as it always did
        if (readOk) {
            this._rememberRestored(
                {
                    [UPGRADE_DIMENSIONS_KEY]: appliedDimensions,
                    [UPGRADE_SCOPE_KEY]: { mode: selection.scopeMode, monsters: this._getChosenTargets() },
                    [UPGRADE_LEVEL_SOURCE_KEY]: levelSource,
                    [UPGRADE_SWAP_AURA_KEY]: savedAuraOnly,
                    [SHRINE_CAP_GUILD_KEY]: savedShrineCapGuild,
                    [UPGRADE_ROOM_LEVELS_KEY]: Boolean(savedRoomLevels),
                    [UPGRADE_TARGET_FLOOR_KEY]: floor,
                },
                keys
            );
        }
    }

    /**
     * The token levels the live run has bought.
     * @returns {Object} buffKey → level
     * @private
     */
    _liveTokenLevels() {
        return readLiveTokenLevels(dataManager.characterData?.characterInfo);
    }

    /**
     * The token levels every simulation this panel runs should use: the live
     * ones, with whatever the Configure tab has been set to on top.
     *
     * Null when nothing is known and nothing has been set, which is not the
     * same answer as "every token at level 0": the Token Upgrades rows read
     * this, and a character the client cannot read would be offered nine
     * purchases off levels nobody has established.
     * @returns {Object|null} buffKey → level
     * @private
     */
    _resolvedTokenLevels() {
        const info = dataManager.characterData?.characterInfo;
        if (!info && !Object.keys(this._tokenBuffOverrides || {}).length) return null;
        return resolveTokenLevels(info, this._tokenBuffOverrides);
    }

    /**
     * The labyrinth combat buff array to hand a simulation.
     *
     * Every lab-sim path reads this rather than `labyrinthClearRate`: the live
     * getter answers "what is this run carrying", which is the right question
     * for a tile badge and the wrong one for a simulator being asked what a
     * different set of tokens would do.
     * @returns {Array<Object>}
     * @private
     */
    _labyrinthCombatBuffs() {
        return buildLabyrinthCombatBuffs(this._resolvedTokenLevels() || {});
    }

    /**
     * Draw the Labyrinth Buffs section: the live levels, and the ones being
     * simulated where those differ.
     *
     * Only the Combat four take an input. They are the tokens the combat engine
     * reads — the rest are levels no fight simulation consults, and an input
     * that silently changes nothing is worse than a readout that admits it is
     * one. The Skilling tab's Player Setup edits the skilling levels, which is
     * where they do change an answer.
     * @private
     */
    _renderBuffsSection() {
        const container = this.panel?.querySelector('#mwi-labsim-buffs-body');
        if (!container) return;

        const info = dataManager.characterData?.characterInfo;
        if (!info) {
            container.innerHTML = '<div style="color:#555;">No character data available.</div>';
            return;
        }

        const live = this._liveTokenLevels();
        const simulated = this._resolvedTokenLevels();

        let html =
            '<div style="color:#666; padding:2px 0 4px;">Combat levels are what the sims run under — change one ' +
            'to ask what those tokens would do. Blank restores the live level.</div>';

        for (const group of LAB_TOKEN_BUFF_GROUPS) {
            html += `<div style="color:#666; font-weight:600; font-size:10px; text-transform:uppercase; margin-top:4px; margin-bottom:2px;">${group.label}</div>`;
            html += '<div style="display:grid; grid-template-columns:1fr 1fr; gap:1px 16px;">';
            for (const buff of group.buffs) {
                const liveLevel = live[buff.key];
                const isMaxed = liveLevel >= MAX_LAB_TOKEN_LEVEL;
                if (!buff.uniqueKey) {
                    const color = isMaxed ? '#4caf50' : '#e0e0e0';
                    html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:1px 0;">
                        <span style="color:#aaa;">${buff.name}</span>
                        <span style="color:${color}; font-weight:${isMaxed ? '600' : '400'};">${liveLevel}/${MAX_LAB_TOKEN_LEVEL}</span>
                    </div>`;
                    continue;
                }
                const chosen = simulated[buff.key];
                const differs = chosen !== liveLevel;
                html += `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:1px 0;">
                    <span style="color:#aaa;">${buff.name}</span>
                    <span style="display:inline-flex; align-items:center; gap:4px;">
                        <input type="number" min="0" max="${MAX_LAB_TOKEN_LEVEL}" value="${chosen}"
                            data-lab-token-buff="${buff.key}"
                            title="Level to simulate. Live: ${liveLevel}/${MAX_LAB_TOKEN_LEVEL}."
                            style="width:44px; text-align:center; background:#1a1a2e;
                            color:${differs ? '#ffb74d' : '#e0e0e0'};
                            border:1px solid ${differs ? '#ffb74d' : '#444'};
                            border-radius:3px; padding:1px 3px; font-size:11px;">
                        <span style="color:${differs ? '#ffb74d' : '#666'}; min-width:56px;">${
                            differs ? `live ${liveLevel}` : `/${MAX_LAB_TOKEN_LEVEL}`
                        }</span>
                    </span>
                </div>`;
            }
            html += '</div>';
        }

        html +=
            '<div style="display:flex; align-items:center; gap:8px; margin-top:6px;">' +
            `<button id="mwi-labsim-buffs-reset" style="${CHIP_BUTTON_STYLE}">Reset to live</button>` +
            '<span id="mwi-labsim-buffs-body-note" style="color:#ffb74d;"></span>' +
            '</div>';

        container.innerHTML = html;

        container.querySelectorAll('[data-lab-token-buff]').forEach((input) => {
            input.addEventListener('change', () => {
                const key = input.dataset.labTokenBuff;
                const raw = input.value.trim();
                if (raw === '') {
                    delete this._tokenBuffOverrides[key];
                } else {
                    const level = Math.min(MAX_LAB_TOKEN_LEVEL, Math.max(0, parseInt(raw, 10) || 0));
                    this._tokenBuffOverrides[key] = level;
                }
                void this._saveTokenBuffLevels();
                this._renderBuffsSection();
            });
        });
        container.querySelector('#mwi-labsim-buffs-reset')?.addEventListener('click', () => {
            this._tokenBuffOverrides = {};
            void this._saveTokenBuffLevels();
            this._renderBuffsSection();
        });

        const note = container.querySelector('#mwi-labsim-buffs-body-note');
        const summary = describeTokenOverrides(info, this._tokenBuffOverrides);
        if (note) note.textContent = summary ? `Simulating ${summary}` : '';
        this._refreshBuffsHeaderNote();
    }

    /**
     * Say on the collapsed header that the sims are not running on the live
     * tokens — the section is shut by default, and a silent override is a run
     * reported as the live character that never was.
     * @private
     */
    _refreshBuffsHeaderNote() {
        const note = this.panel?.querySelector('#mwi-labsim-buffs-note');
        if (!note) return;
        const summary = describeTokenOverrides(dataManager.characterData?.characterInfo, this._tokenBuffOverrides);
        note.textContent = summary ? `simulating ${summary}` : '';
    }

    /**
     * Persist the token levels being simulated, per character.
     * @private
     */
    async _saveTokenBuffLevels() {
        this._tokenBuffEdits += 1;
        try {
            this._tokenBuffOverrides = sanitizeTokenLevels(this._tokenBuffOverrides);
            await writeScoped(TOKEN_BUFF_LEVELS_KEY, this._tokenBuffOverrides, 'settings');
        } catch (error) {
            console.error('[LabSimUI] Failed to save labyrinth token levels:', error);
        }
    }

    /**
     * Read the remembered token levels back.
     * @private
     */
    async _restoreTokenBuffLevels() {
        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();
        const editsBefore = this._tokenBuffEdits;
        let levels;
        try {
            levels = sanitizeTokenLevels(await readScoped(TOKEN_BUFF_LEVELS_KEY, 'settings', null));
        } catch (error) {
            console.error('[LabSimUI] Failed to restore labyrinth token levels:', error);
            levels = {};
        }
        // A switch mid-read must not adopt the departing character's levels
        // into the arriving character's panel: the arriving character's own
        // restore (issued by its own buildPanel()) already raced this one and
        // would otherwise be overwritten by whichever read resolves last.
        if (!this._stillSameCharacter(ownerId)) return;
        // A level typed while the read was out is saved and on screen; the read is the older value
        if (this._tokenBuffEdits !== editsBefore) return;
        this._tokenBuffOverrides = levels;
        this._refreshBuffsHeaderNote();
        const body = this.panel?.querySelector('#mwi-labsim-buffs-body');
        if (body && body.style.display !== 'none') this._renderBuffsSection();
    }

    /**
     * Get selected crate HRIDs from the Configure tab.
     * @returns {string[]}
     */
    getSelectedCrates() {
        // Default the combat crates to what the character has equipped, in case
        // the panel was built before data loaded; a manual pick has opted out.
        this._applyEquippedCombatCrates();
        const crates = [];
        const teaHrid = this.panel?.querySelector('#mwi-labsim-tea')?.value;
        const coffeeHrid = this.panel?.querySelector('#mwi-labsim-coffee')?.value;
        const foodHrid = this.panel?.querySelector('#mwi-labsim-food')?.value;
        if (teaHrid) crates.push(teaHrid);
        if (coffeeHrid) crates.push(coffeeHrid);
        if (foodHrid) crates.push(foodHrid);
        return crates;
    }

    /** @private */
    _switchTab(tab) {
        this._activeTab = tab;
        const configureContent = this.panel.querySelector('#mwi-labsim-configure-content');
        const maxLevelContent = this.panel.querySelector('#mwi-labsim-maxlevel-content');
        const upgradeContent = this.panel.querySelector('#mwi-labsim-upgrade-content');
        const skillingContent = this.panel.querySelector('#mwi-labsim-skilling-content');
        const tabConfigure = this.panel.querySelector('#mwi-labsim-tab-configure');
        const tabMaxLevel = this.panel.querySelector('#mwi-labsim-tab-maxlevel');
        const tabUpgrade = this.panel.querySelector('#mwi-labsim-tab-upgrade');
        const tabSkilling = this.panel.querySelector('#mwi-labsim-tab-skilling');

        const activeStyle = `flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:${ACCENT_BG}; color:${ACCENT}; border-bottom:2px solid ${ACCENT};`;
        const inactiveStyle =
            'flex:1; padding:7px 0; text-align:center; font-size:12px; font-weight:600; cursor:pointer; border:none; font-family:inherit; transition:all 0.1s; background:transparent; color:#888; border-bottom:2px solid transparent;';

        configureContent.style.display = 'none';
        maxLevelContent.style.display = 'none';
        upgradeContent.style.display = 'none';
        skillingContent.style.display = 'none';
        tabConfigure.style.cssText = inactiveStyle;
        tabMaxLevel.style.cssText = inactiveStyle;
        tabUpgrade.style.cssText = inactiveStyle;
        tabSkilling.style.cssText = inactiveStyle;

        if (tab === 'configure') {
            configureContent.style.display = 'flex';
            tabConfigure.style.cssText = activeStyle;
        } else if (tab === 'maxlevel') {
            maxLevelContent.style.display = 'flex';
            tabMaxLevel.style.cssText = activeStyle;
        } else if (tab === 'upgrade') {
            upgradeContent.style.display = 'flex';
            tabUpgrade.style.cssText = activeStyle;
            this._populateUpgradePlayerSelector();
            // Redrawn on the way in rather than only when the panel opens: a
            // skip level that has moved on should not need a reload to be
            // noticed
            this._populateUpgradeTargets();
            // A section remembered as open would otherwise show the loadouts it
            // was last drawn with
            if (this._triggerChoices.open) void this._refreshTriggerLoadouts();
            this._onUpgradeSelectionChanged();
        } else if (tab === 'skilling') {
            skillingContent.style.display = 'flex';
            tabSkilling.style.cssText = activeStyle;
            void this._showSkillingTab();
        }
    }

    /** @private */
    async _showSkillingTab() {
        try {
            if (!this._skillingEditor.isInitialized()) {
                await this._skillingEditor.initEditor();
            }
            await this._renderSkillLoadoutTable();
            await this._restoreSkillingGoalInputs();
        } catch (error) {
            console.error('[LabSimUI] Failed to show skilling tab:', error);
            this._setStatus('Failed to load skilling tab: ' + error.message);
        }
    }

    /** @private */
    _setStatus(text) {
        const el = this.panel?.querySelector('#mwi-labsim-status');
        if (el) el.textContent = text;
    }

    /** @private */
    async _onSimulate() {
        if (this._runStarting) return;
        if (this.isRunning) {
            cancelActiveSimulations();
            this._setStatus('Labyrinth simulation cancelled.');
            return;
        }
        if (this._upgradeRunning || this._skillingRunning) return;

        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();

        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        const roomLevel = parseInt(this.panel.querySelector('#mwi-labsim-level')?.value) || 100;

        // Single Sim run caps. "Uncapped" ignores both numbers (they stay in the
        // fields) and runs to the precision target; otherwise the Max fights and
        // Max hrs inputs bound the run. When uncapped, fall back to a ceiling
        // high enough that only precision can end the run — a finite sentinel
        // keeps the engine's stop rule and the progress/ETA math well-defined.
        const uncapped = this.panel.querySelector('#mwi-labsim-uncapped')?.checked;
        const maxHoursCap = Math.max(
            1,
            parseInt(this.panel.querySelector('#mwi-labsim-maxhours')?.value) || DEFAULT_LAB_SIM_MAX_HOURS
        );
        const maxTrials = uncapped ? Number.MAX_SAFE_INTEGER : LAB_SIM_MAX_FIGHTS;
        const hours = uncapped ? 1e6 : maxHoursCap;

        if (!monsterHrid) {
            this._setStatus('Select a monster first.');
            return;
        }

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const crates = this.getSelectedCrates();
        const labyrinthCombatBuffs = this._labyrinthCombatBuffs();

        // A live profile read yields before `isRunning` is set. Claim that
        // window so a rapid second click cannot start another worker run, and
        // use a generation token so a destroyed panel cannot resume into the
        // same character's newly rebuilt panel.
        this._runStarting = true;
        const startToken = ++this._runStartToken;
        let selfDTO;
        try {
            const editedDTOs = this._editor?.getEditedDTOs();
            if (editedDTOs) {
                const selfHrid = this._editor.getSelfHrid();
                selfDTO = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
            } else {
                const result = await buildAllPlayerDTOs();
                selfDTO = result.players.find((p) => p.hrid === result.selfHrid) || result.players[0];
            }
        } catch (error) {
            if (startToken !== this._runStartToken) return;
            this._runStarting = false;
            if (!this._stillSameCharacter(ownerId)) return;
            console.error('[LabSimUI] Failed to load player for simulation:', error);
            this._setStatus('Simulation failed: ' + error.message);
            return;
        }
        if (startToken !== this._runStartToken) return;
        this._runStarting = false;

        if (!this._stillSameCharacter(ownerId)) return;

        if (!selfDTO) {
            this._setStatus('No character data available.');
            return;
        }

        const playerDTOs = [selfDTO];

        const communityBuffs = getCommunityBuffs();
        const zones = getCombatZones();
        const zoneHrid = zones[0]?.hrid || '/actions/combat/fly';

        this.isRunning = true;
        const runBtn = this.panel.querySelector('#mwi-labsim-run');
        runBtn.disabled = true;
        runBtn.style.opacity = '0.5';
        runBtn.style.cursor = 'not-allowed';

        const progressContainer = this.panel.querySelector('#mwi-labsim-progress');
        const progressFill = this.panel.querySelector('#mwi-labsim-progress-fill');
        const progressText = this.panel.querySelector('#mwi-labsim-progress-text');
        progressContainer.style.display = 'block';
        progressFill.style.width = '0%';
        progressText.textContent = '0%';

        const simStartTime = Date.now();
        // What is left of the run, measured from the run itself — the only
        // source for it, since the same sim takes wildly different times by
        // hours, party size and machine
        const eta = createEtaTracker();
        // A teardown can rebuild this singleton for the same character before
        // the old worker's resolution or cancellation reaches this await.
        const isCurrentRun = () => startToken === this._runStartToken && this._stillSameCharacter(ownerId);

        try {
            if (this._labyFindMaxMode) {
                // Same bar the labyrinth panel's Recommend button uses when the
                // field is blank — a hardcoded 95 here meant the two features
                // disagreed about what "clears" means
                const entered = parseInt(this.panel.querySelector('#mwi-labsim-threshold')?.value, 10);
                const threshold =
                    Number.isFinite(entered) && entered > 0
                        ? Math.min(100, Math.max(1, entered)) / 100
                        : defaultThreshold();
                // The search window follows the character rather than a fixed
                // 20-300, so it covers every room the automation table could
                // send them to and nothing else
                const referenceLevel = (
                    labyrinthClearRate() || bundledLabyrinthClearRate
                ).getPlayerEffectiveCombatLevel();
                const maxResult = await findMaxLabyrinthLevel(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        crates,
                        simHours: hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        threshold,
                        referenceLevel,
                    },
                    (progress) => {
                        if (!isCurrentRun()) return;
                        const percent = Math.round((progress.step / progress.totalSteps) * 100);
                        const { text: remaining } = eta.update(progress.step / progress.totalSteps);
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent =
                            `Level ${progress.level} — ${(progress.winRate * 100).toFixed(0)}% ` +
                            `(step ${progress.step}/${progress.totalSteps})` +
                            (remaining ? ` · ${remaining}` : '');
                    }
                );

                if (!isCurrentRun()) return;
                this._maxLevel = maxResult.maxLevel;
                // Filed against the monster it was searched for, so the Upgrade
                // tab's "Sim max" can use it without re-searching and without
                // reading whichever fight happened to be searched last
                if (maxResult.cleared) this._maxLevelByMonster[monsterHrid] = maxResult.maxLevel;
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                // Nothing cleared means there is no level to put in the box —
                // writing 0 would sim a room that does not exist
                if (levelInput && maxResult.cleared) levelInput.value = maxResult.maxLevel;
                this._refreshLevelSourceReadout();

                this._displayFindMaxResults(maxResult, monsterHrid, simStartTime);
            } else {
                const simResult = await runLabyrinthSimulation(
                    {
                        gameData,
                        playerDTOs,
                        zoneHrid,
                        monsterHrid,
                        roomLevel,
                        crates,
                        hours,
                        // Same rule as the tile badges: stop once the win rate
                        // is pinned down, with Max hrs as the time ceiling and
                        // Max fights as the trial cap (both 0 = unlimited above)
                        precision: {
                            targetHalfWidth:
                                Math.min(
                                    10,
                                    Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1)))
                                ) / 100,
                            minTrials: 100,
                            maxTrials,
                        },
                        communityBuffs,
                        labyrinthCombatBuffs,
                        // Build the monster with its full tier-gated kit (stun,
                        // defence shred, self-buffs), same as the tile badges and
                        // calibration replay — a bare auto-attacker over-predicts
                        // the clear, which was rosier here than the tile it sits on.
                        fullAbilities: true,
                        // Never a task fight. A labyrinth monster is not your
                        // combat task, so taskDamage pays nothing here — the
                        // panel used to offer a checkbox for it, which could
                        // only ever be ticked to get a wrong answer.
                        taskDamageMode: TASK_DAMAGE_OFF,
                    },
                    (percent) => {
                        if (!isCurrentRun()) return;
                        const { text: remaining } = eta.update(percent / 100);
                        progressFill.style.width = `${percent}%`;
                        progressText.textContent = remaining ? `${percent}% · ${remaining}` : `${percent}%`;
                    }
                );

                if (!isCurrentRun()) return;
                this._displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerDTOs[0].hrid);
                await this._recordSingleTargetRun(simResult, {
                    monsterHrid,
                    roomLevel,
                    hours,
                    crates,
                    playerHrid: playerDTOs[0].hrid,
                    ownerId,
                });
            }
        } catch (error) {
            if (!isCurrentRun()) return;
            if (error.message !== 'Cancelled') {
                console.error('[LabSimUI] Simulation failed:', error);
                this._setStatus('Simulation failed: ' + error.message);
            }
        } finally {
            if (isCurrentRun()) {
                this.isRunning = false;
                runBtn.disabled = false;
                runBtn.style.opacity = '1';
                runBtn.style.cursor = 'pointer';
                progressContainer.style.display = 'none';
                clearInterval(this.elapsedTimer);
                this.elapsedTimer = null;
            }
        }
    }

    /** @private */
    _displaySimResults(simResult, monsterHrid, roomLevel, hours, simStartTime, playerHrid) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const attempts = simResult.labyAttemptCount || 0;
        const encounters = simResult.encounters || 0;
        const deaths = simResult.deaths?.[playerHrid || 'player1'] || 0;
        const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
        const winRate = attempts > 0 ? ((encounters / attempts) * 100).toFixed(2) : '0.00';
        // The win rate is a proportion off a sample, so the sample size and the
        // band around it are part of the answer rather than trivia
        const band = wilsonInterval(encounters, attempts);
        const bandText = Number.isFinite(band.halfWidth)
            ? `\u00b1${(band.halfWidth * 100).toFixed(2)}%${simResult.labyStoppedOnPrecision ? '' : ' (capped)'}`
            : 'not enough fights';

        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Level ${roomLevel}
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 20px; font-size:12px;">
                    <div><span style="color:#888;">Win Rate:</span> <span style="color:${parseFloat(winRate) >= 95 ? '#4caf50' : parseFloat(winRate) >= 50 ? '#ff9800' : '#f44336'}; font-weight:600;">${winRate}%</span> <span style="color:#888;">${bandText}</span></div>
                    <div><span style="color:#888;">Encounters:</span> ${formatWithSeparator(attempts)}</div>
                    <div><span style="color:#888;">Deaths:</span> <span style="color:${deaths > 0 ? '#f44336' : '#4caf50'};">${formatWithSeparator(deaths)}</span></div>
                    <div><span style="color:#888;">Sim Time:</span> ${simHours.toFixed(1)}h</div>
                </div>
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed}</div>
            </div>
            <div id="mwi-labsim-comparison"></div>
        `;

        this._renderComparisonSection();
        this._setStatus(`Simulation complete \u2014 ${winRate}% win rate at level ${roomLevel}.`);
    }

    /**
     * Whether the character a run was started for is still the one logged in.
     *
     * A labyrinth run takes minutes, and everything recorded after it — the
     * comparison entry, the remembered upgrade analysis — is filed under a key
     * resolved at the moment of the write. A switch inside that window recorded
     * the departing character's run against the arriving character's gear
     * history and overwrote the analysis the arriving character was keeping.
     *
     * Compared rather than merely required, so a run with no character on
     * either side records exactly as it always has.
     *
     * @param {string|null|undefined} ownerId - The id captured before the run's first await
     * @returns {boolean} True when the results still belong to whoever is current
     * @private
     */
    _stillSameCharacter(ownerId) {
        return dataManager.getCurrentCharacterId() === ownerId;
    }

    /**
     * Keep a finished single-target run so the next one has something to be
     * read against.
     *
     * Only fixed-level fights are recorded. A Find Max run answers a different
     * question with a different headline number, and putting the two in one
     * table would invite a comparison that does not mean anything.
     *
     * @param {Object} simResult - From `runLabyrinthSimulation`
     * @param {Object} context - `{ monsterHrid, roomLevel, hours, crates, playerHrid, ownerId }`
     * @returns {Promise<void>}
     * @private
     */
    async _recordSingleTargetRun(simResult, { monsterHrid, roomLevel, hours, crates, playerHrid, ownerId }) {
        const token = this._runStartToken;
        const comparison = this._comparison;
        const isCurrentRun = () => token === this._runStartToken && this._stillSameCharacter(ownerId);
        try {
            // The run measured the character it started under. Recorded after a
            // switch it would join the arriving character's comparison table,
            // where it reads as their own "before" and skews every delta.
            if (!isCurrentRun()) return;
            await comparison.load();
            if (!isCurrentRun()) return;
            await comparison.add(
                makeLabRunEntry({
                    monsterHrid,
                    monsterName: getLabyrinthMonsters().find((m) => m.hrid === monsterHrid)?.name,
                    roomLevel,
                    hours,
                    crates,
                    gearLabel: this._editor?.generateSimLabel?.() || '',
                    attempts: simResult.labyAttemptCount || 0,
                    encounters: simResult.encounters || 0,
                    deaths: simResult.deaths?.[playerHrid || 'player1'] || 0,
                    simHours: (simResult.simulatedTime || 0) / (3600 * 1e9) || hours,
                })
            );
            if (isCurrentRun()) this._renderComparisonSection();
        } catch (error) {
            if (!isCurrentRun()) return;
            console.error('[LabSimUI] Failed to record run for comparison:', error);
        }
    }

    /**
     * Draw the comparison table under the latest single-target result, and
     * attach its controls.
     * @private
     */
    _renderComparisonSection() {
        const host = this.panel?.querySelector('#mwi-labsim-comparison');
        if (!host) return;

        host.innerHTML = renderLabComparisonPanel(this._comparison.runs, this._comparison.baselineId);
        wireLabComparisonPanel(host, {
            onBaseline: async (id) => {
                await this._comparison.setBaseline(id);
                this._renderComparisonSection();
            },
            onDelete: async (id) => {
                await this._comparison.remove(id);
                this._renderComparisonSection();
            },
            onClear: async () => {
                await this._comparison.clear();
                this._renderComparisonSection();
            },
        });
    }

    /**
     * Render a Find Max result.
     *
     * The objective is unchanged and stays unchanged: the highest room level
     * that still clears at the target rate. Experience per hour is shown beside
     * it as information \u2014 what that level is worth once losses and the walk are
     * paid for \u2014 not as something the search optimised.
     *
     * Two cases the old version got wrong. Nothing clearing anywhere in the
     * window used to print `0 - combatLevel + 1`, a large negative "recommended
     * skip" that reads like advice; it now says so in words. And a character
     * whose combat level is not known yet cannot have a skip derived at all,
     * since skip is a level offset.
     * @private
     */
    _displayFindMaxResults(maxResult, monsterHrid, simStartTime) {
        const container = this.panel?.querySelector('#mwi-labsim-results');
        if (!container) return;

        const totalElapsed = formatElapsed((Date.now() - simStartTime) / 1000);
        const monsterName = monsterHrid
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
        const barPct = ((maxResult.threshold ?? 0) * 100).toFixed(0);
        const effectiveCombatLevel = (
            labyrinthClearRate() || bundledLabyrinthClearRate
        ).getPlayerEffectiveCombatLevel();

        let headline;
        let detail;
        if (!maxResult.cleared) {
            headline = `<div style="font-size:16px; font-weight:700; color:#f44336; margin-bottom:6px;">
                    Nothing clears at ${barPct}%
                </div>`;
            detail = `<div style="font-size:12px; color:#888;">
                    No room between level ${maxResult.minLevel} and ${maxResult.maxSearched} met the target.
                    Lower the target win %, or bring stronger gear.
                </div>`;
        } else {
            const xpPerHour = (labyrinthClearRate() || bundledLabyrinthClearRate).estimateCombatXpPerHour(
                maxResult.maxLevel,
                maxResult.avgFightSeconds,
                maxResult.winRate
            );
            // Skip is a level offset, so it only exists once there is a level
            // to offset from; and it never sensibly goes below 1
            const rawSkip = effectiveCombatLevel > 0 ? maxResult.maxLevel - Math.floor(effectiveCombatLevel) + 1 : null;
            const skipText =
                rawSkip === null
                    ? 'unavailable until your combat level is known'
                    : rawSkip < 1
                      ? `1 (the lowest the game accepts \u2014 level ${maxResult.maxLevel} is below your own level)`
                      : String(rawSkip);

            headline = `<div style="font-size:24px; font-weight:700; color:#4caf50; margin-bottom:6px;">
                    Level ${maxResult.maxLevel}${maxResult.atCeiling ? '+' : ''}
                </div>`;
            detail =
                `<div style="font-size:12px; color:#888;">
                    Win Rate: <span style="color:#e0e0e0; font-weight:600;">${(maxResult.winRate * 100).toFixed(1)}%</span>
                    at level ${maxResult.maxLevel} (target ${barPct}%)
                </div>` +
                (xpPerHour > 0
                    ? `<div style="font-size:12px; color:#888; margin-top:4px;"
                            title="Experience per hour at this level, once lost attempts and the walk to the room are paid for. Shown for information \u2014 the search still picks the highest level clearing at the target rate, not the best experience.">
                            XP/hr here: <span style="color:#e0e0e0; font-weight:600;">${formatKMB(xpPerHour)}</span>
                        </div>`
                    : '') +
                `<div style="font-size:12px; color:#888; margin-top:4px;">
                    Recommended skip: <span style="color:#e0e0e0; font-weight:600;">${skipText}</span>
                </div>` +
                (maxResult.atCeiling
                    ? `<div style="font-size:11px; color:#ff9800; margin-top:4px;">
                            Still clearing at the top of the searched range (${maxResult.maxSearched}) \u2014 the true maximum may be higher.
                        </div>`
                    : '');
        }

        container.innerHTML = `
            <div style="margin-bottom:12px;">
                <div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
                    ${monsterName} \u2014 Find Max Result
                </div>
                ${headline}
                ${detail}
                <div style="color:#555; font-size:10px; margin-top:6px;">Completed in ${totalElapsed} (${maxResult.steps} steps, levels ${maxResult.minLevel}\u2013${maxResult.maxSearched})</div>
            </div>
        `;

        this._setStatus(
            maxResult.cleared
                ? `Max beatable level: ${maxResult.maxLevel} (${(maxResult.winRate * 100).toFixed(1)}% win rate).`
                : `No room cleared at ${barPct}% between levels ${maxResult.minLevel} and ${maxResult.maxSearched}.`
        );
    }

    /**
     * The "Check a swap" row for one tab: an item box with suggestions, a level,
     * Add, Check, and the chips of what is queued.
     *
     * The same row on both tabs, told apart by the suffix on its ids.
     *
     * @param {'combat'|'skilling'} kind - Which tab
     * @returns {HTMLElement}
     * @private
     */
    _buildSwapBar(kind) {
        const bar = document.createElement('div');
        bar.id = `mwi-labsim-swap-bar-${kind}`;
        bar.style.cssText = 'padding:6px 14px; border-bottom:1px solid #222; flex-shrink:0;';
        const inputStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        const buttonStyle =
            'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa; border-radius:6px; ' +
            'padding:4px 10px; font-size:12px; cursor:pointer; font-family:inherit;';
        const what =
            kind === 'combat'
                ? 'Put any piece of equipment, at the level you choose, into every fight loadout that uses its slot, ' +
                  'and see what it does. Owned or not. Add queues it; Check runs the queue with this tab’s ' +
                  'precision, hours and target scope. An ability works too (e.g. Critical Aura, level 7): it is ' +
                  'tried in place of each ability a loadout casts and in a free slot, and the best is shown per loadout.'
                : 'Put any piece of equipment, at the level you choose, into every skill kit that can feel it, and see ' +
                  'what it does to the clear rate. Owned or not. Add queues it; Check runs the queue.';
        bar.innerHTML = `
            <div id="mwi-labsim-swap-header-${kind}" style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;"
                title="${escapeHtmlAttribute(what)}">
                <span id="mwi-labsim-swap-toggle-${kind}" style="font-size:10px; color:#888;">▶</span>
                <span style="color:${ACCENT}; font-weight:700; font-size:12px;">Check a swap</span>
                <span id="mwi-labsim-swap-count-${kind}" style="color:#666; font-size:11px;"></span>
            </div>
            <div id="mwi-labsim-swap-body-${kind}" style="display:none; margin-top:4px;">
            <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px;">
                <input id="mwi-labsim-swap-item-${kind}" list="mwi-labsim-swap-items-${kind}" type="text" autocomplete="off"
                    placeholder="${kind === 'combat' ? 'Item or ability, e.g. Sinister Cape' : 'Item name, e.g. Sinister Cape'}" style="${inputStyle} width:210px; max-width:100%;">
                <datalist id="mwi-labsim-swap-items-${kind}"></datalist>
                <span style="color:#888; font-size:12px;">+</span>
                <input id="mwi-labsim-swap-level-${kind}" type="number" min="0" max="${kind === 'combat' ? MAX_ABILITY_SWAP_LEVEL : MAX_SWAP_LEVEL}" step="1"
                    placeholder="Lv" title="${kind === 'combat' ? 'Enhancement level to check (the ability level, for an ability)' : 'Enhancement level to check'}" style="${inputStyle} width:46px; text-align:center;">
                <button id="mwi-labsim-swap-add-${kind}" style="${buttonStyle}" title="Queue this swap">Add</button>
                <button id="mwi-labsim-swap-check-${kind}" style="${buttonStyle}" title="${escapeHtmlAttribute(what)}">Check</button>
                <button id="mwi-labsim-swap-clear-${kind}" style="${buttonStyle}" title="Hide and empty the checked swaps table. The queue stays.">Clear</button>
                <label style="display:flex; align-items:center; gap:4px; color:#888; font-size:12px; cursor:pointer;"
                    title="${kind === 'combat' ? 'Put the item in every loadout that has the slot, even ones of another attack style. Without this, a ranged item skips melee loadouts and so on.' : 'Put the item in every skill kit in scope, not only the skills it is made for.'}">
                    <input type="checkbox" id="mwi-labsim-swap-all-${kind}" style="margin:0; cursor:pointer;">
                    All loadouts
                </label>
                <span id="mwi-labsim-swap-note-${kind}" style="color:#666; font-size:11px;"></span>
            </div>
            <div id="mwi-labsim-swap-chips-${kind}" style="display:flex; flex-wrap:wrap; gap:4px 6px; margin-top:4px;"></div>
            </div>
        `;
        return bar;
    }

    /**
     * The "Tune triggers" section: which loadouts, which rows, how precise, and the cost before it runs.
     * @returns {HTMLElement}
     * @private
     */
    _buildTriggerBar() {
        const bar = document.createElement('div');
        bar.id = 'mwi-labsim-trigger-bar';
        bar.style.cssText = 'padding:6px 14px; border-bottom:1px solid #222; flex-shrink:0;';
        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:4px; padding:3px 6px; font-size:12px;';
        const buttonStyle =
            'background:rgba(255,255,255,0.04); border:1px solid #333; color:#aaa; border-radius:6px; ' +
            'padding:4px 10px; font-size:12px; cursor:pointer; font-family:inherit;';
        const what =
            'Tune the numbers in each loadout’s trigger rows (how much enemy HP an ability waits for, how low ' +
            'your HP or MP gets before a food or drink fires) to need fewer attempts in the labyrinth fights the ' +
            'loadout is assigned to. Tunes the fights the Upgrade tab’s Targets scope names (the Configure fight, ' +
            'all targets, or the chosen ones). Only simulates: set any change in the game by hand.';
        bar.innerHTML = `
            <div id="mwi-labsim-trigger-header" style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;"
                title="${escapeHtmlAttribute(what)}">
                <span id="mwi-labsim-trigger-toggle" style="font-size:10px; color:#888;">▶</span>
                <span style="color:${ACCENT}; font-weight:700; font-size:12px;">Tune triggers</span>
                <span id="mwi-labsim-trigger-summary" style="display:none; color:#aaa; font-size:11px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"></span>
            </div>
            <div id="mwi-labsim-trigger-body" style="display:none; margin-top:4px;">
                <div id="mwi-labsim-trigger-loadouts" style="display:flex; flex-wrap:wrap; gap:4px 12px;"></div>
                <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin-top:4px;">
                    ${labTriggerOptionsHtml(this._triggerChoices, selectStyle)}
                    <button id="mwi-labsim-trigger-run" style="${buttonStyle}" title="${escapeHtmlAttribute(what)}">Tune</button>
                    <span id="mwi-labsim-trigger-estimate" style="color:#666; font-size:11px;"></span>
                </div>
                <div id="mwi-labsim-trigger-results" style="display:none; margin-top:8px;"></div>
            </div>
        `;
        return bar;
    }

    /**
     * Wire the Tune triggers section.
     * @private
     */
    _wireTriggerBar() {
        this.panel.querySelector('#mwi-labsim-trigger-header')?.addEventListener('click', () => {
            this._triggerChoices.open = !this._triggerChoices.open;
            this._applyTriggerSectionState();
            void this._saveTriggerChoices();
        });
        const body = this.panel.querySelector('#mwi-labsim-trigger-body');
        body?.addEventListener('change', (event) => {
            const target = event.target;
            if (target?.id === 'mwi-labsim-trigger-precision') this._triggerChoices.precision = target.value;
            else if (target?.id === 'mwi-labsim-trigger-conditions') this._triggerChoices.conditions = target.checked;
            else if (target?.dataset?.labTriggerGroup) {
                const skipped = new Set(this._triggerChoices.skipped);
                if (target.checked) skipped.delete(target.dataset.labTriggerGroup);
                else skipped.add(target.dataset.labTriggerGroup);
                this._triggerChoices.skipped = [...skipped];
            } else return;
            this._refreshTriggerEstimate();
            void this._saveTriggerChoices();
        });
        this.panel.querySelector('#mwi-labsim-trigger-run')?.addEventListener('click', () => this._onTuneTriggers());
    }

    /**
     * Draw the section open or closed, with its controls set from the remembered choices; opening it
     * lists the loadouts the labyrinth fights wear now.
     * @private
     */
    _applyTriggerSectionState() {
        const open = this._triggerChoices.open;
        const body = this.panel?.querySelector('#mwi-labsim-trigger-body');
        if (body) body.style.display = open ? 'block' : 'none';
        const toggle = this.panel?.querySelector('#mwi-labsim-trigger-toggle');
        if (toggle) toggle.textContent = open ? '▼' : '▶';
        const precision = this.panel?.querySelector('#mwi-labsim-trigger-precision');
        if (precision) precision.value = this._triggerChoices.precision;
        const conditions = this.panel?.querySelector('#mwi-labsim-trigger-conditions');
        if (conditions) conditions.checked = this._triggerChoices.conditions;
        this._applyTriggerSummary();
        if (open) void this._refreshTriggerLoadouts();
    }

    /**
     * Say what the last result found on the section's header while the section is collapsed (the result is
     * inside it, hidden with it). Nothing extra when there is no result yet, or while the section is open.
     * @private
     */
    _applyTriggerSummary() {
        const summary = this.panel?.querySelector('#mwi-labsim-trigger-summary');
        if (!summary) return;
        const text = this._triggerSummary || '';
        summary.textContent = text ? `— ${text}` : '';
        summary.style.display = !this._triggerChoices.open && text ? 'inline' : 'none';
    }

    /**
     * The fights the Tune triggers section works on, as the Upgrade tab's Targets scope names them:
     * `all` is every labyrinth fight, grouped by the loadout each wears, at the room levels the
     * whole-run analysis uses; `selected` is the ticked rooms' fights only; `current` is the
     * Configure tab's single fight. `note` says why the list is empty, when it is.
     * @param {Object} [options] - `{ forRun, gameData }`; `forRun` resolves the Configure level as Analyze does
     * @returns {Promise<{scopeMode: string, groups: Array<Object>, note: string}>}
     * @private
     */
    async _resolveTriggerTargets({ forRun = false, gameData = null } = {}) {
        const scopeMode = this._getUpgradeScopeMode();
        if (scopeMode === 'current') return this._configureTriggerTargets({ forRun, gameData });
        const useSkipLevels = this.panel?.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
        const fights = this._collectLabyrinthFights(useSkipLevels);
        if (!fights.length) {
            return {
                scopeMode,
                groups: [],
                note: 'No labyrinth fights resolve to a room level yet. Set combat skip levels in the game, or enter the labyrinth.',
            };
        }
        const chosen = this._getChosenTargets();
        const groups = groupFightsForScope(fights, scopeMode, chosen);
        if (scopeMode === 'selected' && !groups.length) {
            return {
                scopeMode,
                groups,
                note: 'No target is ticked in the Upgrade tab’s Chosen targets. Tick at least one room to tune.',
            };
        }
        return { scopeMode, groups, note: '' };
    }

    /**
     * The Configure-fight scope's one group, built the way the Upgrade tab's single-fight analysis
     * builds its fight: the Configure tab's monster at its resolved room level, in the selected player
     * as edited there (saved or not). `forRun` resolves the level the way Analyze does, which may run
     * the Find Max search; a refresh only reads what is already known.
     * @param {Object} [options] - `{ forRun, gameData }`
     * @returns {Promise<{scopeMode: string, groups: Array<Object>, note: string}>}
     * @private
     */
    async _configureTriggerTargets({ forRun = false, gameData = null } = {}) {
        const none = (note) => ({ scopeMode: 'current', groups: [], note });
        const monsterHrid = this.panel?.querySelector('#mwi-labsim-monster')?.value || '';
        if (!monsterHrid) return none('Select a monster in the Configure tab first.');
        const edited = this._editor?.getEditedDTOs();
        let playerDTOs;
        if (edited) playerDTOs = Object.values(edited);
        else playerDTOs = (await buildAllPlayerDTOs()).players;
        const playerIndex = parseInt(this.panel?.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const dto = playerDTOs?.[playerIndex];
        if (!dto) return none('No player data available.');
        let roomLevel;
        if (forRun && gameData) {
            const uncapped = this.panel?.querySelector('#mwi-labsim-upgrade-uncapped')?.checked;
            const maxHours = Math.max(
                1,
                parseInt(this.panel?.querySelector('#mwi-labsim-upgrade-maxhours')?.value) || DEFAULT_LAB_SIM_MAX_HOURS
            );
            roomLevel = await this._resolveUpgradeRoomLevel({
                monsterHrid,
                gameData,
                playerDTOs,
                playerIndex,
                crates: this.getSelectedCrates(),
                hours: uncapped ? 1e6 : maxHours,
                communityBuffs: getCommunityBuffs(),
                labyrinthCombatBuffs: this._labyrinthCombatBuffs(),
            });
        } else {
            roomLevel = this._resolveTargetLevel(monsterHrid).level;
        }
        if (!roomLevel) {
            return none(
                'No room level resolves for the Configure fight. Pick a level source with a value behind it, or put a level in the Configure tab.'
            );
        }
        const monster = getLabyrinthMonsters().find((entry) => entry.hrid === monsterHrid);
        const monsterName = monster?.name || monsterHrid.split('/').pop().replace(/_/g, ' ');
        return {
            scopeMode: 'current',
            // A copy: the group outlives this call (the list and the run hold it), and the DTO is the live
            // editor's, which keeps changing under the player's hands. Solo by design, as the Upgrade tab's
            // single-fight analysis is: the labyrinth sim runs `[playerDTOs[playerIndex]]`, never a party.
            groups: [configureFightGroup({ monsterHrid, monsterName, roomLevel, dto: structuredClone(dto) })],
            note: '',
        };
    }

    /**
     * Something the Tune triggers section's fights depend on changed (the Upgrade tab's target scope,
     * the ticked targets, the skip-level rule, the Configure fight): an earlier result described other
     * fights, so it is cleared, and the list and cost are redrawn.
     * @private
     */
    _onTriggerScopeChanged() {
        if (!this.panel) return;
        // A run in flight described the scope it started with; it checks this when it finishes
        this._triggerScopeGen++;
        const resultsEl = this.panel.querySelector('#mwi-labsim-trigger-results');
        // Cleared whatever else is running: `_upgradeRunning` is also set by the upgrade analysis, Check swaps
        // and the skilling run, none of which redraw this box, and the tune run itself cleared it at its start
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
            this._triggerSummary = '';
            this._applyTriggerSummary();
        }
        // A Verify button on the old result must not run against it, and its verdicts described other fights.
        // Another section's verify in flight keeps its token: only the trigger state is dropped then
        if (!this._verify.running || this._verify.running.scope === 'trigger') {
            this._clearVerify(['trigger']);
        } else {
            this._verifyLive.trigger = null;
            this._verify.trigger = this._freshVerify().trigger;
        }
        if (this._triggerChoices.open) void this._refreshTriggerLoadouts();
    }

    /**
     * What the Configure editor holds right now, as a comparable string.
     * @returns {string|null}
     * @private
     */
    _editorEditSignature() {
        try {
            return JSON.stringify(this._editor?.getEditedDTOs() ?? null);
        } catch {
            return null;
        }
    }

    /**
     * Check the editor shortly after an event from it: a burst of keystrokes costs one comparison.
     * @private
     */
    _scheduleEditorEditCheck() {
        if (this._editorEditTimer) clearTimeout(this._editorEditTimer);
        this._editorEditTimer = setTimeout(() => {
            this._editorEditTimer = null;
            this._checkEditorEdited();
        }, 150);
    }

    /**
     * The Configure editor changed (gear, ability levels, trigger values, food): under the Configure
     * fight scope a run's snapshot or a drawn result describes the old build, so it goes stale like any
     * other scope change. Under All or Selected targets the saved loadouts are the input and the
     * editor does not matter, so only the remembered signature moves.
     * @returns {boolean} True when the editor differs from the last look
     * @private
     */
    _checkEditorEdited() {
        const signature = this._editorEditSignature();
        // First look: nothing has run on an earlier state of the editor
        if (this._editorEditSig === null) {
            this._editorEditSig = signature;
            return false;
        }
        if (signature === this._editorEditSig) return false;
        this._editorEditSig = signature;
        if (this._getUpgradeScopeMode() === 'current') this._onTriggerScopeChanged();
        return true;
    }

    /**
     * List the loadout checkboxes and the cost line.
     * @private
     */
    async _refreshTriggerLoadouts() {
        const box = this.panel?.querySelector('#mwi-labsim-trigger-loadouts');
        if (!box) return;
        const seq = ++this._triggerRefreshSeq;
        const ownerId = dataManager.getCurrentCharacterId();
        let targets;
        try {
            targets = await this._resolveTriggerTargets();
        } catch (error) {
            console.error('[LabSimUI] Listing trigger loadouts failed:', error);
            targets = { scopeMode: this._getUpgradeScopeMode(), groups: [], note: '' };
        }
        // A newer refresh, a closed panel or another character owns the section now
        if (seq !== this._triggerRefreshSeq || !this.panel || !this._stillSameCharacter(ownerId)) return;
        this._triggerTargets = targets;
        try {
            box.innerHTML = labTriggerLoadoutsHtml(targets.groups, new Set(this._triggerChoices.skipped), targets.note);
        } catch (error) {
            console.error('[LabSimUI] Listing trigger loadouts failed:', error);
        }
        this._refreshTriggerEstimate();
    }

    /**
     * The groups a run would tune: the scope's groups with the unticked loadouts taken out (the
     * Configure fight has no tick).
     * @param {Array<Object>} groups - From `_resolveTriggerTargets`
     * @returns {Array<Object>}
     * @private
     */
    _chosenTriggerGroups(groups = this._triggerTargets.groups) {
        const skipped = new Set(this._triggerChoices.skipped);
        return groups.filter((group) => group.configure || !skipped.has(group.key));
    }

    /**
     * Say what a run would cost, before it is started.
     * @private
     */
    _refreshTriggerEstimate() {
        const el = this.panel?.querySelector('#mwi-labsim-trigger-estimate');
        if (!el) return;
        try {
            const gameData = buildGameDataPayload();
            // The list above already says why there is nothing to tune
            if (!this._triggerTargets.groups.length && this._triggerTargets.note) {
                el.textContent = '';
                return;
            }
            el.textContent = gameData
                ? describeLabTriggerEstimate(
                      estimateLabTriggerRun({
                          groups: this._chosenTriggerGroups(),
                          gameData,
                          precision: this._triggerChoices.precision,
                          searchConditions: this._triggerChoices.conditions,
                      })
                  )
                : '';
        } catch (error) {
            console.error('[LabSimUI] Estimating trigger tuning failed:', error);
            el.textContent = '';
        }
    }

    /**
     * Remember the section's choices for this character.
     * @private
     */
    async _saveTriggerChoices() {
        try {
            await writeScoped(TRIGGER_CHOICES_KEY, { ...this._triggerChoices }, 'settings');
        } catch (error) {
            console.error('[LabSimUI] Failed to save trigger tuning choices:', error);
        }
    }

    /**
     * Read this character's choices back, on a build and when a sync pull brings them.
     * @private
     */
    async _restoreTriggerChoices() {
        const ownerId = dataManager.getCurrentCharacterId();
        let saved = null;
        try {
            saved = await readScoped(TRIGGER_CHOICES_KEY, 'settings', null);
        } catch (error) {
            console.error('[LabSimUI] Failed to restore trigger tuning choices:', error);
            return;
        }
        if (!this.panel || !this._stillSameCharacter(ownerId)) return;
        this._triggerChoices = sanitizeLabTriggerChoices(saved);
        this._applyTriggerSectionState();
    }

    /**
     * Tune the ticked loadouts' triggers against their labyrinth fights. Show-only: nothing is
     * written anywhere but the results box, and nothing reaches the game.
     * @private
     */
    async _onTuneTriggers() {
        if (this._upgradeRunning || this._skillingRunning || this._runStarting || this.isRunning) return;
        this._upgradeRunning = true;
        // A teardown (character switch) bumps the token, after which this run is stale
        const runToken = ++this._runStartToken;
        const ownerId = dataManager.getCurrentCharacterId();
        const isCurrent = () =>
            runToken === this._runStartToken && Boolean(this.panel) && this._stillSameCharacter(ownerId);
        const resultsEl = this.panel.querySelector('#mwi-labsim-trigger-results');
        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        const tuneBtn = this.panel.querySelector('#mwi-labsim-trigger-run');
        const finish = () => {
            if (progressEl) progressEl.style.display = 'none';
            if (runBtn) runBtn.style.display = '';
            if (stopBtn) stopBtn.style.display = 'none';
            if (tuneBtn) tuneBtn.disabled = false;
            if (runToken === this._runStartToken) this._upgradeRunning = false;
        };

        try {
            const gameData = buildGameDataPayload();
            if (!gameData) {
                this._setStatus('No game data available.');
                return;
            }
            // The Configure level may need the Find Max search, which reports in the progress box
            this._upgradeAborted = false;
            if (this._getUpgradeScopeMode() === 'current') {
                if (progressEl) progressEl.style.display = 'block';
                if (stopBtn) stopBtn.style.display = 'inline-block';
                if (runBtn) runBtn.style.display = 'none';
            }
            const scopeGen = this._triggerScopeGen;
            this._editorEditSig = this._editorEditSignature();
            // Resolved again here: the DTOs and levels drawn in the list may be older than this press
            const targets = await this._resolveTriggerTargets({ forRun: true, gameData });
            if (!isCurrent()) return;
            if (this._upgradeAborted) {
                this._setStatus('Trigger tuning stopped.');
                return;
            }
            this._triggerTargets = targets;
            const groups = this._chosenTriggerGroups(targets.groups);
            if (!groups.length) {
                this._setStatus(
                    targets.note ||
                        'No loadout to tune. Tick one, or set combat skip levels in the game so fights have room levels.'
                );
                return;
            }
            const { precision, conditions: searchConditions } = this._triggerChoices;
            const estimate = estimateLabTriggerRun({ groups, gameData, precision, searchConditions });
            if (estimate.sims === 0 && !(estimate.conditionSims > 0)) {
                this._setStatus('No tunable trigger rows in the ticked loadouts.');
                return;
            }

            if (progressEl) progressEl.style.display = 'block';
            if (runBtn) runBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (tuneBtn) tuneBtn.disabled = true;
            if (resultsEl) {
                resultsEl.innerHTML = '';
                resultsEl.style.display = 'none';
            }
            this._clearVerify(['trigger']);
            this._upgradeAborted = false;
            this._setStatus(`Tuning triggers: ${describeLabTriggerEstimate(estimate)} Stop cancels at any point.`);

            const eta = createEtaTracker();
            const run = await runLabTriggerOptimization(
                {
                    gameData,
                    groups,
                    crates: this.getSelectedCrates(),
                    communityBuffs: getCommunityBuffs(),
                    labyrinthCombatBuffs: this._labyrinthCombatBuffs(),
                    precision,
                    searchConditions,
                },
                ({ current, total, description }) => {
                    if (!isCurrent() || this._upgradeAborted) return;
                    const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
                    const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` +
                            (remaining ? ` · ${remaining}` : '') +
                            (description ? `: ${description}` : '');
                    }
                },
                { abortSignal: () => !isCurrent() || this._upgradeAborted }
            );

            // A stopped run, or one that now belongs to another character, draws nothing
            if (!isCurrent()) return;
            if (this._upgradeAborted || run.stopped) {
                this._setStatus('Trigger tuning stopped.');
                return;
            }
            // An edit in the Configure editor whose event has not been checked yet counts as a scope move
            this._checkEditorEdited();
            // The scope (target mode, ticked rooms, skip rule, Configure fight) moved while this ran: the list
            // beside the results now names other fights, so the result would read as theirs
            if (scopeGen !== this._triggerScopeGen) {
                this._setStatus('The targets changed while tuning, so the result was not shown. Tune again.');
                return;
            }
            if (resultsEl) {
                this._verifyLive.trigger = { run, gameData, ownerId };
                this._drawTriggerResults();
                this._triggerSummary = summarizeLabTriggerRun(run);
                this._applyTriggerSummary();
            }
            const changes = countLabTriggerChanges(run);
            this._setStatus(
                changes > 0
                    ? `Trigger tuning complete: ${changes} change${changes === 1 ? '' : 's'} found. Set them in the game by hand.`
                    : 'Trigger tuning complete: nothing clearly better found.'
            );
        } catch (error) {
            if (isCurrent() && error.message !== 'Cancelled' && error.message !== 'Aborted') {
                console.error('[LabSimUI] Trigger tuning failed:', error);
                this._setStatus('Trigger tuning failed: ' + error.message);
            }
        } finally {
            finish();
        }
    }

    /**
     * Wire both "Check a swap" rows.
     * @private
     */
    _wireSwapBars() {
        for (const kind of ['combat', 'skilling']) {
            const item = this.panel.querySelector(`#mwi-labsim-swap-item-${kind}`);
            const level = this.panel.querySelector(`#mwi-labsim-swap-level-${kind}`);
            this.panel.querySelector(`#mwi-labsim-swap-header-${kind}`)?.addEventListener('click', () => {
                this._swapOptions.open[kind] = !this._isSwapSectionOpen(kind);
                this._applySwapSectionState(kind);
                this._swapOptionChanged(['open', kind]);
            });
            this.panel.querySelector(`#mwi-labsim-swap-all-${kind}`)?.addEventListener('change', (event) => {
                this._swapOptions.all[kind] = event.target.checked;
                this._swapOptionChanged(['all', kind]);
            });
            item?.addEventListener('input', () => this._fillSwapSuggestions(kind));
            for (const box of [item, level]) {
                box?.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') this._onAddSwap(kind);
                });
            }
            this.panel
                .querySelector(`#mwi-labsim-swap-add-${kind}`)
                ?.addEventListener('click', () => this._onAddSwap(kind));
            this.panel
                .querySelector(`#mwi-labsim-swap-check-${kind}`)
                ?.addEventListener('click', () =>
                    kind === 'combat' ? this._onCheckSwapsCombat() : this._onCheckSwapsSkilling()
                );
            this.panel
                .querySelector(`#mwi-labsim-swap-clear-${kind}`)
                ?.addEventListener('click', () => this._onClearCheckedResults(kind));
            this.panel.querySelector(`#mwi-labsim-upgrades-header-${kind}`)?.addEventListener('click', () => {
                this._swapOptions.upgradesOpen[kind] = !this._swapOptions.upgradesOpen[kind];
                this._applySwapSectionState(kind);
                this._swapOptionChanged(['upgradesOpen', kind]);
            });
            this.panel.querySelector(`#mwi-labsim-swap-chips-${kind}`)?.addEventListener('click', (event) => {
                const remove = event.target.closest('[data-swap-remove]');
                if (!remove) return;
                this._checkedSwaps[kind] = this._checkedSwaps[kind].filter(
                    (swap) => checkedSwapKey(swap) !== remove.dataset.swapRemove
                );
                this._renderSwapChips(kind);
                void this._saveCheckedSwaps();
            });
        }
    }

    /**
     * Whether a tab's Check a swap section is open: what was last chosen, or open
     * when it has swaps queued and nothing was ever chosen.
     * @param {'combat'|'skilling'} kind - Which tab
     * @returns {boolean}
     * @private
     */
    _isSwapSectionOpen(kind) {
        const chosen = this._swapOptions.open[kind];
        return chosen === null ? this._checkedSwaps[kind].length > 0 : chosen;
    }

    /**
     * Draw a tab's section open or closed, its count and its All loadouts box.
     * @param {'combat'|'skilling'} kind - Which tab
     * @private
     */
    _applySwapSectionState(kind) {
        const open = this._isSwapSectionOpen(kind);
        const body = this.panel?.querySelector(`#mwi-labsim-swap-body-${kind}`);
        if (body) body.style.display = open ? 'block' : 'none';
        const toggle = this.panel?.querySelector(`#mwi-labsim-swap-toggle-${kind}`);
        if (toggle) toggle.textContent = open ? '▼' : '▶';
        const count = this.panel?.querySelector(`#mwi-labsim-swap-count-${kind}`);
        const n = this._checkedSwaps[kind].length;
        if (count) count.textContent = n ? `${n} queued` : '';
        const all = this.panel?.querySelector(`#mwi-labsim-swap-all-${kind}`);
        if (all) all.checked = this._swapOptions.all[kind];
        const upgradesOpen = this._swapOptions.upgradesOpen[kind];
        const upgradesToggle = this.panel?.querySelector(`#mwi-labsim-upgrades-toggle-${kind}`);
        if (upgradesToggle) upgradesToggle.textContent = upgradesOpen ? '▼' : '▶';
        const upgradesResults = this.panel?.querySelector(
            kind === 'combat' ? '#mwi-labsim-upgrade-results' : '#mwi-labsim-skilling-results'
        );
        if (upgradesResults) upgradesResults.style.display = upgradesOpen ? '' : 'none';
        this._applyCheckedCollapse(kind);
    }

    /**
     * The clickable "Checked swaps" heading above a tab's checked results.
     * @param {'combat'|'skilling'} kind - Which tab
     * @returns {string} HTML
     * @private
     */
    _checkedHeadingHtml(kind) {
        return (
            `<div id="mwi-labsim-checked-header-${kind}" data-checked-heading style="display:flex; align-items:center; ` +
            `gap:6px; cursor:pointer; user-select:none; margin-bottom:4px;">` +
            `<span data-checked-toggle style="font-size:10px; color:#888;">▼</span>` +
            `<span style="color:${ACCENT}; font-weight:700; font-size:12px;">Checked swaps</span></div>`
        );
    }

    /**
     * Draw a tab's checked results open or closed: everything after the heading
     * (baseline line, table, notes) is hidden while it is collapsed. Safe to call
     * after any render; does nothing while no checked results are drawn.
     * @param {'combat'|'skilling'} kind - Which tab
     * @param {HTMLElement} [results] - The results element; the tab's own when omitted
     * @private
     */
    _applyCheckedCollapse(kind, results) {
        const container =
            results ||
            this.panel?.querySelector(
                kind === 'combat' ? '#mwi-labsim-swap-results' : '#mwi-labsim-skilling-swap-results'
            );
        const header = container?.querySelector('[data-checked-heading]');
        if (!header) return;
        const open = this._swapOptions.checkedOpen[kind];
        const toggle = header.querySelector('[data-checked-toggle]');
        if (toggle) toggle.textContent = open ? '▼' : '▶';
        for (let el = header.nextElementSibling; el; el = el.nextElementSibling) {
            el.style.display = open ? '' : 'none';
        }
    }

    /**
     * Make a freshly drawn "Checked swaps" heading collapse the results, and apply
     * the remembered state to them. Called after every render of the checked results.
     * @param {'combat'|'skilling'} kind - Which tab
     * @param {HTMLElement} container - The element the results were drawn into
     * @private
     */
    _wireCheckedHeading(kind, container) {
        container.querySelector('[data-checked-heading]')?.addEventListener('click', () => {
            this._swapOptions.checkedOpen[kind] = !this._swapOptions.checkedOpen[kind];
            this._applyCheckedCollapse(kind, container);
            this._swapOptionChanged(['checkedOpen', kind]);
        });
        this._applyCheckedCollapse(kind, container);
    }

    /**
     * The clickable "Upgrades" header above a tab's generated results. Collapsing it
     * hides everything the generated run drew (budget row, baseline and table).
     * @param {'combat'|'skilling'} kind - Which tab
     * @returns {HTMLElement}
     * @private
     */
    _buildUpgradesHeader(kind) {
        const header = document.createElement('div');
        header.id = `mwi-labsim-upgrades-header-${kind}`;
        header.style.cssText =
            'display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; padding:6px 14px; ' +
            'border-bottom:1px solid #222; flex-shrink:0;';
        header.title = 'Show or hide the generated upgrade results.';
        header.innerHTML =
            `<span id="mwi-labsim-upgrades-toggle-${kind}" style="font-size:10px; color:#888;">▼</span>` +
            `<span style="color:${ACCENT}; font-weight:700; font-size:12px;">Upgrades</span>`;
        return header;
    }

    /**
     * Clear a tab's checked swaps table: hide and empty it, leaving the queued chips
     * alone. Does nothing while a run is going (the button is a no-op then, with a
     * note), so it never races a check that is about to draw into the same table.
     * Checked results are never stored, so there is nothing else to forget.
     * @param {'combat'|'skilling'} kind - Which tab
     * @private
     */
    _onClearCheckedResults(kind) {
        if (this._upgradeRunning || this._skillingRunning) {
            this._setSwapNote(kind, 'Stop the running check first.', true);
            return;
        }
        const resultsEl = this.panel?.querySelector(
            kind === 'combat' ? '#mwi-labsim-swap-results' : '#mwi-labsim-skilling-swap-results'
        );
        if (resultsEl) {
            resultsEl.innerHTML = '';
            resultsEl.style.display = 'none';
        }
        this._setSwapNote(kind, '');
    }

    /**
     * Say something beside a "Check a swap" row.
     * @param {'combat'|'skilling'} kind - Which tab
     * @param {string} text - The note, empty to clear it
     * @param {boolean} [isError=false] - Draw it as a problem
     * @private
     */
    _setSwapNote(kind, text, isError = false) {
        const note = this.panel?.querySelector(`#mwi-labsim-swap-note-${kind}`);
        if (!note) return;
        note.textContent = text;
        note.style.color = isError ? '#ff9800' : '#666';
    }

    /**
     * Fill the item box's suggestion list from what has been typed.
     * @param {'combat'|'skilling'} kind - Which tab
     * @private
     */
    _fillSwapSuggestions(kind) {
        const list = this.panel?.querySelector(`#mwi-labsim-swap-items-${kind}`);
        const typed = this.panel?.querySelector(`#mwi-labsim-swap-item-${kind}`)?.value;
        if (!list) return;
        const gameData = buildGameDataPayload();
        const matches = gameData ? searchEquipmentItems(gameData, typed, 30) : [];
        // Abilities are only checked on the combat side; the skilling kits have no ability bar
        if (gameData && kind === 'combat') matches.push(...searchAbilities(gameData, typed, 15));
        // Value only: Firefox shows an option's label in place of its value, so a slot label
        // there listed "off hand", "hands"... instead of the item names
        list.innerHTML = matches.map((item) => `<option value="${escapeHtmlAttribute(item.name)}"></option>`).join('');
    }

    /**
     * Queue the typed swap.
     * @param {'combat'|'skilling'} kind - Which tab
     * @private
     */
    _onAddSwap(kind) {
        const itemBox = this.panel?.querySelector(`#mwi-labsim-swap-item-${kind}`);
        const levelBox = this.panel?.querySelector(`#mwi-labsim-swap-level-${kind}`);
        if (!itemBox) return;
        const gameData = buildGameDataPayload();
        const resolve = kind === 'combat' ? resolveSwapHrid : resolveEquipmentHrid;
        const hrid = gameData ? resolve(gameData, itemBox.value) : null;
        if (!hrid) {
            this._setSwapNote(
                kind,
                itemBox.value.trim()
                    ? kind === 'combat'
                        ? 'No single piece of equipment or ability matches. Pick one from the suggestions.'
                        : 'No single piece of equipment matches. Pick one from the suggestions.'
                    : 'Type an item name first.',
                true
            );
            return;
        }
        if (this._queueSwap(kind, { hrid, level: clampLevelFor(hrid, levelBox?.value) })) itemBox.value = '';
        this._fillSwapSuggestions(kind);
    }

    /**
     * Put a swap on a tab's queue, unless it is a repeat or the queue is full.
     * @param {'combat'|'skilling'} kind - Which tab
     * @param {{hrid: string, level: number}} swap - What to queue
     * @returns {boolean} Whether it was queued
     * @private
     */
    _queueSwap(kind, swap) {
        const queue = this._checkedSwaps[kind];
        if (queue.some((queued) => checkedSwapKey(queued) === checkedSwapKey(swap))) {
            this._setSwapNote(kind, 'Already queued.', true);
            return false;
        }
        if (queue.length >= MAX_QUEUED_SWAPS) {
            this._setSwapNote(kind, `At most ${MAX_QUEUED_SWAPS} swaps at a time. Remove one first.`, true);
            return false;
        }
        queue.push(swap);
        this._setSwapNote(kind, '');
        this._renderSwapChips(kind);
        void this._saveCheckedSwaps();
        return true;
    }

    /**
     * Draw the queued swaps as removable chips.
     * @param {'combat'|'skilling'} kind - Which tab
     * @private
     */
    _renderSwapChips(kind) {
        const box = this.panel?.querySelector(`#mwi-labsim-swap-chips-${kind}`);
        if (!box) return;
        this._applySwapSectionState(kind);
        const gameData = buildGameDataPayload();
        box.innerHTML = this._checkedSwaps[kind]
            .map(
                (swap) =>
                    `<span data-swap-chip="${escapeHtmlAttribute(checkedSwapKey(swap))}" style="display:inline-flex; ` +
                    `align-items:center; gap:4px; padding:1px 6px; border:1px solid ${ACCENT_BTN_BORDER}; ` +
                    `border-radius:10px; background:${ACCENT_BTN_BG}; color:${ACCENT}; font-size:11px;">` +
                    `${escapeHtmlAttribute(describeCheckedSwap(swap, gameData))}` +
                    `<button data-swap-remove="${escapeHtmlAttribute(checkedSwapKey(swap))}" title="Remove" ` +
                    `style="background:transparent; border:none; color:${ACCENT}; cursor:pointer; padding:0 2px; ` +
                    `font-size:12px; line-height:1;">×</button></span>`
            )
            .join('');
    }

    /**
     * An option (a section's open state, a toggle) changed. Once the stored queues are loaded this saves like
     * any edit; before then the save would write the still-empty queues over them, so the change is only
     * noted, laid over the stored options when they arrive, and flushed then. It is not a queue edit either
     * way, so it never makes the restore give up.
     * @param {Array<string>} [path] - Where in the options it changed; omitted when only a save is wanted
     * @param {boolean} [save=true] - False to note the path without saving (the caller saves right after)
     * @private
     */
    _swapOptionChanged(path, save = true) {
        if (this._swapsLoaded) {
            if (save) void this._saveCheckedSwaps();
            return;
        }
        if (path) this._optionEdits.push(path);
    }

    /**
     * Remember the queues for this character.
     * @private
     */
    async _saveCheckedSwaps() {
        this._swapEdits += 1;
        try {
            await writeScoped(
                CHECKED_SWAPS_KEY,
                JSON.parse(JSON.stringify({ ...this._checkedSwaps, options: this._swapOptions })),
                'settings'
            );
        } catch (error) {
            console.error('[LabSimUI] Failed to save checked swaps:', error);
        }
    }

    /**
     * Bring this character's queues back, unless one has already been started by
     * hand while the read was in flight.
     * @param {{replace?: boolean}} [options] - `replace`: take the stored queues even over ones in memory, for a
     *   sync pull that brought them (the queues on screen are then the pre-pull copy)
     * @private
     */
    async _restoreCheckedSwaps({ replace = false } = {}) {
        const ownerId = dataManager.getCurrentCharacterId();
        const editsBefore = this._swapEdits;
        let saved = null;
        try {
            saved = await readScoped(CHECKED_SWAPS_KEY, 'settings', null);
        } catch (error) {
            console.error('[LabSimUI] Failed to restore checked swaps:', error);
            return;
        }
        if (!this.panel || !this._stillSameCharacter(ownerId)) return;
        // A swap queued, removed or re-optioned while the read was out is saved and on screen; keep it
        if (this._swapEdits !== editsBefore) {
            // That edit's save carried the options too
            this._swapsLoaded = true;
            this._optionEdits = [];
            return;
        }
        const restored = sanitizeSwapQueues(saved);
        const previous = this._swapOptions;
        this._swapOptions = sanitizeSwapOptions(saved?.options);
        // Options toggled before the read came back win over the stored ones
        const toggled = this._optionEdits;
        for (const path of toggled) {
            let from = previous;
            let to = this._swapOptions;
            for (const key of path.slice(0, -1)) {
                from = from?.[key];
                if (to[key] === null || typeof to[key] !== 'object') to[key] = {};
                to = to[key];
            }
            const last = path[path.length - 1];
            if (from?.[last] === undefined) delete to[last];
            else to[last] = from[last];
        }
        this._optionEdits = [];
        this._swapsLoaded = true;
        for (const kind of ['combat', 'skilling']) {
            if (replace || !this._checkedSwaps[kind].length) this._checkedSwaps[kind] = restored[kind];
            this._renderSwapChips(kind);
        }
        // The sections' collapsed state came back with the options
        this._applyLabSectionStates();
        if (toggled.length) void this._saveCheckedSwaps();
    }

    /**
     * Check the queued swaps against the Upgrade tab's fights.
     *
     * The same analysis the generated rows go through, over the same fights (the
     * target scope the tab is set to), with the same precision, hours, crates and
     * community buffs; the only difference is that the candidates are the queued
     * swaps instead of generated ones, each reaching every loadout that has a use
     * for its slot.
     * @private
     */
    async _onCheckSwapsCombat() {
        if (this._upgradeRunning || this._skillingRunning || this._runStarting || this.isRunning) return;
        const queue = this._checkedSwaps.combat.slice();
        if (!queue.length) {
            this._setSwapNote('combat', 'Add a swap to check first.', true);
            return;
        }
        this._upgradeRunning = true;
        // A teardown (character switch) bumps the token, after which this run is
        // stale and must not clear a guard that now belongs to somebody else's run
        const runToken = ++this._runStartToken;
        const ownerId = dataManager.getCurrentCharacterId();
        // Whether this invocation is still the one the panel is running: a teardown
        // bumps the token even when the same character's panel is rebuilt
        const isCurrent = () =>
            runToken === this._runStartToken && Boolean(this.panel) && this._stillSameCharacter(ownerId);
        const resultsEl = this.panel.querySelector('#mwi-labsim-swap-results');
        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        const checkBtn = this.panel.querySelector('#mwi-labsim-swap-check-combat');
        const finish = () => {
            if (progressEl) progressEl.style.display = 'none';
            if (runBtn) runBtn.style.display = '';
            if (stopBtn) stopBtn.style.display = 'none';
            if (checkBtn) checkBtn.disabled = false;
            if (runToken === this._runStartToken) this._upgradeRunning = false;
        };

        try {
            const gameData = buildGameDataPayload();
            if (!gameData) {
                this._setStatus('No game data available.');
                return;
            }

            // Stopping rules as the generated run reads them
            const uncapped = this.panel.querySelector('#mwi-labsim-upgrade-uncapped')?.checked;
            const maxHours = Math.max(
                1,
                parseInt(this.panel.querySelector('#mwi-labsim-upgrade-maxhours')?.value) || DEFAULT_LAB_SIM_MAX_HOURS
            );
            const hours = uncapped ? 1e6 : maxHours;
            const precision = {
                targetHalfWidth:
                    Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1)))) / 100,
                minTrials: 100,
                maxTrials: uncapped ? Number.MAX_SAFE_INTEGER : LAB_SIM_MAX_FIGHTS,
            };
            const crates = this.getSelectedCrates();
            const communityBuffs = getCommunityBuffs();
            const labyrinthCombatBuffs = this._labyrinthCombatBuffs();

            if (progressEl) progressEl.style.display = 'block';
            if (runBtn) runBtn.style.display = 'none';
            if (stopBtn) stopBtn.style.display = 'inline-block';
            if (checkBtn) checkBtn.disabled = true;
            this._upgradeAborted = false;

            // The fights the tab's scope names. `equipment` is only asked of the
            // planner so it will name the fights; nothing is generated from it
            const plan = planLabUpgradeRun({
                dimensions: ['equipment'],
                scopeMode: this._getUpgradeScopeMode(),
                chosenMonsters: this._getChosenTargets(),
                allMonsters: this._allUpgradeTargets(),
                configureMonsterHrid: this.panel.querySelector('#mwi-labsim-monster')?.value || '',
            });
            if (plan.kind === 'none') {
                this._setStatus(plan.error);
                return;
            }
            let fights;
            // Every loadout the character has, for owned / still-worn checks; null = just the fights
            let ownershipDtos = null;
            let claimLoadouts = null;
            // Whose spare copies price the swap: the live character's, unless the
            // Configure fight is a party member's (as the single-fight analysis reads it)
            let isSelf = true;
            if (plan.kind === 'single') {
                // The Configure fight is the edited player at the resolved room
                // level, exactly as the single-fight analysis takes it, not the
                // monster's assigned labyrinth loadout
                const monsterHrid = plan.monsterHrids[0];
                const edited = this._editor?.getEditedDTOs();
                let playerDTOs;
                let selfHrid = null;
                if (edited) {
                    playerDTOs = Object.values(edited);
                    selfHrid = this._editor.getSelfHrid() ?? null;
                } else {
                    const loaded = await buildAllPlayerDTOs();
                    if (!isCurrent()) return;
                    playerDTOs = loaded.players;
                    selfHrid = loaded.selfHrid ?? null;
                }
                const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
                const dto = playerDTOs?.[playerIndex];
                if (!dto) {
                    this._setStatus('No player data available.');
                    return;
                }
                const roomLevel = await this._resolveUpgradeRoomLevel({
                    monsterHrid,
                    gameData,
                    playerDTOs,
                    playerIndex,
                    crates,
                    hours,
                    communityBuffs,
                    labyrinthCombatBuffs,
                });
                if (!isCurrent() || this._upgradeAborted) return;
                if (!roomLevel) {
                    this._setStatus(
                        'No room level resolves for this fight. Pick a level source with a value behind it, ' +
                            'or put a level in the Configure tab.'
                    );
                    return;
                }
                isSelf = selfHrid != null && dto.hrid === selfHrid;
                const monster = getLabyrinthMonsters().find((entry) => entry.hrid === monsterHrid);
                fights = [
                    {
                        monsterHrid,
                        monsterName: monster?.name || monsterHrid.split('/').pop().replace(/_/g, ' '),
                        roomLevel,
                        dto,
                        loadoutName: 'Configure fight',
                    },
                ];
                // The live character's own fight still owns what its saved loadouts hold; a party
                // member's DTO says nothing about the character's stock, so it keeps just itself
                if (isSelf) {
                    claimLoadouts = this._collectOwnedLoadouts(fights);
                    ownershipDtos = claimLoadouts.map((entry) => entry.dto);
                }
            } else {
                const useSkipLevels = this.panel.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
                const chosen = new Set(plan.monsterHrids);
                const everyFight = this._collectLabyrinthFights(useSkipLevels);
                fights = everyFight.filter((fight) => chosen.has(fight.monsterHrid));
                // What the character holds is every saved loadout, not only the chosen fights'
                ownershipDtos = this._collectOwnedLoadouts(everyFight).map((entry) => entry.dto);
                claimLoadouts = this._collectOwnedLoadouts(everyFight);
            }
            if (!fights.length) {
                this._setStatus(
                    'No labyrinth fights found. Set combat skip levels in the game (or enter the labyrinth) so fights have room levels.'
                );
                return;
            }

            const candidates = [];
            const unreached = [];
            const alreadyEquipped = [];
            const fightDTOs = fights.map((fight) => fight.dto);
            for (const swap of queue) {
                if (isAbilitySwap(swap)) {
                    // One candidate per way onto the bar; the rows are folded back into one afterwards
                    const built = buildCombatAbilityCheck(swap, fightDTOs, gameData, isSelf, {
                        allLoadouts: this._swapOptions.all.combat,
                    });
                    if (built?.candidates.length) candidates.push(...built.candidates);
                    else if (built?.alreadyEquipped) alreadyEquipped.push(swap);
                    else unreached.push(swap);
                    continue;
                }
                const candidate = buildCombatSwapCandidate(
                    swap,
                    fights.map((fight) => fight.dto),
                    gameData,
                    isSelf,
                    { allLoadouts: this._swapOptions.all.combat, ownershipDtos: ownershipDtos || undefined }
                );
                if (candidate && candidate.reach > 0) candidates.push(candidate);
                else unreached.push(swap);
            }
            const describeAll = (list) => list.map((swap) => describeCheckedSwap(swap, gameData)).join(', ');
            if (!candidates.length) {
                resultsEl.style.display = 'none';
                this._setStatus(
                    [
                        alreadyEquipped.length
                            ? `Already equipped at that level or higher: ${describeAll(alreadyEquipped)}.`
                            : '',
                        unreached.length ? `Not in any loadout: ${describeAll(unreached)}.` : '',
                    ]
                        .filter(Boolean)
                        .join(' ')
                );
                return;
            }

            const eta = createEtaTracker();
            // An ability is several candidates (one per slot option) but one swap
            const swapCount = new Set(candidates.map((candidate) => candidate.checkedAbilityKey || candidate)).size;
            this._setStatus(
                `Checking ${swapCount} swap${swapCount === 1 ? '' : 's'} across ${fights.length} fights. Stop cancels at any point.`
            );

            const rawAnalysis = await runLabyrinthAllFightsAnalysis(
                {
                    fights,
                    crates,
                    hours,
                    precision,
                    communityBuffs,
                    labyrinthCombatBuffs,
                    modes: [],
                    extraCandidates: candidates,
                    claimLoadouts,
                },
                ({ current, total, description }) => {
                    if (!isCurrent() || this._upgradeAborted) return;
                    const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
                    const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                    }
                },
                { abortSignal: () => !isCurrent() || this._upgradeAborted }
            );

            if (!isCurrent() || this._upgradeAborted) return;
            const analysisResult = rawAnalysis?.baseline ? mergeCheckedAbilityRows(rawAnalysis, gameData) : rawAnalysis;
            if (!analysisResult?.baseline || !analysisResult.results?.length) {
                resultsEl.style.display = 'none';
                this._setStatus('Checking the swaps produced no results.');
                return;
            }
            resultsEl.style.display = 'block';
            this._renderAllFightsResults(analysisResult, resultsEl, { checked: true });
            const checkedCount = analysisResult.results.length;
            this._setStatus(
                `Checked ${checkedCount} swap${checkedCount === 1 ? '' : 's'} across ${fights.length} fights` +
                    (alreadyEquipped.length
                        ? `. Already equipped at that level or higher: ${describeAll(alreadyEquipped)}`
                        : '') +
                    (unreached.length ? `. Not in any loadout: ${describeAll(unreached)}` : '') +
                    '.'
            );
        } catch (error) {
            if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                console.error('[LabSimUI] Checking swaps failed:', error);
                this._setStatus('Checking swaps failed: ' + error.message);
            }
        } finally {
            finish();
        }
    }

    /**
     * Check the queued swaps on the Skilling tab: each one written into every
     * skill kit that can feel it, measured the way the generated rows are.
     * @private
     */
    async _onCheckSwapsSkilling() {
        if (this._skillingRunning || this._upgradeRunning || this._runStarting || this.isRunning) return;
        const queue = this._checkedSwaps.skilling.slice();
        if (!queue.length) {
            this._setSwapNote('skilling', 'Add a swap to check first.', true);
            return;
        }
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }
        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }
        const dto = editedDTOs[this._skillingEditor.getSelfHrid()] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const skillEquipmentMap = this._scopeSkillEquipmentMap(
            this._buildSkillEquipmentMap(gameData),
            dto,
            targetSkill,
            gameData
        );
        const context = this._buildSkillingContext({
            dto,
            roomLevel,
            crateHrids: this._getSkillingCrates(),
            skillEquipmentMap,
            targetSkill,
            gameData,
            analysisResult: null,
        });
        const resultsEl = this.panel.querySelector('#mwi-labsim-skilling-swap-results');

        let measured = null;
        let wasAborted = () => false;
        await this._runSkillingTask(async (onProgress, isAborted) => {
            wasAborted = isAborted;
            const abortSignal = isAborted;
            measured = await evaluateSkillingSwaps({
                swaps: queue,
                baseSetup: context.baseSetup,
                evaluate: context.evaluate,
                applySetup: (setup, candidate) => applySkillingCandidate(setup, candidate, targetSkill),
                roomLevel,
                skills: context.skills,
                gameData,
                abortSignal,
                onProgress,
                allLoadouts: this._swapOptions.all.skilling,
            });
            if (abortSignal()) return;
            await annotateRoomsReached({
                rows: measured.rows,
                baseSetup: context.baseSetup,
                evaluate: context.evaluate,
                roomLevel,
                targetSkill,
                abortSignal,
            });
        });
        if (!measured || wasAborted() || !resultsEl || !this.panel?.contains(resultsEl)) return;

        const unreached = measured.unreached.map((swap) => describeCheckedSwap(swap, gameData));
        if (!measured.rows.length) {
            resultsEl.style.display = 'none';
            this._setStatus(`Not in any kit: ${unreached.join(', ')}.`);
            return;
        }
        resultsEl.style.display = 'block';
        this._renderSkillingUpgradeResults({ baseline: measured.baseline, results: measured.rows }, resultsEl, {
            checked: true,
        });
        this._setStatus(
            `Checked ${measured.rows.length} swap${measured.rows.length === 1 ? '' : 's'}` +
                (unreached.length ? `. Not in any kit: ${unreached.join(', ')}` : '') +
                '.'
        );
    }

    /** @private */
    async _onUpgradeAnalyze() {
        // Checked synchronously, before any await below (buildAllPlayerDTOs in
        // particular): the Run button isn't hidden until well into this
        // function, so a second click landing in that window would otherwise
        // start a concurrent run sharing this._upgradeAborted and clobbering
        // the first run's results.
        if (this._upgradeRunning || this._skillingRunning || this._runStarting || this.isRunning) return;
        this._upgradeRunning = true;
        // A remembered result a sync pull brings is no longer drawn over this panel's own runs
        this._upgradeRunStarted = true;
        const startToken = ++this._runStartToken;

        // Captured before the first await — see `_stillSameCharacter`
        const ownerId = dataManager.getCurrentCharacterId();

        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const monsterHrid = this.panel.querySelector('#mwi-labsim-monster')?.value;
        // "Uncapped" ignores the Max fights / Max hrs numbers (they stay in the
        // fields) and lets each comparison's baseline run to the precision
        // target; the finite sentinels keep progress/ETA math well-defined.
        const upgradeUncapped = this.panel.querySelector('#mwi-labsim-upgrade-uncapped')?.checked;
        const upgradeMaxHours = Math.max(
            1,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-maxhours')?.value) || DEFAULT_LAB_SIM_MAX_HOURS
        );
        const upgradeMaxFights = LAB_SIM_MAX_FIGHTS;
        const hours = upgradeUncapped ? 1e6 : upgradeMaxHours;
        // Bounds the baseline sim each comparison is paired against: it stops at
        // the precision target, the fight cap, or the time ceiling — whichever
        // first. Candidates then inherit the baseline's fight count (paired).
        const precision = {
            targetHalfWidth:
                Math.min(10, Math.max(0.1, Number(config.getSettingValue('labyrinthSimPrecision', 1)))) / 100,
            minTrials: 100,
            maxTrials: upgradeUncapped ? Number.MAX_SAFE_INTEGER : upgradeMaxFights,
        };

        // The checked candidate sets and the chosen fights, resolved into the
        // one analysis they describe
        const useSkipLevels = this.panel.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
        const allFights = this._collectLabyrinthFights(useSkipLevels);
        this._upgradeTargetHrids = allFights.map((fight) => fight.monsterHrid);
        const plan = this._planFromControls();
        if (plan.kind === 'none') {
            this._setStatus(plan.error);
            this._upgradeRunning = false;
            return;
        }
        const isAllFights = plan.kind === 'allFights';

        const crates = this.getSelectedCrates();

        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            this._upgradeRunning = false;
            return;
        }

        let playerDTOs;
        let selfHrid = null;
        try {
            const editedDTOs = this._editor?.getEditedDTOs();
            if (editedDTOs) {
                playerDTOs = Object.values(editedDTOs);
                selfHrid = this._editor.getSelfHrid() ?? null;
            } else {
                const result = await buildAllPlayerDTOs();
                playerDTOs = result.players;
                selfHrid = result.selfHrid ?? null;
            }
        } catch (error) {
            if (startToken !== this._runStartToken) return;
            this._upgradeRunning = false;
            if (!this._stillSameCharacter(ownerId)) return;
            console.error('[LabSimUI] Failed to load players for upgrade analysis:', error);
            this._setStatus('Upgrade analysis failed: ' + error.message);
            return;
        }

        if (startToken !== this._runStartToken) return;
        if (!this._stillSameCharacter(ownerId)) {
            this._upgradeRunning = false;
            return;
        }

        if (!playerDTOs?.length || !playerDTOs[playerIndex]) {
            this._setStatus('No player data available.');
            this._upgradeRunning = false;
            return;
        }

        const communityBuffs = getCommunityBuffs();
        // Both halves of the same answer: the buff array the sims run under, and
        // the levels those buffs came from — a Token Upgrades row steps up from
        // the level being simulated, not from the level the live run owns
        const tokenLevels = this._resolvedTokenLevels();
        const labyrinthCombatBuffs = this._labyrinthCombatBuffs();

        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-upgrade-results');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        this._upgradeOrderSection = null;
        this._clearVerify(['all', 'order']);
        this._drawUpgradeAbilityOrder();
        runBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._upgradeAborted = false;
        // One tracker per run: it starts its clock where it is made
        const eta = createEtaTracker();

        const selectedDimensions = new Set(isAllFights ? plan.modes : [plan.upgradeMode, ...plan.extraModes]);
        // `combined` is the single-fight analysis's name for equipment plus
        // ability levels, so the two it stands for are what the options below
        // should be read for
        if (selectedDimensions.delete('combined')) {
            selectedDimensions.add('equipment');
            selectedDimensions.add('ability_level');
        }
        const abilityLevelType = this.panel.querySelector('#mwi-labsim-upgrade-level-type')?.value || 'increment';
        let abilityTargetLevel = Math.min(
            200,
            parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value, 10) || 0
        );
        const isCombatLevelMode = selectedDimensions.has('combat_level');
        // Combat levels are ranked as "+N on each skill", and N is this box —
        // an empty box would generate no candidates at all
        if (isCombatLevelMode && !abilityTargetLevel) abilityTargetLevel = 5;
        const combatLevelTargets = isCombatLevelMode ? this._getLabCombatLevelTargets() : null;
        const abilityTargets = selectedDimensions.has('ability_level')
            ? this._getAbilityTargets('#mwi-labsim-ability-targets')
            : null;
        // Blank boxes mean "one level up", which is what every generator does
        // with a zero, so an unopened option costs nothing to read
        const houseTargetLevel = selectedDimensions.has('house') ? this._getHouseTargetLevel() : 0;
        const houseTargets = selectedDimensions.has('house') ? this._getHouseTargets() : null;
        const guildShrineTargetLevel = selectedDimensions.has('guild_shrine') ? this._getShrineTargetLevel() : 0;
        const guildShrineTargets = selectedDimensions.has('guild_shrine') ? this._getShrineTargets() : null;
        // Default on: a shrine level the guild's shrine building cannot sell is
        // not an upgrade the character can buy, however well it would rank
        const guildShrineCapToGuild = selectedDimensions.has('guild_shrine')
            ? Boolean(this.panel.querySelector('#mwi-labsim-shrine-cap-guild')?.checked)
            : false;

        if (plan.dropped.length) {
            this._setStatus(
                `Skipped ${plan.dropped.join(', ')} — not available for this target scope. See the checkbox tooltip.`
            );
        }

        // Only worth a word when House Rooms is checked and the scan found
        // nothing to weigh; the rows speak for themselves when it did
        this._houseScanNote = selectedDimensions.has('house')
            ? this._describeHouseScan(playerDTOs[playerIndex], gameData)
            : '';

        // Which level the Configure fight is analysed at. Resolved from the
        // level source rather than read off the Level box, which opens on 100
        // and so quietly decided most of this panel's analyses. The whole-run
        // scopes never come through here — each of their fights carries its own
        // room level from the automation table.
        let roomLevel = 0;
        if (!isAllFights) {
            roomLevel = await this._resolveUpgradeRoomLevel({
                monsterHrid,
                gameData,
                playerDTOs,
                playerIndex,
                crates,
                hours,
                communityBuffs,
                labyrinthCombatBuffs,
            });
            if (!roomLevel || this._upgradeAborted) {
                if (!this._upgradeAborted) {
                    this._setStatus(
                        'No room level resolves for this fight. Pick a level source with a value behind it, ' +
                            'or put a level in the Configure tab.'
                    );
                }
                progressEl.style.display = 'none';
                runBtn.style.display = '';
                stopBtn.style.display = 'none';
                this._upgradeRunning = false;
                return;
            }
        }

        if (isAllFights) {
            try {
                const chosen = new Set(plan.monsterHrids);
                const fights = allFights.filter((fight) => chosen.has(fight.monsterHrid));
                if (!fights.length) {
                    this._setStatus(
                        'No labyrinth fights found — set combat skip levels in the game (or enter the labyrinth) so fights have room levels.'
                    );
                    return;
                }
                // Nothing is refused for being large any more, so the size is
                // said instead — first from the rough per-dimension estimate,
                // which needs nothing but the checkboxes, then replaced by the
                // analysis's own count the moment it has pooled its candidates.
                // Both land before the first simulation, while Stop still means
                // "I did not mean to ask for that".
                const estimate = estimateLabUpgradeSims(
                    [...plan.modes, ...(plan.includeAbilityOrder ? ['ability_order'] : [])],
                    fights.length
                );
                this._setStatus(`Starting: ${estimate.text}. Stop cancels at any point.`);
                // The table result a combined run saves again with the order section
                let allFightsAnalysis = null;
                if (!plan.orderOnly) {
                    const analysisResult = await runLabyrinthAllFightsAnalysis(
                        {
                            fights,
                            crates,
                            hours,
                            precision,
                            communityBuffs,
                            labyrinthCombatBuffs,
                            abilityTargetLevel,
                            combatLevelTargets,
                            abilityTargets,
                            modes: plan.modes,
                            auraSwapsOnly: this._getAuraSwapsOnly(),
                            houseTargetLevel,
                            houseTargets,
                            guildShrineTargetLevel,
                            guildShrineTargets,
                            guildShrineCapToGuild,
                            tokenLevels,
                            claimLoadouts: this._collectOwnedLoadouts(allFights),
                        },
                        ({ current, total, description, plan: runPlan }) => {
                            if (this._upgradeAborted) return;
                            if (runPlan) this._setStatus(describeAllFightsPlan(runPlan));
                            const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                            const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                            const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                            if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                            if (text) {
                                text.textContent =
                                    `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                            }
                        },
                        { abortSignal: () => this._upgradeAborted }
                    );

                    this._registerVerifyLive('all', analysisResult, ownerId);
                    this._renderAllFightsResults(analysisResult, resultsEl);
                    // Marked, so a reload draws it with the all-fights renderer rather than the single-fight one
                    if (analysisResult?.results?.length) allFightsAnalysis = { ...analysisResult, allFights: true };
                }
                if (plan.includeAbilityOrder && startToken === this._runStartToken && !this._upgradeAborted) {
                    await this._runUpgradeAbilityOrder({
                        fights,
                        isSelf: true,
                        claimLoadouts: this._collectOwnedLoadouts(allFights),
                        gameData,
                        crates,
                        hours,
                        precision,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        startToken,
                        ownerId,
                        orderOnly: plan.orderOnly,
                        savedAnalysis: allFightsAnalysis,
                    });
                }
                await this._autoVerifyCloseCalls({ startToken, ownerId });
            } catch (error) {
                if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                    console.error('[LabSimUI] All-fights analysis failed:', error);
                    this._setStatus('All-fights analysis failed: ' + error.message);
                }
            } finally {
                progressEl.style.display = 'none';
                runBtn.style.display = '';
                stopBtn.style.display = 'none';
                this._upgradeRunning = false;
            }
            return;
        }

        try {
            // The table result a combined run saves again with the order section
            let singleAnalysis = null;
            if (!plan.orderOnly) {
                const analysisResult = await runLabyrinthUpgradeAnalysis(
                    {
                        playerDTOs,
                        playerIndex,
                        selfHrid,
                        monsterHrid,
                        roomLevel,
                        crates,
                        hours,
                        precision,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        upgradeMode: plan.upgradeMode,
                        abilityLevelType,
                        abilityTargetLevel,
                        combatLevelTargets,
                        abilityTargets,
                        auraSwapsOnly: this._getAuraSwapsOnly(),
                        // The single-fight analysis takes one mode, and ranks
                        // anything else it is handed beside whatever that mode
                        // generated — which is how a multi-set selection lands in
                        // one table, against one baseline, at one shared seed
                        houseTargetLevel,
                        houseTargets,
                        guildShrineTargetLevel,
                        guildShrineTargets,
                        guildShrineCapToGuild,
                        tokenLevels,
                        // The second ranking pass, and the two numbers it needs:
                        // the window the level search runs over (the character's
                        // own level) and this tab's fight cap, so a search probe is
                        // bounded by the same Max fights every other sim here is.
                        rankByRoomLevels: this._getRankByRoomLevels(),
                        referenceLevel: (
                            labyrinthClearRate() || bundledLabyrinthClearRate
                        ).getPlayerEffectiveCombatLevel(),
                        maxTrials: upgradeUncapped ? undefined : upgradeMaxFights,
                        extraCandidates: this._extraDimensionCandidates(
                            plan.extraModes,
                            playerDTOs[playerIndex],
                            gameData,
                            {
                                abilityTargetLevel,
                                abilityLevelType,
                                combatLevelTargets,
                                abilityTargets,
                                auraSwapsOnly: this._getAuraSwapsOnly(),
                                houseTargetLevel,
                                houseTargets,
                                guildShrineTargetLevel,
                                guildShrineTargets,
                                guildShrineCapToGuild,
                                communityBuffs,
                                communityBuffTargetLevel: this._getCommunityTargetLevel(),
                            }
                        ),
                    },
                    ({ current, total, description }) => {
                        if (this._upgradeAborted) return;
                        const fill = this.panel.querySelector('#mwi-labsim-upgrade-progress-fill');
                        const text = this.panel.querySelector('#mwi-labsim-upgrade-progress-text');
                        const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                        if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                        if (text) {
                            text.textContent =
                                `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                        }
                    },
                    { abortSignal: () => this._upgradeAborted }
                );

                // A fresh run supersedes any restored set — drop the "from a previous
                // run" note before drawing, and remember the new results (opt-in).
                this._restoredUpgradeAt = null;
                this._restoredUpgradeMeta = null;
                // Travels with the results rather than being read at draw time: a
                // restored set was measured against whatever floor was set then
                if (analysisResult?.roomLevels) analysisResult.roomLevels.targetFloor = this._getTargetFloor();
                this._renderUpgradeResults(analysisResult, resultsEl);
                singleAnalysis = analysisResult;
                // The remembered set is per character and has no undo: writing this
                // run under the character who arrived mid-analysis would delete the
                // analysis they were keeping
                if (analysisResult?.results?.length && this._stillSameCharacter(ownerId)) {
                    const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
                    saveUpgradeResults(LAB_UPGRADE_RESULTS_KEY, analysisResult, {
                        characterName: (this._editor?.getPlayerInfo?.() || [])[playerIndex]?.name || null,
                    });
                }
            }
            if (plan.includeAbilityOrder && startToken === this._runStartToken && !this._upgradeAborted) {
                // The Configure fight: the edited player at the resolved room level, as the single-fight
                // analysis takes it
                const dto = playerDTOs[playerIndex];
                const isSelf = selfHrid != null && dto.hrid === selfHrid;
                const monster = getLabyrinthMonsters().find((entry) => entry.hrid === monsterHrid);
                const orderFights = [
                    {
                        monsterHrid,
                        monsterName: monster?.name || monsterHrid.split('/').pop().replace(/_/g, ' '),
                        roomLevel,
                        dto,
                        loadoutName: 'Configure fight',
                    },
                ];
                await this._runUpgradeAbilityOrder({
                    fights: orderFights,
                    isSelf,
                    claimLoadouts: isSelf ? this._collectOwnedLoadouts(orderFights) : undefined,
                    gameData,
                    crates,
                    hours,
                    precision,
                    communityBuffs,
                    labyrinthCombatBuffs,
                    startToken,
                    ownerId,
                    orderOnly: plan.orderOnly,
                    savedAnalysis: singleAnalysis,
                });
            }
            await this._autoVerifyCloseCalls({ startToken, ownerId });
        } catch (error) {
            if (error.message !== 'Cancelled' && error.message !== 'Aborted') {
                console.error('[LabSimUI] Upgrade analysis failed:', error);
                this._setStatus('Upgrade analysis failed: ' + error.message);
            }
        } finally {
            progressEl.style.display = 'none';
            runBtn.style.display = '';
            stopBtn.style.display = 'none';
            this._upgradeRunning = false;
        }
    }

    /**
     * The candidates for every checked set the single-fight analysis is not
     * generating itself.
     *
     * `runLabyrinthUpgradeAnalysis` takes one mode and generates from it, then
     * ranks any `extraCandidates` beside the result. Generating the rest here
     * with the same exported generator keeps a multi-set selection to a single
     * analysis — one baseline sim, one shared random seed, one ranked table —
     * rather than one run per checked box with a separate baseline each.
     *
     * @param {string[]} modes - Sets the analysis's own mode does not cover
     * @param {Object} playerDTO - The loadout being analyzed
     * @param {Object} gameData - From `buildGameDataPayload`
     * @param {Object} options - `{ abilityTargetLevel, abilityLevelType, combatLevelTargets, abilityTargets,
     *   auraSwapsOnly, houseTargetLevel, houseTargets, guildShrineTargetLevel, guildShrineTargets,
     *   guildShrineCapToGuild }`
     * @returns {Array<Object>} Candidates, deduplicated by the analysis itself
     * @private
     */
    _extraDimensionCandidates(modes, playerDTO, gameData, options = {}) {
        if (!modes?.length || !playerDTO || !gameData) return [];
        const {
            abilityTargetLevel,
            abilityLevelType,
            combatLevelTargets,
            abilityTargets,
            auraSwapsOnly = false,
            houseTargetLevel = 0,
            houseTargets = null,
            guildShrineTargetLevel = 0,
            guildShrineTargets = null,
            guildShrineCapToGuild = false,
            communityBuffs = null,
            communityBuffTargetLevel = 0,
        } = options;
        try {
            return modes.flatMap((mode) =>
                generateCandidates(
                    playerDTO,
                    gameData,
                    mode,
                    abilityTargetLevel,
                    abilityLevelType,
                    false,
                    combatLevelTargets,
                    abilityTargets,
                    houseTargetLevel,
                    houseTargets,
                    communityBuffs,
                    guildShrineTargetLevel,
                    {
                        auraSwapsOnly,
                        houseWinRateOnly: true,
                        communityBuffTargetLevel,
                        guildShrineTargets,
                        guildShrineCapToGuild,
                    }
                )
            );
        } catch (error) {
            console.error('[LabSimUI] Failed to generate candidates for', modes, error);
            return [];
        }
    }

    /**
     * The room level the Configure-fight analysis should run at.
     *
     * Everything but Sim max is already known and costs nothing to look up. Sim
     * max is a binary search over simulations, so it is run here — once per
     * monster per panel session, on the way into the analysis, with its progress
     * on the analysis's own bar. Doing it here rather than making the player run
     * Find Max first is the point of offering it as a default at all.
     *
     * A search that clears nothing leaves the source with no level, and the
     * resolver falls through to the skip level and then to the Configure box
     * rather than analysing a room that does not exist.
     *
     * @param {Object} params - `{ monsterHrid, gameData, playerDTOs, playerIndex,
     *   crates, hours, communityBuffs, labyrinthCombatBuffs }`
     * @returns {Promise<number>} Room level, 0 when nothing resolves
     * @private
     */
    async _resolveUpgradeRoomLevel({
        monsterHrid,
        gameData,
        playerDTOs,
        playerIndex,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs,
    }) {
        if (this._getLevelSource() === 'sim_max' && monsterHrid && !this._maxLevelByMonster[monsterHrid]) {
            try {
                const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
                const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
                if (text) text.textContent = 'Finding the highest level this loadout clears…';

                const maxResult = await findMaxLabyrinthLevel(
                    {
                        gameData,
                        playerDTOs: [playerDTOs[playerIndex]],
                        zoneHrid: getCombatZones()[0]?.hrid || '/actions/combat/fly',
                        monsterHrid,
                        crates,
                        simHours: hours,
                        communityBuffs,
                        labyrinthCombatBuffs,
                        threshold: defaultThreshold(),
                        referenceLevel: (
                            labyrinthClearRate() || bundledLabyrinthClearRate
                        ).getPlayerEffectiveCombatLevel(),
                    },
                    (progress) => {
                        // Stop cannot cut the search short — it has no abort of
                        // its own — but the flag is honoured the moment it ends
                        if (this._upgradeAborted) return;
                        if (fill) fill.style.width = `${Math.round((progress.step / progress.totalSteps) * 100)}%`;
                        if (text) {
                            text.textContent =
                                `Find Max: level ${progress.level} — ${(progress.winRate * 100).toFixed(0)}% ` +
                                `(step ${progress.step}/${progress.totalSteps})`;
                        }
                    }
                );

                if (maxResult?.cleared) this._maxLevelByMonster[monsterHrid] = maxResult.maxLevel;
                this._refreshLevelSourceReadout();
            } catch (error) {
                if (error?.message !== 'Cancelled') {
                    console.error('[LabSimUI] Find Max for the upgrade level failed:', error);
                }
            }
        }

        return this._resolveTargetLevel(monsterHrid).level;
    }

    /**
     * What to say about house rooms when the set came back empty.
     *
     * House candidates ride along inside the shared analyses now — the applier
     * they build each candidate's character with has a branch for a room level,
     * so a room goes in the same table, against the same baseline, on the same
     * seed as every other row. What no table can say for itself is *why* it has
     * no house rows in it: every combat room already at the cap is a different
     * answer from a game with no combat-relevant rooms in it, and neither of
     * them reads as "nothing worth buying".
     *
     * Costs nothing to ask — it is a scan of the room map, not a simulation.
     *
     * @param {Object} playerDTO - The character being analyzed
     * @param {Object} gameData - From `buildGameDataPayload`
     * @returns {string} A phrase for the status line, empty when rooms were found
     * @private
     */
    _describeHouseScan(playerDTO, gameData) {
        try {
            if (!playerDTO || !gameData) return '';
            if (generateHouseCandidates(playerDTO, gameData, 0, null, HOUSE_WIN_RATE_ONLY).length) return '';
            const scan = describeHouseScan(playerDTO, gameData, HOUSE_WIN_RATE_ONLY);
            return scan.combatRelevant
                ? `all ${scan.combatRelevant} combat house rooms are already maxed`
                : 'no house rooms whose buffs can move a win rate';
        } catch (error) {
            console.error('[LabSimUI] House room scan failed:', error);
            return '';
        }
    }

    /**
     * Build the per-room target inputs, prefilled from the uniform Lv box.
     *
     * Only the rooms this tab can rank: the labyrinth reads one number off a
     * simulation and a room that cannot move it has no target worth setting.
     * Levels come from the edited loadout where there is one, so a room raised
     * in the Player Setup editor is offered from where the editor put it.
     * @private
     */
    _buildLabHouseTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-house-targets');
        if (!grid) return;

        const gameData = buildGameDataPayload();
        const roomMap = gameData?.houseRoomDetailMap || {};
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(MAX_HOUSE_LEVEL, Math.max(0, parseInt(this._getHouseTargetLevelInput()) || 0));

        const rooms = Object.entries(roomMap)
            .filter(([, detail]) => houseRoomMovesWinRate(detail))
            .map(([hrid, detail]) => ({
                hrid,
                name: detail.name || hrid.split('/').pop().replace(/_/g, ' '),
                level: Math.max(0, Math.floor(Number(dto?.houseRooms?.[hrid]) || 0)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!rooms.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No house room in this game data carries a buff that could ' +
                'move a labyrinth win rate.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>House</b> target levels (blank or ≤ ' +
            'current level skips the room; used instead of the Lv box while open):</span>' +
            rooms
                .map(
                    (room) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${room.name} (${room.level})</label>
                    <input type="number" min="1" max="${MAX_HOUSE_LEVEL}" data-lab-house-target="${room.hrid}"
                        value="${room.level >= MAX_HOUSE_LEVEL ? '' : Math.min(MAX_HOUSE_LEVEL, Math.max(uniform, room.level + 1))}"
                        ${room.level >= MAX_HOUSE_LEVEL ? 'disabled title="Already at max level"' : ''} style="
                        width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Build the per-shrine target inputs, prefilled from the uniform Lv box.
     *
     * The House grid's arrangement, for the same reason it exists there: one Lv
     * box across the board asks every shrine for the same absolute level, and
     * shrines are not at the same level as each other — a single 6 was a no-op
     * for everything already past 6 and a five-level purchase for everything
     * below it, in one undifferentiated row set.
     *
     * Combat shrines only, matching what `generateGuildShrineCandidates` is
     * asked for here: this tab ranks win rate, and a skilling shrine has no
     * column it could move.
     * @private
     */
    _buildLabShrineTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-shrine-targets');
        if (!grid) return;

        const detailMap = getGuildBuffDetailMap();
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const uniform = Math.min(MAX_GUILD_SHRINE_LEVEL, Math.max(0, this._getShrineTargetLevel()));

        const shrines = Object.entries(detailMap)
            .filter(([, detail]) => Boolean(detail?.isCombat))
            .map(([buffHrid, detail]) => ({
                buffHrid,
                name: shrineDisplayName(detail.shrineHrid || buffHrid),
                level: Math.max(0, Math.floor(Number(dto?.guildShrineLevels?.[buffHrid]) || 0)),
                maxLevel: Math.min(MAX_GUILD_SHRINE_LEVEL, guildBuffMaxLevel(detail) || MAX_GUILD_SHRINE_LEVEL),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        if (!shrines.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No combat guild shrine reached the client — join a ' +
                'guild, or open the shrine screen once, so the levels are known.</span>';
            return;
        }

        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;"><b>Guild Shrine</b> target levels (blank ' +
            'or ≤ current level evaluates one level up; <b>0 skips the shrine</b>; used instead of the Lv ' +
            'box while open):</span>' +
            shrines
                .map(
                    (shrine) => `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;">${shrine.name} (${shrine.level})</label>
                    <input type="number" min="0" max="${shrine.maxLevel}" data-lab-shrine-target="${shrine.buffHrid}"
                        value="${
                            shrine.level >= shrine.maxLevel
                                ? ''
                                : Math.min(shrine.maxLevel, Math.max(uniform, shrine.level + 1))
                        }"
                        ${shrine.level >= shrine.maxLevel ? 'disabled title="Already at max level"' : ''} style="
                        width:48px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`
                )
                .join('');
    }

    /**
     * Per-shrine target levels, or null when the grid is closed.
     *
     * Three readings, the same contract the combat sim's grid sends and
     * `generateGuildShrineCandidates` reads off `perBuffTargets`: a level buys
     * up to it, an explicit **0 drops that shrine** from the run, and a blank
     * box sends -1 for "one level up". This grid used to emit positives only
     * and leave a blank box out of the map, which the advisor reads as a skip —
     * so two grids in the same panel family disagreed about what an empty box
     * meant, and clearing one here quietly dropped the shrine instead of
     * stepping it once.
     *
     * A box disabled because the buff is already maxed is left out of the map
     * entirely, which the advisor also reads as a skip.
     *
     * @returns {Object|null} buffHrid → target level
     * @private
     */
    _getShrineTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-shrine-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-shrine-target]').forEach((input) => {
            if (input.disabled) return;
            const value = parseInt(input.value, 10);
            if (!Number.isFinite(value)) {
                targets[input.dataset.labShrineTarget] = -1;
            } else if (value <= 0) {
                targets[input.dataset.labShrineTarget] = 0;
            } else {
                targets[input.dataset.labShrineTarget] = Math.min(MAX_GUILD_SHRINE_LEVEL, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Whether Analyze Upgrades follows its clear-rate pass with the room-level search.
     * @returns {boolean}
     * @private
     */
    _getSkillingRoomLevelsOn() {
        return Boolean(this.panel?.querySelector('#mwi-labsim-skilling-room-levels')?.checked);
    }

    /**
     * The average clear rate the room-level search and the planner aim at, 0-1.
     * An empty or nonsense box falls back to the shared Target Win % setting.
     * @returns {number}
     * @private
     */
    _getSkillingTargetClear() {
        const typed = parseInt(this.panel?.querySelector('#mwi-labsim-skilling-target-clear')?.value, 10);
        const fallback = Math.floor(Number(config.getSettingValue('labyrinthRecommendTargetRate', 70)) || 70);
        return Math.min(100, Math.max(1, Number.isFinite(typed) ? typed : fallback)) / 100;
    }

    /**
     * The floor the Skilling tab is aiming at, 0 when none is set.
     * @returns {number}
     * @private
     */
    _getSkillingTargetFloor() {
        return Math.max(0, parseInt(this.panel?.querySelector('#mwi-labsim-skilling-target-floor')?.value, 10) || 0);
    }

    /**
     * A goal input changed: remember it, and bring a table already on screen in
     * line with it. The Floor marks are re-drawn against the new floor. The level
     * figures were measured against the old Target clear %, so a different one
     * flags them stale rather than leaving a summary that quotes a bar no longer
     * in the box.
     * @private
     */
    _onSkillingGoalInputsChanged() {
        void this._saveSkillingGoalInputs();
        const context = this._skillingAnalysis;
        const roomLevels = context?.analysisResult?.roomLevels;
        const resultsEl = this.panel?.querySelector('#mwi-labsim-skilling-results');
        if (!roomLevels || !resultsEl || this._skillingRunning) return;
        roomLevels.targetFloor = this._getSkillingTargetFloor();
        roomLevels.stale = Math.abs((roomLevels.threshold || 0) - this._getSkillingTargetClear()) > 1e-9;
        this._renderSkillingUpgradeResults(context.analysisResult, resultsEl);
    }

    /** @private */
    async _saveSkillingGoalInputs() {
        try {
            // Issued together for the same reason the Upgrade tab's are: a
            // character switch landing between awaited writes would split one
            // selection across two characters. Only the changed one is written, so a
            // pulled value of the others is not put back (see `_writeScopedIfChanged`)
            const values = this._skillingGoalValues();
            await Promise.all([
                this._writeScopedIfChanged(SKILLING_ROOM_LEVELS_KEY, values[SKILLING_ROOM_LEVELS_KEY]),
                this._writeScopedIfChanged(SKILLING_TARGET_CLEAR_KEY, values[SKILLING_TARGET_CLEAR_KEY]),
                this._writeScopedIfChanged(SKILLING_TARGET_FLOOR_KEY, values[SKILLING_TARGET_FLOOR_KEY]),
            ]);
        } catch (error) {
            console.error('[LabSimUI] Failed to save skilling goal inputs:', error);
        }
    }

    /**
     * What the Skilling tab's goal inputs hold, by the unscoped key each is saved under.
     * @returns {Record<string, *>}
     * @private
     */
    _skillingGoalValues() {
        return {
            [SKILLING_ROOM_LEVELS_KEY]: this._getSkillingRoomLevelsOn(),
            [SKILLING_TARGET_CLEAR_KEY]: Math.round(this._getSkillingTargetClear() * 100),
            [SKILLING_TARGET_FLOOR_KEY]: this._getSkillingTargetFloor(),
        };
    }

    /**
     * Put the remembered Room levels / Target clear / Floor back, once per
     * character. A plain latch would keep the first character's goals for the
     * life of the page.
     * @private
     */
    async _restoreSkillingGoalInputs() {
        const key = characterKey(SKILLING_ROOM_LEVELS_KEY);
        if (this._skillingGoalKey === key) return;
        this._skillingGoalKey = key;
        const keys = Object.fromEntries(
            [SKILLING_ROOM_LEVELS_KEY, SKILLING_TARGET_CLEAR_KEY, SKILLING_TARGET_FLOOR_KEY].map((base) => [
                base,
                characterKey(base),
            ])
        );
        let saved;
        try {
            saved = await Promise.all([
                readScoped(SKILLING_ROOM_LEVELS_KEY, 'settings', false),
                readScoped(SKILLING_TARGET_CLEAR_KEY, 'settings', null),
                readScoped(SKILLING_TARGET_FLOOR_KEY, 'settings', 0),
            ]);
        } catch (error) {
            console.error('[LabSimUI] Failed to restore skilling goal inputs:', error);
            return;
        }
        // A switch during the read means the arriving character's own restore is
        // the one that counts
        if (!this.panel || this._skillingGoalKey !== key) return;
        const [roomLevelsOn, targetClear, targetFloor] = saved;
        const roomLevelsBox = this.panel.querySelector('#mwi-labsim-skilling-room-levels');
        if (roomLevelsBox) roomLevelsBox.checked = Boolean(roomLevelsOn);
        const clearBox = this.panel.querySelector('#mwi-labsim-skilling-target-clear');
        const clear = Math.floor(Number(targetClear));
        if (clearBox && clear >= 1 && clear <= 100) clearBox.value = String(clear);
        const floorBox = this.panel.querySelector('#mwi-labsim-skilling-target-floor');
        const floor = Math.max(0, Math.floor(Number(targetFloor) || 0));
        if (floorBox) floorBox.value = floor ? String(floor) : '';
        // What this restore read and applied is noted as stored (see `_rememberRestored`). A missing or
        // out-of-range clear % leaves the box on what it shows, which is then what the key reads as
        const clearApplied = clear >= 1 && clear <= 100;
        this._rememberRestored(
            {
                [SKILLING_ROOM_LEVELS_KEY]: Boolean(roomLevelsOn),
                [SKILLING_TARGET_CLEAR_KEY]: clearApplied
                    ? clear
                    : this._skillingGoalValues()[SKILLING_TARGET_CLEAR_KEY],
                [SKILLING_TARGET_FLOOR_KEY]: floor,
            },
            keys
        );
    }

    /**
     * Everything a re-sim of the last analysis needs, gathered once so the
     * room-level search, the planner and Sim together all measure the same
     * thing the table did.
     * @private
     */
    _buildSkillingContext({ dto, roomLevel, crateHrids, skillEquipmentMap, targetSkill, gameData, analysisResult }) {
        return {
            analysisResult,
            roomLevel,
            targetSkill,
            gameData,
            baseSetup: { dto, skillEquipmentMap },
            evaluate: createSkillingEvaluator({
                computeRates: computeSkillingClearRatesFromEditor,
                gameData,
                crateHrids,
                targetSkill,
            }),
            skills: includedSkills({ roomLevel, targetSkill, allSkills: SKILLING_SKILL_HRIDS }),
        };
    }

    /**
     * Measure the shortlist's room levels and attach the summary to the analysis.
     * @param {Object} context - From `_buildSkillingContext`
     * @param {Function} onProgress - `({ current, total, description })`
     * @private
     */
    async _measureSkillingRoomLevels(context, onProgress, isAborted = () => this._skillingAborted) {
        const threshold = this._getSkillingTargetClear();
        const abortSignal = isAborted;
        const measure = createRowLevelMeasure({
            baseSetup: context.baseSetup,
            evaluate: context.evaluate,
            skills: context.skills,
            allSkills: SKILLING_SKILL_HRIDS,
            threshold,
            targetSkill: context.targetSkill,
            abortSignal,
        });
        const summary = await measureRoomLevelGains(context.analysisResult.results, {
            measure,
            select: shortlistSkillingForRoomLevels,
            shortlistSize: ROOM_LEVEL_SHORTLIST_SIZE,
            abortSignal,
            onProgress,
        });
        summary.threshold = threshold;
        summary.targetFloor = this._getSkillingTargetFloor();
        context.analysisResult.roomLevels = summary;
    }

    /**
     * A row ticked or unticked for Sim together.
     * @param {number} index - Index into the analysis's results
     * @param {boolean} checked
     * @private
     */
    _toggleSkillingPick(index, checked) {
        this._skillingChecked = this._skillingChecked.filter((i) => i !== index);
        if (checked) this._skillingChecked.push(index);
        this._updateSkillingCheckedCount();
    }

    /** @private */
    _updateSkillingCheckedCount() {
        const el = this.panel?.querySelector('#mwi-labsim-skilling-checked-count');
        if (!el) return;
        const n = this._skillingChecked.length;
        el.textContent = n ? `${n} checked` : '';
    }

    /**
     * Run a task on the Skilling tab's progress bar and Stop button, the way
     * Analyze Upgrades does.
     * @param {function(function({current: number, total: number, description: string}): void): Promise<void>} task
     * @private
     */
    async _runSkillingTask(task) {
        if (this._skillingRunning || this._upgradeRunning || this._runStarting || this.isRunning) return;
        const panel = this.panel;
        const progressEl = panel.querySelector('#mwi-labsim-skilling-progress');
        const hidden = ['calc', 'upgrade'].map((id) => panel.querySelector(`#mwi-labsim-skilling-${id}`));
        const busy = ['plan', 'combine'].map((id) => panel.querySelector(`#mwi-labsim-skilling-${id}`));
        const stopBtn = panel.querySelector('#mwi-labsim-skilling-stop');
        progressEl.style.display = 'block';
        for (const button of hidden) button.style.display = 'none';
        for (const button of busy) button.disabled = true;
        stopBtn.style.display = 'inline-block';
        this._skillingAborted = false;
        this._skillingRunning = true;
        const runToken = ++this._runStartToken;
        // Stopped by the Stop button, or stale: a teardown bumps the token even when
        // the same character's panel is rebuilt, and a new task resets the flag
        const isAborted = () => this._skillingAborted || runToken !== this._runStartToken;
        const eta = createEtaTracker();
        try {
            await task(({ current, total, description }) => {
                if (isAborted() || !this.panel) return;
                const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                if (fill) fill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 100}%`;
                if (text)
                    text.textContent =
                        `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
            }, isAborted);
        } catch (error) {
            console.error('[LabSimUI] Skilling task failed:', error);
            if (runToken === this._runStartToken) this._setStatus('Skilling task failed: ' + error.message);
        } finally {
            if (runToken === this._runStartToken) this._skillingRunning = false;
            progressEl.style.display = 'none';
            for (const button of hidden) button.style.display = '';
            for (const button of busy) button.disabled = false;
            stopBtn.style.display = 'none';
        }
    }

    /**
     * Plan to goal: the cheapest sequence of the analyzed upgrades that reaches
     * the Target clear % (at the Floor's exit room when a floor is set).
     * @private
     */
    async _onSkillingPlan() {
        const context = this._skillingAnalysis;
        if (!context) {
            this._setStatus('Run Analyze Upgrades first: the plan chooses among its upgrades.');
            return;
        }
        const goalEl = this.panel.querySelector('#mwi-labsim-skilling-goal-results');
        const floor = this._getSkillingTargetFloor();
        const goalRate = this._getSkillingTargetClear();
        const goalLevel = floor > 0 ? goalLevelForFloor(floor) : 0;
        const showLevels = this._getSkillingRoomLevelsOn();
        const barText = `${Math.round(goalRate * 100)}% average clear`;
        const goalText =
            floor > 0
                ? `${barText} at floor ${floor}'s exit room (level ${goalLevel})`
                : `${barText} at the analyzed room level`;

        let plan = null;
        await this._runSkillingTask(async (onProgress, isAborted) => {
            const abortSignal = isAborted;
            plan = await planSkillingGoal({
                baseSetup: context.baseSetup,
                rows: context.analysisResult.results,
                evaluate: context.evaluate,
                goalRoomLevel:
                    floor > 0 ? uniformRoomLevels(goalLevel, context.skills, SKILLING_SKILL_HRIDS) : context.roomLevel,
                goalRate,
                targetSkill: context.targetSkill,
                abortSignal,
                onProgress,
                measureMax: showLevels
                    ? createSetupLevelSearch({
                          evaluate: context.evaluate,
                          skills: context.skills,
                          allSkills: SKILLING_SKILL_HRIDS,
                          threshold: goalRate,
                          abortSignal,
                      })
                    : null,
            });
        });
        if (!plan || !goalEl || !this.panel?.contains(goalEl) || this._skillingAnalysis !== context) return;
        goalEl.innerHTML = renderPlanHtml(plan, { goalText, showLevels });
        this._setStatus(
            plan.aborted
                ? `Plan stopped early (${plan.steps.length} steps taken).`
                : plan.reached
                  ? `Plan reached the goal in ${plan.steps.length} steps.`
                  : `Goal not reached (${plan.steps.length} steps taken).`
        );
    }

    /**
     * Sim together: every ticked row applied at once, one per slot.
     * @private
     */
    async _onSkillingCombine() {
        const context = this._skillingAnalysis;
        if (!context) {
            this._setStatus('Run Analyze Upgrades first, then tick the rows to combine.');
            return;
        }
        const picks = this._skillingChecked.map((i) => context.analysisResult.results[i]).filter(Boolean);
        if (!picks.length) {
            this._setStatus('Tick at least one upgrade row to sim together.');
            return;
        }
        const goalEl = this.panel.querySelector('#mwi-labsim-skilling-goal-results');
        const showLevels = this._getSkillingRoomLevelsOn();
        let combo = null;
        await this._runSkillingTask(async (_onProgress, isAborted) => {
            const abortSignal = isAborted;
            combo = await simulateCombination({
                rows: picks,
                baseSetup: context.baseSetup,
                evaluate: context.evaluate,
                roomLevel: context.roomLevel,
                targetSkill: context.targetSkill,
                measureMax: showLevels
                    ? createSetupLevelSearch({
                          evaluate: context.evaluate,
                          skills: context.skills,
                          allSkills: SKILLING_SKILL_HRIDS,
                          threshold: this._getSkillingTargetClear(),
                          abortSignal,
                      })
                    : undefined,
            });
        });
        if (!combo || !goalEl || !this.panel?.contains(goalEl) || this._skillingAnalysis !== context) return;
        goalEl.innerHTML = renderCombinationHtml(combo, { showLevels });
        this._setStatus(`${combo.kept.length} upgrades simmed together.`);
    }

    /**
     * The community buff level the Skilling tab should sim at, 0 when the box is
     * empty (one level up).
     * @returns {number}
     * @private
     */
    _getSkillingCommunityTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-skilling-community-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_COMMUNITY_BUFF_LEVEL, value) : 0;
    }

    /** @returns {string} Whatever the uniform house Lv box holds @private */
    _getHouseTargetLevelInput() {
        return this.panel?.querySelector('#mwi-labsim-house-target-level')?.value || '';
    }

    /**
     * The uniform house target level, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getHouseTargetLevel() {
        const value = parseInt(this._getHouseTargetLevelInput(), 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_HOUSE_LEVEL, value) : 0;
    }

    /**
     * Per-room house target levels, or null when the grid is closed.
     * @returns {Object|null} roomHrid → target level
     * @private
     */
    _getHouseTargets() {
        const grid = this.panel?.querySelector('#mwi-labsim-house-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-house-target]').forEach((input) => {
            const value = parseInt(input.value, 10);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.labHouseTarget] = Math.min(MAX_HOUSE_LEVEL, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * The shrine level to buy up to, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getShrineTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-shrine-target-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_GUILD_SHRINE_LEVEL, value) : 0;
    }

    /**
     * The community buff level to sim at, 0 when the box is empty (one level up).
     * @returns {number}
     * @private
     */
    _getCommunityTargetLevel() {
        const value = parseInt(this.panel?.querySelector('#mwi-labsim-community-target-level')?.value, 10);
        return Number.isFinite(value) && value > 0 ? Math.min(MAX_COMMUNITY_BUFF_LEVEL, value) : 0;
    }

    /**
     * Prefill the per-skill target inputs from the selected player's current
     * levels plus the +Levels boost. For a single fight, skills the weapon
     * style can't train are hidden; a multi-fight scope keeps every skill
     * visible, since assigned loadouts can differ in style.
     * @private
     */
    _prefillLabCombatTargets() {
        const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        const boost = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-target-level')?.value) || 5;
        const isAllFights = this._upgradeTargetCount() > 1;

        const gameData = buildGameDataPayload();
        const excluded = !isAllFights && dto && gameData ? getStyleExcludedSkills(dto, gameData) : new Set();

        this.panel.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const isExcluded = excluded.has(input.dataset.labCombatTarget);
            const wrapper = input.closest('span');
            if (wrapper) wrapper.style.display = isExcluded ? 'none' : 'inline-flex';
            if (isExcluded) {
                input.value = '';
                return;
            }
            const current = Math.max(1, Math.floor(dto?.[input.dataset.labCombatTarget] || 1));
            input.value = Math.min(200, current + boost);
        });
    }

    /**
     * Every ability the current target scope can level, deduplicated.
     *
     * For the Configure fight that is one loadout, which is what this grid
     * always showed. For a whole run — or a chosen subset — it is the *union*
     * across the loadouts those fights are assigned, which is what it showed
     * before and should have: ten fights across a melee and a magic loadout
     * offered targets for five magic abilities, and every melee ability in the
     * run had no way to be given one at all.
     *
     * An ability slotted in two loadouts is one entry, because a target is a
     * level on the ability itself and applies wherever it is equipped. The
     * loadouts it belongs to come with it, so the label can say so when they
     * are not all of them, and the levels come as a set, because the same
     * ability is often held at different levels in different loadouts.
     *
     * @param {string} [playerSelector] - Which player select the single-loadout
     *   fallback reads its index from
     * @returns {Array<Object>} `[{ hrid, name, levels, loadouts, shared }]`, by name
     * @private
     */
    _upgradeAbilityEntries(playerSelector = '#mwi-labsim-upgrade-player') {
        const gameData = buildGameDataPayload();
        const nameOf = (hrid) => gameData?.abilityDetailMap?.[hrid]?.name || hrid.split('/').pop();

        const scopeMode = this._getUpgradeScopeMode();
        if (scopeMode !== 'current') {
            const chosen = scopeMode === 'selected' ? new Set(this._getChosenTargets()) : null;
            const useSkipLevels = this.panel?.querySelector('#mwi-labsim-allfights-useskip')?.checked ?? true;
            const fights = this._collectLabyrinthFights(useSkipLevels).filter(
                (fight) => !chosen || chosen.has(fight.monsterHrid)
            );
            const loadoutCount = new Set(fights.map((fight) => fight.loadoutName)).size;
            const byHrid = new Map();
            for (const fight of fights) {
                for (const ability of fight.dto?.abilities || []) {
                    if (!ability?.hrid) continue;
                    let entry = byHrid.get(ability.hrid);
                    if (!entry) {
                        entry = { hrid: ability.hrid, levels: new Set(), loadouts: new Set() };
                        byHrid.set(ability.hrid, entry);
                    }
                    entry.levels.add(Math.max(1, Math.floor(Number(ability.level) || 1)));
                    entry.loadouts.add(fight.loadoutName);
                }
            }
            if (byHrid.size) {
                return [...byHrid.values()]
                    .map((entry) => ({
                        hrid: entry.hrid,
                        name: nameOf(entry.hrid),
                        levels: [...entry.levels].sort((a, b) => a - b),
                        loadouts: [...entry.loadouts],
                        // Unlabelled when every loadout in the set casts it —
                        // a label on all of them is noise on all of them
                        shared: entry.loadouts.size >= loadoutCount,
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
            // No fight resolves a loadout yet; the Configure loadout below is a
            // better answer than an empty grid
        }

        const playerIndex = parseInt(this.panel?.querySelector(playerSelector)?.value) || 0;
        const editedDTOs = this._editor?.getEditedDTOs();
        const dto = editedDTOs ? Object.values(editedDTOs)[playerIndex] : null;
        return (dto?.abilities || [])
            .filter((ability) => ability?.hrid)
            .map((ability) => ({
                hrid: ability.hrid,
                name: nameOf(ability.hrid),
                levels: [Math.max(1, Math.floor(Number(ability.level) || 1))],
                loadouts: [],
                shared: true,
            }));
    }

    /**
     * Rebuild and prefill the per-ability target inputs for whatever the target
     * scope covers (highest current level + the +Levels boost).
     *
     * Anything already typed survives the rebuild: the grid is redrawn whenever
     * the scope changes, and a target typed for Fireball should not be lost
     * because a second fight was ticked.
     * @private
     */
    _prefillAbilityTargets(grid, playerSelector, levelSelector) {
        const boost = parseInt(this.panel.querySelector(levelSelector)?.value) || 5;
        const typed = {};
        grid.querySelectorAll('[data-ability-target]').forEach((input) => {
            const value = parseInt(input.value, 10);
            if (Number.isFinite(value) && value > 0) typed[input.dataset.abilityTarget] = value;
        });

        const entries = this._upgradeAbilityEntries(playerSelector);
        if (!entries.length) {
            grid.innerHTML =
                '<span style="color:#666; font-size:11px;">No abilities equipped — configure a simulation first.</span>';
            return;
        }

        const multiLoadout = entries.some((entry) => entry.loadouts.length > 0);
        grid.innerHTML =
            '<span style="color:#666; font-size:11px; flex-basis:100%;">Target levels (blank or ≤ current level ' +
            'skips the ability; used instead of the +Levels boost while open)' +
            (multiLoadout ? ' — every ability across the checked fights, with the loadouts it is slotted in' : '') +
            ':</span>' +
            entries
                .map((entry) => {
                    const lowest = entry.levels[0];
                    const highest = entry.levels[entry.levels.length - 1];
                    const levelText = lowest === highest ? `${lowest}` : `${lowest}–${highest}`;
                    const loadoutText = entry.shared ? '' : ` [${entry.loadouts.join(', ')}]`;
                    // Off the highest of them, so the boost is a real boost in
                    // every loadout rather than a no-op in the ones already past it
                    const target = Math.min(200, typed[entry.hrid] || highest + boost);
                    return `
                <span style="display:inline-flex; align-items:center; gap:4px;">
                    <label style="color:#888; font-size:11px;" title="${entry.loadouts.join(', ')}">${entry.name} (${levelText})<span style="color:#666;">${loadoutText}</span></label>
                    <input type="number" min="1" max="200" data-ability-target="${entry.hrid}" value="${target}" style="
                        width:52px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444;
                        border-radius:3px; padding:2px 4px; font-size:11px; text-align:center;">
                </span>`;
                })
                .join('');
    }

    /**
     * Read the per-ability target map when the grid is open.
     * @private
     * @returns {Object|null} {abilityHrid: targetLevel} or null when not in use
     */
    _getAbilityTargets(gridSelector) {
        const grid = this.panel.querySelector(gridSelector);
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-ability-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.abilityTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Read the per-skill target map when the targets grid is open.
     * @private
     * @returns {Object|null} {skillKey: targetLevel} or null when not in use
     */
    _getLabCombatLevelTargets() {
        const grid = this.panel.querySelector('#mwi-labsim-combat-targets');
        if (!grid || grid.style.display === 'none') return null;
        const targets = {};
        grid.querySelectorAll('[data-lab-combat-target]').forEach((input) => {
            const value = parseInt(input.value);
            if (Number.isFinite(value) && value > 0) {
                targets[input.dataset.labCombatTarget] = Math.min(200, value);
            }
        });
        return Object.keys(targets).length > 0 ? targets : null;
    }

    /**
     * Every loadout the character owns gear in: the given fights plus each saved loadout no fight wears
     * (unassigned, or a monster with no resolvable room level). A bag copy such a loadout wears is not a
     * free spare, and a piece it wears is owned, so they must count whatever the fight list left out.
     * @private
     * @param {Array<{dto: Object, loadoutName: string, loadoutId: number}>} fights
     * @returns {Array<{dto: Object, loadoutName: string, loadoutId: number}>}
     */
    _collectOwnedLoadouts(fights) {
        const owned = fights.slice();
        const worn = new Set(fights.map((fight) => Number(fight.loadoutId) || 0));
        const snapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots || {};
        for (const id of Object.keys(snapshots)) {
            const loadoutId = Number(id) || 0;
            if (!loadoutId || worn.has(loadoutId)) continue;
            const dto = (labyrinthClearRate() || bundledLabyrinthClearRate).buildLabyrinthPlayerDTO(loadoutId);
            if (!dto) continue;
            worn.add(loadoutId);
            owned.push({ dto, loadoutName: snapshots[id]?.name || `Loadout #${loadoutId}`, loadoutId });
        }
        return owned;
    }

    /**
     * Collect every labyrinth combat fight: each monster with a resolvable
     * room level paired with the player DTO wearing its assigned labyrinth
     * loadout. Room levels come from the automation skip thresholds
     * (effective combat level + skip − 1) unless useSkipLevels is false, in
     * which case an active run's live room levels take precedence.
     * @private
     * @param {boolean} [useSkipLevels=true]
     * @returns {Array<{monsterHrid: string, monsterName: string, roomLevel: number, dto: Object, loadoutName: string,
     *   loadoutId: number}>}
     */
    _collectLabyrinthFights(useSkipLevels = true) {
        const fights = [];
        for (const monster of getLabyrinthMonsters()) {
            const roomLevel = useSkipLevels
                ? (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatSkipRoomLevel(monster.hrid)
                : (labyrinthClearRate() || bundledLabyrinthClearRate).getCombatRoomLevel(monster.hrid);
            if (!roomLevel) continue; // no skip threshold configured for this monster
            const loadoutId = (labyrinthClearRate() || bundledLabyrinthClearRate).getLabyrinthLoadoutId(monster.hrid);
            const dto = (labyrinthClearRate() || bundledLabyrinthClearRate).buildLabyrinthPlayerDTO(loadoutId);
            if (!dto) continue;
            const snapshot = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots[loadoutId];
            const loadoutName = snapshot?.name || (loadoutId ? `Loadout #${loadoutId}` : 'Current gear');
            fights.push({
                monsterHrid: monster.hrid,
                monsterName: monster.name,
                roomLevel,
                dto,
                loadoutName,
                // Which saved loadout the fight wears, 0 for the worn gear: an id the store does not hold
                // builds the worn gear too (`buildLabyrinthPlayerDTO`). Read by the trigger tuning's grouping.
                loadoutId: snapshot ? Number(loadoutId) || 0 : 0,
            });
        }
        return fights;
    }

    /**
     * Put an Export CSV button above a results table.
     *
     * A ranked table in a panel is read once and closed; the same numbers in a
     * spreadsheet can be sorted another way, kept beside last week's run, and
     * shown to someone else — which is most of what people do with an analysis
     * that took minutes to produce.
     *
     * The button is a sibling of the container rather than inside it: sorting a
     * column re-renders the container's whole innerHTML, and a button living in
     * there would vanish the first time anyone clicked a header.
     *
     * @param {HTMLElement} container - The results container
     * @param {string} stem - Filename stem, e.g. `labsim-upgrades`
     * @param {Function} build - Returns `{ rows, columns }` at click time, so the
     *   export is of what is on screen now rather than what was there at render
     * @private
     */
    _addCsvExport(container, stem, build) {
        const previous = container.previousElementSibling;
        if (previous?.dataset?.csvExport) previous.remove();

        const bar = document.createElement('div');
        bar.dataset.csvExport = stem;
        bar.style.cssText = 'display:flex; justify-content:flex-end; margin:0 0 6px 0;';

        const button = document.createElement('button');
        button.textContent = 'Export CSV';
        button.style.cssText =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer;';

        const flash = (text) => {
            button.textContent = text;
            clearTimeout(this._csvFlash);
            this._csvFlash = setTimeout(() => {
                button.textContent = 'Export CSV';
            }, 1600);
        };

        button.addEventListener('click', () => {
            try {
                const { rows, columns } = build();
                if (!rows?.length) {
                    flash('Nothing to export');
                    return;
                }
                flash(downloadCsv(csvFilename(stem), toCsv(rows, columns)) ? 'Saved \u2713' : 'Failed');
            } catch (error) {
                console.error('[LabSimUI] CSV export failed:', error);
                flash('Failed');
            }
        });

        // The generated results' button rides in their "Upgrades" header row, beside the title,
        // rather than taking a row of its own above the table
        const resultsRoot = container.closest?.('#mwi-labsim-upgrade-results, #mwi-labsim-skilling-results');
        const kind = resultsRoot?.id === 'mwi-labsim-skilling-results' ? 'skilling' : 'combat';
        const header = resultsRoot ? this.panel?.querySelector(`#mwi-labsim-upgrades-header-${kind}`) : null;
        if (header) {
            header.querySelector('[data-csv-export]')?.remove();
            button.dataset.csvExport = stem;
            button.style.marginLeft = 'auto';
            // A click on the button must not also collapse the section its header toggles
            button.addEventListener('click', (event) => event.stopPropagation());
            header.appendChild(button);
            return;
        }

        bar.appendChild(button);
        container.parentNode?.insertBefore(bar, container);
    }

    /**
     * The shopping list a budget buys, above the table it came from.
     *
     * The table answers "what is the best single thing"; nobody buys one thing.
     * This answers the question people actually have — "I have 500M, what should
     * I get" — by walking the table in value order and taking what fits, one
     * upgrade per slot, skipping anything whose gain is inside the simulation's
     * own error.
     *
     * @param {Array<Object>} results - Ranked results
     * @param {Object} baseline - Baseline metrics, for valuing room coverage
     * @returns {string} HTML
     * @private
     */
    _renderBudgetPlan(results, baseline) {
        const budget = this._allFightsBudget ?? 0;
        const baselineFights = baseline?.fights || [];
        const money = (value) => formatKMB(Math.round(value));
        const inputStyle =
            'width:90px; background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; ' +
            'padding:2px 6px; font-size:11px;';
        const btnStyle =
            'background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ' +
            'padding:2px 8px; font-size:11px; cursor:pointer;';

        let body = '';
        if (budget > 0) {
            const plan = planWithinBudget(results, budget, { baselineFights });
            if (!plan.picks.length) {
                body = `<div style="color:#888; font-size:11px;">Nothing in the list fits ${money(budget)}${
                    plan.skipped.length ? ' — the cheapest measured upgrade costs more.' : '.'
                }</div>`;
            } else {
                const rows = plan.picks
                    .map((pick) => {
                        // The saving credited to this pick is what it adds
                        // *beyond the others* — a second piece for a slot is
                        // worth only the rooms it improves on the first
                        const rooms = pick.rooms ?? 0;
                        return `<div style="display:flex; justify-content:space-between; gap:10px; padding:1px 0;">
                                <span style="color:#e0e0e0;">${pick.candidate.description}
                                    <span style="color:#666;">· ${rooms} room${rooms === 1 ? '' : 's'}</span>
                                    ${combatSimUI.upgradeRowActionsHtml(pick)}</span>
                                <span style="white-space:nowrap; color:#aaa;">${goldCostCell(pick.cost)}
                                    <span style="color:#4caf50;">−${(pick.marginalAttemptsSaved ?? -pick.attemptsDelta).toFixed(1)} attempts</span></span>
                            </div>`;
                    })
                    .join('');
                const noise = plan.skipped.filter((s) => s.reason.startsWith('within the noise')).length;
                body =
                    rows +
                    `<div style="margin-top:4px; padding-top:4px; border-top:1px solid #222; color:#aaa; font-size:11px;">
                        ${plan.picks.length} upgrades ·
                        ${
                            // A plan whose resales outrun its purchases spends
                            // nothing at all — "−17.7M of 500M" reads as an
                            // outlay, and it is the opposite of one
                            plan.totalCost < 0
                                ? `${money(-plan.totalCost)} back, none of ${money(budget)} spent`
                                : `${money(plan.totalCost)} of ${money(budget)}`
                        } ·
                        <span style="color:#4caf50; font-weight:600;">−${plan.attemptsSaved.toFixed(1)} attempts</span>
                        <span style="color:#666;"> if gains in different slots add up</span>
                        <button id="mwi-labsim-verify-combo" style="${btnStyle} margin-left:8px;"
                            title="Runs the whole run again with every pick installed at once — each loadout wearing all of the picks that apply to it, and the better one where two picks share a slot. Upgrades that fix the same failing room overlap, and the total above counts that room twice.">Verify together</button>
                        ${
                            planPurchases(plan.picks).length
                                ? `<button id="mwi-labsim-budget-market" style="${btnStyle} margin-left:4px;"
                            title="Opens the marketplace with one tab per purchase in this plan, so the whole list is one trip.">Open all in marketplace</button>`
                                : ''
                        }
                    </div>` +
                    (noise
                        ? `<div style="color:#666; font-size:10px; margin-top:2px;">${noise} skipped as within the simulation's own error</div>`
                        : '') +
                    `<div id="mwi-labsim-combo-result" style="margin-top:4px; font-size:11px;"></div>`;
            }
        }

        return `<div id="mwi-labsim-budget" style="margin-bottom:8px; padding:6px 8px; background:#0d0d1a;
            border:1px solid #222; border-radius:4px;">
            <div style="display:flex; align-items:center; gap:6px; font-size:11px; color:#888;">
                <span style="color:${ACCENT}; font-weight:700;">Budget</span>
                <input id="mwi-labsim-budget-input" type="text" inputmode="numeric" placeholder="e.g. 500m"
                    value="${this._allFightsBudgetText || ''}" style="${inputStyle}">
                <button id="mwi-labsim-budget-plan" style="${btnStyle}">Plan</button>
                <span style="color:#555;">best set that fits — most rooms covered per coin, skipping gains inside the noise</span>
            </div>
            ${body ? `<div style="margin-top:6px;">${body}</div>` : ''}
        </div>`;
    }

    /**
     * Make the budget box work: parse what was typed, re-render on Plan, and run
     * the combination check on Verify.
     * @private
     */
    _wireBudgetPlan(container, results, baseline) {
        const input = container.querySelector('#mwi-labsim-budget-input');
        const plan = () => {
            this._allFightsBudgetText = input?.value || '';
            const typed = parseKMB(this._allFightsBudgetText);
            this._allFightsBudget = Number.isFinite(typed) ? typed : 0;
            this._renderAllFightsResults(this._allFightsResult, container);
        };
        container.querySelector('#mwi-labsim-budget-plan')?.addEventListener('click', plan);
        input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') plan();
        });

        // "Save for this" and "Watch" on each pick
        combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');

        container.querySelector('#mwi-labsim-budget-market')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const label = button.textContent;
            const picks = planWithinBudget(results, this._allFightsBudget ?? 0, {
                baselineFights: baseline?.fights || [],
            }).picks;

            button.disabled = true;
            button.textContent = 'Opening…';
            try {
                const opened = await openPlanInMarketplace(picks);
                button.textContent = opened ? `${opened} tab${opened === 1 ? '' : 's'} ✓` : 'Marketplace unavailable';
            } catch (error) {
                console.error('[LabSimUI] Opening the plan in the marketplace failed:', error);
                button.textContent = 'Failed';
            } finally {
                button.disabled = false;
                setTimeout(() => {
                    button.textContent = label;
                }, 1600);
            }
        });

        container.querySelector('#mwi-labsim-verify-combo')?.addEventListener('click', async (event) => {
            const button = event.currentTarget;
            const output = container.querySelector('#mwi-labsim-combo-result');
            const picks = planWithinBudget(results, this._allFightsBudget ?? 0, {
                baselineFights: baseline?.fights || [],
            }).picks;
            if (!picks.length || !output) return;

            button.disabled = true;
            button.textContent = 'Checking…';
            try {
                const check = await runLabyrinthCombinationCheck(
                    {
                        picks,
                        baseline,
                        pairing: this._allFightsResult?.pairing,
                        context: this._allFightsResult?.context,
                    },
                    ({ current, total, description }) => {
                        button.textContent = `${current} / ${total} ${description}`;
                    },
                    { abortSignal: () => this._upgradeAborted }
                );
                output.innerHTML = check ? this._renderComboCheck(check) : '';
            } catch (error) {
                console.error('[LabSimUI] Combination check failed:', error);
                output.innerHTML = '<span style="color:#f44336;">Combination check failed — see console.</span>';
            } finally {
                button.disabled = false;
                button.textContent = 'Verify together';
            }
        });
    }

    /**
     * What the set turned out to be worth, next to what the parts promised.
     * @private
     */
    _renderComboCheck(check) {
        const worn = check.fights?.length ? Math.max(...check.fights.map((f) => f.installed?.length || 0)) : 0;
        const promised = -check.summedDelta;
        const actual = -check.attemptsDelta;
        // Overlap is the usual outcome and not a fault: two upgrades that both
        // rescue the same failing room cannot both be the thing that rescued it
        const lost = promised - actual;
        const share = promised > 0 ? Math.round((lost / promised) * 100) : 0;
        const color = lost > check.noise ? '#ff9800' : '#4caf50';
        return `<span style="color:#e0e0e0;">Together: <b>−${actual.toFixed(1)}</b> attempts</span>
            <span style="color:#666;">(each loadout wearing every pick that fits it, up to ${worn} at once)</span>
            <span style="color:#888;">vs −${promised.toFixed(1)} promised by the parts</span>
            <span style="color:${color};">${
                lost > check.noise
                    ? `— ${share}% of it was double-counted (they overlap)`
                    : '— they do not overlap, the sum holds'
            }</span>
            <span style="color:#555;">±${check.noise.toFixed(1)}</span>`;
    }

    /**
     * A minimizable tab section: a header (see `collapseHeaderHtml`) over a body holding the given elements.
     * The header is static and the body is what hides, so the elements inside can be redrawn and can set
     * their own `display` without touching the collapsed state, which lives in the saved swap options.
     * @param {string} key - Section id; the saved state is keyed `lab:<key>`
     * @param {string} title - Plain-text title
     * @param {Array<HTMLElement>} children - What the section holds
     * @param {Object} [options]
     * @param {string} [options.empty] - Summary shown when the body has nothing to say
     * @param {Function} [options.summary] - `(body) => string`, the collapsed one-liner; the body's own text by default
     * @returns {HTMLElement}
     * @private
     */
    _makeSection(key, title, children, { empty = '', summary = null } = {}) {
        const wrap = document.createElement('div');
        wrap.setAttribute('data-lab-section', key);
        wrap.style.cssText = 'flex:0 0 auto;';
        wrap.innerHTML = collapseHeaderHtml({
            key: `lab:${key}`,
            title: escapeHtmlAttribute(title),
            summary: empty,
            style: `padding:6px 14px; border-bottom:1px solid #222; color:${ACCENT}; font-size:12px; font-weight:700;`,
        });
        const body = document.createElement('div');
        body.setAttribute('data-lab-section-body', key);
        for (const child of children) body.appendChild(child);
        wrap.appendChild(body);
        const refresh = () => {
            const header = wrap.firstElementChild;
            const el = header?.querySelector('[data-collapse-summary]');
            if (!el) return;
            let text = '';
            try {
                text = oneLine(summary ? summary(body) : body.textContent);
            } catch {
                text = '';
            }
            el.textContent = text || empty;
            if (header.getAttribute('aria-expanded') === 'false') el.style.display = el.textContent ? 'inline' : 'none';
        };
        wrap._refreshSummary = refresh;
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(refresh).observe(body, { childList: true, subtree: true, characterData: true });
        }
        return wrap;
    }

    /**
     * Make every section header made by `_makeSection` clickable. Their collapsed state is read from, and
     * written to, the saved swap options as they are at the moment, so a restore that replaces the options
     * needs only `_applyLabSectionStates`.
     * @private
     */
    _wireLabSections() {
        const owner = this;
        const state = () => owner._swapOptions.sectionsCollapsed;
        this._sectionMap = new Proxy(
            {},
            {
                get: (_target, key) => state()[key],
                set: (_target, key, value) => {
                    owner._swapOptionChanged(['sectionsCollapsed', key], false);
                    if (value) state()[key] = true;
                    else delete state()[key];
                    return true;
                },
                deleteProperty: (_target, key) => {
                    owner._swapOptionChanged(['sectionsCollapsed', key], false);
                    delete state()[key];
                    return true;
                },
            }
        );
        this._applyLabSectionStates(true);
    }

    /**
     * Draw each tab section open or closed from the saved options. Safe to call after any restore.
     * @param {boolean} [first=false] - Wire the headers too
     * @private
     */
    _applyLabSectionStates(first = false) {
        if (!this.panel || !this._sectionMap) return;
        for (const wrap of this.panel.querySelectorAll('[data-lab-section]')) {
            wrap._refreshSummary?.();
            enhanceCollapsibles(
                wrap,
                this._sectionMap,
                first
                    ? () => {
                          wrap._refreshSummary?.();
                          this._swapOptionChanged();
                      }
                    : undefined,
                first ? () => wrap._refreshSummary?.() : undefined
            );
        }
    }

    // ---- Verify: re-measuring the winners on fresh paired seeds -----------------------------------

    /**
     * An empty verify record: verdicts by row key for each section, a note line for the two tables, and the run
     * in flight (`{ scope, keys }`) while there is one.
     * @returns {{all: Map, order: Map, trigger: Map, notes: {all: string, order: string}, running: Object|null}}
     * @private
     */
    _freshVerify() {
        return { all: new Map(), order: new Map(), trigger: new Map(), notes: { all: '', order: '' }, running: null };
    }

    /**
     * Drop the verdicts (and the live analysis they could run against) of some sections, and retire any verify
     * run in flight: its token no longer matches, so whatever it returns is discarded.
     * @param {Array<string>} [scopes] - Sections to clear; all three by default
     * @private
     */
    _clearVerify(scopes = ['all', 'order', 'trigger']) {
        this._verifyToken++;
        const fresh = this._freshVerify();
        for (const scope of scopes) {
            this._verify[scope] = fresh[scope];
            if (scope !== 'trigger') this._verify.notes[scope] = '';
            this._verifyLive[scope] = null;
        }
        this._verify.running = null;
    }

    /** @returns {boolean} Whether the Auto-verify close calls setting is on @private */
    _autoVerifyEnabled() {
        return config.getSettingValue('combatSim_autoVerifyCloseCalls', false) === true;
    }

    /**
     * Remember a fresh analysis as something a verify can run against. A remembered (restored) result is never
     * registered: it carries no simulation context, so its Verify controls stay off.
     * @param {'all'|'order'|'trigger'} scope - Section
     * @param {Object} source - The analysis (`all`), `{ raw, section }` (`order`) or `{ run, gameData }` (`trigger`)
     * @param {string|null} ownerId - Character the analysis ran for
     * @private
     */
    _registerVerifyLive(scope, source, ownerId) {
        this._verifyLive[scope] = null;
        if (scope === 'all') {
            if (!source?.context || !source?.pairing || !Array.isArray(source.results)) return;
            this._verifyLive.all = { analysis: source, context: source.context, pairing: source.pairing, ownerId };
        } else if (scope === 'order') {
            const { raw, section } = source;
            if (!raw?.context || !raw?.pairing || !raw?.baseline) return;
            const rows = (raw.results || []).filter(
                (row) => row.candidate?.checkedAbilityKey === 'ability_order' && !row.candidate.keepCurrent
            );
            // The section's groups are the baseline's loadout groups with two or more ordinary abilities, in order
            const groupIdx = [...groupFightsByLoadout(raw.baseline, raw.context.fights).values()].filter(
                (indexes) =>
                    (raw.context.fights?.[indexes[0]]?.dto?.abilities || []).slice(1).filter(Boolean).length >= 2
            );
            this._verifyLive.order = {
                section,
                context: raw.context,
                pairing: raw.pairing,
                rows,
                groupIdx,
                ownerId,
            };
        } else {
            this._verifyLive.trigger = { ...source, ownerId };
        }
    }

    /**
     * Whether a section's verify controls can act: its analysis is the live one and the character has not moved.
     * @param {'all'|'order'} scope - Section
     * @param {Object} subject - The analysis (`all`) or the order section (`order`) being drawn
     * @returns {boolean}
     * @private
     */
    _isVerifyLive(scope, subject) {
        const live = this._verifyLive[scope];
        if (!live || !this._stillSameCharacter(live.ownerId)) return false;
        return (scope === 'all' ? live.analysis : live.section) === subject;
    }

    /** The verdict key of an all-fights row @private */
    _allRowKey(row) {
        try {
            if (row?.candidate) return candidateAssignmentKey(row.candidate);
        } catch {
            // fall through to the description
        }
        return row?.candidate?.description ?? '';
    }

    /** The verdict key of one order in the Ability order section @private */
    _orderRowKey(groupIndex, order) {
        return `${groupIndex}|${(order.order || []).join('>')}`;
    }

    /**
     * The analysis row to hand the engine for an order of one loadout group: the raw row, narrowed to the fights
     * of that group so a verify measures the loadout the section ranked it in.
     * @param {number} groupIndex - Index into the section's groups
     * @param {Object} order - A section order
     * @returns {Object|null} Null when the raw row is gone
     * @private
     */
    _orderVerifyRow(groupIndex, order) {
        const live = this._verifyLive.order;
        const indexes = new Set(live?.groupIdx?.[groupIndex] || []);
        const wanted = (order.order || []).join('>');
        const row = (live?.rows || []).find(
            (candidate) =>
                (candidate.candidate.order || []).join('>') === wanted &&
                [...indexes].some((i) => candidate.fights?.[i]?.applied)
        );
        if (!row) return null;
        return {
            ...row,
            fights: row.fights.map((fight, i) => (indexes.has(i) ? fight : { ...fight, applied: false })),
        };
    }

    /**
     * The improving rows of one section worth verifying on their own: close calls the analysis did not call
     * significant, not yet verified. `score` is the improvement against its own noise (a row with no noise
     * figure scores 0), the order the auto-verify picks its three by across both sections.
     * @param {'all'|'order'} scope - Section
     * @returns {Array<{key: string, row: Object, delta: number, score: number}>}
     * @private
     */
    _closeCallItems(scope) {
        const live = this._verifyLive[scope];
        if (!live) return [];
        const found = [];
        const scoreOf = (source) => {
            const noise = source.attemptsDeltaNoise;
            return Number.isFinite(noise) && noise > 0 ? -source.attemptsDelta / noise : 0;
        };
        if (scope === 'all') {
            for (const row of live.analysis.results) {
                if (isLevelRow(row) || row.costType === 'token') continue;
                if (!(row.attemptsDelta < 0) || !isCloseCall(row)) continue;
                found.push({ key: this._allRowKey(row), row, delta: row.attemptsDelta, score: scoreOf(row) });
            }
        } else {
            (live.section.groups || []).forEach((group, gi) => {
                for (const order of group.orders) {
                    if (!(order.attemptsDelta < 0) || !isCloseCall(order)) continue;
                    const row = this._orderVerifyRow(gi, order);
                    if (row) {
                        found.push({
                            key: this._orderRowKey(gi, order),
                            row,
                            delta: order.attemptsDelta,
                            score: scoreOf(order),
                        });
                    }
                }
            });
        }
        return found.filter((item) => !this._verify[scope].has(item.key));
    }

    /**
     * After an analysis finishes: verify its close, improving winners when the Auto-verify setting is on. Never
     * after a stop, a character switch or a newer run, and never for a remembered result (those have no live
     * record to verify against).
     * @param {Object} params
     * @param {number} params.startToken - `_runStartToken` of the analysis
     * @param {string|null} params.ownerId - Character the analysis ran for
     * @returns {Promise<void>}
     * @private
     */
    async _autoVerifyCloseCalls({ startToken, ownerId }) {
        if (!this._autoVerifyEnabled()) return;
        const isCurrent = () =>
            startToken === this._runStartToken && Boolean(this.panel) && this._stillSameCharacter(ownerId);
        // At most three in all, the ones whose improvement is largest against its noise across both sections
        const candidates = [];
        for (const scope of ['all', 'order']) {
            const live = this._verifyLive[scope];
            if (!live || live.ownerId !== ownerId) continue;
            for (const item of this._closeCallItems(scope)) candidates.push({ ...item, scope });
        }
        const chosen = candidates.sort((a, b) => b.score - a.score || a.delta - b.delta).slice(0, VERIFY_DEFAULTS.top);
        for (const scope of ['all', 'order']) {
            if (!isCurrent() || this._upgradeAborted) return;
            const items = chosen.filter((item) => item.scope === scope);
            if (items.length) await this._runLabVerify({ scope, items, auto: true });
        }
    }

    /**
     * Set up the progress box and the guards a verify run needs, and hand back what it must check after each
     * await. A manual verify claims the Upgrade tab (so no analysis starts beside it); an auto-verify runs inside
     * the analysis that triggered it, which already holds it.
     * @param {string|null} ownerId - Character the verify is for
     * @param {boolean} auto - Whether an analysis is already holding the tab
     * @returns {{isCurrent: Function, onProgress: Function, finish: Function, token: number}}
     * @private
     */
    _beginVerify(ownerId, auto) {
        if (!auto) {
            this._upgradeRunning = true;
            this._upgradeAborted = false;
        }
        const startToken = this._runStartToken;
        const token = ++this._verifyToken;
        const isCurrent = () =>
            token === this._verifyToken &&
            startToken === this._runStartToken &&
            Boolean(this.panel) &&
            this._stillSameCharacter(ownerId);
        const progressEl = this.panel.querySelector('#mwi-labsim-upgrade-progress');
        const runBtn = this.panel.querySelector('#mwi-labsim-upgrade-run');
        const stopBtn = this.panel.querySelector('#mwi-labsim-upgrade-stop');
        if (progressEl) progressEl.style.display = 'block';
        if (runBtn) runBtn.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'inline-block';
        const eta = createEtaTracker();
        const onProgress = ({ current, total, description }) => {
            if (!isCurrent() || this._upgradeAborted) return;
            const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
            const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
            const { text: remaining } = eta.update(total > 0 ? current / total : 0);
            if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
            if (text)
                text.textContent = `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
        };
        const finish = () => {
            if (token === this._verifyToken) this._verify.running = null;
            if (auto) return;
            // The run that was torn down while this one ran owns the flags now
            if (startToken === this._runStartToken) this._upgradeRunning = false;
            const progress = this.panel?.querySelector('#mwi-labsim-upgrade-progress');
            const run = this.panel?.querySelector('#mwi-labsim-upgrade-run');
            const stop = this.panel?.querySelector('#mwi-labsim-upgrade-stop');
            if (progress) progress.style.display = 'none';
            if (run) run.style.display = '';
            if (stop) stop.style.display = 'none';
        };
        return { isCurrent, onProgress, finish, token };
    }

    /**
     * Verify rows of the all-fights table or the Ability order section: each is re-run on fresh paired seeds,
     * several times longer than the analysis, against the analysis' own fights, loadouts and buffs.
     * @param {Object} params
     * @param {'all'|'order'} params.scope - Section
     * @param {Array<{key: string, row: Object}>} params.items - Rows to verify, with their verdict keys
     * @param {boolean} [params.auto] - Started by the Auto-verify setting inside an analysis
     * @returns {Promise<void>}
     * @private
     */
    async _runLabVerify({ scope, items, auto = false }) {
        const live = this._verifyLive[scope];
        if (!live || !items.length || !this.panel) return;
        if (!auto && (this._upgradeRunning || this._skillingRunning || this._runStarting || this.isRunning)) {
            this._setStatus('Wait for the current run to finish, then verify.');
            return;
        }
        if (!this._stillSameCharacter(live.ownerId)) return;
        const frame = this._beginVerify(live.ownerId, auto);
        const state = this._verify;
        state.running = { scope, keys: new Set(items.map((item) => item.key)) };
        state.notes[scope] = '';
        const noun = scope === 'order' ? 'ability order' : 'upgrade';
        this._setStatus(
            `${auto ? 'Auto-verifying' : 'Verifying'} ${items.length} ${noun}${items.length === 1 ? '' : 's'} on fresh seeds. Stop cancels at any point.`
        );
        let out = null;
        let error = null;
        try {
            // Inside the try: a draw that throws must still reach `frame.finish()` below, or the tab stays busy
            this._redrawVerify(scope);
            out = await verifyLabCandidates({
                context: live.context,
                pairing: live.pairing,
                rows: items.map((item) => item.row),
                seeds: VERIFY_DEFAULTS.seeds,
                hoursMultiplier: VERIFY_DEFAULTS.hoursMultiplier,
                abortSignal: () => !frame.isCurrent() || this._upgradeAborted,
                onProgress: frame.onProgress,
            });
        } catch (caught) {
            error = caught;
        }
        const current = frame.isCurrent();
        frame.finish();
        // A newer analysis, a character switch or a teardown owns the panel now: nothing of this run is kept
        if (!current) return;
        const label = auto ? 'Auto-verify' : 'Verify';
        if (error) {
            const cancelled = error.message === 'Cancelled' || error.message === 'Aborted';
            if (!cancelled) console.error('[LabSimUI] Verify failed:', error);
            state.notes[scope] = cancelled
                ? `${label} stopped before any result.`
                : `${label} failed: ${error.message}`;
        } else {
            state.notes[scope] = this._applyLabVerify(scope, items, out, label);
        }
        this._redrawVerify(scope);
        this._setStatus(state.notes[scope]);
    }

    /**
     * Keep a verify run's rows and word its outcome.
     * @param {'all'|'order'} scope - Section
     * @param {Array<{key: string}>} items - The rows asked for, parallel to `out.rows`
     * @param {Object} out - `verifyLabCandidates` result
     * @param {string} label - "Verify" or "Auto-verify"
     * @returns {string} The note for the section
     * @private
     */
    _applyLabVerify(scope, items, out, label) {
        if (out?.refused) {
            const reason = {
                seeds: 'too few seeds',
                rows: 'nothing to verify',
                context: 'the analysis record is incomplete',
            }[out.refused];
            return `${label} did not run: ${reason || out.refused}.`;
        }
        const map = this._verify[scope];
        const tally = { confirmed: 0, 'not-confirmed': 0, worse: 0, error: 0 };
        let unfinished = 0;
        (out?.rows || []).forEach((row, i) => {
            const key = items[i]?.key;
            if (key === undefined) return;
            // After a stop a row with no seed only means "did not finish" (a cancelled simulation is no error row)
            if (out.stopped && row.verdict !== 'error' && !(row.seeds > 0)) {
                unfinished++;
                return;
            }
            map.set(key, { ...row, partial: Boolean(out.stopped) && row.seeds < out.seeds });
            tally[row.verdict] = (tally[row.verdict] || 0) + 1;
        });
        if (out?.error && !map.size) return `${label} failed: ${out.error}`;
        const parts = [`${tally.confirmed} confirmed`, `${tally['not-confirmed']} not confirmed`];
        if (tally.worse) parts.push(`${tally.worse} worse`);
        if (tally.error) parts.push(`${tally.error} failed`);
        return (
            `${label}: ${parts.join(', ')} of ${items.length} ` +
            `(${out.seeds} fresh seeds, ${VERIFY_DEFAULTS.hoursMultiplier}x longer than the analysis).` +
            (out.stopped
                ? ` Stopped early${unfinished ? `: ${unfinished} unfinished and left unmarked` : ''}; partial results are marked.`
                : '')
        );
    }

    /**
     * Draw a section again after its verdicts moved, without touching the status line.
     * @param {'all'|'order'|'trigger'} scope - Section
     * @private
     */
    _redrawVerify(scope) {
        if (!this.panel) return;
        if (scope === 'all') {
            const live = this._verifyLive.all;
            const container = this._allFightsContainer;
            if (live && this._allFightsResult === live.analysis && container?.isConnected) {
                this._renderAllFightsResults(this._allFightsResult, container, { quiet: true });
            }
        } else if (scope === 'order') {
            this._drawUpgradeAbilityOrder();
        } else {
            this._drawTriggerResults();
        }
    }

    /**
     * The chip and the per-row Verify button for one table row.
     * @param {'all'|'order'} scope - Section
     * @param {string} key - Verdict key
     * @param {string} dataAttr - The data attribute name for the button, with the row's index as its value
     * @param {number} index - Row index the click handler maps back
     * @param {boolean} live - Whether Verify can act on this table
     * @returns {string} HTML
     * @private
     */
    _verifyRowHtml(scope, key, dataAttr, index, live) {
        const running = this._verify.running;
        if (running?.scope === scope && running.keys.has(key)) {
            return '<span data-verify-running style="color:#8ab4f8; font-size:10px; margin-left:6px;">verifying…</span>';
        }
        const verdict = this._verify[scope].get(key);
        let html = verdict ? verifyChipHtml(verdict, { partial: verdict.partial }) : '';
        if (live && !running) {
            html +=
                `<button ${dataAttr}="${index}" style="background:#1a1a2e; color:#8ab4f8; border:1px solid #333; ` +
                `border-radius:3px; padding:0 5px; font-size:10px; cursor:pointer; font-family:inherit; margin-left:6px;">` +
                `${verdict ? 'verify again' : 'verify'}</button>`;
        }
        return html;
    }

    /**
     * The strip above the all-fights table: Verify top 3, the run's progress word, and the last outcome. A
     * remembered table says why it cannot be verified.
     * @param {Object} analysis - The result being drawn
     * @param {Array<Object>} picks - The rows Verify top 3 would take
     * @returns {string} HTML
     * @private
     */
    _allFightsVerifyBarHtml(analysis, picks) {
        const style = 'color:#777; font-size:11px; margin:0 0 8px;';
        if (!this._isVerifyLive('all', analysis)) {
            return (
                `<div data-verify-bar="all" style="${style}">Verify: re-run the analysis to verify. A remembered ` +
                `result carries no simulation to re-measure.</div>`
            );
        }
        const running = this._verify.running;
        const busy = Boolean(running);
        const note = this._verify.notes.all;
        const top = VERIFY_DEFAULTS.top;
        return (
            `<div data-verify-bar="all" style="${style}">` +
            `<button data-af-verify-top ${busy || !picks.length ? 'disabled' : ''} title="${
                picks.length
                    ? 'Re-run the best improving rows longer, on fresh paired seeds'
                    : 'No improving row to verify'
            }" style="background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; padding:2px 8px; ` +
            `font-size:11px; cursor:${busy || !picks.length ? 'default' : 'pointer'}; font-family:inherit;">Verify top ${top}</button>` +
            `${running?.scope === 'all' ? ' <span>Verifying on fresh seeds… Stop cancels.</span>' : ''}` +
            `${note ? ` <span data-verify-note>${escapeHtmlAttribute(note)}</span>` : ''}</div>`
        );
    }

    /**
     * Verify one loadout group's best orders from the Ability order section.
     * @param {number} groupIndex - Index into the section's groups
     * @returns {Promise<void>}
     * @private
     */
    async _verifyOrderGroup(groupIndex) {
        const section = this._upgradeOrderSection;
        if (!this._isVerifyLive('order', section)) return;
        const group = section.groups?.[groupIndex];
        if (!group) return;
        const items = [];
        for (const order of group.orders) {
            if (items.length >= VERIFY_DEFAULTS.top) break;
            if (!(order.attemptsDelta < 0)) continue;
            const row = this._orderVerifyRow(groupIndex, order);
            if (row) items.push({ key: this._orderRowKey(groupIndex, order), row });
        }
        await this._runLabVerify({ scope: 'order', items });
    }

    /**
     * Draw the Tune triggers results box from the live run and the verify verdicts.
     * @private
     */
    _drawTriggerResults() {
        const live = this._verifyLive.trigger;
        const resultsEl = this.panel?.querySelector('#mwi-labsim-trigger-results');
        if (!live || !resultsEl) return;
        resultsEl.innerHTML = renderLabTriggerResultsHtml(live.run, live.gameData, {
            states: this._verify.trigger,
            busy: Boolean(this._verify.running),
        });
        resultsEl.style.display = 'block';
        resultsEl.querySelectorAll('[data-lab-trigger-verify]').forEach((button) => {
            button.addEventListener('click', () => this._verifyTriggerGroup(Number(button.dataset.labTriggerVerify)));
        });
    }

    /**
     * Verify one loadout's trigger recommendation on fresh seeds.
     * @param {number} index - Index into the live run's groups
     * @returns {Promise<void>}
     * @private
     */
    async _verifyTriggerGroup(index) {
        const live = this._verifyLive.trigger;
        const group = live?.run?.groups?.[index];
        if (!group || !canVerifyTriggerResult(group.result) || !this.panel) return;
        if (
            this._upgradeRunning ||
            this._skillingRunning ||
            this._runStarting ||
            this.isRunning ||
            this._verify.running
        ) {
            this._setStatus('Wait for the current run to finish, then verify.');
            return;
        }
        if (!this._stillSameCharacter(live.ownerId)) return;
        const frame = this._beginVerify(live.ownerId, false);
        const state = this._verify;
        state.running = { scope: 'trigger', keys: new Set([group.key]) };
        state.trigger.set(group.key, { running: true });
        this._setStatus(`Verifying ${group.name}'s trigger changes on fresh seeds. Stop cancels at any point.`);
        let out = null;
        let error = null;
        try {
            this._drawTriggerResults();
            out = await verifyTriggerChanges({
                result: group.result,
                conditions: group.conditions ?? null,
                seeds: VERIFY_DEFAULTS.seeds,
                hoursMultiplier: VERIFY_DEFAULTS.hoursMultiplier,
                abortSignal: () => !frame.isCurrent() || this._upgradeAborted,
                onProgress: frame.onProgress,
            });
        } catch (caught) {
            error = caught;
        }
        const current = frame.isCurrent();
        frame.finish();
        if (!current) return;
        const row = out?.rows?.[0] || null;
        let status;
        if (error) {
            console.error('[LabSimUI] Trigger verify failed:', error);
            state.trigger.set(group.key, { error: error.message });
            status = `Verify failed: ${error.message}`;
        } else if (out.refused) {
            state.trigger.set(group.key, { refused: out.refused });
            status = `Nothing to verify (${out.refused}).`;
        } else if (out.stopped && (!row || (row.verdict !== 'error' && !(row.seeds > 0)))) {
            // With no seed finished there is nothing to show (a cancelled simulation is no error row)
            state.trigger.delete(group.key);
            status = 'Verify stopped before any seed finished.';
        } else if (row?.verdict === 'error') {
            state.trigger.set(group.key, { row, error: row.error || out.error || 'unknown error' });
            status = `Verify failed: ${row.error || out.error || 'unknown error'}`;
        } else {
            state.trigger.set(group.key, {
                row,
                basis: out.basis,
                stopped: Boolean(out.stopped) && row.seeds < out.seeds,
            });
            status =
                `Verify: ${row.verdict === 'confirmed' ? 'confirmed' : row.verdict === 'worse' ? 'worse than the current triggers' : 'not confirmed'} ` +
                `(${row.seeds} fresh seeds)` +
                (out.stopped ? '. Stopped early; the partial result is marked.' : '.');
        }
        this._drawTriggerResults();
        this._setStatus(status);
    }

    /**
     * The element the Ability order section draws into, below the Upgrade results.
     * @returns {HTMLElement|null}
     * @private
     */
    _abilityOrderContainer() {
        return this.panel?.querySelector('#mwi-labsim-upgrade-order') || null;
    }

    /**
     * Draw (or clear) the Ability order section from `_upgradeOrderSection`. Kept apart from the Upgrade
     * results so a sort or a redraw of the table neither loses it nor is lost by it.
     * @private
     */
    _drawUpgradeAbilityOrder() {
        const el = this._abilityOrderContainer();
        if (!el) return;
        const section = this._upgradeOrderSection;
        if (!section) {
            el.innerHTML = '';
            el.style.display = 'none';
            return;
        }
        el.style.display = 'block';
        el.innerHTML = this._renderLabAbilityOrderSection(section);
        this._wireLabAbilityOrder(el, () => this._drawUpgradeAbilityOrder());
    }

    /**
     * The Include option's Ability order pass: every order of each loadout's ordinary abilities, simulated
     * against the fights the Targets scope named (the same fights, precision, hours, crates and buffs as the
     * rest of the run) and drawn as its own section. Stopping draws nothing, as it does for the table.
     * @param {Object} params
     * @param {Array<Object>} params.fights - The run's fights, `{ monsterHrid, monsterName, roomLevel, dto, loadoutName }`
     * @param {boolean} params.isSelf - Whether the loadouts are the live character's
     * @param {Array<Object>} [params.claimLoadouts] - Passed through to the analysis
     * @param {Object} params.gameData - Game data payload
     * @param {Array} params.crates - Selected crates
     * @param {number} params.hours - Simulated-hours ceiling
     * @param {Object} params.precision - Stopping rule
     * @param {Object} params.communityBuffs - Community buffs
     * @param {Array} params.labyrinthCombatBuffs - Token buffs
     * @param {number} params.startToken - `_runStartToken` of the run
     * @param {string} params.ownerId - Character the run began for
     * @param {boolean} params.orderOnly - Nothing else was checked, so the status line is this pass's alone
     * @param {Object|null} [params.savedAnalysis] - The run's own table result, saved again with the section
     * @returns {Promise<void>}
     * @private
     */
    async _runUpgradeAbilityOrder({
        fights,
        isSelf,
        claimLoadouts,
        gameData,
        crates,
        hours,
        precision,
        communityBuffs,
        labyrinthCombatBuffs,
        startToken,
        ownerId,
        orderOnly,
        savedAnalysis = null,
    }) {
        const isCurrent = () =>
            startToken === this._runStartToken && Boolean(this.panel) && this._stillSameCharacter(ownerId);
        const built = buildCombatAbilityOrderCandidates(
            fights.map((fight) => fight.dto),
            gameData,
            isSelf
        );
        let section;
        let rawOrder = null;
        if (!built.candidates.length) {
            // Fewer than two orderable abilities in every loadout: nothing to simulate
            section = { groups: [] };
        } else {
            const eta = createEtaTracker();
            this._setStatus(
                `Checking ability orders across ${fights.length} fight${fights.length === 1 ? '' : 's'}. Stop cancels at any point.`
            );
            const raw = await runLabyrinthAllFightsAnalysis(
                {
                    fights,
                    crates,
                    hours,
                    precision,
                    communityBuffs,
                    labyrinthCombatBuffs,
                    modes: [],
                    extraCandidates: built.candidates,
                    claimLoadouts,
                },
                ({ current, total, description }) => {
                    if (!isCurrent() || this._upgradeAborted) return;
                    const fill = this.panel?.querySelector('#mwi-labsim-upgrade-progress-fill');
                    const text = this.panel?.querySelector('#mwi-labsim-upgrade-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                    }
                },
                { abortSignal: () => !isCurrent() || this._upgradeAborted }
            );
            if (!isCurrent() || this._upgradeAborted) return;
            section = raw?.baseline
                ? extractAbilityOrderSection(raw, gameData).section || { groups: [], noResult: true }
                : { groups: [], noResult: true };
            rawOrder = raw;
        }
        this._upgradeOrderSection = section;
        if (rawOrder?.baseline && section.groups?.length)
            this._registerVerifyLive('order', { raw: rawOrder, section }, ownerId);
        this._drawUpgradeAbilityOrder();
        // The pass sets its own ending whether or not other sets ran first, so "Checking ability orders"
        // never outlives it. A stop is worded by the Stop button and an error by the caller
        const orders = section.groups.reduce((sum, group) => sum + group.orders.length, 0);
        const outcome = section.noResult
            ? 'Checking ability orders produced no results.'
            : section.groups.length
              ? `Ranked ${orders} ability order${orders === 1 ? '' : 's'} across ${fights.length} fight${fights.length === 1 ? '' : 's'}.`
              : 'Nothing to reorder: no loadout has two or more ordinary abilities.';
        this._setStatus(orderOnly ? outcome : `Upgrade analysis finished. ${outcome}`);
        // Remembered with the table so a reload brings the section back. An order-only run has no table, so
        // it is saved as an empty result set beside the section
        // A completed run saves whatever it found, an empty section included ("Nothing to reorder"): the
        // record is replaced whole, so skipping it would bring an older run's section back on reload
        if (this._stillSameCharacter(ownerId)) {
            const playerIndex = parseInt(this.panel.querySelector('#mwi-labsim-upgrade-player')?.value) || 0;
            saveUpgradeResults(LAB_UPGRADE_RESULTS_KEY, savedAnalysis || { results: [] }, {
                characterName: (this._editor?.getPlayerInfo?.() || [])[playerIndex]?.name || null,
                orderSection: section,
            });
        }
    }

    /**
     * The Ability order section of the Upgrade results (the Include option): every simulated order of a loadout's ordinary
     * abilities ranked by expected attempts saved, the Lab's own measure, with the current order as a baseline
     * row. One block per loadout, because each loadout's orders are permutations of its own abilities (one
     * table would interleave unrelated sets under a single ranking). Orders cost nothing, so there is no Cost
     * or Per 1M column. The collapsed state and Show-all live in the saved swap options.
     * @param {{groups: Array<Object>, noResult?: boolean}} section - From `extractAbilityOrderSection`
     * @returns {string} HTML
     * @private
     */
    _renderLabAbilityOrderSection(section) {
        const groups = section.groups || [];
        const orderCount = groups.reduce((sum, g) => sum + g.orders.length, 0);
        const showAll = Boolean(this._swapOptions.orderShowAll);
        const top = LAB_ABILITY_ORDER_TOP;
        const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '');
        const attemptsText = (v) => `${sign(v)}${Math.abs(v).toFixed(1)}`;
        const clearText = (v) => `${sign(v)}${Math.abs(v * 100).toFixed(2)}%`;
        const td = 'padding:3px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap; text-align:right;';
        const th = 'padding:3px 6px; text-align:right; border-bottom:1px solid #333; color:#888; font-weight:600;';
        const noteStyle = 'font-size:9px; margin-left:4px; padding:0 3px; border-radius:2px; vertical-align:middle;';
        const note = (text, color = '#aaa') =>
            `<div style="color:${color}; font-size:11px; margin:4px 0;">${text}</div>`;

        const bestOrderOf = (list) => list.find((o) => o.attemptsDelta < 0 && o.significant) || list[0] || null;
        // Verify: one button per loadout group, because each group is its own ranking of its own permutations
        // (one overall top 3 would be three orders of whichever loadout happens to lead, and the section already
        // keeps every loadout's orders apart)
        const verifyLive = this._isVerifyLive('order', section);
        const verifyRunning = this._verify.running;
        const verdictOf = (gi, order) => this._verify.order.get(this._orderRowKey(gi, order)) || null;
        // The confirmed order with the largest verified saving, the one the section should lead with
        const confirmedOf = (gi, orders) =>
            orders
                .map((o) => ({ order: o, verdict: verdictOf(gi, o) }))
                .filter((x) => x.verdict?.verdict === 'confirmed')
                .sort((a, b) => a.verdict.mean - b.verdict.mean)[0] || null;
        const blocks = groups.map((group, gi) => {
            const orders = group.orders;
            // Best significant improving order; a noisy top must not hide a significant later one
            const best = bestOrderOf(orders);
            const confirmed = confirmedOf(gi, orders);
            let verdict = '';
            if (confirmed) {
                verdict = note(
                    `Confirmed on fresh seeds: ${escapeHtmlAttribute(confirmed.order.name)} (` +
                        `${attemptsText(confirmed.verdict.mean)} ± ${confirmed.verdict.se.toFixed(2)} attempts).`,
                    '#4caf50'
                );
            } else if (!orders.length) {
                verdict = note('No other order of these abilities was reached.', '#888');
            } else if (best.attemptsDelta >= 0) {
                verdict = note('Your current order is already the best measured.', '#9ab');
            } else if (!best.significant) {
                verdict = note(
                    'Every order is within noise of your current one: none is clearly better, so keep it.',
                    '#9ab'
                );
            }
            const entries = [...orders, { current: true, attemptsDelta: 0 }].sort(
                (a, b) => a.attemptsDelta - b.attemptsDelta || (a.current ? -1 : 1)
            );
            let kept = 0;
            const shown = showAll ? entries : entries.filter((e) => e.current || ++kept <= top);
            let rows = '';
            for (const e of shown) {
                if (e.current) {
                    rows +=
                        `<tr data-order-current style="background:rgba(120,150,190,0.08);">` +
                        `<td style="${td} text-align:left; white-space:normal; color:#e0e0e0;">${escapeHtmlAttribute(group.currentName)}` +
                        `<span style="${noteStyle} background:rgba(120,150,190,0.25); color:#9ab;">current</span></td>` +
                        `<td style="${td} color:#888;">baseline</td><td style="${td} color:#888;">—</td>` +
                        `<td style="${td} color:#888;">—</td></tr>`;
                    continue;
                }
                const color = !e.significant ? '#888' : e.attemptsDelta < 0 ? '#4caf50' : '#f44336';
                const clearColor = !e.significant
                    ? '#888'
                    : e.runClearDelta > 0
                      ? '#4caf50'
                      : e.runClearDelta < 0
                        ? '#f44336'
                        : '#888';
                rows +=
                    `<tr data-order-row>` +
                    `<td style="${td} text-align:left; white-space:normal; color:#e0e0e0;">${escapeHtmlAttribute(e.name)}` +
                    (e.significant
                        ? ''
                        : `<span style="${noteStyle} background:rgba(150,150,150,0.2); color:#999;" title="The change is inside the simulation’s own error">within noise</span>`) +
                    (verifyRunning?.scope === 'order' && verifyRunning.keys.has(this._orderRowKey(gi, e))
                        ? '<span data-verify-running style="color:#8ab4f8; font-size:10px; margin-left:6px;">verifying…</span>'
                        : verdictOf(gi, e)
                          ? verifyChipHtml(verdictOf(gi, e), { partial: verdictOf(gi, e).partial })
                          : '') +
                    `</td><td style="${td} color:${color};">${attemptsText(e.attemptsDelta)}</td>` +
                    `<td style="${td} color:${clearColor};">${clearText(e.runClearDelta)}</td>` +
                    `<td style="${td} color:#888;">±${e.attemptsDeltaNoise.toFixed(1)}</td></tr>`;
            }
            const title =
                groups.length > 1
                    ? `<div style="color:#aaa; font-size:11px; margin-top:6px;">${escapeHtmlAttribute(group.loadoutName)}</div>`
                    : '';
            const improving = orders.filter((o) => o.attemptsDelta < 0);
            const verifyBusy = Boolean(verifyRunning);
            const verifyButton =
                verifyLive && improving.length
                    ? `<div style="margin:4px 0;"><button data-order-verify="${gi}" ${verifyBusy ? 'disabled' : ''} ` +
                      `title="Re-run this loadout's best improving orders longer, on fresh paired seeds" ` +
                      `style="background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ` +
                      `padding:2px 8px; font-size:11px; cursor:${verifyBusy ? 'default' : 'pointer'}; font-family:inherit;">` +
                      `Verify top ${Math.min(VERIFY_DEFAULTS.top, improving.length)}</button>` +
                      `${verifyRunning?.scope === 'order' ? ' <span style="color:#8ab4f8; font-size:11px;">Verifying on fresh seeds… Stop cancels.</span>' : ''}</div>`
                    : '';
            return (
                title +
                verdict +
                verifyButton +
                `<table style="width:100%; border-collapse:collapse; font-size:11px;"><thead><tr>` +
                `<th style="${th} text-align:left;">Order</th>` +
                `<th style="${th}" title="Change in expected attempts to clear this loadout’s fights; negative is better">ΔExpected attempts</th>` +
                `<th style="${th}" title="Change in the chance of clearing this loadout’s fights in one go">ΔClear chance</th>` +
                `<th style="${th}" title="One standard error of the change in expected attempts">Noise</th></tr></thead>` +
                `<tbody>${rows}</tbody></table>`
            );
        });

        const bests = groups.map((g) => bestOrderOf(g.orders)).filter(Boolean);
        const improving = bests.filter((b) => b.attemptsDelta < 0 && b.significant);
        let summary;
        // A confirmed order outranks a merely significant one: it survived a longer run on fresh seeds
        const confirmedBests = groups.map((g, gi) => confirmedOf(gi, g.orders)).filter(Boolean);
        if (section.noResult) summary = 'no order measured';
        else if (!groups.length) summary = 'nothing to reorder';
        else if (!bests.length) summary = 'no order reached';
        else if (confirmedBests.length) {
            const winner = confirmedBests.reduce((a, b) => (b.verdict.mean < a.verdict.mean ? b : a));
            summary = `best confirmed ${attemptsText(winner.verdict.mean)} attempts`;
        } else if (improving.length) {
            const winner = improving.reduce((a, b) => (b.attemptsDelta < a.attemptsDelta ? b : a));
            summary = `best ${attemptsText(winner.attemptsDelta)} attempts`;
        } else if (bests.some((b) => b.attemptsDelta < 0)) summary = 'all within noise';
        else summary = 'current order is best';

        const body = groups.length
            ? blocks.join('')
            : note(
                  section.noResult
                      ? 'No ability order could be measured: the simulation returned no baseline.'
                      : 'Nothing to reorder: no loadout has two or more ordinary abilities.',
                  '#888'
              );
        const improvable = groups.some((g) => g.orders.some((o) => o.attemptsDelta < 0));
        let verifyNote = '';
        if (this._verify.notes.order) {
            verifyNote = `<div data-verify-note style="color:#9ab; font-size:11px; margin:4px 0;">${escapeHtmlAttribute(this._verify.notes.order)}</div>`;
        } else if (!verifyLive && improvable) {
            verifyNote =
                '<div data-verify-note style="color:#777; font-size:11px; margin:4px 0;">Verify: re-run the analysis to ' +
                'verify. A remembered result carries no simulation to re-measure.</div>';
        }
        const needsToggle = groups.some((g) => g.orders.length > top);
        const toggle = needsToggle
            ? `<button data-order-showall style="background:#1a1a2e; color:#8ab4f8; border:1px solid #333; border-radius:3px; ` +
              `padding:2px 8px; font-size:11px; cursor:pointer; font-family:inherit; margin-top:6px;">` +
              `${showAll ? `Show top ${top}` : `Show all ${orderCount}`}</button>`
            : '';
        return (
            `<div id="mwi-labsim-order-section" style="margin-top:14px; padding:8px 10px; background:#0d0d1a; ` +
            `border:1px solid #2a2a4a; border-radius:6px;">` +
            collapseHeaderHtml({
                key: 'abilityOrder',
                title: 'Ability order',
                summary,
                style: `color:${ACCENT}; font-size:12px; font-weight:600; margin-bottom:2px;`,
            }) +
            `<div style="color:#666; font-size:10px; margin-bottom:6px;">Every order of each loadout’s ordinary abilities, ` +
            `simulated and ranked by expected attempts saved. Free to apply: set it in the game.</div>` +
            verifyNote +
            body +
            toggle +
            `</div>`
        );
    }

    /**
     * Wire the Ability order section's collapse header and Show-all toggle. The collapsed state is part of the
     * saved Check a swap options; Show-all redraws the results through `redraw`.
     * @param {HTMLElement} container - The results element
     * @param {Function} redraw - Draws the results again
     * @private
     */
    _wireLabAbilityOrder(container, redraw) {
        const map = this._swapOptions.orderCollapsed ? { abilityOrder: true } : {};
        enhanceCollapsibles(container, map, () => {
            this._swapOptions.orderCollapsed = Boolean(map.abilityOrder);
            this._swapOptionChanged(['orderCollapsed']);
        });
        container.querySelectorAll('[data-order-verify]').forEach((button) => {
            button.addEventListener('click', () => this._verifyOrderGroup(Number(button.dataset.orderVerify)));
        });
        container.querySelector('[data-order-showall]')?.addEventListener('click', () => {
            this._swapOptions.orderShowAll = !this._swapOptions.orderShowAll;
            this._swapOptionChanged(['orderShowAll']);
            redraw();
        });
    }

    /**
     * Render the all-fights combat level analysis: candidates ranked by how
     * many expected combat attempts they save across the whole run (retrying
     * failed rooms), with a per-fight breakdown on click.
     * @private
     */
    _renderAllFightsResults(analysisResult, container, options = {}) {
        // The "Checked swaps" table above the generated one: the same columns,
        // sorting and per-fight breakdown, but no budget plan, no token section
        // and no CSV or status line, which belong to the generated run
        const checked = Boolean(options.checked);
        const baseline = analysisResult?.baseline;
        const results = analysisResult?.results;
        if (!baseline || !results?.length) {
            container.innerHTML = checked
                ? ''
                : '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No results — check that combat skip levels and loadouts are set.</div>';
            if (!checked) this._setStatus('All-fights analysis produced no results.');
            return;
        }

        // Kept so a header click can re-render without re-running the analysis
        if (!checked) {
            this._allFightsResult = analysisResult;
            this._allFightsContainer = container;
        }

        // Two currencies, two sections — the same split the Configure fight's
        // table makes. A token buff has no coin price at all, so it cannot share
        // a Cost column, a Per 1M column or the budget planner with the gear.
        // And a third for combat levels: they are paid for in grind time, so the
        // gear table's Cost and Per 1M columns have nothing to say about them
        const tokenResults = results.filter((r) => r.costType === 'token');
        const levelResults = checked ? [] : results.filter((r) => r.candidate?.type === 'combat_level');
        const goldResults = results.filter((r) => r.costType !== 'token' && !levelResults.includes(r));
        const levelsOnly = levelResults.length > 0 && !goldResults.length;

        const pct = (v) => `${(v * 100).toFixed(1)}%`;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const deltaColor = (v) => (v > 0.0001 ? '#4caf50' : v < -0.0001 ? '#f44336' : '#888');
        // Fewer expected attempts = better, so the good direction is negative
        const attemptsDeltaColor = (v) => (v < -0.05 ? '#4caf50' : v > 0.05 ? '#f44336' : '#888');
        const fmtAttempts = (v) => v.toFixed(1);
        // Per-million values run small — two decimals would print most of them
        // as 0.00, which reads as "no value" rather than "a modest one"
        const fmtPerMillion = (v) => (v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2));
        const fmtAttemptsDelta = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
        const expectedTries = (winRate) => 1 / Math.max(winRate, 0.001);
        // Sticky needs an opaque background or rows scroll through the header.
        // The offset is the results pane's own padding, so the header parks flush
        // with the top of the scroll area rather than floating below it.
        const thStyle =
            'padding:4px 6px; text-align:left; border-bottom:1px solid #333; color:#888; font-weight:600; ' +
            'white-space:nowrap; position:sticky; top:-10px; z-index:2; background:#12121f;';
        const tdStyle = 'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:nowrap;';
        // Only the Upgrade name reflows; a two-piece swap label is long enough
        // to push every measured column off the panel if it is kept to one line
        const tdNameStyle =
            'padding:4px 6px; border-bottom:1px solid #1a1a2e; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';
        const bestDelta = Math.min(...goldResults.map((r) => r.attemptsDelta));
        const sharedStyles = { thStyle, tdStyle, tdNameStyle, fmtAttempts, fmtAttemptsDelta, attemptsDeltaColor };

        // What each column sorts by, and which way round is "good" — clicking
        // Cost wants the cheapest first, clicking Avg ΔWin the biggest gain
        const SORTS = {
            upgrade: { get: (r) => r.candidate?.description || '', dir: 'asc' },
            cost: { get: (r) => r.cost, dir: 'asc' },
            perMillion: { get: (r) => r.attemptsSavedPerMillion, dir: 'desc' },
            attempts: { get: (r) => r.expectedAttempts, dir: 'asc' },
            attemptsDelta: { get: (r) => r.attemptsDelta, dir: 'asc' },
            rooms: { get: (r) => r.appliedFights ?? r.fights.length, dir: 'desc' },
            avgWinDelta: { get: (r) => r.avgWinDelta, dir: 'desc' },
        };
        const sort = checked ? this._checkedSwapSort : this._allFightsSort;
        const sorted = goldResults.slice();
        if (sort && SORTS[sort.key]) {
            const { get } = SORTS[sort.key];
            const sign = sort.dir === 'asc' ? 1 : -1;
            sorted.sort((a, b) => {
                const av = get(a);
                const bv = get(b);
                // A candidate with no coin price sorts last either way rather
                // than pretending to be free or infinitely expensive
                if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
                if (bv === null || bv === undefined) return -1;
                if (typeof av === 'string') return sign * av.localeCompare(bv);
                return sign * (av - bv);
            });
        }
        const arrow = (key) => (sort?.key === key ? (sort.dir === 'asc' ? ' \u25B2' : ' \u25BC') : '');
        const th = (key, label, title) =>
            `<th data-af-sort="${key}" style="${thStyle} cursor:pointer; user-select:none;" title="${title}">` +
            `${label}${arrow(key)}</th>`;

        let html = checked
            ? this._checkedHeadingHtml('combat')
            : levelsOnly
              ? ''
              : this._renderBudgetPlan(goldResults, baseline);
        html += `
            <div style="margin-bottom:8px; font-size:12px; color:#888;">
                Baseline: <span style="color:#e0e0e0; font-weight:700;">${fmtAttempts(baseline.expectedAttempts)}</span>
                expected combat attempts to clear all ${baseline.fights.length} fights
                <span style="color:#555; font-size:10px; margin-left:6px;">Σ 1/win rate per fight, at its skip level with its assigned loadout — retries included</span>
            </div>
            `;
        // Verify top N: the first rows of this table, in the order it is showing, that the analysis found improving
        const verifyPicks = checked ? [] : sorted.filter((r) => r.attemptsDelta < 0).slice(0, VERIFY_DEFAULTS.top);
        const verifyLive = !checked && this._isVerifyLive('all', analysisResult);
        if (!checked && !levelsOnly) html += this._allFightsVerifyBarHtml(analysisResult, verifyPicks);
        // A run of nothing but combat levels has no gear to table
        if (!levelsOnly)
            html += `<table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                ${th('upgrade', 'Upgrade', 'Sort by name')}
                ${th('cost', 'Cost', 'What it would cost in coins. Combat levels cost experience, not gold.')}
                ${th('perMillion', 'Per 1M', 'Attempts saved across a whole run per million coins spent — the value figure. Blank where there is no coin price; "pays for itself" where selling the replaced piece covers the purchase.')}
                ${th('attempts', 'Attempts', 'Expected combat attempts to clear every fight once (retrying failed rooms)')}
                ${th('attemptsDelta', 'ΔAttempts', 'Change in expected attempts vs baseline — negative is better. The ± is one standard error of the simulation; a change smaller than about twice that has not been measured, and is shown grey.')}
                ${th('rooms', 'Rooms', 'How many fights this upgrade actually reaches. A combat level is every fight; a piece of gear only the loadouts that wear what it replaces.')}
                ${th('avgWinDelta', 'Avg ΔWin', 'Average win rate change across the rooms it reaches')}
            </tr></thead><tbody>`;

        // The per-fight breakdown under a row, the same for gear and combat levels
        const fightBreakdown = (r) => {
            let fightRows = '';
            for (let f = 0; f < r.fights.length; f++) {
                const fight = r.fights[f];
                const base = baseline.fights[f];
                const triesBase = expectedTries(base.winRate);
                const triesNew = expectedTries(fight.winRate);
                // Untouched rooms are named rather than dropped: "this upgrade
                // does nothing here" is an answer, and a fight missing from the
                // list looks like a fight that was not run
                const outcome =
                    fight.applied === false
                        ? `<span style="color:#666;">${fight.skipReason || 'not in this loadout'} — ${pct(base.winRate)} unchanged</span>`
                        : `${pct(base.winRate)} → ${pct(fight.winRate)}
                        <span style="color:${deltaColor(fight.winRateDelta)};">(${deltaPct(fight.winRateDelta)})</span>
                        <span style="color:#666;">| ${fmtAttempts(triesBase)} → ${fmtAttempts(triesNew)} tries` +
                          `${fight.replaced ? `, over ${fight.replaced}` : ''}${fight.note ? `, ${fight.note}` : ''}</span>`;
                fightRows += `<div style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">
                    <span style="color:#aaa;">${fight.monsterName} <span style="color:#666;">(Lv ${fight.roomLevel}, "${fight.loadoutName}")</span></span>
                    <span style="white-space:nowrap;">${outcome}</span>
                </div>`;
            }
            return fightRows;
        };
        sharedStyles.fightBreakdown = fightBreakdown;

        if (!levelsOnly)
            sorted.forEach((r, i) => {
                const isBest = r.attemptsDelta === bestDelta && bestDelta < -0.05;
                const attemptsStyle = isBest ? 'color:#4caf50; font-weight:700;' : '';
                // A dash rather than a zero where there is no coin price: a combat
                // level is not free, it is paid for in experience, and a zero here
                // would read as "costs nothing" instead of "not a coin question"
                // Negative is real: a swap whose sold piece brings back more than
                // the new one costs is a credit, not a row with no price
                const cost =
                    r.cost > 0
                        ? formatKMB(r.cost)
                        : r.cost === 0
                          ? 'free'
                          : Number.isFinite(r.cost)
                            ? `+${formatKMB(-r.cost)} back`
                            : '—';
                // How many rooms it reaches — a sword upgrade is only about the
                // loadouts carrying that sword, and a row that does not say so
                // reads as an upgrade to the whole run
                const reach = r.appliedFights ?? r.fights.length;
                const total = r.fights.length;
                const perGold =
                    r.attemptsSavedPerMillion === null
                        ? '—'
                        : r.attemptsSavedPerMillion === Infinity
                          ? 'pays for itself'
                          : `${r.attemptsSavedPerMillion >= 0 ? '' : '−'}${fmtPerMillion(Math.abs(r.attemptsSavedPerMillion))}`;
                // A change smaller than the sampling error of the sims behind it has
                // not been measured — coloring it green sells an upgrade on noise
                const measured = r.significant !== false;
                const noise =
                    r.attemptsDeltaNoise > 0
                        ? ` <span style="color:#555;">±${r.attemptsDeltaNoise.toFixed(1)}</span>`
                        : '';
                html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-row="${i}">
                <td style="${tdNameStyle}${measured ? '' : ' opacity:0.55;'}">${r.candidate.description}${combatSimUI.upgradeRowActionsHtml(r)}${
                    checked ? '' : this._verifyRowHtml('all', this._allRowKey(r), 'data-af-verify', i, verifyLive)
                }</td>
                <td style="${tdStyle} color:#aaa;">${cost}</td>
                <td style="${tdStyle} color:${measured && r.attemptsSavedPerMillion > 0 ? '#4caf50' : '#888'}; font-weight:600;">${perGold}</td>
                <td style="${tdStyle} ${attemptsStyle}">${fmtAttempts(r.expectedAttempts)}</td>
                <td style="${tdStyle} color:${measured ? attemptsDeltaColor(r.attemptsDelta) : '#666'}; ${isBest && measured ? 'font-weight:700;' : ''}"
                    title="${measured ? '' : 'Smaller than the simulation’s own error — not a measured gain'}">${fmtAttemptsDelta(r.attemptsDelta)}${noise}</td>
                <td style="${tdStyle} color:${reach === total ? '#888' : '#8ab4f8'};">${reach} / ${total}</td>
                <td style="${tdStyle} color:${deltaColor(r.avgWinDelta)};">${deltaPct(r.avgWinDelta)}</td>
            </tr>`;

                // Per-fight breakdown (hidden until the row is clicked)
                const fightRows = fightBreakdown(r);
                html += `<tr data-allfights-detail="${i}" style="display:none;">
                <td colspan="7" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">
                    ${fightRows}${this._renderAllFightsNotes(r)}</td>
            </tr>`;
            });

        if (!levelsOnly) html += '</tbody></table>';
        const levelSorted = checked ? [] : this._sortedLevelRows(levelResults);
        if (!checked) html += this._renderAllFightsLevelSection(levelSorted, sharedStyles);
        if (!checked) html += this._renderAllFightsTokenSection(tokenResults, sharedStyles);
        container.innerHTML = html;
        if (checked) this._wireCheckedHeading('combat', container);

        if (!checked)
            this._addCsvExport(container, 'labsim-all-fights', () => ({
                columns: [
                    { key: 'upgrade', label: 'Upgrade' },
                    { key: 'type', label: 'Type' },
                    { key: 'cost', label: 'Cost' },
                    { key: 'perMillion', label: 'Attempts saved per 1M' },
                    { key: 'attempts', label: 'Expected attempts' },
                    { key: 'attemptsDelta', label: 'Change in attempts' },
                    { key: 'attemptsNoise', label: 'Change std error' },
                    { key: 'measured', label: 'Above noise' },
                    { key: 'roomsApplied', label: 'Rooms reached' },
                    { key: 'roomsTotal', label: 'Rooms total' },
                    { key: 'avgWinDelta', label: 'Avg win rate change' },
                    { key: 'tokenCost', label: 'Token cost' },
                    { key: 'levelTimeHours', label: 'Hours to level' },
                    { key: 'hoursPerAttemptSaved', label: 'Hours per attempt saved' },
                    { key: 'levelScore', label: 'Combat levels score' },
                ],
                // Raw numbers rather than the formatted cells: a spreadsheet cannot
                // sort "1.2B" or sum "+0.32%". Both sections, since a spreadsheet
                // has no trouble holding two currencies in two columns.
                rows: [...sorted, ...levelSorted, ...tokenResults].map((r) => ({
                    upgrade: r.candidate?.description || '',
                    type: r.costType === 'token' ? 'token buff' : isLevelRow(r) ? 'combat level' : 'gear',
                    cost: r.cost ?? null,
                    // Infinity does not survive a spreadsheet; the credit-funded
                    // row's value figure is its (negative) cost column
                    perMillion: r.attemptsSavedPerMillion === Infinity ? null : (r.attemptsSavedPerMillion ?? null),
                    attempts: r.expectedAttempts,
                    attemptsDelta: r.attemptsDelta,
                    attemptsNoise: r.attemptsDeltaNoise ?? null,
                    measured: r.significant !== false,
                    roomsApplied: r.appliedFights ?? r.fights.length,
                    roomsTotal: r.fights.length,
                    avgWinDelta: r.avgWinDelta,
                    tokenCost: r.tokenCost ?? null,
                    levelTimeHours: isLevelRow(r) && Number.isFinite(r.levelTimeHours) ? r.levelTimeHours : null,
                    hoursPerAttemptSaved: isLevelRow(r) ? finiteOrNull(levelHoursPerAttemptSaved(r)) : null,
                    levelScore: isLevelRow(r) && r.score > 0 ? r.score : null,
                })),
            }));

        container.querySelector('[data-af-verify-top]')?.addEventListener('click', () => {
            this._runLabVerify({
                scope: 'all',
                items: verifyPicks.map((row) => ({ key: this._allRowKey(row), row })),
            });
        });
        container.querySelectorAll('[data-af-verify]').forEach((button) => {
            button.addEventListener('click', (event) => {
                // The row itself toggles its per-fight breakdown
                event.stopPropagation();
                const row = sorted[Number(button.dataset.afVerify)];
                if (row) this._runLabVerify({ scope: 'all', items: [{ key: this._allRowKey(row), row }] });
            });
        });
        container.querySelectorAll('[data-allfights-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(`[data-allfights-detail="${row.dataset.allfightsRow}"]`);
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });
        container.querySelectorAll('[data-allfights-level-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(
                    `[data-allfights-level-detail="${row.dataset.allfightsLevelRow}"]`
                );
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });
        container.querySelectorAll('[data-af-level-sort]').forEach((header) => {
            header.addEventListener('click', () => {
                const key = header.dataset.afLevelSort;
                const standing = this._allFightsLevelSort || LEVEL_SORT_DEFAULT;
                this._allFightsLevelSort =
                    standing.key === key
                        ? { key, dir: standing.dir === 'asc' ? 'desc' : 'asc' }
                        : { key, dir: LEVEL_SORTS[key].dir };
                this._renderAllFightsResults(this._allFightsResult, container, options);
            });
        });
        container.querySelectorAll('[data-allfights-token-row]').forEach((row) => {
            row.addEventListener('click', () => {
                const detail = container.querySelector(
                    `[data-allfights-token-detail="${row.dataset.allfightsTokenRow}"]`
                );
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                }
            });
        });

        if (checked) {
            combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');
        } else {
            this._wireBudgetPlan(container, goldResults, baseline);
        }

        container.querySelectorAll('[data-af-sort]').forEach((header) => {
            header.addEventListener('click', () => {
                const key = header.dataset.afSort;
                // Second click on the same column reverses it; a new column
                // starts at whichever end of it is the good news
                const standing = checked ? this._checkedSwapSort : this._allFightsSort;
                const next =
                    standing?.key === key
                        ? { key, dir: standing.dir === 'asc' ? 'desc' : 'asc' }
                        : { key, dir: SORTS[key].dir };
                if (checked) this._checkedSwapSort = next;
                else this._allFightsSort = next;
                this._renderAllFightsResults(checked ? analysisResult : this._allFightsResult, container, options);
            });
        });

        // A redraw for a verdict leaves the status line to the verify run that caused it
        if (checked || options.quiet) return;
        const budget = analysisResult.budget;
        this._setStatus(
            `All-fights analysis complete: ${results.length} upgrades across ${baseline.fights.length} fights` +
                (budget?.sims ? `, ${budget.sims.toLocaleString()} simulations` : '') +
                (budget?.reduced
                    ? ` at ${Math.round(budget.trialScale * 100)}% of the ${budget.requestedHours}h per fight — every fight simulated, win rates noisier.`
                    : '.') +
                describeArchetypes(analysisResult.archetypes) +
                (this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '')
        );
    }

    /**
     * The combat-level rows of a whole-run table, scored and in the order the
     * Combat levels table sorts them. Scoring writes `score` onto the rows, so
     * the CSV export reads the same figure the table shows.
     *
     * @param {Array<Object>} levelResults - Rows whose candidate is a combat level
     * @returns {Array<Object>} The same rows, sorted
     * @private
     */
    _sortedLevelRows(levelResults) {
        if (!levelResults?.length) return [];
        combatSimUI.applyScoreScale(levelResults, combatSimUI.DEFAULT_LEVEL_SCORE_SCALE, {
            metrics: LEVEL_SCORE_METRICS,
            keys: LEVEL_SCORE_METRICS.map((metric) => metric.key),
        });
        const sort = this._allFightsLevelSort || LEVEL_SORT_DEFAULT;
        const { get } = LEVEL_SORTS[sort.key] || LEVEL_SORTS[LEVEL_SORT_DEFAULT.key];
        const sign = sort.dir === 'asc' ? 1 : -1;
        return levelResults.slice().sort((a, b) => {
            const av = get(a);
            const bv = get(b);
            // A row with no figure in the column sorts last whichever way round
            const aMissing = av === null || av === undefined || !(typeof av === 'string' || Number.isFinite(av));
            const bMissing = bv === null || bv === undefined || !(typeof bv === 'string' || Number.isFinite(bv));
            if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
            if (typeof av === 'string') return sign * av.localeCompare(bv);
            return sign * (av - bv);
        });
    }

    /**
     * The combat levels of a whole-run table, as their own section.
     *
     * Levels are not bought, so the gear table's Cost and Per 1M columns have
     * nothing to say about them. They are paid for in grind time instead, and
     * the figure that ranks them is how many hours of that grind each expected
     * attempt saved costs. Modelled on the Combat Sim's Combat levels table.
     *
     * @param {Array<Object>} levelRows - Scored, sorted level rows (`_sortedLevelRows`)
     * @param {Object} styles - The shared cell styles and formatters
     * @returns {string} HTML, empty when the run ranked no combat levels
     * @private
     */
    _renderAllFightsLevelSection(levelRows, styles) {
        if (!levelRows?.length) return '';
        const { thStyle, tdStyle, tdNameStyle, fmtAttemptsDelta, attemptsDeltaColor, fightBreakdown } = styles;
        const sort = this._allFightsLevelSort || LEVEL_SORT_DEFAULT;
        const arrow = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' \u25B2' : ' \u25BC') : '');
        const th = (key, label, title) =>
            `<th data-af-level-sort="${key}" style="${thStyle} cursor:pointer; user-select:none;" title="${title}">` +
            `${label}${arrow(key)}</th>`;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const deltaColor = (v) => (v > 0.0001 ? '#4caf50' : v < -0.0001 ? '#f44336' : '#888');
        const fmtLevelTime = (h) => {
            if (!Number.isFinite(h)) return '\u2014';
            if (h < 24) return `${h.toFixed(1)}h`;
            return `${(h / 24).toFixed(1)}d`;
        };
        const label = (skill) => skill.charAt(0).toUpperCase() + skill.slice(1);
        const scoreTitle =
            combatSimUI.scoreScaleTitle(
                combatSimUI.DEFAULT_LEVEL_SCORE_SCALE,
                'Hours per attempt saved and Avg \u0394Win'
            ) + ' Both columns count equally.';
        const primaryNames = [...new Set(levelRows.flatMap((r) => r.primarySkills || []))];
        const primaryNote = primaryNames.length
            ? ` Your weapon trains ${primaryNames.map(label).join(' / ')} with 30% of all combat XP whatever charm is worn, so each row also shows where that skill lands by the time the grind is done \u2014 the \u0394 columns are for both together.`
            : '';
        const bestDelta = Math.min(...levelRows.map((r) => r.attemptsDelta));

        let html = `<div style="margin-top:14px; padding:8px 10px; background:#0d0d1a; border:1px solid #2a2a4a; border-radius:6px;">
            <div style="color:${ACCENT}; font-size:12px; font-weight:600; margin-bottom:2px;">Combat levels</div>
            <div style="color:#666; font-size:10px; margin-bottom:6px;">
                Levels can't be bought, so these are ranked by hours of grind per expected attempt saved (lower is
                better), not against the gold costs above. Level time assumes you train that skill at the XP rates
                your fights earn now, and each row is one step on its own \u2014 they don't stack.${primaryNote}
            </div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                ${th('skill', 'Skill', 'Sort by name')}
                ${th('time', 'Level Time', 'Hours of combat, at the XP rates your fights earn now, to earn these levels')}
                ${th('attemptsDelta', '\u0394Attempts', 'Change in expected attempts vs baseline \u2014 negative is better. The \u00B1 is one standard error of the simulation. Includes the weapon\u2019s own skill where the same hours carry it.')}
                ${th('hoursPer', 'Hours / attempt saved', 'Level Time divided by the attempts saved. Lower is better; a dash where the levels save nothing.')}
                ${th('rooms', 'Rooms', 'How many fights this reaches. A combat level is every fight.')}
                ${th('avgWinDelta', 'Avg \u0394Win', 'Average win rate change across the rooms it reaches')}
                <th data-af-level-sort="score" style="${thStyle} cursor:pointer; user-select:none; color:${ACCENT};" title="${scoreTitle}">Score<br>${combatSimUI.scoreDepthLabel(combatSimUI.DEFAULT_LEVEL_SCORE_SCALE)}${arrow('score')}</th>
            </tr></thead><tbody>`;

        levelRows.forEach((r, i) => {
            const measured = r.significant !== false;
            const noise =
                r.attemptsDeltaNoise > 0
                    ? ` <span style="color:#555;">\u00B1${r.attemptsDeltaNoise.toFixed(1)}</span>`
                    : '';
            const reach = r.appliedFights ?? r.fights.length;
            const total = r.fights.length;
            const hoursPer = levelHoursPerAttemptSaved(r);
            const along = Array.isArray(r.alongside) ? r.alongside : [];

            // Where the weapon's own skill lands, under the skill name
            let alongLine = '';
            if (along.length) {
                alongLine = along
                    .map(
                        (a) =>
                            `<div style="color:#777; font-size:10px;">+ ${a.label} ${a.currentLevel} \u2192 ${a.upgradeLevel} along the way${
                                a.fights < total ? ` (trained in ${a.fights} of ${total} rooms)` : ''
                            }</div>`
                    )
                    .join('');
            } else if (r.isMainSkill) {
                alongLine = `<div style="color:#555; font-size:10px;">your weapon's own skill</div>`;
            } else if (r.primarySkills?.length) {
                alongLine = `<div style="color:#555; font-size:10px;">${r.primarySkills.map(label).join(' / ')} gains no level along the way</div>`;
            }
            const timeTitle = Number.isFinite(r.levelTimeHours)
                ? 'Grinding time at the XP rates your fights earn now, to earn these levels'
                : 'No XP accrues in this skill in these fights';
            const deltaTitle = along.length
                ? `\u0394 is for both together: ${r.candidate.description}, ${along.map((a) => `${a.label} ${a.currentLevel} \u2192 ${a.upgradeLevel}`).join(', ')}`
                : '';
            const scoreColor = combatSimUI.scoreValueColor(r.score);
            const isBest = r.attemptsDelta === bestDelta && bestDelta < -0.05;

            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-level-row="${i}">
                <td style="${tdNameStyle}${measured ? '' : ' opacity:0.55;'}">${r.candidate.description}${alongLine}</td>
                <td style="${tdStyle}" title="${timeTitle}">${fmtLevelTime(r.levelTimeHours)}</td>
                <td style="${tdStyle} color:${measured ? attemptsDeltaColor(r.attemptsDelta) : '#666'}; ${isBest && measured ? 'font-weight:700;' : ''}"
                    title="${measured ? deltaTitle : 'Smaller than the simulation\u2019s own error \u2014 not a measured gain'}">${fmtAttemptsDelta(r.attemptsDelta)}${noise}</td>
                <td style="${tdStyle}" data-level-hours-per>${combatSimUI.formatCompactHours(hoursPer)}</td>
                <td style="${tdStyle} color:${reach === total ? '#888' : '#8ab4f8'};">${reach} / ${total}</td>
                <td style="${tdStyle} color:${deltaColor(r.avgWinDelta)};">${deltaPct(r.avgWinDelta)}</td>
                <td style="${tdStyle}${scoreColor ? ` color:${scoreColor};` : ''}" data-level-score>${combatSimUI.formatScore(r.score)}</td>
            </tr>
            <tr data-allfights-level-detail="${i}" style="display:none;">
                <td colspan="7" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">
                    ${fightBreakdown(r)}${this._renderAllFightsNotes(r)}</td>
            </tr>`;
        });
        return html + '</tbody></table></div>';
    }

    /**
     * The labyrinth token buffs, as their own section of a whole-run table.
     *
     * A section rather than more rows in the gear table, for the reason the
     * Configure fight has always split them: the two are paid for in different
     * currencies. A token buff has no coin price, so it cannot share a Cost
     * column, it cannot be ranked on attempts-per-million, and it cannot be
     * planned around by a budget in gold. What it can be ranked on is its own
     * currency, which is what the last column does.
     *
     * Unsorted by the table's own header clicks: those belong to the gear table
     * above, and four rows sorted by the analysis's own best-first order need no
     * affordance of their own.
     *
     * @param {Array<Object>} tokenResults - Rows with `costType === 'token'`
     * @param {Object} styles - The shared cell styles and formatters
     * @returns {string} HTML, empty when the run ranked no token buffs
     * @private
     */
    _renderAllFightsTokenSection(tokenResults, styles) {
        if (!tokenResults?.length) return '';
        const { thStyle, tdStyle, tdNameStyle, fmtAttempts, fmtAttemptsDelta, attemptsDeltaColor } = styles;
        const deltaPct = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
        const perTokens = (v) =>
            v === null ? '—' : v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(3) : v.toPrecision(2);

        let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin:14px 0 4px;">Labyrinth Token Buffs</div>
            <div style="color:#666; font-size:10px; margin-bottom:4px;">Bought once with labyrinth tokens and paid
                for in every room, so each is simulated against every fight and aggregated exactly like a combat
                level. Ranked in tokens rather than coins, and left out of the budget plan above, which is a plan
                in gold.</div>
            <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead><tr>
                <th style="${thStyle}">Upgrade</th>
                <th style="${thStyle}" title="Labyrinth tokens for this level">Tokens</th>
                <th style="${thStyle}" title="Attempts saved across a whole run per 100 tokens spent — the value figure, in the currency these are actually bought with">Per 100</th>
                <th style="${thStyle}" title="Expected combat attempts to clear every fight once (retrying failed rooms)">Attempts</th>
                <th style="${thStyle}" title="Change in expected attempts vs baseline — negative is better. The ± is one standard error of the simulation.">ΔAttempts</th>
                <th style="${thStyle}" title="Average win rate change across every fight — a token level reaches all of them">Avg ΔWin</th>
            </tr></thead><tbody>`;

        tokenResults.forEach((r, i) => {
            const measured = r.significant !== false;
            const noise =
                r.attemptsDeltaNoise > 0 ? ` <span style="color:#555;">±${r.attemptsDeltaNoise.toFixed(1)}</span>` : '';
            html += `<tr style="cursor:pointer; color:#e0e0e0;" data-allfights-token-row="${i}">
                <td style="${tdNameStyle}${measured ? '' : ' opacity:0.55;'}">${r.candidate.description}</td>
                <td style="${tdStyle} color:#aaa;">${formatWithSeparator(r.tokenCost || 0)}</td>
                <td style="${tdStyle} color:${measured && r.attemptsSavedPerHundredTokens > 0 ? '#4caf50' : '#888'}; font-weight:600;">${perTokens(r.attemptsSavedPerHundredTokens ?? null)}</td>
                <td style="${tdStyle}">${fmtAttempts(r.expectedAttempts)}</td>
                <td style="${tdStyle} color:${measured ? attemptsDeltaColor(r.attemptsDelta) : '#666'};"
                    title="${measured ? '' : 'Smaller than the simulation’s own error — not a measured gain'}">${fmtAttemptsDelta(r.attemptsDelta)}${noise}</td>
                <td style="${tdStyle} color:${r.avgWinDelta > 0.0001 ? '#4caf50' : r.avgWinDelta < -0.0001 ? '#f44336' : '#888'};">${deltaPct(r.avgWinDelta)}</td>
            </tr>`;

            const fightRows = r.fights
                .map(
                    (fight) => `<div style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">
                        <span style="color:#aaa;">${fight.monsterName}
                            <span style="color:#666;">(Lv ${fight.roomLevel}, "${fight.loadoutName}")</span></span>
                        <span style="white-space:nowrap; color:#888;">${(fight.winRate * 100).toFixed(1)}%
                            <span style="color:${fight.winRateDelta > 0.0001 ? '#4caf50' : fight.winRateDelta < -0.0001 ? '#f44336' : '#888'};">(${deltaPct(fight.winRateDelta || 0)})</span></span>
                    </div>`
                )
                .join('');
            html += `<tr data-allfights-token-detail="${i}" style="display:none;">
                <td colspan="6" style="padding:6px 12px; background:#0d0d1a; border-bottom:1px solid #222; font-size:11px;">
                    ${fightRows}</td>
            </tr>`;
        });

        return html + '</tbody></table>';
    }

    /**
     * The notes a row's own numbers cannot carry.
     *
     * The forced armor swaps are priced without crediting the resale of what
     * they replace, because the labyrinth wants every element kept — a gross
     * price that reads as an overcharge unless the row says why. And a pooled
     * ability swap is measured at a different level in every loadout it reaches,
     * which the description no longer states now that it is one row for the
     * whole run.
     *
     * @param {Object} result - One all-fights result row
     * @returns {string} HTML, empty where there is nothing to add
     * @private
     */
    _renderAllFightsNotes(result) {
        const notes = [];
        const kept = result.costDetail?.kept;
        if (kept?.length) {
            const text = keptResaleText(
                kept,
                result.costDetail.keptValue,
                result.candidate?.checkedSwap ? KEPT_REASON_CHECKED : KEPT_REASON_LABYRINTH,
                (value) => formatKMB(Math.round(value))
            );
            if (text) notes.push(text);
        }
        if (result.candidate?.caveat) notes.push(result.candidate.caveat);
        // How a hand-checked swap was priced: context, not a task caveat
        if (result.candidate?.pricingNote) notes.push(result.candidate.pricingNote);
        if (!notes.length) return '';
        return notes
            .map(
                (note) =>
                    `<div style="color:#8ab4f8; margin-top:6px; white-space:normal; line-height:1.4;">${note}</div>`
            )
            .join('');
    }

    /** @private */
    /**
     * Restore the last Upgrade-tab results after a refresh, when the option is on
     * and a fresh run has not already drawn its own. Fire-and-forget from panel
     * open; draws into the (possibly hidden) Upgrade tab so the results are there
     * when the tab is next shown.
     *
     * `replace` is a sync pull's: the table on screen is itself a restored one (no analysis has
     * started on this panel), so it gives way to the pulled set, and a pulled clear empties it.
     * An analysis started while the read was out owns the panel, replace or not, and nothing is drawn.
     * @param {{replace?: boolean}} [options] - Replace a restored table already shown
     * @private
     */
    async _restoreUpgradeResults({ replace = false } = {}) {
        try {
            const container = this.panel?.querySelector('#mwi-labsim-upgrade-results');
            if (!container || (container.querySelector('table') && !replace)) return;
            const payload = await loadUpgradeResults(LAB_UPGRADE_RESULTS_KEY);
            // Whatever the read's kind: an analysis (an order-only one draws no table to notice) that started
            // or finished while it was out owns the panel, and the older saved payload must not paint over it
            if (this._upgradeRunning || this._upgradeRunStarted) return;
            if (!payload) {
                if (replace && this.panel && (container.querySelector('table') || this._upgradeOrderSection)) {
                    this._restoredUpgradeAt = null;
                    this._restoredUpgradeMeta = null;
                    container.innerHTML = '';
                    this._upgradeOrderSection = null;
                    this._drawUpgradeAbilityOrder();
                }
                return;
            }
            if (!this.panel || (container.querySelector('table') && !replace)) return;
            this._restoredUpgradeAt = payload.savedAt || null;
            this._restoredUpgradeMeta = { characterName: payload.characterName || null };
            // An order-only run saved no table, only its section
            // A combined all-fights run saved its own table, marked, and draws with the renderer the run used
            if (payload.data?.results?.length && payload.data.allFights) {
                this._renderAllFightsResults(payload.data, container);
            } else if (payload.data?.results?.length) this._renderUpgradeResults(payload.data, container);
            else container.innerHTML = '';
            // A payload from before the section was remembered carries none
            this._upgradeOrderSection = payload.orderSection || null;
            this._drawUpgradeAbilityOrder();
        } catch (error) {
            console.error('[LabSimUI] Restoring upgrade results failed:', error);
        }
    }

    /**
     * A quiet banner saying the shown results are remembered from a previous run.
     * @param {number} savedAt - Epoch ms the results were saved
     * @returns {string} HTML
     * @private
     */
    _restoredUpgradeNote(savedAt, meta = null) {
        const when = savedAt ? new Date(savedAt).toLocaleString() : 'a previous session';
        // A payload from before the name was stored renders the old sentence.
        // No zone half here - the lab is the zone
        const who = meta?.characterName ? escapeHtmlAttribute(meta.characterName) : null;
        return (
            `<div style="margin:0 0 8px; padding:5px 8px; font-size:11px; color:#9ab; display:flex; ` +
            `align-items:center; justify-content:space-between; gap:8px; ` +
            `background:rgba(120,150,190,0.10); border:1px solid rgba(120,150,190,0.25); border-radius:5px;">` +
            `<span>Showing results remembered from ${when}${who ? ` — ${who}` : ''}. Run a new analysis to refresh them.</span>` +
            `<button data-clear-remembered-upgrade title="Forget these remembered results. Does not affect a running analysis." ` +
            `style="flex:0 0 auto; background:transparent; color:#9ab; border:1px solid rgba(120,150,190,0.4); ` +
            `border-radius:3px; padding:1px 6px; font-size:10px; cursor:pointer; font-family:inherit;">Clear</button>` +
            `</div>`
        );
    }

    _renderUpgradeResults(analysisResult, container) {
        const results = analysisResult?.results;
        if (!results || !results.length) {
            // The house note matters most here: an empty table is exactly where
            // "every combat room is already at the cap" reads as "nothing to buy"
            const note = this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '';
            container.innerHTML =
                '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.' +
                (note ? `<div style="margin-top:6px; color:#666; font-size:11px;">${note.trim()}</div>` : '') +
                '</div>';
            this._setStatus(`No upgrade candidates found.${note}`);
            return;
        }

        // The second ranking pass, when it was run. Its columns are added to the
        // token and gold tables; the community rows are ranked on experience and
        // never touched whether a room is cleared, so they get none.
        const roomLevels = analysisResult?.roomLevels || null;
        const targetFloor = Math.max(0, Math.floor(Number(roomLevels?.targetFloor) || 0));

        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const communityResults = results.filter((r) => r.costType === 'community');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        // Numbers right-align and never wrap; only the Upgrade name reflows —
        // the same division the combat sim's table makes, and what stops a
        // two-piece swap label ("Royal Nature Robe Top +7 + Royal Nature Robe
        // Bottoms +7 → …") from running off the edge of the panel on one line
        const tdStyle = 'padding:3px 4px; text-align:right; white-space:nowrap;';
        const tdNameStyle =
            'padding:3px 4px; color:#e0e0e0; text-align:left; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';

        // Pre-compute row data for sorting
        const tokenRows = tokenResults.map((r) => {
            let rateVal, deltaVal, rateStr;

            if (r.metricType === 'clearRate') {
                rateVal = (r.clearRate || 0) * 100;
                deltaVal = (r.clearRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(1) + '%';
            } else {
                rateVal = (r.winRate || 0) * 100;
                deltaVal = (r.winRateDelta || 0) * 100;
                rateStr = rateVal.toFixed(2) + '%';
            }

            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const deltaStr = (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%';

            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;
            const tokensPerPctStr = deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014';

            const levels = roomLevels ? roomLevelCells(r, roomLevels) : null;

            return {
                ...(levels
                    ? {
                          roomLevelDelta: levels.delta,
                          roomLevelStr: levels.deltaStr,
                          roomLevelColor: levels.deltaColor,
                          floorVal: levels.floor,
                          floorStr: levels.floorStr,
                          levelTitle: levels.title,
                          reachesTarget: levels.reachesTarget,
                      }
                    : {}),
                desc: r.candidate?.description || '',
                // Whatever handoff buttons the shared builder emits for this
                // row — never a hand-picked subset of them, so a button added
                // to the combat sim's rows turns up here without being asked for
                actions: combatSimUI.upgradeRowActionsHtml(r),
                tokenCost,
                rateVal,
                rateStr,
                deltaVal,
                deltaStr,
                deltaColor,
                tokensPerPct,
                tokensPerPctStr,
            };
        });

        const goldRows = goldResults.map((r) => {
            const delta = (r.winRateDelta || 0) * 100;
            const deltaColor = delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888';
            const winRate = (r.winRate || 0) * 100;
            const goldPerPct = goldPerPercent(r.cost, delta);

            const levels = roomLevels ? roomLevelCells(r, roomLevels) : null;

            return {
                ...(levels
                    ? {
                          roomLevelDelta: levels.delta,
                          roomLevelStr: levels.deltaStr,
                          roomLevelColor: levels.deltaColor,
                          floorVal: levels.floor,
                          floorStr: levels.floorStr,
                          levelTitle: levels.title,
                          reachesTarget: levels.reachesTarget,
                      }
                    : {}),
                desc: r.candidate?.description || '',
                actions: combatSimUI.upgradeRowActionsHtml(r),
                // Unpriced sorts last rather than as the cheapest thing on the
                // table, which is where `r.cost || 0` put a combat level
                cost: Number.isFinite(r.cost) ? r.cost : Infinity,
                costStr: goldCostCell(r.cost),
                winRate,
                winRateStr: winRate.toFixed(2) + '%',
                deltaVal: delta,
                deltaStr: (delta >= 0 ? '+' : '') + delta.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, delta),
                detailHtml: this._renderUpgradeCostDetail(r, analysisResult?.baseline),
            };
        });

        // Neither community buff a combat fight reads can change whether it is
        // won, so the clear-chance columns stay at the baseline and the row is
        // read on what it does move: experience per attempt. The same treatment
        // the Skilling tab gives the Experience token, for the same reason.
        const communityRows = communityResults.map((r) => {
            const xpDelta = r.xpPerRoomDelta || 0;
            return {
                desc: r.candidate?.description || '',
                cowbellCost: r.cowbellCost ?? Infinity,
                cowbellCostStr: r.cowbellCost == null ? '\u2014' : formatWithSeparator(r.cowbellCost) + '/min',
                xpPerRoom: r.xpPerRoom || 0,
                xpPerRoomStr: (r.xpPerRoom || 0).toFixed(1),
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
            };
        });

        // Sort state
        // With the room-level pass on, the table opens on the currency it was
        // asked for. The cost-efficiency columns are untouched and one click
        // away, so nothing that was on this table has changed meaning.
        const sortState = {
            token: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'tokensPerPct', dir: 'asc' },
            gold: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'goldPerPct', dir: 'asc' },
            community: { key: 'xpDelta', dir: 'desc' },
        };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        /**
         * The Levels and Floor cells, empty when the pass was not run.
         * @param {Object} row - A prepared token or gold row
         * @returns {string} HTML
         */
        const roomLevelCellsHtml = (row) => {
            if (!roomLevels) return '';
            const reached = row.reachesTarget ? ' font-weight:700;' : '';
            const floorColor = row.reachesTarget ? '#4caf50' : '#888';
            return (
                `<td style="${tdStyle} color:${row.roomLevelColor}; font-weight:600;" title="${escapeHtmlAttribute(row.levelTitle)}">${row.roomLevelStr}</td>` +
                `<td style="${tdStyle} color:${floorColor};${reached}" title="${escapeHtmlAttribute(row.levelTitle)}">${row.floorStr}</td>`
            );
        };

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Rate', 'rateVal', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${roomLevels ? th('Levels', 'roomLevelDelta', 'right') : ''}
                ${roomLevels ? th('Floor', 'floorVal', 'right') : ''}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}${row.actions}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.rateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Gold Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Win Rate', 'winRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${roomLevels ? th('Levels', 'roomLevelDelta', 'right') : ''}
                ${roomLevels ? th('Floor', 'floorVal', 'right') : ''}
                ${th('Gold/1%', 'goldPerPct', 'right')}
            </tr></thead><tbody>`;

            goldRows.forEach((row, i) => {
                html += `<tr data-gold-row="${i}" style="border-bottom:1px solid #1a1a1a; cursor:pointer;" title="Click for the cost breakdown">
                    <td style="${tdNameStyle}">${row.desc}${row.actions}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.winRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                </tr>
                <tr data-gold-detail="${i}" style="display:none;">
                    <td colspan="${roomLevels ? 7 : 5}" style="padding:6px 10px; background:#0d0d1a; border-bottom:1px solid #222;">
                        ${row.detailHtml}
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            return html;
        };

        const renderCommunityTable = () => {
            const s = sortState.community;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="community" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Community Buffs</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${th('Upgrade', 'desc', 'left')}
                ${th('Cowbells', 'cowbellCost', 'right')}
                ${th('Win Rate', 'winRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}
                ${th('XP/Attempt', 'xpPerRoom', 'right')}
                ${th('ΔXP', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of communityRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    <td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.cowbellCostStr}</td>
                    <td style="${tdStyle} color:#666;">\u2014</td>
                    <td style="${tdStyle} color:#666;">\u2014</td>
                    <td style="${tdStyle} color:#ccc;">${row.xpPerRoomStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                A community buff's level is what the whole server's donated minutes add up to, so there is no price
                for one more level to rank on — the cowbell figure is what the game charges per minute to keep the
                buff running. Neither of these can change whether a fight is won, so the win-rate columns are left
                blank rather than filled in with the simulation's own noise; they are read on experience instead.
                The Combat Drop buff is left out entirely — it moves what a win pays out, and this table does not
                price drops. Capped at Lv${MAX_COMMUNITY_BUFF_LEVEL} (max).
            </div>`;
            return html;
        };

        /**
         * What the room-level pass measured, above the tables it annotated.
         * @returns {string} HTML
         */
        const renderRoomLevelSummary = () => {
            const bar = `${Math.round((roomLevels.threshold || defaultThreshold()) * 100)}%`;
            const parts = [];
            if (roomLevels.baselineCleared) {
                parts.push(
                    `Today this loadout clears room level <b>${roomLevels.baselineLevel}</b> at ${bar} — ` +
                        `floor <b>${roomLevels.baselineFloor}</b> finished` +
                        (roomLevels.baselineFloor > 0
                            ? ` (its exit room is level ${labyrinthFloorClearLevel(roomLevels.baselineFloor)})`
                            : '') +
                        '.'
                );
                parts.push(
                    `Levels is what the top ${roomLevels.shortlistSize} upgrades move that by; every other row ` +
                        'reads +0 because it was not searched.'
                );
            } else {
                parts.push(`No room in this character’s range cleared at ${bar}, so there is no level to move.`);
            }
            if (targetFloor > 0) {
                const need = labyrinthFloorClearLevel(targetFloor);
                parts.push(
                    `Floor ${targetFloor} needs room level <b>${need}</b> — its exit room, not its average one — ` +
                        `which is ${need - roomLevels.baselineLevel > 0 ? `${need - roomLevels.baselineLevel} levels away` : 'already cleared'}.`
                );
            }
            if (roomLevels.aborted) parts.push('Stopped early: the rows below it were never searched.');
            return (
                `<div style="margin:0 0 8px; padding:5px 8px; font-size:11px; color:#9ab; line-height:1.5; ` +
                `background:rgba(120,150,190,0.10); border:1px solid rgba(120,150,190,0.25); border-radius:5px;">` +
                parts.join(' ') +
                `</div>`
            );
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            sortRows(communityRows, sortState.community.key, sortState.community.dir);
            let html = '';
            if (this._restoredUpgradeAt) {
                html += this._restoredUpgradeNote(this._restoredUpgradeAt, this._restoredUpgradeMeta);
            }
            // The verify engine re-measures every fight an upgrade reaches; the single-fight analysis keeps
            // no such record, so there is nothing to offer here
            html +=
                '<div data-verify-single-note style="color:#666; font-size:10px; margin:0 0 6px;">' +
                'Verify needs the All or Chosen targets scope: this single-fight table cannot be re-measured.</div>';
            if (roomLevels) html += renderRoomLevelSummary();
            if (tokenResults.length > 0) html += renderTokenTable();
            if (communityResults.length > 0) html += renderCommunityTable();
            if (goldResults.length > 0) html += renderGoldTable();
            container.innerHTML = html;
            // Re-wired on every render: a sort rebuilds the table, and buttons
            // wired to the elements it threw away do nothing at all
            combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');

            // Forgets the saved run only — the table on screen came from this
            // render call and stays right there
            const clearBtn = container.querySelector('[data-clear-remembered-upgrade]');
            if (clearBtn) {
                clearBtn.addEventListener('click', async () => {
                    clearBtn.disabled = true;
                    await clearUpgradeResults(LAB_UPGRADE_RESULTS_KEY);
                    this._restoredUpgradeAt = null;
                    this._restoredUpgradeMeta = null;
                    clearBtn.closest('div')?.remove();
                });
            }
        };

        renderAll();

        this._addCsvExport(container, 'labsim-upgrades', () => ({
            columns: [
                { key: 'upgrade', label: 'Upgrade' },
                { key: 'paidIn', label: 'Paid in' },
                { key: 'cost', label: 'Gold cost' },
                { key: 'tokenCost', label: 'Token cost' },
                { key: 'rate', label: 'Win rate' },
                { key: 'rateDelta', label: 'Win rate change' },
                { key: 'perPercent', label: 'Cost per +1%' },
            ],
            rows: results.map((r) => {
                const rate = r.winRate ?? r.clearRate ?? null;
                const delta = r.winRateDelta ?? r.clearRateDelta ?? null;
                const paid = r.costType === 'token' ? r.tokenCost : r.cost;
                const gain = (delta || 0) * 100;
                return {
                    upgrade: r.candidate?.description || '',
                    paidIn: CSV_PAID_IN[r.costType] || 'gold',
                    cost: r.costType === 'gold' ? (r.cost ?? null) : null,
                    // Shrine rows are paid in gold *and* guild tokens; the token
                    // half rides on the candidate rather than the result row
                    tokenCost: r.costType === 'token' ? (r.tokenCost ?? null) : (r.candidate?.guildTokenCost ?? null),
                    rate,
                    rateDelta: delta,
                    perPercent: gain > 0 && paid ? Math.round(paid / gain) : null,
                };
            }),
        }));

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        if (this._upgradeSortHandler) {
            container.removeEventListener('click', this._upgradeSortHandler);
        }
        this._upgradeSortHandler = (e) => {
            const expandable = e.target.closest('tr[data-gold-row]');
            if (expandable) {
                const detail = container.querySelector(`[data-gold-detail="${expandable.dataset.goldRow}"]`);
                if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                return;
            }
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this._upgradeSortHandler);

        this._setStatus(
            `${results.length} upgrade candidates analyzed.` +
                (this._houseScanNote ? ` House rooms: ${this._houseScanNote}.` : '')
        );
    }

    /**
     * Cost breakdown shown when a gold-upgrade row is expanded: what gets bought
     * at what price, what the swap credits or keeps, and — when the Cost column
     * reads as a dash — which item has no price behind it.
     * @param {Object} result - Analysis result row
     * @param {Object} [baseline] - Baseline metrics
     * @returns {string} HTML
     * @private
     */
    _renderUpgradeCostDetail(result, baseline) {
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;

        const parts = [];

        const baseWinRate = baseline?.winRate != null ? (baseline.winRate * 100).toFixed(2) + '%' : null;
        parts.push(
            line(
                `Win rate ${((result.winRate || 0) * 100).toFixed(2)}%` +
                    (baseWinRate ? ` vs ${baseWinRate} baseline` : '') +
                    ` · ${(result.winRateDelta || 0) >= 0 ? '+' : ''}${((result.winRateDelta || 0) * 100).toFixed(2)}%`,
                '#ccc'
            )
        );

        // A room level is not a listing, so the breakdown says what it is: a
        // build cost, and a number measured against a baseline of its own
        if (result.candidate?.type === 'house') {
            parts.push(
                line(
                    `House room level ${result.candidate.currentLevel} → ${result.candidate.upgradeLevel}. ` +
                        'Cost is the build cost of that one level — coins at face value plus the materials at ' +
                        'their buy price.'
                )
            );
            parts.push(
                line(
                    'Weighed in a pass of its own, against its own baseline at its own seed, so the delta is ' +
                        'paired. The absolute win rate can sit a fraction of a percent off the rows above it.',
                    '#888'
                )
            );
        }

        parts.push(
            this._renderCostBreakdown(result.costDetail, {
                keptReason: result.candidate?.checkedSwap ? KEPT_REASON_CHECKED : KEPT_REASON_LABYRINTH,
            })
        );
        return parts.join('');
    }

    /**
     * The same expansion, for a table ranked on clear rate rather than win rate.
     *
     * The Skilling tab's Gear Upgrades rows had a Cost column and no way to ask
     * what the number was made of — including the two cases where the number is
     * least self-explanatory: a dash, which means the market has no listing at
     * that enhancement rather than that the piece is free; and a cost that looks
     * far too high, which is a skilling piece priced without crediting the combat
     * armour it goes in place of, because that armour stays in its loadout.
     *
     * Everything below the header lines is the same breakdown the combat rows
     * draw. What differs is the header: the rate this table measures, and what
     * kind of purchase the row is, since "enhance what you wear" and "buy a piece
     * you do not own yet, at +5" are priced in completely different ways.
     *
     * @param {Object} result - Skilling analysis result row
     * @param {Object} [baseline] - `{ clearRate }` from the analysis
     * @returns {string} HTML
     * @private
     */
    _renderClearRateCostDetail(result, baseline) {
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;
        const parts = [];
        const candidate = result.candidate || {};

        const baseRate = baseline?.clearRate != null ? (baseline.clearRate * 100).toFixed(2) + '%' : null;
        const delta = (result.clearRateDelta || 0) * 100;
        parts.push(
            line(
                `Avg clear rate ${((result.clearRate || 0) * 100).toFixed(2)}%` +
                    (baseRate ? ` vs ${baseRate} baseline` : '') +
                    ` · ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`,
                '#ccc'
            )
        );

        if (candidate.type === 'enhancement') {
            parts.push(
                line(
                    `Enhancing a piece you already wear, +${candidate.currentLevel} → +${candidate.upgradeLevel}. ` +
                        'Cost is the cheapest priced way to reach that level — the piece itself is already yours, ' +
                        'so nothing is bought and nothing is sold back.'
                )
            );
        } else if (candidate.type === 'skilling_gear') {
            parts.push(
                line(
                    `A piece you do not own yet, priced and simulated at +${candidate.upgradeLevel}. Nobody buys ` +
                        'one of these and leaves it at +0, so costing it there would understate both the price ' +
                        'and the gain against every other row.'
                )
            );
            if (candidate.skillKey) {
                parts.push(
                    line(
                        `Applied to the ${String(candidate.skillKey).replace('/skills/', '')} kit only. A piece that ` +
                            'serves several skills’ rooms is listed once, with the rooms it covers in its name.',
                        '#888'
                    )
                );
            }
        }

        if (candidate.pricingNote) parts.push(line(candidate.pricingNote, '#8ab4f8'));
        parts.push(this._renderCostBreakdown(result.costDetail, { keptReason: skillingKeptReason(candidate) }));
        return parts.join('');
    }

    /**
     * Every room an analyzed upgrade was weighed against: before to after, or
     * "unaffected" where its stats do nothing in that room.
     * @param {Object|undefined} result - A skilling result row
     * @returns {string} HTML, empty when there is no analysis to measure against
     * @private
     */
    _renderSkillBreakdown(result) {
        const context = this._skillingAnalysis;
        if (result?.breakdownLines) return renderSkillBreakdownHtml(result.breakdownLines);
        if (!context || !result?.candidate) return '';
        try {
            return renderSkillBreakdownHtml(
                skillBreakdown({
                    baseSetup: context.baseSetup,
                    candidate: result.candidate,
                    evaluate: context.evaluate,
                    roomLevel: context.roomLevel,
                    targetSkill: context.targetSkill,
                })
            );
        } catch (error) {
            console.error('[LabSimUI] Skill breakdown failed:', error);
            return '';
        }
    }

    /**
     * What a cost is made of: bought, credited, kept, or missing a price.
     *
     * Shared by every expandable row in the panel, because the answer does not
     * depend on which rate the table above it is ranked on. Only the header lines
     * differ, and those belong to the renderers that call this.
     *
     * @param {Object|null} detail - `costDetail` from the analysis
     * @param {Object} [options] - `keptReason`: why an uncredited resale is uncredited,
     *   which is a different answer for the labyrinth's forced armor sets than for a
     *   skilling piece that goes in place of combat gear
     * @returns {string} HTML
     * @private
     */
    _renderCostBreakdown(detail, { keptReason = KEPT_REASON_LABYRINTH } = {}) {
        const money = (value) => formatWithSeparator(Math.round(value));
        const line = (text, color = '#aaa') => `<div style="color:${color}; font-size:11px;">${text}</div>`;
        const parts = [];

        if (!detail) {
            return line('No cost breakdown available for this candidate.', '#666');
        }

        // A shrine level is bought with guild credits and guild tokens. Credits
        // have a gold value (the cheapest items that convert into them); tokens
        // are priced through the guild shop's token→credit exchange when a rate
        // is known — the note names which ranking applied
        if (detail.guild) {
            const guild = detail.guild;
            const tokenText =
                guild.tokenNote || `${formatWithSeparator(guild.tokens)} guild token${guild.tokens === 1 ? '' : 's'}`;
            parts.push(
                line(
                    `Costs ${tokenText} + ` +
                        `credits worth ${guild.creditGold == null ? 'no price' : money(guild.creditGold)}. ` +
                        (guild.rankedNote || '')
                )
            );
            for (const credit of guild.credits) {
                const each =
                    credit.goldEach === null ? '<span style="color:#ff9800;">no rate</span>' : money(credit.gold);
                parts.push(line(`${formatWithSeparator(credit.count)} × ${credit.name} — ${each}`, '#888'));
            }
            if (guild.needsShrineLevel) {
                parts.push(
                    line(
                        `Your guild's ${guild.shrineName} shrine is level ${guild.shrineLevel}; buying level ` +
                            `${guild.needsShrineLevel} needs the shrine there first — a guild-wide upgrade this ` +
                            'cost does not include.',
                        '#ff9800'
                    )
                );
            } else if (!guild.shrineLevelKnown) {
                parts.push(
                    line('No guild shrine levels reached the client, so any cap on this level is unknown.', '#888')
                );
            }
            return parts.join('');
        }

        // An ability is paid for in books, and nothing comes back — it is not an
        // item, so there is no listing at a level to buy and nothing to sell back
        if (detail.books) {
            const books = detail.books;
            const each =
                books.bookPrice === null
                    ? '<span style="color:#ff9800;">no price found</span>'
                    : `${money(books.bookPrice)} each`;
            parts.push(line(`Buy ${formatWithSeparator(Math.ceil(books.books))} × ${books.bookName} — ${each}`));
            if (books.learnBook) {
                parts.push(line('Includes the one book that learns it, on top of the levels.', '#888'));
            }
            parts.push(line('Abilities cannot be sold back, so nothing is credited against this.', '#888'));
        }

        for (const buy of detail.buys || []) {
            const price = buy.price === null ? '<span style="color:#ff9800;">no price found</span>' : money(buy.price);
            parts.push(line(`Buy ${buy.name} +${buy.enhancementLevel} — ${price}`));
        }

        // Nothing is listed at that enhancement, so half the figure above is a
        // simulated enhance path — and the same path costs different money on
        // different benches. Named in the words the enhancement tooltip's chip
        // uses, so one source reads identically wherever it turns up.
        if (detail.enhanceSource) {
            const rates = detail.enhanceSource;
            parts.push(line(`Enhance rates: ${rates.label}${rates.detail ? ` — ${rates.detail}` : ''}.`, '#888'));
        }

        if (detail.unpriced?.length > 0) {
            // "The measured delta is still accurate" rather than naming win rate:
            // the same breakdown is drawn under a table ranked on clear rate, and
            // the point holds either way — a missing listing costs the row its
            // price, not its measurement
            parts.push(
                line(
                    detail.books
                        ? `Cost shows as \u2014 because ${detail.unpriced.join(' and ')} has no market listing ` +
                              'right now. The measured delta is still accurate.'
                        : `Cost shows as \u2014 because ${detail.unpriced.join(' and ')} has no market listing at ` +
                              'that enhancement and no priced path to reach it. The measured delta is still accurate.',
                    '#ff9800'
                )
            );
        }

        const keptText = detail.kept?.length ? keptResaleText(detail.kept, detail.keptValue, keptReason, money) : '';
        if (keptText) {
            parts.push(line(keptText, '#8ab4f8'));
        } else if (!detail.kept?.length && detail.credits?.length > 0) {
            for (const credit of detail.credits) {
                parts.push(
                    line(`Sell ${credit.name} +${credit.enhancementLevel} — ${money(credit.price)} back`, '#8bc34a')
                );
            }
            if (detail.creditCapped) {
                parts.push(
                    line(
                        `Resale credit capped at the purchase: the current item's bid of ${money(detail.rawCredit)} ` +
                            'looks out of line with the market.',
                        '#ff9800'
                    )
                );
            }
        }

        if (detail.gross !== null) {
            const net = detail.net;
            parts.push(
                line(
                    `Total ${money(detail.gross)}` + (net !== detail.gross ? ` \u2212 credit = ${money(net)}` : ''),
                    '#e0e0e0'
                )
            );
        }

        // Kits that read one owned piece at different levels: each copy is sold
        // once, at the level it is owned at, and the row says where they disagreed
        for (const note of detail.ownershipNotes || []) parts.push(line(note, '#ff9800'));

        return parts.join('');
    }

    /**
     * The labyrinth crates the character actually has equipped — the same source
     * the live clear-rate reader scores a room with (getCrateBuffs). Shared by
     * the skilling and combat crate dropdowns, which point at one equipped set.
     * @private
     */
    _equippedCrateHrids() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return {
            tea: labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            coffee: labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            food: labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        };
    }

    /**
     * Point one crate dropdown trio at the equipped crates.
     *
     * The sim's room level already comes from the live equipped crate (via
     * getTargetRoomLevel → getEffectiveLevel for skilling, the effective combat
     * level for combat), so the success calc must use the same crates or the two
     * halves disagree — a room set from the equipped crate and a fight scored
     * against a hardcoded Expert crate the player may not own. That mismatch reads
     * a higher clear than the live tile / recommendation for the same threshold
     * (e.g. the Expert coffee crate's +15 combat levels). Skipped once the user
     * picks a crate by hand, so exploring a different crate still works.
     * @param {{tea:string,coffee:string,food:string}} ids - Select element ids
     * @param {string} userSetKey - The "user has overridden" flag to honour
     * @private
     */
    _applyEquippedCratesTo(ids, userSetKey) {
        if (this[userSetKey]) return;
        // Before character data loads there is nothing to read; leave the
        // dropdowns as they are rather than forcing them to None.
        if (!dataManager.characterData) return;
        const equipped = this._equippedCrateHrids();
        const set = (id, hrid) => {
            const select = this.panel?.querySelector(id);
            if (!select) return;
            if (!hrid) {
                select.value = '';
            } else if ([...select.options].some((option) => option.value === hrid)) {
                // Leave an unrecognised crate on its current value rather than blanking it
                select.value = hrid;
            }
        };
        set(ids.tea, equipped.tea);
        set(ids.coffee, equipped.coffee);
        set(ids.food, equipped.food);
    }

    /** @private */
    _applyEquippedSkillingCrates() {
        this._applyEquippedCratesTo(
            {
                tea: '#mwi-labsim-skilling-tea',
                coffee: '#mwi-labsim-skilling-coffee',
                food: '#mwi-labsim-skilling-food',
            },
            '_skillingCratesUserSet'
        );
    }

    /** @private */
    _applyEquippedCombatCrates() {
        this._applyEquippedCratesTo(
            { tea: '#mwi-labsim-tea', coffee: '#mwi-labsim-coffee', food: '#mwi-labsim-food' },
            '_combatCratesUserSet'
        );
    }

    /** @private */
    _getSkillingCrates() {
        // Re-point at the equipped crates in case the panel was built before
        // character data arrived; a manual pick has already opted out.
        this._applyEquippedSkillingCrates();
        const crates = [];
        // Only the tea crate reaches a skilling room (measured); the coffee and food crates are combat-only
        const tea = this.panel?.querySelector('#mwi-labsim-skilling-tea')?.value;
        if (tea) crates.push(tea);
        return crates;
    }

    /** @private */
    async _renderSkillLoadoutTable() {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-loadouts');
        if (!container) return;

        const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
        const nonCombatSnapshots = allSnapshots.filter(
            (s) => s.actionTypeHrid && s.actionTypeHrid !== '/action_types/combat'
        );
        const allSkillsSnapshots = allSnapshots.filter((s) => !s.actionTypeHrid);

        const skills = [
            { hrid: '/skills/woodcutting', label: 'Woodcutting', actionType: '/action_types/woodcutting' },
            { hrid: '/skills/foraging', label: 'Foraging', actionType: '/action_types/foraging' },
            { hrid: '/skills/milking', label: 'Milking', actionType: '/action_types/milking' },
            { hrid: '/skills/cooking', label: 'Cooking', actionType: '/action_types/cooking' },
            { hrid: '/skills/brewing', label: 'Brewing', actionType: '/action_types/brewing' },
            { hrid: '/skills/cheesesmithing', label: 'Cheesesmithing', actionType: '/action_types/cheesesmithing' },
            { hrid: '/skills/crafting', label: 'Crafting', actionType: '/action_types/crafting' },
            { hrid: '/skills/tailoring', label: 'Tailoring', actionType: '/action_types/tailoring' },
            { hrid: '/skills/alchemy', label: 'Alchemy', actionType: '/action_types/alchemy' },
            { hrid: '/skills/enhancing', label: 'Enhancing', actionType: '/action_types/enhancing' },
        ];

        // Load persisted overrides once per character. A plain latch kept the
        // first character's assignments in memory for the life of the page: the
        // table then offered the wrong character's loadouts, the auto-populate
        // below saw a full map and never filled from the arriving character's
        // own lab automation settings, and changing any row wrote that whole
        // stale map back — over assignments the arriving character had made.
        const loadoutsKey = characterKey(SKILLING_LOADOUTS_KEY);
        if (this._skillLoadoutsKey !== loadoutsKey) {
            this._skillLoadoutsKey = loadoutsKey;
            this._skillLoadouts = {};
            // Discard any legacy global value: loadout names resolve against
            // this character's snapshots, so another character's map is noise.
            const persisted = await readScoped(SKILLING_LOADOUTS_KEY, 'settings', null, { migrate: 'discard' });
            // A switch during the read means a later render is loading the
            // character who is actually here; this one's result is not theirs
            if (this._skillLoadoutsKey !== loadoutsKey) return;
            if (persisted && typeof persisted === 'object') {
                this._skillLoadouts = persisted;
            }
        }

        // Auto-populate from game's lab automation settings for any skill not already set
        if (Object.keys(this._skillLoadouts).length < skills.length) {
            const charSetting = dataManager.characterData?.characterSetting;
            const snapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).snapshots || {};
            for (const skill of skills) {
                if (this._skillLoadouts[skill.hrid]) continue;
                const skillId = skill.hrid.replace('/skills/', '');
                const pascal = skillId.charAt(0).toUpperCase() + skillId.slice(1);
                const loadoutId = charSetting?.[`labyrinthLoadout${pascal}`];
                if (loadoutId && snapshots[loadoutId]?.name) {
                    this._skillLoadouts[skill.hrid] = snapshots[loadoutId].name;
                } else {
                    const match = nonCombatSnapshots.find((s) => s.actionTypeHrid === skill.actionType);
                    if (match) {
                        this._skillLoadouts[skill.hrid] = match.name;
                    } else if (allSkillsSnapshots.length > 0) {
                        this._skillLoadouts[skill.hrid] = allSkillsSnapshots[0].name;
                    }
                }
            }
        }

        const selectStyle =
            'background:#1a1a2e; color:#e0e0e0; border:1px solid #444; border-radius:3px; padding:1px 4px; font-size:11px; width:100%;';

        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || '';
        const visibleSkills = targetSkill ? skills.filter((s) => s.hrid === targetSkill) : skills;
        const collapsed = this._loadoutsCollapsed || false;

        const arrow = collapsed ? '&#9654;' : '&#9660;';
        let html = `<div id="mwi-labsim-loadout-toggle" style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px; cursor:pointer; user-select:none;">
            <span style="display:inline-block; width:14px; font-size:10px;">${arrow}</span> Skill Loadouts
        </div>`;
        html += `<div id="mwi-labsim-loadout-grid" style="display:${collapsed ? 'none' : 'grid'}; grid-template-columns:1fr 1fr; gap:3px 10px;">`;

        for (const skill of visibleSkills) {
            const current = this._skillLoadouts[skill.hrid] || '';
            html += `<div style="display:flex; align-items:center; gap:4px; font-size:11px;">`;
            html += `<span style="color:#888; width:85px; flex-shrink:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${skill.label}">${skill.label}</span>`;
            html += `<select class="toolasha-select" data-skill-loadout="${skill.hrid}" style="${selectStyle}">`;
            html += `<option value=""${!current ? ' selected' : ''}>Current Gear</option>`;
            for (const snap of [...nonCombatSnapshots, ...allSkillsSnapshots]) {
                const label = snap.name + (snap.actionTypeHrid ? '' : ' (All)');
                const selected = current === snap.name ? ' selected' : '';
                html += `<option value="${snap.name}"${selected}>${label}</option>`;
            }
            html += '</select></div>';
        }

        html += '</div>';
        container.innerHTML = html;

        container.querySelectorAll('[data-skill-loadout]').forEach((select) => {
            select.addEventListener('change', () => this._saveSkillLoadout(select.dataset.skillLoadout, select.value));
        });

        container.querySelector('#mwi-labsim-loadout-toggle')?.addEventListener('click', () => {
            this._loadoutsCollapsed = !this._loadoutsCollapsed;
            this._renderSkillLoadoutTable();
        });
    }

    /**
     * Record one skill's loadout choice and persist it.
     *
     * The stored map is folded under the in-memory one, so an assignment a sync
     * pull brought in since this page read it survives; only this change is
     * laid on top. Written to the key the map was read from, not whoever is
     * current: a table left on screen across a switch is still the departing
     * character's, and their edit belongs to them.
     * @param {string} skillHrid - The skill
     * @param {string} loadoutName - The loadout name, or '' for current gear
     * @returns {Promise<void>}
     * @private
     */
    async _saveSkillLoadout(skillHrid, loadoutName) {
        const key = this._skillLoadoutsKey;
        this._skillLoadouts[skillHrid] = loadoutName;
        // Folded in one transaction against the newest value, a queued write included, so two quick
        // edits or an edit racing a pull cannot put back what the other one changed
        const defaults = { ...this._skillLoadouts };
        try {
            const result = await storage.update(
                key,
                (stored) => ({
                    ...defaults,
                    ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}),
                    [skillHrid]: loadoutName,
                }),
                'settings'
            );
            if (result?.value && this._skillLoadoutsKey === key) this._skillLoadouts = { ...result.value };
        } catch (error) {
            console.error('[LabSimUI] Could not save the skill loadout:', error);
        }
    }

    /**
     * Take a sync pull's copy of the loadout assignments into memory and redraw the table.
     * @param {Record<string, Array<string>>} written - The keys the pull wrote, by store
     * @returns {Promise<void>}
     * @private
     */
    async _adoptPulledSkillLoadouts(written) {
        const key = this._skillLoadoutsKey;
        if (!key || !written?.settings?.includes(key)) return;
        const stored = await storage.get(key, 'settings', null);
        if (this._skillLoadoutsKey !== key) return;
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
        this._skillLoadouts = { ...stored };
        await this._renderSkillLoadoutTable();
    }

    /**
     * Build per-skill equipment map from loadout assignments.
     * @param {Object} gameData
     * @returns {Object} { '/skills/woodcutting': { '/equipment_types/...': { hrid, enhancementLevel } }, ... }
     */
    _buildSkillEquipmentMap(gameData) {
        const itemDetailMap = gameData?.itemDetailMap || {};
        const allSnapshots = (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots();
        const equipmentMap = {};

        for (const [skillHrid, loadoutName] of Object.entries(this._skillLoadouts)) {
            if (!loadoutName) continue;
            const snapshot = allSnapshots.find((s) => s.name === loadoutName);
            if (!snapshot?.equipment?.length) continue;

            const equipment = {};
            // Levels from the loadout's own rule rather than the stored number:
            // a loadout in "highest owned" mode wears the best copy you have
            // now, and the previous fallback only looked at what was equipped
            // this moment — so every loadout except the active one reported the
            // enhancement it had when it was last saved, often +0
            for (const equip of (loadoutSnapshot() || bundledLoadoutSnapshot).resolveEquipment(snapshot)) {
                const itemDetail = itemDetailMap[equip.itemHrid];
                const equipType = itemDetail?.equipmentDetail?.type;
                if (!equipType) continue;
                equipment[equipType] = { hrid: equip.itemHrid, enhancementLevel: equip.enhancementLevel };
            }
            equipmentMap[skillHrid] = equipment;
        }

        return equipmentMap;
    }

    /** @private */
    /**
     * Room level(s) for skilling calculations: a per-skill map derived from
     * each skill's automation skip level when "Use Skip Levels" is checked,
     * otherwise the single manual room level.
     * @private
     */
    _getSkillingRoomLevels() {
        const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip')?.checked;
        if (!useSkip) {
            return parseInt(this.panel.querySelector('#mwi-labsim-skilling-level')?.value, 10) || 100;
        }
        const skillHrids = [
            '/skills/milking',
            '/skills/foraging',
            '/skills/woodcutting',
            '/skills/cheesesmithing',
            '/skills/crafting',
            '/skills/tailoring',
            '/skills/cooking',
            '/skills/brewing',
            '/skills/alchemy',
            '/skills/enhancing',
        ];
        const levels = {};
        for (const skillHrid of skillHrids) {
            levels[skillHrid] = (labyrinthClearRate() || bundledLabyrinthClearRate).getTargetRoomLevel(skillHrid);
        }
        return levels;
    }

    _onSkillingCalculate() {
        if (this._skillingRunning) return;
        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const skillEquipmentMap = this._buildSkillEquipmentMap(gameData);
        const results = computeSkillingClearRatesFromEditor(roomLevel, dto, crateHrids, gameData, skillEquipmentMap);
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const filtered = targetSkill ? results.filter((r) => r.skillHrid === targetSkill) : results;
        this._renderSkillingClearResults(filtered, roomLevel);
    }

    /** @private */
    /**
     * The success/clear working for one skilling row, as hover text. Spells out
     * how the room level is assigned (skip basis + trigger, from base + tea, the
     * way the game does it) versus the effective level the success rate uses
     * (base + every buff) — the two are different, which is what makes a skip
     * trigger read as one room here and another in the automation panel.
     * @private
     */
    _skillingRowBreakdown(r, usesSkipLevels, clearRate, crateSummary) {
        const room = r.roomLevel;
        const lines = [r.skillName];
        if (usesSkipLevels && r.skillHrid && clearRate) {
            const skip = clearRate.getSkipThreshold?.(r.skillHrid);
            const basis = clearRate.getEffectiveLevel?.(r.skillHrid);
            if (Number.isFinite(skip) && Number.isFinite(basis) && skip > 0) {
                // Explain the − 1: the trigger is the gap at which skipping starts,
                // so the hardest room you actually enter is one below it.
                lines.push(`Room ${room} — the hardest room you still fight`);
                lines.push(
                    `  trigger ${skip}: rooms ${basis + skip}+ (≥${skip} above you) are skipped, so ${room} is the top`
                );
            }
        }
        const bonus = Number(r.skillLevelBonus) || 0;
        lines.push(
            `Effective level ${r.effectiveLevel} = base ${r.baseLevel}${bonus ? ` + ${+bonus.toFixed(2)} buffs` : ''}`
        );
        const delta = Number.isFinite(r.levelDelta) ? r.levelDelta : r.effectiveLevel - room;
        lines.push(`Level gap: ${r.effectiveLevel} − ${room} = ${delta >= 0 ? '+' : ''}${delta}`);
        const lb = Number(r.levelBonus) || 0;
        const sb = Number(r.successBonus) || 0;
        lines.push(
            `Success = 0.8 × (1 ${lb >= 0 ? '+' : '−'} ${Math.abs(lb * 100).toFixed(1)}%` +
                `${sb ? ` + ${(sb * 100).toFixed(1)}% gear` : ''}) = ${((r.successChance || 0) * 100).toFixed(1)}%`
        );
        if (Number.isFinite(r.doubleChance) && r.doubleChance > 0) {
            lines.push(`Double progress: ${(r.doubleChance * 100).toFixed(0)}%`);
        }
        if (Number.isFinite(r.workPower)) {
            lines.push(
                `Work power ${r.workPower.toFixed(1)} → ${r.progressPerSuccess}/success, room needs ${r.targetProgress}`
            );
        }
        lines.push(`Clear ${((r.clearChance || 0) * 100).toFixed(1)}% over ${r.attempts || 0} attempts`);
        if (crateSummary) lines.push(`Crates: ${crateSummary}`);
        return lines.join('\n');
    }

    /**
     * "Expert tea" from an /items/expert_tea_crate hrid, for the breakdown's
     * crate line so it is clear which crate tier drove the numbers.
     * @private
     */
    _crateTierLabel(hrid) {
        const match = /\/items\/(\w+?)_(tea|coffee|food)_crate/.exec(hrid || '');
        return match ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}` : '';
    }

    _renderSkillingClearResults(results, roomLevel) {
        const container = this.panel?.querySelector('#mwi-labsim-skilling-results');
        if (!container) return;

        const usesSkipLevels = roomLevel && typeof roomLevel === 'object';
        const clearRate = labyrinthClearRate() || bundledLabyrinthClearRate;
        // The crate tiers behind every row's numbers, for the breakdown's crate line
        const crateSummary = this._getSkillingCrates()
            .map((h) => this._crateTierLabel(h))
            .filter(Boolean)
            .join(' · ');
        // Hover text carries newlines and the odd math symbol — encode for an attr
        const attr = (text) =>
            String(text)
                .replace(/&/g, '&amp;')
                .replace(/"/g, '&quot;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/\n/g, '&#10;');
        const activeResults = results.filter((r) => !r.skipped);
        const avgClearRate = activeResults.length
            ? activeResults.reduce((s, r) => s + (r.clearChance || 0), 0) / activeResults.length
            : 0;

        const thStyle = 'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const thLeftStyle = 'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; font-size:10px;';
        const tdStyle = 'padding:3px 4px; text-align:right; font-size:11px;';

        const headerText = usesSkipLevels ? 'Skip-Level Rooms' : `Skilling Room Level ${roomLevel}`;
        let html = `<div style="color:${ACCENT}; font-weight:700; font-size:13px; margin-bottom:6px;">
            ${headerText}
            <span style="color:#888; font-weight:400; font-size:11px; margin-left:8px;">
                Avg Clear: <span style="color:${avgClearRate >= 0.95 ? '#4caf50' : avgClearRate >= 0.5 ? '#ff9800' : '#f44336'}; font-weight:600;">${(avgClearRate * 100).toFixed(1)}%</span>
                <span style="margin-left:8px; opacity:0.7;">· hover a row for the calculation</span>
            </span>
        </div>`;

        html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
        html += `<thead><tr>
            <th style="${thLeftStyle}">Skill</th>
            <th style="${thStyle}">Room</th>
            <th style="${thStyle}">Level</th>
            <th style="${thStyle}">Eff. Lvl</th>
            <th style="${thStyle}">Success</th>
            <th style="${thStyle}">Clear</th>
            <th style="${thStyle}">XP/Room</th>
            <th style="${thStyle}">Actions</th>
        </tr></thead><tbody>`;

        for (const r of results) {
            if (r.skipped) {
                html += `<tr style="border-bottom:1px solid #1a1a1a; opacity:0.55;">
                    <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                    <td style="${tdStyle} color:#888;">Skip</td>
                    <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                    <td style="${tdStyle} color:#888;">—</td>
                </tr>`;
                continue;
            }
            const clearColor = r.clearChance >= 0.95 ? '#4caf50' : r.clearChance >= 0.5 ? '#ff9800' : '#f44336';
            const successPct = ((r.successChance || 0) * 100).toFixed(1);
            const clearPct = ((r.clearChance || 0) * 100).toFixed(1);
            const rowRoomLevel = r.roomLevel ?? roomLevel;
            const xpPerRoom = r.xpPerRoom > 0 ? formatKMB(r.xpPerRoom) : '—';
            const breakdown = attr(this._skillingRowBreakdown(r, usesSkipLevels, clearRate, crateSummary));

            html += `<tr style="border-bottom:1px solid #1a1a1a; cursor:help;" title="${breakdown}">
                <td style="padding:3px 4px; color:#e0e0e0;">${r.skillName}</td>
                <td style="${tdStyle} color:#ccc;">${rowRoomLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.baseLevel}</td>
                <td style="${tdStyle} color:#ccc;">${r.effectiveLevel}</td>
                <td style="${tdStyle} color:#ccc;">${successPct}%</td>
                <td style="${tdStyle} color:${clearColor}; font-weight:600;">${clearPct}%</td>
                <td style="${tdStyle} color:#ccc;">${xpPerRoom}</td>
                <td style="${tdStyle} color:#888;">${r.attempts || 0}</td>
            </tr>`;
        }

        html += '</tbody></table>';
        container.innerHTML = html;
        this._setStatus(
            usesSkipLevels
                ? 'Skilling clear rates calculated from automation skip levels.'
                : `Skilling clear rates calculated for level ${roomLevel}.`
        );
    }

    /** @private */
    async _onSkillingUpgradeAnalyze() {
        if (this._skillingRunning || this._upgradeRunning || this._runStarting || this.isRunning) return;

        const roomLevel = this._getSkillingRoomLevels();
        const gameData = buildGameDataPayload();
        if (!gameData) {
            this._setStatus('No game data available.');
            return;
        }

        const editedDTOs = this._skillingEditor?.getEditedDTOs();
        if (!editedDTOs) {
            this._setStatus('No character data. Wait for editor to load.');
            return;
        }

        const selfHrid = this._skillingEditor.getSelfHrid();
        const dto = editedDTOs[selfHrid] || Object.values(editedDTOs)[0];
        if (!dto) {
            this._setStatus('No player data available.');
            return;
        }

        const crateHrids = this._getSkillingCrates();
        const targetSkill = this.panel.querySelector('#mwi-labsim-skilling-filter')?.value || null;
        const skillEquipmentMap = this._scopeSkillEquipmentMap(
            this._buildSkillEquipmentMap(gameData),
            dto,
            targetSkill,
            gameData
        );

        const progressEl = this.panel.querySelector('#mwi-labsim-skilling-progress');
        const resultsEl = this.panel.querySelector('#mwi-labsim-skilling-results');
        const calcBtn = this.panel.querySelector('#mwi-labsim-skilling-calc');
        const upgradeBtn = this.panel.querySelector('#mwi-labsim-skilling-upgrade');
        const stopBtn = this.panel.querySelector('#mwi-labsim-skilling-stop');
        progressEl.style.display = 'block';
        resultsEl.innerHTML = '';
        calcBtn.style.display = 'none';
        upgradeBtn.style.display = 'none';
        stopBtn.style.display = 'inline-block';
        this._skillingAborted = false;
        this._skillingRunning = true;
        // Stopped, or stale: a teardown bumps the token even when the same
        // character's panel is rebuilt, and the new run resets the flag
        const runToken = ++this._runStartToken;
        const isAborted = () => this._skillingAborted || runToken !== this._runStartToken;
        // The previous run's rows are about to be replaced, so ticks and answers
        // made against them mean nothing to the new table
        this._skillingAnalysis = null;
        this._skillingChecked = [];
        const goalResultsEl = this.panel.querySelector('#mwi-labsim-skilling-goal-results');
        if (goalResultsEl) goalResultsEl.innerHTML = '';
        this._updateSkillingCheckedCount();
        const eta = createEtaTracker();

        try {
            const analysisResult = await runSkillingUpgradeAnalysis(
                { editorDTO: dto, roomLevel, crateHrids, skillEquipmentMap, targetSkill },
                ({ current, total, description }) => {
                    if (isAborted()) return;
                    const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                    const { text: remaining } = eta.update(total > 0 ? current / total : 0);
                    if (fill) fill.style.width = `${Math.round((current / total) * 100)}%`;
                    if (text) {
                        text.textContent =
                            `${current} / ${total}` + (remaining ? ` · ${remaining}` : '') + `: ${description}`;
                    }
                },
                { abortSignal: isAborted }
            );

            // Community buffs are an argument to the skilling calculation rather
            // than anything on the character, so the shared analysis — which
            // works by applying a candidate to a DTO — has nowhere to put one.
            // They get a pass of their own, for the same reason house rooms do.
            await this._runSkillingCommunityPass({
                dto,
                roomLevel,
                crateHrids,
                skillEquipmentMap,
                targetSkill,
                gameData,
                analysisResult,
                isAborted,
                onProgress: ({ current, total, description }) => {
                    if (isAborted()) return;
                    const fill = this.panel.querySelector('#mwi-labsim-skilling-progress-fill');
                    const text = this.panel.querySelector('#mwi-labsim-skilling-progress-text');
                    if (fill) fill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 100}%`;
                    if (text) text.textContent = `Community buffs ${current} / ${total}: ${description}`;
                },
            });

            // The results element this run started drawing into, still where it
            // was. A skilling analysis is not a worker run — it is a main-thread
            // loop that yields between candidates — so the `cancelSimulation()`
            // a feature teardown fires never reached it, and a run that outlived
            // a character switch came back to a panel that had been rebuilt for
            // somebody else. Drawn anyway, it replaced `_skillingSortHandler`
            // with one bound to the torn-down container, leaving the arriving
            // character's own sort handler orphaned on their table — every
            // later render stacked another, and sorting the skilling results
            // silently stopped working.
            if (this.panel?.contains(resultsEl)) {
                const context = this._buildSkillingContext({
                    dto,
                    roomLevel,
                    crateHrids,
                    skillEquipmentMap,
                    targetSkill,
                    gameData,
                    analysisResult,
                });
                // One physical item that serves several rooms becomes one row,
                // before anything ranks or measures the per-skill halves of it
                if (analysisResult?.baseline && !isAborted()) {
                    mergeMultiSkillGearRows({
                        analysisResult,
                        baseSetup: context.baseSetup,
                        evaluate: context.evaluate,
                        roomLevel,
                        targetSkill,
                        gameData,
                    });
                }
                if (analysisResult?.baseline && !isAborted()) {
                    await annotateRoomsReached({
                        rows: analysisResult.results,
                        baseSetup: context.baseSetup,
                        evaluate: context.evaluate,
                        roomLevel,
                        targetSkill,
                        abortSignal: isAborted,
                    });
                }
                if (analysisResult?.baseline && this._getSkillingRoomLevelsOn() && !isAborted()) {
                    await this._measureSkillingRoomLevels(
                        context,
                        ({ current, total, description }) => {
                            if (isAborted()) return;
                            const fill = this.panel?.querySelector('#mwi-labsim-skilling-progress-fill');
                            const text = this.panel?.querySelector('#mwi-labsim-skilling-progress-text');
                            if (fill) fill.style.width = `${total > 0 ? Math.round((current / total) * 100) : 100}%`;
                            if (text) text.textContent = `Room levels ${current} / ${total}: ${description}`;
                        },
                        isAborted
                    );
                }
                if (this.panel?.contains(resultsEl) && runToken === this._runStartToken) {
                    this._skillingAnalysis = analysisResult?.baseline ? context : null;
                    this._renderSkillingUpgradeResults(analysisResult, resultsEl);
                }
            }
        } catch (error) {
            console.error('[LabSimUI] Skilling upgrade analysis failed:', error);
            if (runToken === this._runStartToken) {
                this._setStatus('Skilling upgrade analysis failed: ' + error.message);
            }
        } finally {
            if (runToken === this._runStartToken) this._skillingRunning = false;
            progressEl.style.display = 'none';
            calcBtn.style.display = '';
            upgradeBtn.style.display = '';
            stopBtn.style.display = 'none';
        }
    }

    /**
     * The per-skill kits, with the pieces a single-skill run cannot feel removed.
     *
     * A skilling run over one skill used to weigh every noncombat piece the kit
     * had on — a Cooking run spent a full room evaluation on "Holy Chisel +5 →
     * +7", a crafting tool that cannot change a cooking room by any amount, and
     * then printed the +0.00% as though it were a finding. `scopeEquipmentToSkill`
     * decides what stays from the item's own stats, so it keeps up with the item
     * data rather than with a list kept here.
     *
     * Only for a single-skill run. Across every skill each kit is the kit some
     * room is actually wearing, and a chisel is exactly what the Crafting room
     * wants weighed.
     *
     * The kit is materialised for the target skill even when no loadout is
     * assigned to it, because the analysis falls back to the character's base
     * equipment when the map has no entry — and the base equipment is the
     * unscoped kit this is trying to avoid.
     *
     * @private
     * @param {Object} skillEquipmentMap - From `_buildSkillEquipmentMap`
     * @param {Object} dto - The editor's player
     * @param {string|null} targetSkill - The skill being simmed, when only one is
     * @param {Object} gameData - From `buildGameDataPayload`
     * @returns {Object} A per-skill equipment map
     */
    _scopeSkillEquipmentMap(skillEquipmentMap, dto, targetSkill, gameData) {
        if (!targetSkill) return skillEquipmentMap;
        const worn = skillEquipmentMap?.[targetSkill] || dto?.equipment || {};
        return {
            ...skillEquipmentMap,
            [targetSkill]: scopeEquipmentToSkill(worn, targetSkill, gameData?.itemDetailMap || {}),
        };
    }

    /**
     * Weigh one more level of each community buff the rooms being run can feel.
     *
     * The skilling tab could see the buffs — they have been part of the baseline
     * since the adapter started reading them — but never asked what another
     * level of one would do, which is the question a player who watches the
     * Gathering Quantity buff tick up actually has.
     *
     * Results are appended to the analysis the shared advisor returned, so one
     * table set covers the whole run. The XP baseline is filled in here when the
     * advisor did not need one: it only pays for the XP pass when something it
     * generated is ranked on XP, and the Experience buff is not something it
     * generates.
     *
     * @private
     * @param {Object} params - The run, plus `analysisResult` to append to
     * @returns {Promise<void>}
     */
    async _runSkillingCommunityPass({
        dto,
        roomLevel,
        crateHrids,
        skillEquipmentMap,
        targetSkill,
        gameData,
        analysisResult,
        onProgress,
        isAborted = () => this._skillingAborted,
    }) {
        if (!analysisResult || isAborted()) return;

        const skills = targetSkill ? [targetSkill] : SKILLING_SKILL_HRIDS;
        const actionTypes = skills.map((hrid) => hrid.replace('/skills/', '/action_types/'));
        const candidates = generateSkillingCommunityBuffCandidates(
            dto.communityBuffLevels,
            actionTypes,
            this._getSkillingCommunityTargetLevel()
        );
        if (!candidates.length) return;

        // The same average the advisor's own baseline is, computed from the same
        // per-skill results so a delta is a difference rather than a comparison
        // of two ways of measuring
        const average = (results, key) => {
            const active = results.filter((r) => !r.skipped && (!targetSkill || r.skillHrid === targetSkill));
            if (!active.length) return 0;
            return active.reduce((sum, r) => sum + (r[key] || 0), 0) / active.length;
        };
        const evaluate = (player) =>
            computeSkillingClearRatesFromEditor(roomLevel, player, crateHrids, gameData, skillEquipmentMap);

        const baselineResults = evaluate(dto);
        const baselineClearRate = average(baselineResults, 'clearChance');
        const baselineXpPerRoom = average(baselineResults, 'xpPerRoom');

        if (analysisResult.baseline && !analysisResult.baseline.xpPerRoom) {
            analysisResult.baseline.xpPerRoom = baselineXpPerRoom;
        }

        let current = 0;
        for (const candidate of candidates) {
            // Yield so a Stop click and the progress paint can land between runs
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (isAborted()) break;

            onProgress?.({ current, total: candidates.length, description: candidate.description });

            const modified = JSON.parse(JSON.stringify(dto));
            modified.communityBuffLevels = { ...(modified.communityBuffLevels || {}) };
            modified.communityBuffLevels[candidate.buffKey] = candidate.upgradeLevel;

            const results = evaluate(modified);
            const clearRate = average(results, 'clearChance');
            const xpPerRoom = average(results, 'xpPerRoom');

            analysisResult.results.push({
                candidate,
                // Neither gold nor tokens nor guild credits: donated cowbells,
                // and the level is the whole server's donations rather than a
                // purchase, so these rows are read on their delta
                costType: 'community',
                cost: null,
                cowbellCost: candidate.cowbellCost,
                clearRate,
                clearRateDelta: clearRate - baselineClearRate,
                xpPerRoom,
                xpPerRoomDelta: xpPerRoom - baselineXpPerRoom,
                metricType: candidate.metric,
            });

            current++;
            onProgress?.({ current, total: candidates.length, description: candidate.description });
        }
    }

    /** @private */
    _renderSkillingUpgradeResults(analysisResult, container, options = {}) {
        // The "Checked swaps" table above the generated one: the same columns and
        // breakdown, with no pick boxes (Sim together and the planner work from
        // the generated table's rows) and no status line of its own
        const checked = Boolean(options.checked);
        const results = analysisResult?.results;
        if (!results || !results.length) {
            container.innerHTML = checked
                ? ''
                : '<div style="color:#888; font-size:12px; padding:20px 0; text-align:center;">No upgrade candidates found.</div>';
            if (!checked) this._setStatus('No skilling upgrade candidates found.');
            return;
        }

        const baseline = analysisResult.baseline;
        // Present only when the room-level pass ran. Everything it adds is
        // behind this one value, so a run without it draws what it always did
        // apart from the pick checkboxes.
        const roomLevels = analysisResult.roomLevels || null;
        const targetFloor = Math.max(0, Math.floor(Number(roomLevels?.targetFloor) || 0));
        const extraFields = (r) => {
            const levels = roomLevels ? roomLevelCells(r, roomLevels) : null;
            return {
                result: r,
                pickIdx: results.indexOf(r),
                ...(levels
                    ? {
                          roomLevelDelta: levels.delta,
                          roomLevelStr: levels.deltaStr,
                          roomLevelColor: levels.deltaColor,
                          floorVal: levels.floor,
                          floorStr: levels.floorStr,
                          levelTitle: levels.title,
                          reachesTarget: levels.reachesTarget,
                      }
                    : {}),
            };
        };
        const tokenResults = results.filter((r) => r.costType === 'token');
        const goldResults = results.filter((r) => r.costType === 'gold');
        const guildResults = results.filter((r) => r.costType === 'guild');
        const communityResults = results.filter((r) => r.costType === 'community');
        const thStyle =
            'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const thLeftStyle =
            'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333; cursor:pointer; user-select:none;';
        const tdStyle = 'padding:3px 4px; text-align:right;';
        // The same division the combat Upgrade tab makes: numbers right-aligned
        // and never wrapped, only the name column reflowing. A gear row's label
        // — "Maelstrom Plate Body ★ → Lumberjack's Top +5 (woodcutting)" — is
        // long enough to push every measured column off the panel on one line.
        const tdNameStyle =
            'padding:3px 4px; color:#e0e0e0; text-align:left; white-space:normal; ' +
            'overflow-wrap:anywhere; line-height:1.4;';

        const tokenRows = tokenResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const tokenCost = r.tokenCost || 0;
            const tokensPerPct = deltaVal > 0 ? Math.round(tokenCost / deltaVal) : Infinity;
            // The Experience token buys XP, not clears, so its two columns are
            // the ones that carry its case; every other row leaves them blank
            const isXpRow = r.metricType === 'xpPerRoom';
            const xpDelta = r.xpPerRoomDelta || 0;
            const tokensPerXp = r.tokensPerXp ?? Infinity;

            return {
                ...extraFields(r),
                desc: r.candidate?.description || '',
                tokenCost,
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: isXpRow ? '\u2014' : (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor: isXpRow ? '#888' : deltaColor,
                tokensPerPct,
                tokensPerPctStr: !isXpRow && deltaVal > 0 ? formatWithSeparator(tokensPerPct) : '\u2014',
                xpDelta,
                xpDeltaStr: isXpRow ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: isXpRow && xpDelta > 0 ? '#4caf50' : '#888',
                tokensPerXp,
                tokensPerXpStr:
                    isXpRow && Number.isFinite(tokensPerXp) ? formatWithSeparator(Math.round(tokensPerXp)) : '\u2014',
            };
        });

        const goldRows = goldResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const goldPerPct = goldPerPercent(r.cost, deltaVal);
            // A skilling piece replacing combat armour is priced at the piece
            // alone — the plate goes back in the loadout, not on the market — and
            // a row whose cost is suspiciously *high* has to say why, the same
            // way the labyrinth's forced armor swaps do
            const kept = r.candidate?.keptItems || [];

            return {
                ...extraFields(r),
                desc: r.candidate?.description || '',
                cost: Number.isFinite(r.cost) ? r.cost : Infinity,
                costStr: goldCostCell(r.cost),
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, deltaVal),
                // Whatever handoff buttons the shared builder emits — the same
                // ones the combat Upgrade tab's gear rows carry, since a
                // skilling tool is bought in exactly the same marketplace
                actions: combatSimUI.upgradeRowActionsHtml(r),
                roomsAffected: r.rooms?.affected ?? -1,
                roomsStr: r.rooms ? `${r.rooms.affected} / ${r.rooms.total}` : '\u2014',
                roomsTitle: r.rooms
                    ? `Moves ${r.rooms.affected} of the ${r.rooms.total} rooms in scope; the rest are unaffected.`
                    : '',
                tries: r.tries ?? Infinity,
                triesStr: Number.isFinite(r.tries) ? r.tries.toFixed(1) : '\u2014',
                triesDelta: r.triesDelta ?? 0,
                triesDeltaStr: Number.isFinite(r.triesDelta)
                    ? (r.triesDelta > 0 ? '+' : '') + r.triesDelta.toFixed(2)
                    : '\u2014',
                triesDeltaColor: r.triesDelta < -1e-9 ? '#4caf50' : r.triesDelta > 1e-9 ? '#f44336' : '#888',
                keptNote: kept.length
                    ? r.candidate?.keptUnreached
                        ? `Costed as the new piece alone. ${kept
                              .map(
                                  (item) =>
                                      itemName(item.hrid) + (item.enhancementLevel ? ` +${item.enhancementLevel}` : '')
                              )
                              .join(', ')}: resale deliberately not credited, ${skillingKeptReason(r.candidate)}`
                        : `Costed as the new piece alone. ${kept
                              .map(
                                  (item) =>
                                      itemName(item.hrid) + (item.enhancementLevel ? ` +${item.enhancementLevel}` : '')
                              )
                              .join(
                                  ', '
                              )} is combat gear you keep in a loadout, so its resale is deliberately not credited — selling it to fund skilling gear is not a trade anybody makes.`
                    : '',
                // The same click-to-expand the combat tab's gold rows carry. A
                // Cost column with no way to ask what is behind it is exactly
                // where a dash reads as free and a kept-gear price reads as wrong
                detailHtml: this._renderClearRateCostDetail(r, baseline),
            };
        });

        // A shrine level is bought with guild credits and guild tokens at once \u2014
        // neither the token table nor the gold table can price it, so it gets its
        // own with both halves side by side
        const guildRows = guildResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const cost = r.cost || 0;
            const goldPerPct = goldPerPercent(r.cost, deltaVal);
            const xpDelta = r.xpPerRoomDelta || 0;

            return {
                ...extraFields(r),
                desc: r.candidate?.description || '',
                cost,
                costStr: r.cost == null ? '\u2014' : formatWithSeparator(cost),
                tokenCost: r.tokenCost || 0,
                tokenCostStr: formatWithSeparator(r.tokenCost || 0),
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor,
                goldPerPct,
                goldPerPctStr: goldPerPctCell(r.cost, deltaVal),
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '\u2014',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
                shrineNote: r.candidate?.needsShrineLevel
                    ? `Needs your guild's shrine at level ${r.candidate.needsShrineLevel} first`
                    : '',
            };
        });

        // A community buff level is not bought by anybody in particular — it is
        // what the server's donated minutes add up to — so there is no cost
        // column to rank on and the rows are read on their delta alone. The
        // cowbells-per-minute the game charges to keep the buff running is the
        // one real price there is, and it is shown as what it is.
        const communityRows = communityResults.map((r) => {
            const clearRate = (r.clearRate || 0) * 100;
            const deltaVal = (r.clearRateDelta || 0) * 100;
            const deltaColor = deltaVal > 0 ? '#4caf50' : deltaVal < 0 ? '#f44336' : '#888';
            const xpDelta = r.xpPerRoomDelta || 0;
            const isXpRow = r.metricType === 'xpPerRoom';

            return {
                ...extraFields(r),
                desc: r.candidate?.description || '',
                cowbellCost: r.cowbellCost ?? Infinity,
                cowbellCostStr: r.cowbellCost == null ? '—' : formatWithSeparator(r.cowbellCost) + '/min',
                clearRate,
                clearRateStr: clearRate.toFixed(1) + '%',
                deltaVal,
                deltaStr: isXpRow ? '—' : (deltaVal >= 0 ? '+' : '') + deltaVal.toFixed(2) + '%',
                deltaColor: isXpRow ? '#888' : deltaColor,
                xpDelta,
                xpDeltaStr: Math.abs(xpDelta) > 1e-9 ? (xpDelta >= 0 ? '+' : '') + xpDelta.toFixed(1) : '—',
                xpDeltaColor: xpDelta > 0 ? '#4caf50' : '#888',
            };
        });

        const sortState = {
            token: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'tokensPerPct', dir: 'asc' },
            gold: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'goldPerPct', dir: 'asc' },
            guild: roomLevels ? { key: 'roomLevelDelta', dir: 'desc' } : { key: 'goldPerPct', dir: 'asc' },
            community: { key: 'deltaVal', dir: 'desc' },
        };

        const sortRows = (rows, key, dir) => {
            rows.sort((a, b) => {
                const av = a[key],
                    bv = b[key];
                if (typeof av === 'string') return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
                return dir === 'asc' ? av - bv : bv - av;
            });
        };

        const arrow = (dir) => (dir === 'asc' ? ' \u25B2' : ' \u25BC');

        const pickTh = '<th style="width:1%; border-bottom:1px solid #333;"></th>';
        const pickCellHtml = (row) =>
            checked
                ? '<td style="padding:3px 4px; width:1%;"></td>'
                : `<td style="padding:3px 4px; width:1%;"><input type="checkbox" data-skilling-pick="${row.pickIdx}"` +
                  `${this._skillingChecked.includes(row.pickIdx) ? ' checked' : ''} style="margin:0; cursor:pointer;" ` +
                  `title="Check to include in Sim together"></td>`;
        const roomLevelCellsHtml = (row) => {
            if (!roomLevels) return '';
            const floorColor = row.reachesTarget ? '#4caf50' : '#888';
            const reached = row.reachesTarget ? ' font-weight:700;' : '';
            return (
                `<td style="${tdStyle} color:${row.roomLevelColor}; font-weight:600;" title="${escapeHtmlAttribute(row.levelTitle)}">${row.roomLevelStr}</td>` +
                `<td data-reaches-target="${row.reachesTarget ? 1 : 0}" style="${tdStyle} color:${floorColor};${reached}" title="${escapeHtmlAttribute(row.levelTitle)}">${row.floorStr}</td>`
            );
        };
        const renderRoomLevelSummary = () => {
            const bar = `${Math.round((roomLevels.threshold || 0) * 100)}%`;
            const parts = [];
            if (roomLevels.baselineCleared) {
                parts.push(
                    `Today this setup clears room level <b>${roomLevels.baselineLevel}</b> at an average ${bar} — ` +
                        `floor <b>${roomLevels.baselineFloor}</b> finished` +
                        (roomLevels.baselineFloor > 0
                            ? ` (its exit room is level ${labyrinthFloorClearLevel(roomLevels.baselineFloor)})`
                            : '') +
                        '.'
                );
                parts.push(
                    `Levels is what the top ${roomLevels.shortlistSize} upgrades move that by; every other row ` +
                        'shows a dash because it was not searched.'
                );
            } else {
                parts.push(`No room level cleared at an average ${bar}, so there is no level to move.`);
            }
            if (targetFloor > 0) {
                const need = labyrinthFloorClearLevel(targetFloor);
                parts.push(
                    `Floor ${targetFloor} needs room level <b>${need}</b> — its exit room — ` +
                        `which is ${need - roomLevels.baselineLevel > 0 ? `${need - roomLevels.baselineLevel} levels away` : 'already cleared'}.`
                );
            }
            if (roomLevels.aborted) parts.push('Stopped early: the rows below it were never searched.');
            if (roomLevels.stale) {
                parts.push(
                    '<b>Target clear % has changed since these levels were measured: re-run Analyze Upgrades to re-measure.</b>'
                );
            }
            return (
                `<div data-skilling-room-level-summary style="margin:0 0 8px; padding:5px 8px; font-size:11px; color:#9ab; line-height:1.5; ` +
                `background:rgba(120,150,190,0.10); border:1px solid rgba(120,150,190,0.25); border-radius:5px;">` +
                parts.join(' ') +
                `</div>`
            );
        };

        const renderTokenTable = () => {
            const s = sortState.token;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="token" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Token Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:12px;">';
            html += `<thead><tr>
                ${pickTh}${th('Upgrade', 'desc', 'left')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}${roomLevels ? th('Levels', 'roomLevelDelta', 'right') + th('Floor', 'floorVal', 'right') : ''}
                ${th('Tokens/1%', 'tokensPerPct', 'right')}
                ${th('XP/Room', 'xpDelta', 'right')}
                ${th('Tokens/XP', 'tokensPerXp', 'right')}
            </tr></thead><tbody>`;

            for (const row of tokenRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    ${pickCellHtml(row)}<td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCost || '\u2014'}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.tokensPerPctStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                    <td style="${tdStyle} color:#888;">${row.tokensPerXpStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            return html;
        };

        const renderGuildTable = () => {
            const s = sortState.guild;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="guild" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Guild Shrines</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${pickTh}${th('Upgrade', 'desc', 'left')}
                ${th('Credits', 'cost', 'right')}
                ${th('Tokens', 'tokenCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}${roomLevels ? th('Levels', 'roomLevelDelta', 'right') + th('Floor', 'floorVal', 'right') : ''}
                ${th('Gold/1%', 'goldPerPct', 'right')}
                ${th('XP/Room', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of guildRows) {
                const note = row.shrineNote ? ` title="${row.shrineNote}"` : '';
                html += `<tr style="border-bottom:1px solid #1a1a1a;"${note}>
                    ${pickCellHtml(row)}<td style="${tdNameStyle}">${row.desc}${row.shrineNote ? ' <span style="color:#ff9800;">*</span>' : ''}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.tokenCostStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                Credits are valued at the cheapest items that convert into them. Guild tokens are counted, not
                priced — nothing converts into them — so Gold/1% covers the credits only.${
                    guildRows.some((row) => row.shrineNote)
                        ? ' <span style="color:#ff9800;">*</span> needs a guild shrine upgrade first.'
                        : ''
                }
            </div>`;
            return html;
        };

        const renderCommunityTable = () => {
            const s = sortState.community;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="community" style="${style}">${label}${ind}</th>`;
            };

            let html = `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Community Buffs</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-bottom:4px;">';
            html += `<thead><tr>
                ${pickTh}${th('Upgrade', 'desc', 'left')}
                ${th('Cowbells', 'cowbellCost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}${roomLevels ? th('Levels', 'roomLevelDelta', 'right') + th('Floor', 'floorVal', 'right') : ''}
                ${th('XP/Room', 'xpDelta', 'right')}
            </tr></thead><tbody>`;

            for (const row of communityRows) {
                html += `<tr style="border-bottom:1px solid #1a1a1a;">
                    ${pickCellHtml(row)}<td style="${tdNameStyle}">${row.desc}</td>
                    <td style="${tdStyle} color:#ccc;">${row.cowbellCostStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:${row.xpDeltaColor}; font-weight:600;">${row.xpDeltaStr}</td>
                </tr>`;
            }
            html += '</tbody></table>';
            html += `<div style="color:#666; font-size:10px; margin-bottom:12px;">
                A community buff's level is what the whole server's donated minutes add up to, so there is no price
                for one more level to rank on — the cowbell figure is what the game charges per minute to keep the
                buff running. A buff already at Lv${MAX_COMMUNITY_BUFF_LEVEL} (max) has no next level and is left out.
            </div>`;
            return html;
        };

        const renderGoldTable = () => {
            const s = sortState.gold;
            const th = (label, key, align) => {
                const style = align === 'left' ? thLeftStyle : thStyle;
                const ind = s.key === key ? arrow(s.dir) : '';
                return `<th data-sort-key="${key}" data-table="gold" style="${style}">${label}${ind}</th>`;
            };

            let html = checked
                ? this._checkedHeadingHtml('skilling')
                : `<div style="color:${ACCENT}; font-weight:700; font-size:12px; margin-bottom:4px;">Gear Upgrades</div>`;
            html += '<table style="width:100%; border-collapse:collapse; font-size:11px;">';
            html += `<thead><tr>
                ${pickTh}${th('Upgrade', 'desc', 'left')}
                ${th('Cost', 'cost', 'right')}
                ${th('Clear Rate', 'clearRate', 'right')}
                ${th('Delta', 'deltaVal', 'right')}${roomLevels ? th('Levels', 'roomLevelDelta', 'right') + th('Floor', 'floorVal', 'right') : ''}
                ${th('Gold/1%', 'goldPerPct', 'right')}
                ${th('Rooms', 'roomsAffected', 'right')}
                ${th('Tries', 'tries', 'right')}
                ${th('\u0394Tries', 'triesDelta', 'right')}
            </tr></thead><tbody>`;

            goldRows.forEach((row, i) => {
                const note = ` title="${escapeHtmlAttribute(row.keptNote || 'Click for the cost breakdown')}"`;
                html += `<tr data-skilling-gold-row="${i}" style="border-bottom:1px solid #1a1a1a; cursor:pointer;"${note}>
                    ${pickCellHtml(row)}<td style="${tdNameStyle}">${row.desc}${row.actions}${row.keptNote ? ' <span style="color:#ff9800;">*</span>' : ''}</td>
                    <td style="${tdStyle} color:#ccc;">${row.costStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.clearRateStr}</td>
                    <td style="${tdStyle} color:${row.deltaColor}; font-weight:600;">${row.deltaStr}</td>
                    ${roomLevelCellsHtml(row)}
                    <td style="${tdStyle} color:#888;">${row.goldPerPctStr}</td>
                    <td style="${tdStyle} color:${row.roomsAffected < 0 ? '#666' : '#8ab4f8'};" title="${escapeHtmlAttribute(row.roomsTitle)}">${row.roomsStr}</td>
                    <td style="${tdStyle} color:#ccc;">${row.triesStr}</td>
                    <td style="${tdStyle} color:${row.triesDeltaColor};">${row.triesDeltaStr}</td>
                </tr>
                <tr data-skilling-gold-detail="${i}" style="display:none;">
                    <td colspan="${9 + (roomLevels ? 2 : 0)}" style="padding:6px 10px; background:#0d0d1a; border-bottom:1px solid #222;">
                        <div data-skill-breakdown style="margin-bottom:4px; font-size:11px;"></div>
                        ${row.detailHtml}
                    </td>
                </tr>`;
            });
            html += '</tbody></table>';
            if (goldRows.some((row) => row.keptNote)) {
                html += `<div style="color:#666; font-size:10px; margin-top:4px;">
                    <span style="color:#ff9800;">*</span> priced as the new piece alone: the combat gear it goes in
                    place of is kept for its loadout, so its resale is not credited against the purchase.
                </div>`;
            }
            return html;
        };

        const renderAll = () => {
            sortRows(tokenRows, sortState.token.key, sortState.token.dir);
            sortRows(goldRows, sortState.gold.key, sortState.gold.dir);
            sortRows(guildRows, sortState.guild.key, sortState.guild.dir);
            sortRows(communityRows, sortState.community.key, sortState.community.dir);
            const baselineXp = baseline?.xpPerRoom || 0;
            let html = `<div style="color:#888; font-size:11px; margin-bottom:8px;">
                Baseline Avg Clear: <span style="color:#e0e0e0; font-weight:600;">${((baseline?.clearRate || 0) * 100).toFixed(1)}%</span>
                ${baselineXp > 0 ? ` · Avg XP/Room: <span style="color:#e0e0e0; font-weight:600;">${baselineXp.toFixed(1)}</span>` : ''}
            </div>`;
            if (roomLevels) html += renderRoomLevelSummary();
            if (tokenRows.length > 0) html += renderTokenTable();
            if (guildRows.length > 0) html += renderGuildTable();
            if (communityRows.length > 0) html += renderCommunityTable();
            if (goldRows.length > 0) html += renderGoldTable();
            container.innerHTML = html;
            // Re-wired on every render: a sort rebuilds the tables, and buttons
            // wired to the elements it threw away do nothing at all
            combatSimUI.wireUpgradeRowActions(container, 'LabSimUI');
            if (checked) this._wireCheckedHeading('skilling', container);
        };

        renderAll();

        if (!checked)
            this._addCsvExport(container, 'labsim-skilling-upgrades', () => ({
                columns: [
                    { key: 'upgrade', label: 'Upgrade' },
                    { key: 'skill', label: 'Skill' },
                    { key: 'paidIn', label: 'Paid in' },
                    { key: 'cost', label: 'Gold cost' },
                    { key: 'tokenCost', label: 'Token cost' },
                    { key: 'clearRate', label: 'Avg clear rate' },
                    { key: 'clearRateDelta', label: 'Clear rate change' },
                    { key: 'perPercent', label: 'Cost per +1%' },
                    { key: 'xpPerRoomDelta', label: 'XP/room change' },
                    { key: 'tokensPerXp', label: 'Tokens per +1 XP/room' },
                ],
                rows: results.map((r) => {
                    const paid = r.costType === 'token' ? r.tokenCost : r.cost;
                    const gain = (r.clearRateDelta || 0) * 100;
                    return {
                        upgrade: r.candidate?.description || '',
                        // Gear bought for one skill says which; an enhancement of
                        // something worn everywhere has no one skill to name
                        // a merged piece names every skill it serves
                        skill: (r.candidate?.skillKey ? [r.candidate.skillKey] : r.candidate?.skillKeys || [])
                            .map((key) => String(key).replace('/skills/', ''))
                            .join(', '),
                        paidIn: CSV_PAID_IN[r.costType] || 'gold',
                        cost: r.costType === 'token' ? null : (r.cost ?? null),
                        tokenCost: r.costType === 'gold' || r.costType === 'community' ? null : (r.tokenCost ?? null),
                        clearRate: r.clearRate ?? null,
                        clearRateDelta: r.clearRateDelta ?? null,
                        perPercent: gain > 0 && paid ? Math.round(paid / gain) : null,
                        xpPerRoomDelta: r.xpPerRoomDelta ?? null,
                        tokensPerXp: Number.isFinite(r.tokensPerXp) ? Math.round(r.tokensPerXp) : null,
                    };
                }),
            }));

        // The container persists across Analyze runs — replace the previous
        // sort handler instead of stacking a new one each analysis
        // (the checked-swaps table keeps its own handler, on its own container)
        const handlerField = checked ? '_skillingSwapSortHandler' : '_skillingSortHandler';
        if (this[handlerField]) {
            container.removeEventListener('click', this[handlerField]);
        }
        this[handlerField] = (e) => {
            // A pick box is a choice about the row, not a click on the row
            const pick = e.target.closest('input[data-skilling-pick]');
            if (pick) {
                this._toggleSkillingPick(Number(pick.dataset.skillingPick), pick.checked);
                return;
            }
            // A row's own handoff buttons come first — a click on "Buy" is not a
            // request to unfold the row it sits in
            const expandable = e.target.closest('tr[data-skilling-gold-row]');
            if (expandable && !e.target.closest('[data-buy-action]')) {
                const detail = container.querySelector(
                    `[data-skilling-gold-detail="${expandable.dataset.skillingGoldRow}"]`
                );
                if (detail) {
                    detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
                    // Worked out on first look: it is a few room evaluations per
                    // row, which nobody pays for the rows they never open
                    const slot = detail.querySelector('[data-skill-breakdown]');
                    if (slot && !slot.dataset.filled) {
                        slot.dataset.filled = '1';
                        slot.innerHTML = this._renderSkillBreakdown(
                            goldRows[Number(expandable.dataset.skillingGoldRow)]?.result
                        );
                    }
                }
                return;
            }
            const th = e.target.closest('th[data-sort-key]');
            if (!th) return;
            const table = th.dataset.table;
            const key = th.dataset.sortKey;
            const state = sortState[table];
            if (state.key === key) {
                state.dir = state.dir === 'desc' ? 'asc' : 'desc';
            } else {
                state.key = key;
                state.dir = key === 'desc' ? 'asc' : 'desc';
            }
            renderAll();
        };
        container.addEventListener('click', this[handlerField]);

        if (checked) return;
        this._updateSkillingCheckedCount();
        this._setStatus(`${results.length} skilling upgrade candidates analyzed.`);
    }

    /**
     * Open the panel.
     *
     * @param {Object} [options] - `remember: false` when reopening at start-up,
     *   so restoring a panel is not itself recorded as opening one
     */
    show({ remember = true } = {}) {
        if (!this.panel) return;
        if (remember) saveOpenState(GEOMETRY_KEY, true);

        this.panel.style.display = 'flex';
        bringPanelToFront(this.panel);
        this._populateMonsters();

        if (!this._editor.isInitialized()) {
            this._editor.initEditor();
            // The first monster in the list is selected but was never chosen,
            // so the handler that applies its labyrinth loadout never ran — the
            // default monster opened on whatever gear happened to be on, which
            // is the one case where the panel silently disagreed with every
            // other monster in the list.
            //
            // Only on the first initialization: reapplying on every open would
            // throw away gear changed by hand since.
            this._whenEditorReady().then(() => {
                const selected = this.panel?.querySelector('#mwi-labsim-monster')?.value;
                if (selected) this._onMonsterChange(selected);
            });
        }
    }

    /** @param {Object} [options] - `remember: false` to close without forgetting it was open */
    hide({ remember = true } = {}) {
        if (!this.panel) return;
        if (remember) saveOpenState(GEOMETRY_KEY, false);
        this.panel.style.display = 'none';
    }

    toggle() {
        if (!this.panel) return;
        if (this.panel.style.display !== 'none') this.hide();
        else this.show();
    }

    /**
     * Reopen if the page was left with this panel up.
     *
     * The waiting is `panel-geometry.js`'s: the answer lives in IndexedDB, which
     * is not open yet when the panel is built.
     */
    restore() {
        reopenIfLeftOpen(GEOMETRY_KEY, () => this.show({ remember: false }));
    }

    /**
     * Open the panel preconfigured from a labyrinth tile: combat tiles select
     * the monster (applying its assigned labyrinth loadout) at the tile's room
     * level; skilling tiles open the Skilling tab with the room level set and
     * the skill's loadout row filtered.
     * @param {Object} detail - { monsterHrid?, skillHrid?, roomLevel? }
     */
    async openPreconfigured(detail = {}) {
        if (!this.panel) return;
        if (this.panel.style.display === 'none') {
            this.show();
        } else {
            bringPanelToFront(this.panel);
        }
        // A minimized panel has its tab bar and every body hidden; switching a
        // tab on it would show one body under no tab bar. Unfold first so the
        // requested tab, switched to below, is what ends up visible.
        this.minimizeCtl?.setCollapsed(false);

        const roomLevel = Math.round(Number(detail.roomLevel) || 0);

        if (detail.monsterHrid) {
            this._switchTab('configure');
            const select = this.panel.querySelector('#mwi-labsim-monster');
            if (select) select.value = detail.monsterHrid;
            if (roomLevel > 0) {
                const levelInput = this.panel.querySelector('#mwi-labsim-level');
                if (levelInput) levelInput.value = roomLevel;
            }
            // Applying the assigned loadout needs the editor loaded
            await this._whenEditorReady();
            this._onMonsterChange(detail.monsterHrid);
        } else if (detail.skillHrid) {
            this._switchTab('skilling');
            if (roomLevel > 0) {
                const useSkip = this.panel.querySelector('#mwi-labsim-skilling-useskip');
                const levelInput = this.panel.querySelector('#mwi-labsim-skilling-level');
                if (useSkip) useSkip.checked = false;
                if (levelInput) {
                    levelInput.disabled = false;
                    levelInput.value = roomLevel;
                }
            }
            const filter = this.panel.querySelector('#mwi-labsim-skilling-filter');
            if (filter && [...filter.options].some((o) => o.value === detail.skillHrid)) {
                filter.value = detail.skillHrid;
                filter.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    /**
     * Wait (up to ~10s) for the configure editor to finish initializing.
     * @private
     * @returns {Promise<boolean>} True when the editor is ready
     */
    async _whenEditorReady() {
        for (let i = 0; i < 40; i++) {
            if (this._editor?.isInitialized()) return true;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return this._editor?.isInitialized() || false;
    }

    destroy() {
        if (this._openRequestHandler) {
            document.removeEventListener('mwi-labsim-open', this._openRequestHandler);
            this._openRequestHandler = null;
        }
        if (this.elapsedTimer) {
            clearInterval(this.elapsedTimer);
            this.elapsedTimer = null;
        }
        this._detachDrag?.();
        this._detachDrag = null;
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (this.panel) {
            unregisterFloatingPanel(this.panel);
            this.panel.remove();
            this.panel = null;
        }
        this.isRunning = false;
        this._runStartToken++;
        this._runStarting = false;
        this._upgradeRunning = false;
        this._upgradeAborted = true;
        this._skillingRunning = false;
        // A reading of one character's build and the ticks made on it
        this._skillingAnalysis = null;
        this._skillingChecked = [];
        this._skillingGoalKey = null;
        // The next build reads every grouped key back and notes it again
        this._storedValues.clear();
        this._upgradeRunStarted = false;
        // Queued swaps belong to the character being torn down; the arriving one
        // reads its own back from storage
        this._checkedSwaps = { combat: [], skilling: [] };
        this._swapOptions = sanitizeSwapOptions(null);
        this._swapsLoaded = false;
        this._optionEdits = [];
        this._upgradeOrderSection = null;
        this._clearVerify();
        this._triggerChoices = sanitizeLabTriggerChoices(null);
        this._triggerTargets = { scopeMode: 'current', groups: [], note: '' };
        // What the last result found, shown on the Tune triggers header while it is collapsed
        this._triggerSummary = '';
        this._triggerRefreshSeq++;
        clearTimeout(this._editorEditTimer);
        this._editorEditTimer = null;
        this._editorEditSig = null;
        if (this._editor) this._editor.reset();
        if (this._skillingEditor) this._skillingEditor.reset();
        this._maxLevel = null;
        this._labyResults = null;
        this._upgradeTargetHrids = null;
        // "I picked a crate by hand" is a choice about the panel that is being
        // torn down here, not a standing preference. destroy() runs on a
        // character switch (the feature is disabled and re-initialised around
        // it), so leaving these set means the arriving character's freshly
        // built dropdowns skip _applyEquippedCratesTo and sit on the markup's
        // hardcoded Expert — scoring their fight against crates they may not
        // own, silently, until they notice and touch the dropdown themselves.
        this._skillingCratesUserSet = false;
        this._combatCratesUserSet = false;
        // Typed-over token levels are per-panel state, not a standing
        // preference; the stored value is re-read by the next build's
        // _restoreTokenBuffLevels().
        this._tokenBuffOverrides = {};
        // Every sim behind this panel is a worker run, and the feature's
        // `disable()` rejects all of them through `cancelSimulation()` — except
        // the Skilling tab's upgrade analysis, which is main-thread arithmetic
        // that yields between candidates and stops only when this flag is set.
        // Nothing set it here, so a switch left it running against the
        // departing character's build: it kept burning CPU, and its progress
        // callbacks re-read `this.panel` on every tick, so once the arriving
        // character's panel was built it drove *their* progress bar and text
        // from a run that was never theirs — with the Stop button that could
        // have ended it torn down along with the panel it belonged to.
        this._skillingAborted = true;
        // Everything below is a reading of one character's build. None of it is
        // re-derived on the way back in — `_maxLevelByMonster` is consulted only
        // when a monster is missing from it, and the rest is simply redrawn — so
        // left standing it becomes the arriving character's answer.
        //
        // `_maxLevelByMonster` is the worst of them: the highest room level that
        // character could clear, fed straight into the next fight setup as
        // `simMaxLevel`.
        this._maxLevelByMonster = {};
        this._allFightsResult = null;
        this._upgradePlayerName = null;
        this._houseScanNote = null;
        this._restoredUpgradeAt = null;
        this._restoredUpgradeMeta = null;
        // A fresh store rather than a cleared one: the runs live in storage, and
        // the next panel should read them back rather than start empty
        this._comparison = new LabComparisonStore();
    }

    /**
     * Let the panel be dragged by its header, remembering where it is dropped.
     *
     * The shared helper rather than a local copy: it carries the click-vs-drag
     * guard and the pointer/touch handling, and — the point of the change — a
     * drop that actually goes somewhere is written to the geometry store, so the
     * panel stops snapping back to the top-right corner on every reload.
     *
     * @param {HTMLElement} handle - The bar you grab
     * @private
     */
    _setupDrag(handle) {
        this._detachDrag?.();
        this._detachDrag = makeDraggable(this.panel, handle, (position) => {
            saveGeometry(GEOMETRY_KEY, { left: parseFloat(position.left), top: parseFloat(position.top) });
        });
    }

    /**
     * Remember how big the panel is, and where its left edge ended up.
     *
     * The left grip moves the left edge as it resizes, so a saved size without
     * the position it was reached at would put the panel back somewhere it never
     * was.
     *
     * @private
     */
    _persistPanelGeometry() {
        if (!this.panel) return;
        const rect = this.panel.getBoundingClientRect();
        saveGeometry(GEOMETRY_KEY, {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
        });
    }

    /**
     * Put the panel back where and how it was left.
     *
     * Clamping lives in `panel-geometry.js`, so geometry saved in a larger window
     * cannot open the panel off-screen or wider than it can be resized back from.
     *
     * @private
     */
    _restorePanelGeometry() {
        restoreGeometry(this.panel, GEOMETRY_KEY, { width: MIN_PANEL_WIDTH, height: MIN_PANEL_HEIGHT });
    }

    /**
     * The two bottom corner grips.
     *
     * Kept bespoke rather than moved to `makeResizable`, which only offers the
     * bottom-right corner — the left grip, which holds the right edge still while
     * the left one follows the cursor, is the whole reason a panel docked against
     * the right of the screen can be widened at all.
     *
     * @param {HTMLElement} handle - The grip
     * @param {'left'|'right'} [corner] - Which corner it sits in
     * @private
     */
    _setupResize(handle, corner = 'right') {
        handle.style.touchAction = 'none';
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = this.panel.offsetWidth;
            const startHeight = this.panel.offsetHeight;
            // The panel opens anchored to the right of the window; growing it
            // leftwards means moving its left edge, so pin the position it is
            // at now and drive it from the left from here on
            const startLeft = this.panel.getBoundingClientRect().left;
            this.panel.style.left = `${startLeft}px`;
            this.panel.style.right = 'auto';
            bringPanelToFront(this.panel);

            const onMove = (ev) => {
                const dx = ev.clientX - startX;
                const newWidth = Math.max(MIN_PANEL_WIDTH, corner === 'left' ? startWidth - dx : startWidth + dx);
                const newHeight = Math.max(MIN_PANEL_HEIGHT, startHeight + (ev.clientY - startY));
                // Clamped at the minimum the left edge stops moving too, rather
                // than sliding the panel along while it refuses to shrink
                if (corner === 'left') this.panel.style.left = `${startLeft + (startWidth - newWidth)}px`;
                this.panel.style.width = `${newWidth}px`;
                this.panel.style.height = `${newHeight}px`;
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                this._persistPanelGeometry();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }
}

/**
 * What a whole-run analysis has just committed to, in one sentence.
 *
 * Nothing about the Upgrade tab is refused for being large any more — ability
 * swaps across a full labyrinth used to be, and the refusal landed on the one
 * scope where the question is most worth asking. What replaces the refusal is
 * this: the count is put in front of the player before the first simulation,
 * while Stop still costs nothing, and if the run is large enough that each
 * simulation has been shortened to fit, the sentence says so rather than letting
 * a noisier table pass for the same table.
 *
 * @param {Object} plan - The `plan` an all-fights analysis reports up front
 * @returns {string} Status line text
 */
export function describeAllFightsPlan(plan) {
    if (!plan) return '';
    const head =
        `${plan.candidates.toLocaleString()} upgrades across ${plan.fights} fights — ` +
        `${plan.sims.toLocaleString()} simulations (each upgrade only in the rooms it reaches)`;
    if (!plan.reduced) return `${head}. Stop cancels at any point.`;
    return (
        `${head}. Big enough that each one runs ${Math.round(plan.trialScale * 100)}% of the ${plan.requestedHours}h ` +
        'asked for — every fight is still simulated, the win rates are just noisier. Stop cancels at any point.'
    );
}

/**
 * Which build guide each loadout was read as playing, in one clause.
 *
 * The swap generator narrows a loadout to its archetype's own ability set when
 * it can name the archetype off the weapon, and falls back to offering every
 * style-compatible ability in the game when it cannot. Those are different
 * questions producing differently trustworthy tables, and after pooling the
 * results carry no trace of which loadout got which. A loadout that fell back is
 * the one a reader most needs to know about: its rows came out of a search wide
 * enough that the guide's own answer may not be in them at all.
 *
 * @param {Array<Object>} archetypes - `[{loadoutName, archetype, label}]` from the analysis
 * @returns {string} Status clause, empty when there is nothing to report
 */
export function describeArchetypes(archetypes) {
    if (!archetypes?.length) return '';
    const parts = archetypes.map((entry) => {
        const name = entry.loadoutName || 'Loadout';
        if (!entry.archetype) return `${name} → no archetype (all abilities offered)`;
        return `${name} → ${entry.label || entry.archetype}`;
    });
    return ` Swaps: ${parts.join(', ')}.`;
}

const labSimUI = new LabSimUI();
export default labSimUI;
