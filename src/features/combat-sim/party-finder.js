/**
 * Party Finder: which party, from your saved teammates, does best for YOU?
 *
 * The arithmetic half of the Combat Sim's Party tab — kept free of the DOM so every rule
 * can be tested on its own. Given you, a roster and a set of zone/tiers, it plans every
 * party worth simming (you alone, then you plus every combination of teammates up to the
 * zone's party cap), builds each party's player DTOs, reads one finished sim into a row
 * for you alone, and ranks the rows against your solo baseline in the same zone/tier.
 *
 * The rules this follows are the All Zones sweep's (`_onSimulateAllZones` in
 * `combat-sim-ui.js`), checked off one by one in the module that runs it:
 *
 * - Figures are always yours (player1): your XP, deaths and your share of the drops,
 *   priced by `calculateSimRevenue` — never the party's sum.
 * - A party's level-gap penalties are recomputed for that party; alone, there is none.
 * - Ordinary zones take at most 3 players, dungeons 5.
 * - An unpriced drop, consumable or key is counted at zero by the pricing helper; such a
 *   row says so rather than passing its profit off as complete. A row whose pricing
 *   threw has no profit at all (null), never 0.
 * - Profit is bounded by market volume where the cache already knows the answer, display
 *   only, the same cache-only cap All Zones applies.
 */

import { calculateSimRevenue, recomputeLevelGapDebuffs } from './combat-sim-adapter.js';
import { capProfitRateCached } from '../../utils/liquidity-cap.js';
import { isAuraAbility } from '../../utils/party-lint.js';
import { buildFingerprint } from './party-roster.js';

/** Largest party the game lets into an ordinary combat zone */
export const ZONE_MAX_PARTY = 3;

/** Largest party the game lets into a dungeon */
export const DUNGEON_MAX_PARTY = 5;

/** Above this many sims in all, the tab asks before starting */
export const CONFIRM_RUNS_ABOVE = 60;

/** More quick sims than this is refused outright: narrow the roster, zones or party size */
export const MAX_QUICK_RUNS = 1500;

/** Default sim hours for the quick first pass */
export const DEFAULT_QUICK_HOURS = 2;

/** Default number of best rows re-run at full hours */
export const DEFAULT_TOP_K = 5;

/** What the table can rank by */
export const RANK_METRICS = Object.freeze([
    { key: 'xp', label: 'EXP/hr' },
    { key: 'profit', label: 'Profit/hr' },
    { key: 'xpVsSolo', label: 'EXP vs solo' },
    { key: 'profitVsSolo', label: 'Profit vs solo' },
]);

const ONE_HOUR_NS = 3600 * 1e9;

/** The "XP per coin" weight a fresh character starts with: 1M profit = 1M XP, a plain sum */
export const DEFAULT_SCORE_WEIGHT = 1;

/**
 * A usable score weight: a finite number of at least 0, else the default.
 * @param {*} value
 * @returns {number}
 */
export function normalizeScoreWeight(value) {
    const weight = typeof value === 'string' && !value.trim() ? NaN : Number(value);
    return Number.isFinite(weight) && weight >= 0 && weight <= 1e9 ? weight : DEFAULT_SCORE_WEIGHT;
}

/**
 * The blended score of a row's figures: EXP/hr + weight × Profit/hr. A loss lowers it. A profit that could not be
 * priced at all gives no score (null), never a score that counts it as 0.
 * @param {{xpPerHour: number, profitPerHour: number|null}} shown
 * @param {number} [weight] - XP per coin ("1M profit = weight M XP")
 * @returns {number|null}
 */
export function blendedScore(shown, weight = DEFAULT_SCORE_WEIGHT) {
    if (!shown || shown.profitPerHour == null) return null;
    const xp = Number(shown.xpPerHour);
    const profit = Number(shown.profitPerHour);
    if (!Number.isFinite(xp) || !Number.isFinite(profit)) return null;
    return xp + normalizeScoreWeight(weight) * profit;
}

/**
 * Party cap for a zone.
 * @param {{isDungeon?: boolean}} zone
 * @returns {number}
 */
export function zoneMaxParty(zone) {
    return zone?.isDungeon ? DUNGEON_MAX_PARTY : ZONE_MAX_PARTY;
}

/**
 * A zone/tier's key in the plan and the results.
 * @param {{zoneHrid: string, difficultyTier: number}} zone
 * @returns {string}
 */
export function zoneTierKey(zone) {
    return `${zone.zoneHrid}#${Number(zone.difficultyTier) || 0}`;
}

/** Highest ability level the editor accepts, used when the game data carries no level table */
const FALLBACK_MAX_ABILITY_LEVEL = 200;

/**
 * The highest level an ability can have, from the game's level table.
 * @param {Object|null} gameData
 * @returns {number}
 */
export function maxAbilityLevel(gameData) {
    const table = gameData?.levelExperienceTable;
    return Array.isArray(table) && table.length > 1 ? table.length - 1 : FALLBACK_MAX_ABILITY_LEVEL;
}

/**
 * Whether an aura option can run against this game data, and why not.
 * @param {{hrid: string, level: number}} option
 * @param {Object|null} gameData - Without it nothing can be judged, and the option is taken as given
 * @returns {{ok: boolean, reason?: string, name: string}}
 */
/**
 * Whether an ability can fill a player's special slot: a special ability a player can learn, i.e.
 * one with an ability book. The five party auras plus Insanity, Invincible and Revive qualify;
 * Promote is a monster-only special with no book (measured on the test server, 2026-10-29).
 * @param {string} hrid
 * @param {Object|null} gameData
 * @returns {boolean}
 */
export function isPlayerSpecialAbility(hrid, gameData) {
    const detail = gameData?.abilityDetailMap?.[hrid];
    if (detail?.isSpecialAbility !== true) return false;
    // Without ability books in the item data there is no way to tell a monster-only special
    // (Promote) apart; allow it
    const books = Object.values(gameData?.itemDetailMap || {}).filter((item) => item?.abilityBookDetail);
    if (books.length === 0) return true;
    return books.some((item) => item.abilityBookDetail.abilityHrid === hrid);
}

export function checkAuraOption(option, gameData) {
    if (!gameData?.abilityDetailMap) return { ok: true, name: option.hrid.split('/').pop() };
    const detail = gameData.abilityDetailMap[option.hrid];
    if (!detail) return { ok: false, name: option.hrid, reason: `${option.hrid} is not in the game data` };
    const name = detail.name || option.hrid;
    // Any special-slot ability a player can learn: the five party auras, and Insanity, Invincible
    // and Revive, which take the same slot
    if (!isPlayerSpecialAbility(option.hrid, gameData)) {
        return { ok: false, name, reason: `${name} is not a special-slot ability a player can use` };
    }
    const max = maxAbilityLevel(gameData);
    if (!(option.level >= 1 && option.level <= max)) {
        return { ok: false, name, reason: `${name} level ${option.level} is outside 1-${max}` };
    }
    return { ok: true, name };
}

/**
 * A copy of a build wearing an aura. An aura is a special ability, and a player has one special slot — slot 0,
 * where `buildPlayerDTO` and the editor's ability picker put special abilities — so the aura takes that slot,
 * replacing whatever special sits there; a build always has that slot, so there is never "no room". The slot's
 * triggers are kept when it already held this aura, else left to the engine's defaults (null), as the editor's
 * ability picker does.
 * @param {Object} dto
 * @param {{hrid: string, level: number}} aura
 * @returns {{dto: Object, replaced: string|null}} `replaced` is the hrid of a different special it displaced
 */
export function applyAura(dto, aura) {
    const copy = structuredClone(dto);
    const abilities = Array.isArray(copy.abilities) ? copy.abilities : [];
    while (abilities.length < 5) abilities.push(null);
    const previous = abilities[0];
    abilities[0] = {
        hrid: aura.hrid,
        level: aura.level,
        triggers: previous?.hrid === aura.hrid ? (previous.triggers ?? null) : null,
    };
    copy.abilities = abilities;
    return { dto: copy, replaced: previous?.hrid && previous.hrid !== aura.hrid ? previous.hrid : null };
}

/**
 * The variants of YOU a sweep tries: as worn always, then once per usable aura option. An option the game data cannot
 * run is left out with a note; one that is already what the build wears (same aura, same level) is the as-worn
 * variant and is not tried twice; the same aura at another level is a different build and is kept.
 * @param {Array<{hrid: string, level: number}>} options - Auras the simming player may wear (owned, or picked)
 * @param {Object|null} selfDto - The build, to tell what it already wears; without it nothing is folded away
 * @param {Object|null} gameData - Judges the options and names them
 * @returns {{variants: Array<{key: string, aura: ({hrid: string, level: number, name: string,
 *   replaced: string|null}|null)}>, notes: Array<string>}} The as-worn variant first (`aura: null`, key `worn`)
 */
export function buildSelfVariants(options, selfDto, gameData) {
    const variants = [{ key: 'worn', aura: null }];
    const notes = [];
    const worn = selfDto?.abilities?.[0];
    const seen = new Set();
    for (const option of Array.isArray(options) ? options : []) {
        const hrid = typeof option?.hrid === 'string' ? option.hrid : '';
        const level = Math.floor(Number(option?.level));
        if (!hrid || !Number.isFinite(level) || level < 1) continue;
        const key = `me:${hrid}:${level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const check = checkAuraOption({ hrid, level }, gameData);
        if (!check.ok) {
            notes.push(`You: ${check.reason}, skipped`);
            continue;
        }
        if (worn?.hrid === hrid && Number(worn.level) === level) continue;
        const replacedHrid = worn?.hrid && worn.hrid !== hrid ? worn.hrid : null;
        const replaced = replacedHrid
            ? gameData?.abilityDetailMap?.[replacedHrid]?.name || replacedHrid.split('/').pop()
            : null;
        variants.push({ key, aura: { hrid, level, name: check.name, replaced } });
    }
    return { variants, notes };
}

/**
 * The roster narrowed by the include/exclude choices. Each teammate comes with the variants a party may take
 * them as: as built, and once per usable aura option. Options this game data cannot run are left out with a note.
 * @param {Array<{id: string, name: string, dto: Object, auras?: Array, includeAsBuilt?: boolean}>} roster
 * @param {Object<string, 'try'|'always'|'never'>} [choices] - By teammate id; missing means 'try'
 * @param {Object|null} [gameData] - Judges aura options and names them
 * @returns {{pool: Array<{id: string, name: string, variants: Array<Object>}>, mustInclude: Array<Object>,
 *   notes: Array<string>}} `pool` holds every teammate that may be picked (the must-includes among them). Every
 *   teammate is taken to be of the searching character's own game mode (the game parties no other), so none is
 *   left out for it.
 */
export function narrowRoster(roster, choices = {}, gameData = null) {
    const pool = [];
    const mustInclude = [];
    const notes = [];
    const nameOf = (hrid) => gameData?.abilityDetailMap?.[hrid]?.name || hrid?.split('/').pop() || '';
    for (const entry of Array.isArray(roster) ? roster : []) {
        const choice = choices?.[entry.id] || 'try';
        if (choice === 'never') continue;
        const options = Array.isArray(entry.auras) ? entry.auras : [];
        const variants = [];
        if (!options.length || entry.includeAsBuilt !== false) {
            variants.push({
                id: entry.id,
                variantKey: `${entry.id}:built`,
                name: entry.name,
                aura: null,
                replaced: null,
                dto: entry.dto,
                fingerprint: buildFingerprint(entry.dto),
            });
        }
        for (const option of options) {
            const check = checkAuraOption(option, gameData);
            if (!check.ok) {
                notes.push(`${entry.name}: ${check.reason}, skipped`);
                continue;
            }
            const { dto, replaced } = applyAura(entry.dto, option);
            variants.push({
                id: entry.id,
                variantKey: `${entry.id}:${option.hrid}:${option.level}`,
                name: entry.name,
                aura: { hrid: option.hrid, level: option.level, name: check.name },
                replaced: replaced ? nameOf(replaced) : null,
                dto,
                fingerprint: buildFingerprint(dto),
            });
        }
        if (!variants.length) {
            notes.push(`${entry.name}: no usable aura option and "as built" is off, left out`);
            continue;
        }
        const teammate = { id: entry.id, name: entry.name, variants };
        pool.push(teammate);
        if (choice === 'always') mustInclude.push(teammate);
    }
    return { pool, mustInclude, notes };
}

/**
 * An upper bound on how many parties a zone would try, before any duplicate builds fold together — cheap
 * enough to check before enumerating anything. A teammate with several variants (aura options) counts once per
 * variant, and never twice in one party.
 * @param {Array<number>} variantCounts - Variants per teammate that may be picked (must-includes included)
 * @param {Array<boolean>} mustFlags - Same order: whether every party holds that teammate
 * @param {number} maxMembers - Most teammates beside you
 * @param {number} [selfVariants=1] - Variants of you (as worn, plus one per aura of yours tried): every party, and
 *   the solo row, is tried once per variant
 * @returns {number} Including the solo baseline and the solo rows of your aura variants; 0 when the required
 *   teammates cannot all fit
 */
export function countCompositionsUpperBound(variantCounts, mustFlags, maxMembers, selfVariants = 1) {
    const mustCount = mustFlags.filter(Boolean).length;
    if (mustCount > maxMembers) return 0;
    // ways[k]: parties of k teammates, each teammate taken as one of their variants
    let ways = [1];
    variantCounts.forEach((variants, i) => {
        const next = new Array(Math.min(ways.length + 1, maxMembers + 1)).fill(0);
        for (let k = 0; k < ways.length; k++) {
            if (!ways[k]) continue;
            if (!mustFlags[i]) next[k] += ways[k];
            if (k + 1 <= maxMembers) next[k + 1] += ways[k] * variants;
        }
        ways = next;
    });
    // ways[0] is the empty party, possible only when nobody is required; the solo baseline is run either way
    const parties = ways.slice(1).reduce((sum, n) => sum + n, 0) + 1;
    return parties * Math.max(1, Math.floor(Number(selfVariants)) || 1);
}

/**
 * Every party to try beside you: solo first, then by size. A teammate joins as one of their variants, never two.
 * Two parties whose builds are the same multiset — the same build saved under two names, or an aura option a
 * teammate already wears — are one party; the names it also goes by ride along as `aliases`. Two teammates
 * offering the same aura are two different builds and are both tried.
 * @param {Array<Object>} pool - From {@link narrowRoster}
 * @param {Array<Object>} mustInclude - From {@link narrowRoster}
 * @param {number} maxMembers - Most teammates beside you
 * @returns {Array<{key: string, members: Array<Object>, aliases: Array<Array<string>>, isBaseline: boolean}>}
 */
export function enumerateCompositions(pool, mustInclude, maxMembers) {
    const result = [{ key: 'solo', members: [], aliases: [], isBaseline: true }];
    const mustIds = new Set(mustInclude.map((m) => m.id));
    if (mustIds.size > maxMembers) return result;

    // Same build, same index, so a party's key is its multiset of builds
    const buildIndex = new Map();
    for (const teammate of pool) {
        for (const variant of teammate.variants) {
            if (!buildIndex.has(variant.fingerprint)) buildIndex.set(variant.fingerprint, buildIndex.size);
        }
    }
    // Required teammates first
    const ordered = [...pool.filter((t) => mustIds.has(t.id)), ...pool.filter((t) => !mustIds.has(t.id))];
    const byKey = new Map();

    const record = (members) => {
        const key = members
            .map((m) => buildIndex.get(m.fingerprint))
            .sort((a, b) => a - b)
            .join('+');
        const existing = byKey.get(key);
        if (existing) existing.aliases.push(members.map(memberLabel));
        else byKey.set(key, { key, members, aliases: [], isBaseline: false });
    };
    const visit = (index, picked) => {
        if (index === ordered.length) {
            if (picked.length) record(picked);
            return;
        }
        const teammate = ordered[index];
        if (picked.length < maxMembers) {
            for (const variant of teammate.variants) visit(index + 1, [...picked, variant]);
        }
        if (!mustIds.has(teammate.id)) visit(index + 1, picked);
    };
    visit(0, []);

    const parties = [...byKey.values()].sort((a, b) => a.members.length - b.members.length);
    return [...result, ...parties];
}

/**
 * The whole sweep: every (zone/tier × party) to sim, solo baselines first so a stop still leaves them.
 * @param {Object} options
 * @param {Array<{zoneHrid: string, difficultyTier: number, isDungeon: boolean, name: string}>} options.zones
 * @param {Array<Object>} options.roster - Saved teammates
 * @param {Object} [options.choices] - Include/exclude by teammate id
 * @param {number} [options.maxPartySize] - Largest party to try, you included; capped by each zone's own
 * @param {Object|null} [options.gameData] - Judges aura options
 * @param {Array<{hrid: string, level: number}>} [options.selfAuras] - Auras YOU may wear: each adds a variant of
 *   you, tried solo and in every party, beside you as worn (see {@link buildSelfVariants})
 * @param {Object|null} [options.selfDto] - Your build, to tell which aura option is already worn
 * @returns {{tasks: Array<{zone: Object, zoneKey: string, comp: Object}>, perZone: Array<{zone: Object,
 *   zoneKey: string, count: number, note: string|null}>, total: number, refused: string|null,
 *   notes: Array<string>}} `refused` explains a sweep too large to plan; `notes` names aura options left out
 */
export function planSweep({
    zones,
    roster,
    choices = {},
    maxPartySize = DUNGEON_MAX_PARTY,
    gameData = null,
    selfAuras = [],
    selfDto = null,
}) {
    const { pool, mustInclude, notes } = narrowRoster(roster, choices, gameData);
    const self = buildSelfVariants(selfAuras, selfDto, gameData);
    notes.push(...self.notes);
    const selfVariants = self.variants;
    const mustIds = new Set(mustInclude.map((m) => m.id));
    const variantCounts = pool.map((t) => t.variants.length);
    const mustFlags = pool.map((t) => mustIds.has(t.id));
    const seen = new Set();
    const uniqueZones = [];
    for (const zone of Array.isArray(zones) ? zones : []) {
        const key = zoneTierKey(zone);
        if (seen.has(key)) continue;
        seen.add(key);
        uniqueZones.push(zone);
    }

    const perZone = [];
    let bound = 0;
    for (const zone of uniqueZones) {
        const maxMembers = Math.max(0, Math.min(Number(maxPartySize) || DUNGEON_MAX_PARTY, zoneMaxParty(zone)) - 1);
        bound += countCompositionsUpperBound(variantCounts, mustFlags, maxMembers, selfVariants.length);
        perZone.push({ zone, zoneKey: zoneTierKey(zone), maxMembers, count: 0, note: null });
    }
    if (bound > MAX_QUICK_RUNS * 20) {
        return {
            tasks: [],
            perZone,
            total: bound,
            refused: tooManyText(bound),
            selfAuraCount: selfVariants.length - 1,
            notes,
        };
    }

    const baselines = [];
    const selfSolos = [];
    const parties = [];
    const compsByCap = new Map();
    for (const entry of perZone) {
        if (mustInclude.length > entry.maxMembers) {
            entry.note =
                `${mustInclude.map((m) => m.name).join(', ')} cannot all fit in a ` +
                `${entry.maxMembers + 1}-player party here`;
            continue;
        }
        if (!compsByCap.has(entry.maxMembers)) {
            compsByCap.set(entry.maxMembers, enumerateCompositions(pool, mustInclude, entry.maxMembers));
        }
        const comps = compsByCap.get(entry.maxMembers);
        // With no teammate that may join, the baseline alone answers nothing
        if (comps.length === 1) {
            entry.note = pool.length ? 'no party fits the size limit' : 'no teammates to try';
            // Your aura variants alone are still answers: whether an aura helps you solo. The zone still runs
            // those, so the note must not read as if nothing runs here
            if (selfVariants.length === 1) continue;
            entry.note += ', so only your own aura variants run';
        }
        entry.count = 0;
        for (const comp of comps) {
            // The solo baseline is you as worn alone; every "vs solo" compares against it. Your aura variants
            // alone are rows of their own, so a player sees whether an aura helps solo too
            for (const variant of selfVariants) {
                entry.count += 1;
                if (comp.isBaseline && !variant.aura) {
                    baselines.push({ zone: entry.zone, zoneKey: entry.zoneKey, comp: { ...comp, selfAura: null } });
                    continue;
                }
                const withSelf = variant.aura
                    ? { ...comp, key: `${comp.key}~${variant.key}`, isBaseline: false, selfAura: variant.aura }
                    : { ...comp, selfAura: null };
                (comp.isBaseline ? selfSolos : parties).push({
                    zone: entry.zone,
                    zoneKey: entry.zoneKey,
                    comp: withSelf,
                });
            }
        }
    }
    const tasks = [...baselines, ...selfSolos, ...parties];
    return {
        tasks,
        perZone,
        total: tasks.length,
        refused: tasks.length > MAX_QUICK_RUNS ? tooManyText(tasks.length) : null,
        selfAuraCount: selfVariants.length - 1,
        notes,
    };
}

/**
 * Why a sweep was refused.
 * @param {number} count
 * @returns {string}
 */
function tooManyText(count) {
    return (
        `That is ${count.toLocaleString('en-US')} sims, over the ${MAX_QUICK_RUNS.toLocaleString('en-US')} limit. ` +
        'Lower the max party size, exclude some teammates, or pick fewer zones.'
    );
}

/**
 * The player DTOs for one party: you as player1, teammates as player2.., each a copy, with the party's level-gap
 * penalties worked out for this party (none alone).
 * @param {Object} selfDTO
 * @param {Array<{dto: Object}>} members
 * @param {{hrid: string, level: number}|null} [selfAura] - An aura you wear in this party, in your special ability
 *   slot (see {@link applyAura}), instead of what the build wears
 * @returns {Array<Object>}
 */
export function buildCompositionParty(selfDTO, members, selfAura = null) {
    const me = selfAura ? applyAura(selfDTO, selfAura).dto : selfDTO;
    const party = [me, ...members.map((m) => m.dto)].map((dto, index) => ({
        ...structuredClone(dto),
        hrid: `player${index + 1}`,
        debuffOnLevelGap: 0,
    }));
    if (party.length > 1) recomputeLevelGapDebuffs(party);
    return party;
}

/**
 * One finished sim read for you (player1).
 * @param {Object|null} simResult
 * @param {Object} gameData
 * @param {number} hours - Hours the sim was asked for
 * @param {Object} [options]
 * @param {Map} [options.priceCache] - Shared by every row of a pass, so a price change midway cannot read as a
 *   difference between parties
 * @param {number|null} [options.saleTaxRate] - Your sale tax when "you" is not the live character
 *   (`saleTaxRateOf`); null for the live character's own
 * @returns {{failed: true}|{failed: false, hours: number, xpPerHour: number, deathsPerHour: number,
 *   profitPerHour: number|null, uncappedProfit: number|null, liquidityLimit: Object|null,
 *   unpriced: Array<string>, simResult: Object}}
 */
export function readResult(simResult, gameData, hours, { priceCache, saleTaxRate = null } = {}) {
    if (!simResult) return { failed: true };
    const playerHrid = 'player1';
    const simHours = (simResult.simulatedTime || 0) / ONE_HOUR_NS || hours;
    const xp = simResult.experienceGained?.[playerHrid] || {};
    const xpPerHour = Object.values(xp).reduce((sum, value) => sum + (Number(value) || 0), 0) / simHours;
    const deathsPerHour = (simResult.deaths?.[playerHrid] || 0) / simHours;
    const priced = priceRow(simResult, gameData, simHours, priceCache, saleTaxRate);
    return {
        failed: false,
        hours,
        xpPerHour,
        deathsPerHour,
        ...priced,
        saleTaxRate,
        simResult: slimSimResult(simResult),
    };
}

/**
 * The fields of a sim result that pricing it again reads (`calculateSimRevenue` → `calculateExpectedDrops`, the
 * consumables and the dungeon keys), and nothing else. A row is kept for the life of the table and a sweep can
 * hold over a thousand; a weak party's dungeon result carries a wipe log per wipe (each with a 200-entry event
 * log and HP readings), per-wave timing, attack counters and so on, which together can run to megabytes.
 */
const KEPT_RESULT_FIELDS = [
    'simulatedTime',
    'experienceGained',
    'deaths',
    'encounters',
    'consumablesUsed',
    'dropRateMultiplier',
    'rareFindMultiplier',
    'combatDropQuantity',
    'debuffOnLevelGap',
    'numberOfPlayers',
    'zoneName',
    'difficultyTier',
    'isDungeon',
    'dungeonsCompleted',
    'dungeonsFailed',
    'lootStates',
    'dungeonQtyStates',
];

/**
 * A sim result cut down to {@link KEPT_RESULT_FIELDS}.
 * @param {Object} simResult
 * @returns {Object}
 */
export function slimSimResult(simResult) {
    const slim = {};
    for (const field of KEPT_RESULT_FIELDS) {
        if (simResult[field] !== undefined) slim[field] = simResult[field];
    }
    return slim;
}

/**
 * Your profit for one result.
 * @param {Object} simResult
 * @param {Object} gameData
 * @param {number} simHours
 * @param {Map} [priceCache]
 * @returns {{profitPerHour: number|null, uncappedProfit: number|null, liquidityLimit: Object|null,
 *   unpriced: Array<string>, unpricedCost: Array<string>}} `unpricedCost` is the consumables and keys among `unpriced`
 */
function priceRow(simResult, gameData, simHours, priceCache, saleTaxRate = null) {
    let revenue = null;
    try {
        const options = { ...(priceCache ? { priceCache } : {}), ...(saleTaxRate != null ? { saleTaxRate } : {}) };
        revenue = calculateSimRevenue(simResult, gameData, 'player1', simHours, options);
    } catch (error) {
        console.error('[PartyFinder] Pricing a result failed:', error);
    }
    if (!revenue || !Number.isFinite(revenue.netPerHour)) {
        return { profitPerHour: null, uncappedProfit: null, liquidityLimit: null, unpriced: [], unpricedCost: [] };
    }
    // The expense side (consumables, dungeon keys) apart from the drops: a drop nothing priced makes profit a floor,
    // an expense nothing priced makes it a ceiling
    const unpricedCost = [...(revenue.unpricedConsumables || []), ...(revenue.unpricedKeys || [])];
    const unpriced = [...(revenue.unpricedDrops || []), ...unpricedCost];
    let profitPerHour = revenue.netPerHour;
    let uncappedProfit = null;
    let liquidityLimit = null;
    try {
        const sells = (revenue.dropEntries || [])
            .filter((entry) => entry?.itemHrid && Number(entry.countPerHour) > 0)
            .map((entry) => ({ itemHrid: entry.itemHrid, name: entry.name || null, unitsPerHour: entry.countPerHour }));
        const capped = capProfitRateCached({ goldPerHour: profitPerHour, sells });
        if (capped?.capped) {
            uncappedProfit = profitPerHour;
            profitPerHour = capped.goldPerHour;
            liquidityLimit = capped.limit;
        }
    } catch (error) {
        console.error('[PartyFinder] Bounding a row by market volume failed:', error);
    }
    return { profitPerHour, uncappedProfit, liquidityLimit, unpriced, unpricedCost };
}

/**
 * Price an already-read result again (a pricing setting changed), keeping its sim.
 * @param {Object} metrics - From {@link readResult}
 * @param {Object} gameData
 * @param {Map} [priceCache]
 * @returns {Object} New metrics
 */
export function repriceMetrics(metrics, gameData, priceCache) {
    if (!metrics || metrics.failed || !metrics.simResult) return metrics;
    const simHours = (metrics.simResult.simulatedTime || 0) / ONE_HOUR_NS || metrics.hours;
    return { ...metrics, ...priceRow(metrics.simResult, gameData, simHours, priceCache, metrics.saleTaxRate ?? null) };
}

/**
 * The figures a row shows: the full-hours re-run when there is one, else the quick pass.
 * @param {Object} row
 * @returns {Object|null}
 */
export function shownMetrics(row) {
    if (row?.full && !row.full.failed) return row.full;
    if (row?.quick && !row.quick.failed) return row.quick;
    return null;
}

/**
 * A row's standing against your solo baseline in the same zone/tier, like against like: the full re-runs when
 * both have one, the quick passes otherwise.
 * @param {Object} row
 * @param {Object|null} baseline - The solo row of the same zone/tier
 * @returns {{xpPct: number|null, profitDelta: number|null, stage: 'full'|'quick'|null, unpriced: Array<string>}}
 *   `unpriced` names the items nothing priced on either side of the compared stage: each counted at zero, so the
 *   profit delta is built on a zero and says so
 */
export function soloDelta(row, baseline) {
    const none = { xpPct: null, profitDelta: null, stage: null, unpriced: [] };
    if (!row || !baseline) return none;
    let mine = null;
    let theirs = null;
    let stage = null;
    if (row.full && !row.full.failed && baseline.full && !baseline.full.failed) {
        [mine, theirs, stage] = [row.full, baseline.full, 'full'];
    } else if (row.quick && !row.quick.failed && baseline.quick && !baseline.quick.failed) {
        [mine, theirs, stage] = [row.quick, baseline.quick, 'quick'];
    }
    if (!mine) return none;
    const xpPct = theirs.xpPerHour > 0 ? ((mine.xpPerHour - theirs.xpPerHour) / theirs.xpPerHour) * 100 : null;
    const profitDelta =
        mine.profitPerHour != null && theirs.profitPerHour != null ? mine.profitPerHour - theirs.profitPerHour : null;
    const unpriced = [...new Set([...(mine.unpriced || []), ...(theirs.unpriced || [])])];
    return { xpPct, profitDelta, stage, unpriced };
}

/**
 * The value a row ranks by.
 * @param {Object} row
 * @param {Object|null} baseline
 * @param {string} metric - A {@link RANK_METRICS} key, 'deaths' or 'score'
 * @param {number} [scoreWeight] - XP per coin for the 'score' metric (see {@link blendedScore})
 * @returns {number|null} null when the row has no such figure (failed, unpriced, no baseline)
 */
export function metricValue(row, baseline, metric, scoreWeight = DEFAULT_SCORE_WEIGHT) {
    const shown = shownMetrics(row);
    if (!shown) return null;
    switch (metric) {
        case 'xp':
            return shown.xpPerHour;
        case 'profit':
            return shown.profitPerHour;
        case 'score':
            return blendedScore(shown, scoreWeight);
        case 'deaths':
            return shown.deathsPerHour;
        case 'xpVsSolo':
            return soloDelta(row, baseline).xpPct;
        case 'profitVsSolo':
            return soloDelta(row, baseline).profitDelta;
        default:
            return null;
    }
}

/**
 * Rows ranked by a metric; a row without the figure sinks to the bottom whichever way the sort runs.
 * @param {Array<Object>} rows
 * @param {Map<string, Object>} baselines - zoneKey → solo row
 * @param {string} metric
 * @param {boolean} [ascending=false]
 * @param {number} [scoreWeight] - XP per coin, for the 'score' metric
 * @returns {Array<Object>} A new array
 */
export function sortRows(rows, baselines, metric, ascending = false, scoreWeight = DEFAULT_SCORE_WEIGHT) {
    const keyed = rows.map((row, index) => ({
        row,
        index,
        value: metricValue(row, baselines.get(row.zoneKey) || null, metric, scoreWeight),
    }));
    keyed.sort((a, b) => {
        const aMissing = a.value == null || !Number.isFinite(a.value);
        const bMissing = b.value == null || !Number.isFinite(b.value);
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (!aMissing && a.value !== b.value) return ascending ? a.value - b.value : b.value - a.value;
        return a.index - b.index;
    });
    return keyed.map((entry) => entry.row);
}

/**
 * The parties worth a full-hours re-run: the best K by the metric, never a baseline, never a failed row, plus the
 * solo baselines of their zone/tiers (first, so a stop still leaves the comparison).
 * @param {Array<Object>} rows
 * @param {Map<string, Object>} baselines
 * @param {string} metric
 * @param {number} k
 * @returns {Array<Object>} Rows to re-run, baselines first
 */
export function pickRerunRows(rows, baselines, metric, k) {
    const count = Math.max(0, Math.floor(Number(k) || 0));
    if (!count) return [];
    const candidates = rows.filter((row) => !row.isBaseline && shownMetrics(row));
    const ranked = sortRows(candidates, baselines, metric).filter(
        (row) => metricValue(row, baselines.get(row.zoneKey) || null, metric) != null
    );
    const top = ranked.slice(0, count);
    const baselineRows = [];
    const seen = new Set();
    for (const row of top) {
        const baseline = baselines.get(row.zoneKey);
        if (baseline && shownMetrics(baseline) && !seen.has(row.zoneKey)) {
            seen.add(row.zoneKey);
            baselineRows.push(baseline);
        }
    }
    return [...baselineRows, ...top];
}

/**
 * One teammate as a row names them: "Bob", or "Bob [Fierce Aura 20]" when the party tried them with an aura.
 * @param {{name: string, aura?: {name: string, level: number}|null}} member
 * @returns {string}
 */
export function memberLabel(member) {
    return member?.aura ? `${member.name} [${member.aura.name} ${member.aura.level}]` : member?.name || '';
}

/**
 * The names a party shows: you alone, or the teammates beside you (with the aura each was tried with); an aura
 * of yours that differs from what you wear is named after them.
 * @param {Object} comp
 * @returns {string}
 */
export function partyLabel(comp) {
    const mine = comp?.selfAura ? ` (you: ${comp.selfAura.name} ${comp.selfAura.level})` : '';
    if (!comp || comp.isBaseline || !comp.members?.length) return `Solo${mine}`;
    return comp.members.map(memberLabel).join(' + ') + mine;
}

/**
 * Auras two or more players of one party run — allowed (the engine decides whether they stack), and said on the
 * row so nobody reads it as a mistake.
 * @param {Array<Object>} partyDTOs - From {@link buildCompositionParty}
 * @param {Object|null} gameData
 * @returns {Array<{name: string, count: number}>}
 */
export function sharedAuras(partyDTOs, gameData) {
    const counts = new Map();
    for (const dto of partyDTOs || []) {
        const hrid = dto?.abilities?.[0]?.hrid;
        const detail = hrid ? gameData?.abilityDetailMap?.[hrid] : null;
        if (!detail || !isAuraAbility(detail)) continue;
        counts.set(hrid, (counts.get(hrid) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([hrid, count]) => ({ name: gameData.abilityDetailMap[hrid].name || hrid, count }));
}

/**
 * "stopped early — 12 of 40 sims"
 * @param {number} done
 * @param {number} total
 * @returns {string}
 */
export function stoppedSweepText(done, total) {
    return `stopped early — ${done} of ${total} sim${total === 1 ? '' : 's'}`;
}

/** CSV columns for the results table */
export const CSV_COLUMNS = Object.freeze([
    { key: 'zone', label: 'Zone' },
    { key: 'tier', label: 'Tier' },
    { key: 'party', label: 'Party' },
    { key: 'size', label: 'Players' },
    { key: 'hours', label: 'Sim hours' },
    { key: 'xpPerHour', label: 'Your EXP/hr' },
    { key: 'profitPerHour', label: 'Your profit/hr' },
    { key: 'deathsPerHour', label: 'Your deaths/hr' },
    { key: 'xpVsSoloPct', label: 'EXP vs solo %' },
    { key: 'profitVsSolo', label: 'Profit vs solo' },
    { key: 'comparedAt', label: 'Compared at' },
    { key: 'unpriced', label: 'Unpriced items' },
    { key: 'note', label: 'Note' },
]);

/**
 * One results row as CSV fields.
 * @param {Object} row
 * @param {Object|null} baseline
 * @returns {Object}
 */
export function csvRow(row, baseline) {
    const shown = shownMetrics(row);
    const delta = soloDelta(row, baseline);
    const round = (value, places) => (value == null || !Number.isFinite(value) ? '' : Number(value.toFixed(places)));
    return {
        zone: row.zone?.name || row.zone?.zoneHrid || '',
        tier: Number(row.zone?.difficultyTier) || 0,
        party: partyLabel(row.comp),
        size: (row.comp?.members?.length || 0) + 1,
        hours: shown ? shown.hours : '',
        xpPerHour: shown ? round(shown.xpPerHour, 0) : '',
        profitPerHour: shown ? round(shown.profitPerHour, 0) : '',
        deathsPerHour: shown ? round(shown.deathsPerHour, 3) : '',
        xpVsSoloPct: round(delta.xpPct, 1),
        profitVsSolo: round(delta.profitDelta, 0),
        comparedAt: delta.stage === 'full' ? 'full hours' : delta.stage === 'quick' ? 'quick pass' : '',
        unpriced: shown?.unpriced?.length ? shown.unpriced.join(' ') : '',
        note: !shown
            ? 'sim failed'
            : shown.profitPerHour == null
              ? 'profit could not be priced'
              : delta.profitDelta != null && delta.unpriced.length
                ? 'profit vs solo counts unpriced items as 0'
                : '',
    };
}
