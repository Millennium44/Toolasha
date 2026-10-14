/**
 * Skilling goals: the Lab Sim Skilling tab's room-level search, goal planner and
 * combined-upgrade check.
 *
 * The Skilling tab's Analyze Upgrades pass measures every candidate alone, at one
 * room level, and reports the clear rate it would move. Three questions that
 * cannot be answered from that table live here:
 *
 * - how many room levels deeper (and which floor) an upgrade lets the character
 *   clear at a chosen clear-rate bar,
 * - what is the cheapest set of upgrades that reaches a goal, and
 * - what do several upgrades do when they are worn together.
 *
 * Everything is measured on the same quantity the table's baseline row is: the
 * average clear rate over the rooms being run (every skilling room for All
 * Skills, one room for a single skill), by re-running the same skilling model
 * with the upgrades applied to the player setup together. Nothing is additive.
 *
 * The model is DOM-free and takes its simulation as `evaluate(setup, roomLevel)`
 * so the searches can be driven by a stand-in in tests.
 */

import { labyrinthFloorClearLevel, labyrinthFloorForLevel } from '../combat/labyrinth-formulas.js';
import { applyCandidateToDTO, applyToEquipment, calculateUpgradeCost, explainUpgradeCost } from './upgrade-advisor.js';

/** Lowest skilling room level the search will probe. */
export const SKILLING_ROOM_LEVEL_MIN = 1;
/** Highest: the Room Level box's own maximum. */
export const SKILLING_ROOM_LEVEL_MAX = 1300;
/**
 * Priced candidates (gear, shrines) the planner weighs per step. Rows paid in
 * tokens or by a community buff are not priced in gold, so they are not
 * competing for these places and are always weighed.
 */
export const PLAN_CANDIDATE_CAP = 12;
/** A clear-rate gain smaller than this is a tie, not an improvement. */
const GAIN_EPSILON = 1e-9;
/** Rounding slack when asking whether a rate has reached its bar. */
const RATE_EPSILON = 1e-12;

// ─── Setups ──────────────────────────────────────────────────────────────────

/**
 * The player as the skilling model reads it: the editor's DTO plus the per-skill
 * equipment kits. Both are plain data, copied by value whenever a candidate is
 * applied so the setup a panel is showing is never the one being experimented on.
 *
 * @typedef {Object} SkillingSetup
 * @property {Object} dto - The editor's player
 * @property {Object} skillEquipmentMap - Per-skill equipment overrides
 */

/**
 * The same setup with one candidate applied.
 *
 * Mirrors how `runSkillingUpgradeAnalysis` and the community pass apply a row,
 * so a candidate means the same thing here as in the table it came from. The
 * four kinds are written to four different places — token levels and community
 * buff levels onto the DTO, shrine levels through the advisor's own writer, and
 * equipment into whichever kits wear the piece — and a combination is just
 * these applied one after another.
 *
 * @param {SkillingSetup} setup - Not modified
 * @param {Object} candidate - A candidate from the Skilling analysis
 * @param {string|null} [targetSkill] - The skill being analyzed, when only one
 * @returns {SkillingSetup} A new setup
 */
export function applySkillingCandidate(setup, candidate, targetSkill = null) {
    // One physical item that serves several rooms is applied as the pieces it
    // was merged from, one after another, each into the kits it belongs to
    if (Array.isArray(candidate.members)) {
        return candidate.members.reduce((acc, member) => applySkillingCandidate(acc, member, targetSkill), setup);
    }

    let dto = JSON.parse(JSON.stringify(setup.dto));
    const skillEquipmentMap = JSON.parse(JSON.stringify(setup.skillEquipmentMap || {}));

    if (candidate.type === 'labyrinth_buff') {
        dto.tokenUpgrades = { ...(dto.tokenUpgrades || {}) };
        dto.tokenUpgrades[candidate.editorKey] = (candidate.currentLevel || 0) + 1;
    } else if (candidate.type === 'community_buff') {
        dto.communityBuffLevels = { ...(dto.communityBuffLevels || {}) };
        dto.communityBuffLevels[candidate.buffKey] = candidate.upgradeLevel;
    } else if (candidate.type === 'guild_shrine') {
        dto = applyCandidateToDTO(dto, candidate);
    } else {
        const payload = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };
        applyToEquipment(candidate, payload, dto, skillEquipmentMap, targetSkill);
    }
    return { dto, skillEquipmentMap };
}

// ─── Rooms and rates ─────────────────────────────────────────────────────────

/**
 * The rooms a run covers. A single skill is just that skill; All Skills is every
 * skilling room, narrowed by Use Skip Levels to the ones that have a skip level
 * set — the same rooms Calculate runs.
 *
 * @param {Object} params
 * @param {number|Object} params.roomLevel - What Calculate is given: one level, or a per-skill map
 * @param {string|null} params.targetSkill - The Skill dropdown, null for All Skills
 * @param {string[]} params.allSkills - Every skilling skill hrid
 * @returns {string[]} Skill hrids
 */
export function includedSkills({ roomLevel, targetSkill, allSkills }) {
    const base = targetSkill ? [targetSkill] : [...allSkills];
    if (roomLevel && typeof roomLevel === 'object') {
        return base.filter((skill) => Number(roomLevel[skill]) > 0);
    }
    return base;
}

/**
 * A room-level map putting the given skills at one level and skipping the rest.
 *
 * A skipped skill costs nothing to evaluate, so a single-skill search does not
 * pay for the other nine rooms.
 *
 * @param {number} level - Room level
 * @param {string[]} skills - Skills that run a room
 * @param {string[]} allSkills - Every skilling skill hrid
 * @returns {Object} skill hrid → level (0 = skipped)
 */
export function uniformRoomLevels(level, skills, allSkills) {
    const run = new Set(skills);
    const map = {};
    for (const skill of allSkills) map[skill] = run.has(skill) ? level : 0;
    return map;
}

/**
 * Average the per-skill results the way the table's baseline row does.
 *
 * @param {Array<Object>} results - From `computeSkillingClearRatesFromEditor`
 * @param {string|null} [targetSkill] - Restrict to one skill
 * @returns {{clearRate: number, xpPerRoom: number, count: number, perSkill: Array<Object>}}
 */
export function averageSkillingResults(results, targetSkill = null) {
    const active = (Array.isArray(results) ? results : []).filter(
        (r) => r && !r.skipped && (!targetSkill || r.skillHrid === targetSkill)
    );
    if (!active.length) return { clearRate: 0, xpPerRoom: 0, count: 0, perSkill: [] };
    return {
        // Each room's own figure, so a caller can say which rooms an upgrade moved
        perSkill: active.map((r) => ({
            skillHrid: r.skillHrid,
            skillName: r.skillName,
            roomLevel: r.roomLevel,
            clearChance: r.clearChance || 0,
        })),
        clearRate: active.reduce((sum, r) => sum + (r.clearChance || 0), 0) / active.length,
        xpPerRoom: active.reduce((sum, r) => sum + (r.xpPerRoom || 0), 0) / active.length,
        count: active.length,
    };
}

/**
 * An evaluator over the real skilling model.
 *
 * @param {Object} params
 * @param {function(number|Object, Object, string[], Object, Object): Array<Object>} params.computeRates -
 *   `computeSkillingClearRatesFromEditor`
 * @param {Object} params.gameData - From `buildGameDataPayload`
 * @param {string[]} params.crateHrids - Selected crates
 * @param {string|null} [params.targetSkill]
 * @returns {function(SkillingSetup, number|Object): {clearRate: number, xpPerRoom: number, count: number}}
 */
export function createSkillingEvaluator({ computeRates, gameData, crateHrids, targetSkill = null }) {
    return (setup, roomLevel) =>
        averageSkillingResults(
            computeRates(roomLevel, setup.dto, crateHrids, gameData, setup.skillEquipmentMap),
            targetSkill
        );
}

// ─── Room-level search ───────────────────────────────────────────────────────

const defaultYield = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The highest room level whose average clear rate still meets the bar.
 *
 * A binary search, which is sound because the skilling model is monotone in room
 * level: a deeper room raises the progress to make and lowers the success
 * chance, so the clear rate never rises with level. The result has the shape
 * `findMaxLabyrinthLevel` returns, so the combat side's measurement pass can
 * drive it unchanged.
 *
 * @param {Object} params
 * @param {function(number): number} params.clearRateAt - Average clear rate (0-1) at a room level
 * @param {number} params.threshold - Clear-rate bar (0-1)
 * @param {number} [params.minLevel] - Lowest level probed
 * @param {number} [params.maxLevel] - Highest level probed
 * @param {Function} [params.abortSignal] - Polled before every probe
 * @param {function(): Promise<void>} [params.yieldFn] - Awaited between probes so the page can paint
 * @returns {Promise<{maxLevel: number, clearRate: number, steps: number, threshold: number,
 *   cleared: boolean, atCeiling: boolean, aborted: boolean}>} `maxLevel` is 0 when nothing met the bar
 */
export async function findMaxSkillingRoomLevel(params) {
    const {
        clearRateAt,
        threshold,
        minLevel = SKILLING_ROOM_LEVEL_MIN,
        maxLevel = SKILLING_ROOM_LEVEL_MAX,
        abortSignal = null,
        yieldFn = defaultYield,
    } = params;

    let low = Math.max(SKILLING_ROOM_LEVEL_MIN, Math.floor(minLevel));
    let high = Math.max(low, Math.floor(maxLevel));
    const ceiling = high;
    let bestLevel = 0;
    let bestRate = 0;
    let steps = 0;
    let aborted = false;

    while (low <= high) {
        if (abortSignal?.()) {
            aborted = true;
            break;
        }
        await yieldFn();
        const mid = Math.floor((low + high) / 2);
        steps++;
        const rate = clearRateAt(mid);
        if (rate >= threshold - RATE_EPSILON) {
            bestLevel = mid;
            bestRate = rate;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return {
        maxLevel: bestLevel,
        clearRate: bestRate,
        steps,
        threshold,
        cleared: bestLevel > 0,
        atCeiling: bestLevel === ceiling,
        aborted,
    };
}

/**
 * The rows worth a room-level search: those that raised the clear rate. A row
 * ranked on experience (the Experience token, the Scholar shrine when it moves
 * nothing else) never changes whether a room is cleared.
 *
 * @param {Array<Object>} results - Skilling analysis rows
 * @param {number} size - How many to keep
 * @returns {Array<Object>} Best first
 */
export function shortlistSkillingForRoomLevels(results, size) {
    const keep = Math.max(0, Math.floor(Number(size) || 0));
    return (Array.isArray(results) ? results : [])
        .filter((r) => r && r.metricType !== 'xpPerRoom' && (r.clearRateDelta || 0) > GAIN_EPSILON)
        .sort((a, b) => (b.clearRateDelta || 0) - (a.clearRateDelta || 0))
        .slice(0, keep);
}

/**
 * A room-level search over one setup, for the rooms being run.
 *
 * Every probe is a uniform room level for those rooms. With Use Skip Levels on,
 * the skip levels choose *which* skills run a room (those with a threshold set)
 * but not the level: a floor is a room level, and skills sitting at different
 * skip-derived levels have no single one to report.
 *
 * @param {Object} params
 * @param {function(SkillingSetup, number|Object): {clearRate: number}} params.evaluate
 * @param {string[]} params.skills - Skills that run a room (see `includedSkills`)
 * @param {string[]} params.allSkills - Every skilling skill hrid
 * @param {number} params.threshold - Clear-rate bar (0-1)
 * @param {Function} [params.abortSignal]
 * @param {function(): Promise<void>} [params.yieldFn]
 * @returns {function(SkillingSetup): Promise<Object>} A `findMaxSkillingRoomLevel` result for a setup
 */
export function createSetupLevelSearch({ evaluate, skills, allSkills, threshold, abortSignal = null, yieldFn }) {
    return (setup) =>
        findMaxSkillingRoomLevel({
            clearRateAt: (level) => evaluate(setup, uniformRoomLevels(level, skills, allSkills)).clearRate,
            threshold,
            abortSignal,
            yieldFn,
        });
}

/**
 * The `measure` callback `measureRoomLevelGains` wants, over the skilling model.
 *
 * @param {Object} params - `createSetupLevelSearch`'s, plus `baseSetup` and `targetSkill`
 * @param {SkillingSetup} params.baseSetup - The unmodified player
 * @param {string|null} [params.targetSkill]
 * @returns {function(Object|null): Promise<Object>} Search for a row's candidate, or for the baseline on null
 */
export function createRowLevelMeasure({ baseSetup, targetSkill = null, ...search }) {
    const searchSetup = createSetupLevelSearch(search);
    return (row) => searchSetup(row ? applySkillingCandidate(baseSetup, row.candidate, targetSkill) : baseSetup);
}

// ─── One row per physical item ───────────────────────────────────────────────

/**
 * A skilling piece's stats are read per room: `<skill>Speed`/`<skill>Efficiency`
 * apply only in that skill's room and `skillingSpeed`/`skillingEfficiency` in
 * all of them (`parseEquipmentEfficiencyBonuses`). So an item worn in a room of
 * a skill it has no stat for really does nothing there, and a cape with stats
 * for three skills really does help three rooms. The analysis generates its
 * pieces one skill at a time, which lists such an item once per skill with each
 * row counting only that room.
 *
 * This merges the rows that are the same purchase (the same slot, item and
 * target level) into one row applied to every kit it was generated for, and
 * measures it as a whole. The per-skill rows are removed: each is a part of the
 * merged gain, so leaving them in would rank every part as if it were the whole.
 *
 * Cost is that of the single acquisition, through the advisor's own cost helpers:
 * the piece is bought once and the distinct pieces the kits give up are credited
 * once each (a kept combat piece, as on the parts, earns nothing). When a part
 * enhances a copy already owned, that route competes and the cheaper one wins.
 * Without `gameData` the dearest part's cost stands in.
 *
 * @param {Object} params
 * @param {Object} params.analysisResult - `{ results }`, modified in place
 * @param {SkillingSetup} params.baseSetup
 * @param {function(SkillingSetup, number|Object): Object} params.evaluate
 * @param {number|Object} params.roomLevel - What the table was measured at
 * @param {string|null} [params.targetSkill]
 * @param {Object} [params.gameData] - From `buildGameDataPayload`, for pricing the single acquisition
 * @returns {number} How many merged rows were added
 */
export function mergeMultiSkillGearRows({
    analysisResult,
    baseSetup,
    evaluate,
    roomLevel,
    targetSkill = null,
    gameData = null,
}) {
    const results = analysisResult?.results || [];
    const groups = new Map();
    for (const row of results) {
        const c = row.candidate;
        if (row.costType !== 'gold' || !c?.upgradeHrid || !c.slot) continue;
        if (c.type !== 'skilling_gear' && c.type !== 'enhancement') continue;
        const key = `${c.slot}|${c.upgradeHrid}|${c.upgradeLevel}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }

    const baseline = evaluate(baseSetup, roomLevel);
    let added = 0;
    for (const members of groups.values()) {
        // Parts must be for different kits: two rows for the same skill are
        // alternatives, not halves of one purchase
        const identity = (r) => r.candidate.skillKey || `${r.candidate.currentHrid}+${r.candidate.currentLevel}`;
        if (new Set(members.map(identity)).size < 2) continue;

        const first = members[0].candidate;
        const skills = members.map((r) => r.candidate.skillKey).filter(Boolean);
        const sameStem = members.every((r) => r.candidate.currentHrid === first.currentHrid);
        const stem = String(first.description || '').replace(/ \([^)]*\)$/, '');
        const base = sameStem ? stem : stem.replace(/^.* \u2192 /, '');
        const scope =
            skills.length === members.length
                ? skills.map((k) => k.replace('/skills/', '')).join(', ')
                : `${members.length} kits`;
        const pricey = members.reduce((best, r) => ((r.cost ?? -Infinity) > (best.cost ?? -Infinity) ? r : best));
        const candidate = {
            ...first,
            description: `${base} (${scope})`,
            skillKey: undefined,
            skillKeys: skills,
            members: members.map((r) => r.candidate),
            merged: true,
        };
        const after = evaluate(applySkillingCandidate(baseSetup, candidate, targetSkill), roomLevel);
        const clearRateDelta = after.clearRate - baseline.clearRate;
        const { cost, costDetail } = gameData
            ? priceMergedAcquisition(members, gameData)
            : {
                  cost: members.some((r) => r.cost === null || r.cost === undefined) ? null : pricey.cost,
                  costDetail: pricey.costDetail ?? null,
              };
        const merged = {
            candidate,
            costType: 'gold',
            cost,
            costDetail,
            clearRate: after.clearRate,
            clearRateDelta,
            goldPerClearRate: clearRateDelta > GAIN_EPSILON && cost != null ? cost / (clearRateDelta * 100) : Infinity,
            metricType: 'clearRate',
            mergedFrom: members,
        };
        const at = results.indexOf(members[0]);
        for (const r of members) results.splice(results.indexOf(r), 1);
        results.splice(Math.min(at, results.length), 0, merged);
        added++;
    }
    return added;
}

/**
 * One purchase serving several kits, priced once.
 *
 * Buy route: the target piece at its level, net of the resale of each distinct
 * piece the kits give up, priced by `calculateUpgradeCost` on a single
 * combined candidate. Pieces a part marks as kept (combat gear that stays in its
 * loadout) are not sold. Own-copy route: a part that enhances a copy already held
 * is priced by the advisor already, and one copy serves every kit, so the
 * cheapest finite route wins. No finite route means no price.
 *
 * @param {Array<Object>} members - The rows being merged
 * @param {Object} gameData
 * @returns {{cost: number|null, costDetail: Object|null}}
 */
function priceMergedAcquisition(members, gameData) {
    const first = members[0].candidate;
    const displacedBy = (c) =>
        c.removedItems || (c.currentHrid ? [{ hrid: c.currentHrid, enhancementLevel: c.currentLevel }] : []);
    /** The distinct pieces a set of parts give up, minus any in `except` */
    const distinct = (candidates, except = []) => {
        const seen = new Set(except.map((item) => `${item.hrid}+${item.enhancementLevel || 0}`));
        const out = [];
        for (const c of candidates) {
            for (const item of displacedBy(c)) {
                const key = `${item?.hrid}+${item?.enhancementLevel || 0}`;
                if (item?.hrid && !seen.has(key)) {
                    seen.add(key);
                    out.push(item);
                }
            }
        }
        return out;
    };
    const removedItems = distinct(members.map((r) => r.candidate));
    const keptItems = members.flatMap((r) => r.candidate.keptItems || []);
    const buy = {
        ...first,
        type: 'skilling_gear',
        currentHrid: '',
        currentLevel: 0,
        removedItems,
        keptItems,
    };
    const routes = [];
    const bought = calculateUpgradeCost(buy, gameData);
    if (Number.isFinite(bought))
        routes.push({
            cost: bought,
            detail: () => {
                const detail = explainUpgradeCost(buy, gameData);
                const kept = members.flatMap((r) => r.costDetail?.kept || []);
                if (kept.length) {
                    detail.kept = kept.filter(
                        (k, i) =>
                            kept.findIndex((o) => o.hrid === k.hrid && o.enhancementLevel === k.enhancementLevel) === i
                    );
                    detail.keptValue = detail.kept.reduce((sum, entry) => sum + (entry.price || 0), 0);
                }
                return detail;
            },
        });
    for (const row of members) {
        if (row.candidate.type !== 'enhancement' || !Number.isFinite(row.cost)) continue;
        // Enhancing the copy already held still frees the other kits' pieces. They
        // are credited by the same helper as on the buy route: the difference
        // between pricing the purchase with and without them
        const owned = displacedBy(row.candidate);
        const others = distinct(
            members.filter((m) => m !== row).map((m) => m.candidate),
            owned
        );
        const without = calculateUpgradeCost({ ...buy, removedItems: [] }, gameData);
        const withOthers = calculateUpgradeCost({ ...buy, removedItems: others }, gameData);
        const credit = Number.isFinite(without) && Number.isFinite(withOthers) ? without - withOthers : 0;
        routes.push({
            cost: row.cost - credit,
            detail: () => {
                const base = row.costDetail;
                if (!base || !(credit !== 0)) return base ?? null;
                // The enhancement lines as priced, plus a sale line per freed piece. Each
                // piece's credit is its own marginal effect on the purchase price; the last
                // line takes the remainder so the lines total exactly what the row charged
                const lines = others.map((item) => {
                    const alone = calculateUpgradeCost({ ...buy, removedItems: [item] }, gameData);
                    const marginal = Number.isFinite(alone) && Number.isFinite(without) ? without - alone : 0;
                    const info = gameData?.itemDetailMap?.[item.hrid];
                    return {
                        hrid: item.hrid,
                        name: info?.name || item.hrid.split('/').pop().replace(/_/g, ' '),
                        enhancementLevel: item.enhancementLevel || 0,
                        price: marginal,
                    };
                });
                if (lines.length) {
                    lines[lines.length - 1].price += credit - lines.reduce((sum, line) => sum + line.price, 0);
                }
                return {
                    ...base,
                    credits: [...(base.credits || []), ...lines],
                    credit: (base.credit || 0) + credit,
                    net: row.cost - credit,
                    creditApplied: true,
                };
            },
        });
    }
    if (!routes.length) return { cost: null, costDetail: null };
    const cheapest = routes.reduce((best, r) => (r.cost < best.cost ? r : best));
    return { cost: cheapest.cost, costDetail: cheapest.detail() };
}

/**
 * What an upgrade does to each room in scope.
 *
 * @param {Object} params
 * @param {SkillingSetup} params.baseSetup
 * @param {Object} params.candidate - A row's candidate (merged or not)
 * @param {function(SkillingSetup, number|Object): Object} params.evaluate - Must report `perSkill`
 * @param {number|Object} params.roomLevel
 * @param {string|null} [params.targetSkill]
 * @returns {Array<{skillHrid: string, skillName: string, roomLevel: number, before: number, after: number,
 *   delta: number, triesBefore: number, triesAfter: number, affected: boolean}>}
 */
export function skillBreakdown({ baseSetup, candidate, evaluate, roomLevel, targetSkill = null }) {
    const before = evaluate(baseSetup, roomLevel).perSkill || [];
    const after = evaluate(applySkillingCandidate(baseSetup, candidate, targetSkill), roomLevel).perSkill || [];
    const tries = (rate) => (rate > 0 ? 1 / rate : Infinity);
    return before.map((b) => {
        const a = after.find((x) => x.skillHrid === b.skillHrid) || b;
        return {
            skillHrid: b.skillHrid,
            skillName: b.skillName,
            roomLevel: b.roomLevel,
            before: b.clearChance,
            after: a.clearChance,
            delta: a.clearChance - b.clearChance,
            triesBefore: tries(b.clearChance),
            triesAfter: tries(a.clearChance),
            affected: Math.abs(a.clearChance - b.clearChance) > RATE_EPSILON,
        };
    });
}

// ─── Costs ───────────────────────────────────────────────────────────────────

/**
 * What a row costs, in the three currencies the table keeps apart.
 *
 * Gold is only what the row is priced in gold for (gear, and the credits half of
 * a shrine). Guild and labyrinth tokens are counted, never converted; a
 * community buff costs nothing to level, only cowbells per minute to keep up.
 * `gold` is null when the row has no price, which is not the same as free.
 *
 * @param {Object} row - Skilling analysis row
 * @returns {{gold: number|null, tokens: number, cowbells: number}}
 */
export function rowCost(row) {
    const type = row?.costType;
    if (type === 'token') return { gold: 0, tokens: row.tokenCost || 0, cowbells: 0 };
    if (type === 'community') return { gold: 0, tokens: 0, cowbells: row.cowbellCost || 0 };
    const gold = Number.isFinite(row?.cost) ? row.cost : null;
    return { gold, tokens: type === 'guild' ? row.tokenCost || 0 : 0, cowbells: 0 };
}

/**
 * Total several rows' costs. An unpriced row adds nothing to `gold` and is
 * counted in `unpriced`, so a total can say it is a lower bound.
 *
 * @param {Array<{gold: number|null, tokens: number, cowbells: number}>} costs
 * @returns {{gold: number, tokens: number, cowbells: number, unpriced: number}}
 */
export function sumCosts(costs) {
    const total = { gold: 0, tokens: 0, cowbells: 0, unpriced: 0 };
    for (const cost of costs) {
        if (cost.gold === null) total.unpriced++;
        else total.gold += cost.gold;
        total.tokens += cost.tokens || 0;
        total.cowbells += cost.cowbells || 0;
    }
    return total;
}

/** Gold to rank on: a refund is no better than free, an unpriced row is never free. */
function rankGold(cost) {
    return cost.gold === null ? Infinity : Math.max(0, cost.gold);
}

// ─── Exclusivity ─────────────────────────────────────────────────────────────

/**
 * Whether two candidates are alternatives for the same thing, so that only one
 * can be taken.
 *
 * - The same shrine, community buff or labyrinth token at two levels.
 * - Two pieces for one equipment slot: a swap and another swap for the same
 *   slot, or the same item enhanced to two levels. Gear for different skills
 *   goes into different kits and so does not collide, and neither do
 *   enhancements of different items that merely share a slot (a milking top and
 *   a woodcutting top are worn in different rooms). Gear for a skill against an
 *   enhancement of anything in that slot is treated as a collision: whether the
 *   enhanced item is the one in that skill's kit depends on a setup this check
 *   does not see, and taking both could count the slot twice.
 *
 * @param {Object} a - Candidate
 * @param {Object} b - Candidate
 * @returns {boolean}
 */
export function skillingCandidatesConflict(a, b) {
    if (!a || !b) return false;
    if (a.members || b.members) {
        return (a.members || [a]).some((x) => (b.members || [b]).some((y) => skillingCandidatesConflict(x, y)));
    }
    if (a.type === 'labyrinth_buff' || b.type === 'labyrinth_buff') {
        return a.type === b.type && a.editorKey === b.editorKey;
    }
    if (a.type === 'community_buff' || b.type === 'community_buff') {
        return a.type === b.type && a.buffKey === b.buffKey;
    }
    if (a.type === 'guild_shrine' || b.type === 'guild_shrine') {
        return a.type === b.type && a.buffHrid === b.buffHrid;
    }
    if (!a.slot || a.slot !== b.slot) return false;
    if (a.skillKey && b.skillKey) return a.skillKey === b.skillKey;
    if (!a.skillKey && !b.skillKey) return a.currentHrid === b.currentHrid;
    return true;
}

/**
 * Resolve a set of picks to one upgrade per slot.
 *
 * Picks come in the order they were made. A later pick that collides with an
 * earlier one replaces it, which is the natural reading of choosing a second
 * option for something already chosen.
 *
 * @param {Array<Object>} rows - Skilling analysis rows, in pick order
 * @returns {{kept: Array<Object>, dropped: Array<{row: Object, replacedBy: Object}>}}
 */
export function resolveSlotConflicts(rows) {
    let kept = [];
    const dropped = [];
    for (const row of rows) {
        const clashing = kept.filter((earlier) => skillingCandidatesConflict(earlier.candidate, row.candidate));
        for (const earlier of clashing) dropped.push({ row: earlier, replacedBy: row });
        kept = kept.filter((earlier) => !clashing.includes(earlier));
        kept.push(row);
    }
    return { kept, dropped };
}

// ─── Combine checked rows ────────────────────────────────────────────────────

/**
 * Sim several upgrades together.
 *
 * @param {Object} params
 * @param {Array<Object>} params.rows - Picked rows, in pick order
 * @param {SkillingSetup} params.baseSetup
 * @param {function(SkillingSetup, number|Object): {clearRate: number, xpPerRoom: number}} params.evaluate
 * @param {number|Object} params.roomLevel - What the table was measured at
 * @param {string|null} [params.targetSkill]
 * @param {function(SkillingSetup): Promise<Object>} [params.measureMax] - Room-level search of a setup
 * @returns {Promise<Object>} `{ kept, dropped, baseline, clearRate, clearRateDelta, xpPerRoom,
 *   xpPerRoomDelta, costs, goldPerPct, maxRoomLevel, floor }`
 */
export async function simulateCombination({ rows, baseSetup, evaluate, roomLevel, targetSkill = null, measureMax }) {
    const { kept, dropped } = resolveSlotConflicts(rows);
    let setup = baseSetup;
    for (const row of kept) setup = applySkillingCandidate(setup, row.candidate, targetSkill);

    const baseline = evaluate(baseSetup, roomLevel);
    const combined = evaluate(setup, roomLevel);
    const clearRateDelta = combined.clearRate - baseline.clearRate;
    const costs = sumCosts(kept.map(rowCost));

    let maxRoomLevel = null;
    let floor = null;
    if (measureMax) {
        const found = await measureMax(setup);
        if (found?.cleared && !found?.aborted) {
            maxRoomLevel = found.maxLevel;
            floor = labyrinthFloorForLevel(found.maxLevel);
        }
    }

    return {
        kept,
        dropped,
        baseline,
        clearRate: combined.clearRate,
        clearRateDelta,
        xpPerRoom: combined.xpPerRoom,
        xpPerRoomDelta: combined.xpPerRoom - baseline.xpPerRoom,
        costs,
        // Gold per point of clear rate; absent when nothing is priced in gold or
        // the set does not help, rather than a zero that reads as free
        goldPerPct:
            clearRateDelta > GAIN_EPSILON && costs.gold > 0 ? Math.round(costs.gold / (clearRateDelta * 100)) : null,
        maxRoomLevel,
        floor,
    };
}

// ─── Goal planner ────────────────────────────────────────────────────────────

/**
 * The candidates a plan weighs: rows that helped on their own, with the priced
 * ones capped at the best by gold per point.
 *
 * @param {Array<Object>} rows - Skilling analysis rows
 * @param {number} [cap=PLAN_CANDIDATE_CAP] - Priced rows to keep
 * @param {function(Object): number} [deltaOf] - The clear-rate gain to judge a row by; defaults to the
 *   table's, which was measured at the analyzed room level
 * @returns {Array<Object>}
 */
export function selectPlanPool(rows, cap = PLAN_CANDIDATE_CAP, deltaOf = (r) => r.clearRateDelta || 0) {
    const helpful = (Array.isArray(rows) ? rows : []).filter(
        (r) => r?.candidate && r.metricType !== 'xpPerRoom' && deltaOf(r) > GAIN_EPSILON
    );
    const unpriced = helpful.filter((r) => r.costType === 'token' || r.costType === 'community');
    const priced = helpful
        .filter((r) => !unpriced.includes(r))
        .map((row) => ({ row, ratio: rankGold(rowCost(row)) / (deltaOf(row) * 100) }))
        .sort((a, b) => {
            if (a.ratio !== b.ratio) return a.ratio < b.ratio ? -1 : 1;
            return deltaOf(b.row) - deltaOf(a.row);
        })
        .slice(0, Math.max(0, Math.floor(Number(cap) || 0)))
        .map((entry) => entry.row);
    return [...unpriced, ...priced];
}

/**
 * Choose this step's upgrade among the ones that helped.
 *
 * Far from the goal the best value is the cheapest per point of clear rate
 * gained. Once any one upgrade finishes the job, the cheapest of those wins
 * instead: paying for gain beyond the goal is waste, and a cheap upgrade that
 * gets there outright beats a better-value one that leaves a remainder.
 *
 * @param {Array<{cost: Object, gain: number, rate: number}>} trials
 * @param {number} goalRate
 * @returns {Object} The chosen trial
 */
function pickStep(trials, goalRate) {
    const finishers = trials.filter((t) => t.rate >= goalRate - RATE_EPSILON);
    const compare = (a, b, key) => {
        if (key(a) !== key(b)) return key(a) < key(b) ? -1 : 1;
        return 0;
    };
    if (finishers.length) {
        return [...finishers].sort(
            (a, b) => compare(a, b, (t) => rankGold(t.cost)) || compare(a, b, (t) => t.cost.tokens) || b.rate - a.rate
        )[0];
    }
    return [...trials].sort(
        (a, b) =>
            compare(a, b, (t) => rankGold(t.cost) / t.gain) ||
            compare(a, b, (t) => t.cost.tokens / t.gain) ||
            b.gain - a.gain
    )[0];
}

/** Simulations the improvement pass may spend after the greedy plan. */
export const PLAN_IMPROVE_SIM_BUDGET = 120;

/**
 * Build a good plan from the candidates to a goal.
 *
 * Every candidate is first simulated alone at the goal level, so the pool is
 * ranked on the gain that matters there (a row measured at an easier analyzed
 * level can show no gain at all at the floor's exit room). Then, greedily, one
 * upgrade at a time: every remaining candidate is simulated on top of the ones
 * already chosen (applied together to the setup and re-run, not summed), the
 * best value is taken, and the rest of that candidate's slot is closed off. It
 * stops when the average clear rate at the goal level meets the bar, or when
 * nothing left helps.
 *
 * Greedy by value is not guaranteed cheapest, so a plan that reaches the goal
 * then gets a bounded improvement pass: drop any step, or swap a step for one or
 * two unchosen candidates, re-simulating the combination, keeping any cheaper
 * set that still meets the goal. The result is the best plan found, not a proof
 * of the cheapest one.
 *
 * A candidate is only in the pool if it moved the clear rate on its own, so an
 * upgrade that helps only alongside another is never found; and slot closure
 * means a slot is upgraded once, not walked up level after level.
 *
 * @param {Object} params
 * @param {SkillingSetup} params.baseSetup
 * @param {Array<Object>} params.rows - Skilling analysis rows
 * @param {function(SkillingSetup, number|Object): {clearRate: number, xpPerRoom: number}} params.evaluate
 * @param {number|Object} params.goalRoomLevel - Room level(s) the goal rate is measured at
 * @param {number} params.goalRate - Clear-rate bar (0-1)
 * @param {string|null} [params.targetSkill]
 * @param {number} [params.candidateCap=PLAN_CANDIDATE_CAP]
 * @param {Function} [params.abortSignal]
 * @param {function({current: number, total: number, description: string}): void} [params.onProgress]
 * @param {function(SkillingSetup): Promise<Object>} [params.measureMax] - Room-level search of a setup
 * @param {function(): Promise<void>} [params.yieldFn]
 * @returns {Promise<Object>} `{ steps, reached, aborted, baselineRate, finalRate, totals, poolSize, sims,
 *   improved, improveSims }`
 */
export async function planSkillingGoal(params) {
    const {
        baseSetup,
        rows,
        evaluate,
        goalRoomLevel,
        goalRate,
        targetSkill = null,
        candidateCap = PLAN_CANDIDATE_CAP,
        abortSignal = null,
        onProgress = null,
        measureMax = null,
        yieldFn = defaultYield,
    } = params;

    let sims = 0;
    const run = (setup) => {
        sims++;
        return evaluate(setup, goalRoomLevel);
    };

    let setup = baseSetup;
    let current = run(setup);
    const baselineRate = current.clearRate;
    const applied = [];
    const steps = [];
    let aborted = false;

    // Rank on the gain at the goal level. One simulation per eligible row, once;
    // skipped when there is nothing to buy.
    let pool = [];
    if (current.clearRate < goalRate - RATE_EPSILON) {
        const eligible = (Array.isArray(rows) ? rows : []).filter((r) => r?.candidate && r.metricType !== 'xpPerRoom');
        const goalDelta = new Map();
        for (let i = 0; i < eligible.length; i++) {
            if (abortSignal?.()) {
                aborted = true;
                break;
            }
            await yieldFn();
            onProgress?.({
                current: i,
                total: eligible.length,
                description: `Ranking at the goal: ${eligible[i].candidate.description || 'upgrade'}`,
            });
            const alone = run(applySkillingCandidate(baseSetup, eligible[i].candidate, targetSkill));
            goalDelta.set(eligible[i], alone.clearRate - baselineRate);
        }
        if (!aborted) pool = selectPlanPool(eligible, candidateCap, (r) => goalDelta.get(r) || 0);
    }
    let remaining = [...pool];

    while (!aborted && current.clearRate < goalRate - RATE_EPSILON) {
        // Closed off by what is already chosen: a slot is one choice
        remaining = remaining.filter(
            (row) => !applied.some((a) => skillingCandidatesConflict(a.candidate, row.candidate))
        );
        if (!remaining.length) break;

        const trials = [];
        for (let i = 0; i < remaining.length; i++) {
            if (abortSignal?.()) {
                aborted = true;
                break;
            }
            await yieldFn();
            const row = remaining[i];
            onProgress?.({
                current: i,
                total: remaining.length,
                description: `Step ${steps.length + 1}: ${row.candidate?.description || 'upgrade'}`,
            });
            const trialSetup = applySkillingCandidate(setup, row.candidate, targetSkill);
            const result = run(trialSetup);
            const gain = result.clearRate - current.clearRate;
            if (gain > GAIN_EPSILON) {
                trials.push({ row, setup: trialSetup, result, rate: result.clearRate, gain, cost: rowCost(row) });
            }
        }
        if (aborted || !trials.length) break;

        const chosen = pickStep(trials, goalRate);
        applied.push(chosen.row);
        remaining = remaining.filter((row) => row !== chosen.row);
        setup = chosen.setup;
        current = chosen.result;

        const step = {
            index: steps.length + 1,
            row: chosen.row,
            description: chosen.row.candidate?.description || 'Upgrade',
            cost: chosen.cost,
            cumulative: sumCosts(applied.map(rowCost)),
            clearRate: current.clearRate,
            gain: chosen.gain,
            maxRoomLevel: null,
            floor: null,
        };
        if (measureMax) {
            const found = await measureMax(setup);
            if (found?.aborted) aborted = true;
            else if (found?.cleared) {
                step.maxRoomLevel = found.maxLevel;
                step.floor = labyrinthFloorForLevel(found.maxLevel);
            }
        }
        steps.push(step);
        if (aborted) break;
    }

    const greedySims = sims;
    let chosen = applied;
    let improved = false;
    if (!aborted && applied.length && current.clearRate >= goalRate - RATE_EPSILON) {
        const better = await improvePlan({
            chosen: applied,
            unchosen: pool.filter((row) => !applied.includes(row)),
            reaches: (set) => {
                const setupOf = set.reduce(
                    (acc, row) => applySkillingCandidate(acc, row.candidate, targetSkill),
                    baseSetup
                );
                return run(setupOf).clearRate >= goalRate - RATE_EPSILON;
            },
            budget: () => PLAN_IMPROVE_SIM_BUDGET - (sims - greedySims),
            abortSignal,
            yieldFn,
        });
        if (better) {
            improved = true;
            chosen = better;
            // The steps are re-derived for the new set, in order, so each row's
            // clear rate is the one after that step and the ones before it
            steps.length = 0;
            let walk = baseSetup;
            let before = baselineRate;
            for (const row of chosen) {
                walk = applySkillingCandidate(walk, row.candidate, targetSkill);
                current = run(walk);
                const step = {
                    index: steps.length + 1,
                    row,
                    description: row.candidate?.description || 'Upgrade',
                    cost: rowCost(row),
                    cumulative: sumCosts(chosen.slice(0, steps.length + 1).map(rowCost)),
                    clearRate: current.clearRate,
                    gain: current.clearRate - before,
                    maxRoomLevel: null,
                    floor: null,
                };
                before = current.clearRate;
                if (measureMax) {
                    const found = await measureMax(walk);
                    if (found?.aborted) aborted = true;
                    else if (found?.cleared) {
                        step.maxRoomLevel = found.maxLevel;
                        step.floor = labyrinthFloorForLevel(found.maxLevel);
                    }
                }
                steps.push(step);
            }
        }
    }

    return {
        steps,
        reached: current.clearRate >= goalRate - RATE_EPSILON,
        aborted,
        baselineRate,
        finalRate: current.clearRate,
        totals: sumCosts(chosen.map(rowCost)),
        poolSize: pool.length,
        sims,
        improved,
        improveSims: sims - greedySims,
    };
}

/**
 * Try to find a cheaper set than the greedy one that still reaches the goal.
 *
 * Moves, in order: drop a step; swap a step for one unchosen candidate; swap a
 * step for two. A set is only simulated if it is cheaper than the best so far
 * (gold, then tokens, then fewer upgrades), so most moves cost nothing. Takes
 * the first improvement and starts over, within the simulation budget.
 *
 * @param {Object} params
 * @param {Array<Object>} params.chosen - The greedy plan, in order
 * @param {Array<Object>} params.unchosen - Pool rows not in it
 * @param {function(Array<Object>): boolean} params.reaches - Simulates a set; true when it meets the goal
 * @param {function(): number} params.budget - Simulations left
 * @param {Function} [params.abortSignal]
 * @param {function(): Promise<void>} params.yieldFn
 * @returns {Promise<Array<Object>|null>} A cheaper set, or null when none was found
 */
async function improvePlan({ chosen, unchosen, reaches, budget, abortSignal, yieldFn }) {
    const price = (set) => {
        const total = sumCosts(set.map(rowCost));
        return { gold: total.unpriced ? Infinity : total.gold, tokens: total.tokens, n: set.length };
    };
    const cheaper = (a, b) => {
        if (a.gold !== b.gold) return a.gold < b.gold;
        if (a.tokens !== b.tokens) return a.tokens < b.tokens;
        return a.n < b.n;
    };
    const compatible = (set) =>
        set.every((a, i) => set.every((b, j) => i >= j || !skillingCandidatesConflict(a.candidate, b.candidate)));

    let best = chosen;
    let found = false;
    let progress = true;
    while (progress) {
        progress = false;
        const current = best;
        const others = unchosen.filter((row) => !current.includes(row));
        const proposals = [];
        for (let i = 0; i < best.length; i++) {
            const rest = best.filter((_, k) => k !== i);
            proposals.push(rest);
            for (const u of others) proposals.push([...rest, u]);
        }
        for (let i = 0; i < best.length; i++) {
            const rest = best.filter((_, k) => k !== i);
            for (let a = 0; a < others.length; a++) {
                for (let b = a + 1; b < others.length; b++) proposals.push([...rest, others[a], others[b]]);
            }
        }
        for (const set of proposals) {
            if (!set.length || !compatible(set) || !cheaper(price(set), price(best))) continue;
            if (budget() <= 0 || abortSignal?.()) return found ? best : null;
            await yieldFn();
            if (reaches(set)) {
                best = set;
                found = true;
                progress = true;
                break;
            }
        }
    }
    return found ? best : null;
}

/**
 * The room level the goal is measured at, when the goal is a floor.
 * @param {number} floor - Target floor
 * @returns {number} Room level, 0 when no floor is set
 */
export function goalLevelForFloor(floor) {
    return labyrinthFloorClearLevel(floor);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const number = (value) => Math.round(value).toLocaleString('en-US');

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * A cost in words: "1,200,000 gold + 40 tokens". Gold that has no price says so
 * rather than reading as free.
 *
 * @param {{gold: number|null, tokens: number, cowbells: number, unpriced?: number}} cost
 * @returns {string}
 */
export function describeCost(cost) {
    const parts = [];
    if (cost.gold === null) parts.push('unpriced');
    else if (cost.gold !== 0) parts.push(`${number(cost.gold)} gold`);
    if (cost.tokens) parts.push(`${number(cost.tokens)} tokens`);
    if (cost.cowbells) parts.push(`${number(cost.cowbells)} cowbells/min`);
    if (!parts.length) return cost.unpriced ? `${cost.unpriced} unpriced` : 'free';
    if (cost.unpriced) parts.push(`+ ${cost.unpriced} unpriced`);
    return parts.join(' + ');
}

const pct = (rate) => `${(rate * 100).toFixed(1)}%`;
const levelCell = (level, floor) => (level ? `L${level} · F${floor}` : '—');
const TD = 'padding:3px 4px; text-align:right; white-space:nowrap;';
const TD_NAME = 'padding:3px 4px; color:#e0e0e0; text-align:left; white-space:normal; overflow-wrap:anywhere;';
const TH = 'text-align:right; padding:4px; color:#888; border-bottom:1px solid #333;';
const TH_LEFT = 'text-align:left; padding:4px; color:#888; border-bottom:1px solid #333;';

/**
 * The plan as a table plus a closing line.
 *
 * @param {Object} plan - From `planSkillingGoal`
 * @param {Object} view
 * @param {string} view.goalText - What the goal was, e.g. "70% clear at floor 3 (room level 80)"
 * @param {boolean} [view.showLevels] - Whether steps carry a measured max level
 * @returns {string} HTML
 */
export function renderPlanHtml(plan, { goalText, showLevels = false }) {
    let html = `<div style="color:#e0e0e0; font-weight:700; font-size:12px; margin-bottom:4px;">Plan to goal</div>`;
    html += `<div style="color:#888; font-size:11px; margin-bottom:6px;">Goal: ${esc(goalText)}. Starts at ${pct(plan.baselineRate)}; ${plan.poolSize} candidates weighed per step, ${plan.sims} simulations${plan.improved ? ' (a cheaper set than the greedy one was found)' : ''}.</div>`;
    if (plan.steps.length) {
        html += '<table style="width:100%; border-collapse:collapse; font-size:11px;"><thead><tr>';
        html += `<th style="${TH_LEFT}">#</th><th style="${TH_LEFT}">Upgrade</th><th style="${TH}">Step cost</th>`;
        html += `<th style="${TH}">Total cost</th><th style="${TH}">Clear</th>`;
        if (showLevels) html += `<th style="${TH}">Max level</th>`;
        html += '</tr></thead><tbody>';
        for (const step of plan.steps) {
            html += `<tr data-plan-step="${step.index}" style="border-bottom:1px solid #1a1a1a;">`;
            html += `<td style="${TD_NAME} width:1%;">${step.index}</td><td style="${TD_NAME}">${esc(step.description)}</td>`;
            html += `<td style="${TD} color:#ccc;">${esc(describeCost(step.cost))}</td>`;
            html += `<td style="${TD} color:#ccc;">${esc(describeCost(step.cumulative))}</td>`;
            html += `<td style="${TD} color:#4caf50; font-weight:600;">${pct(step.clearRate)}</td>`;
            if (showLevels) html += `<td style="${TD} color:#ccc;">${levelCell(step.maxRoomLevel, step.floor)}</td>`;
            html += '</tr>';
        }
        html += '</tbody></table>';
    }
    let verdict;
    if (plan.aborted) {
        verdict = `Stopped early at ${pct(plan.finalRate)} after ${plan.steps.length} steps.`;
    } else if (plan.reached) {
        verdict = plan.steps.length
            ? `Best plan found reaches the goal at total ${describeCost(plan.totals)}.`
            : `Already at the goal: ${pct(plan.finalRate)} without buying anything.`;
    } else {
        verdict = `Not reachable with these candidates (best reached ${pct(plan.finalRate)}).`;
    }
    html += `<div data-plan-verdict style="margin-top:6px; font-size:12px; font-weight:600; color:${plan.reached && !plan.aborted ? '#4caf50' : '#ff9800'};">${esc(verdict)}</div>`;
    return html;
}

/**
 * The combined result of several checked upgrades.
 *
 * @param {Object} combo - From `simulateCombination`
 * @param {Object} view
 * @param {boolean} [view.showLevels]
 * @returns {string} HTML
 */
export function renderCombinationHtml(combo, { showLevels = false } = {}) {
    const delta = combo.clearRateDelta * 100;
    const names = combo.kept.map((row) => esc(row.candidate?.description || 'Upgrade')).join('; ');
    let html = `<div style="color:#e0e0e0; font-weight:700; font-size:12px; margin-bottom:4px;">Upgrades together</div>`;
    html += `<div style="color:#888; font-size:11px; margin-bottom:4px;">${names}</div>`;
    for (const { row, replacedBy } of combo.dropped) {
        html +=
            `<div data-combo-conflict style="color:#ff9800; font-size:11px;">` +
            `${esc(row.candidate?.description)} and ${esc(replacedBy.candidate?.description)} are for the same slot; ` +
            `the later one was taken.</div>`;
    }
    html += '<table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:4px;"><thead><tr>';
    html += `<th style="${TH_LEFT}">Combined clear</th><th style="${TH}">Delta</th><th style="${TH}">XP/Room</th>`;
    html += `<th style="${TH}">Total cost</th><th style="${TH}">Gold/1%</th>`;
    if (showLevels) html += `<th style="${TH}">Max level</th>`;
    html += '</tr></thead><tbody><tr>';
    html += `<td style="${TD_NAME}" data-combo-clear>${pct(combo.clearRate)}</td>`;
    html += `<td style="${TD} color:${delta > 0 ? '#4caf50' : delta < 0 ? '#f44336' : '#888'}; font-weight:600;" data-combo-delta>${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%</td>`;
    const xp = combo.xpPerRoomDelta;
    html += `<td style="${TD} color:#ccc;">${combo.xpPerRoom.toFixed(1)}${Math.abs(xp) > 1e-9 ? ` (${xp >= 0 ? '+' : ''}${xp.toFixed(1)})` : ''}</td>`;
    html += `<td style="${TD} color:#ccc;" data-combo-cost>${esc(describeCost(combo.costs))}</td>`;
    html += `<td style="${TD} color:#888;">${combo.goldPerPct === null ? '—' : number(combo.goldPerPct)}</td>`;
    if (showLevels) html += `<td style="${TD} color:#ccc;">${levelCell(combo.maxRoomLevel, combo.floor)}</td>`;
    html += '</tr></tbody></table>';
    return html;
}

/**
 * Work out, for each gear row, which rooms it moves and what it does to the
 * tries a full pass over the rooms takes.
 *
 * Fills `rooms` ({affected, total}), `tries` and `triesDelta` (the sum of
 * 1 / clear rate over the rooms run, before and after; the skilling model is
 * analytic, so unlike the combat table there is no sampling error to quote) and
 * keeps the room lines on the row for its expansion. A room that never clears
 * has infinite tries.
 *
 * @param {Object} params
 * @param {Array<Object>} params.rows - Skilling analysis rows; only gold rows are annotated
 * @param {SkillingSetup} params.baseSetup
 * @param {function(SkillingSetup, number|Object): Object} params.evaluate - Must report `perSkill`
 * @param {number|Object} params.roomLevel
 * @param {string|null} [params.targetSkill]
 * @param {Function} [params.abortSignal]
 * @param {function(): Promise<void>} [params.yieldFn]
 * @returns {Promise<void>}
 */
export async function annotateRoomsReached({
    rows,
    baseSetup,
    evaluate,
    roomLevel,
    targetSkill = null,
    abortSignal = null,
    yieldFn = defaultYield,
}) {
    for (const row of rows) {
        if (row.costType !== 'gold' || !row.candidate) continue;
        if (abortSignal?.()) return;
        await yieldFn();
        const lines = skillBreakdown({ baseSetup, candidate: row.candidate, evaluate, roomLevel, targetSkill });
        const before = lines.reduce((sum, l) => sum + l.triesBefore, 0);
        const after = lines.reduce((sum, l) => sum + l.triesAfter, 0);
        row.breakdownLines = lines;
        row.rooms = { affected: lines.filter((l) => l.affected).length, total: lines.length };
        row.tries = after;
        row.triesDelta = after - before;
    }
}

/**
 * The per-room breakdown of one upgrade, laid out like the combat Upgrade tab's
 * per-fight lines: the room on the left, before to after on the right, and
 * rooms the upgrade cannot touch named as such rather than dropped.
 *
 * @param {Array<Object>} lines - From `skillBreakdown`
 * @returns {string} HTML
 */
export function renderSkillBreakdownHtml(lines) {
    const tries = (value) => (Number.isFinite(value) ? value.toFixed(1) : '\u221e');
    return lines
        .map((line) => {
            const outcome = line.affected
                ? `${pct(line.before)} \u2192 ${pct(line.after)} ` +
                  `<span style="color:${line.delta > 0 ? '#4caf50' : '#f44336'};">(${line.delta >= 0 ? '+' : ''}${(line.delta * 100).toFixed(2)}%)</span> ` +
                  `<span style="color:#666;">| ${tries(line.triesBefore)} \u2192 ${tries(line.triesAfter)} tries</span>`
                : `<span style="color:#666;">unaffected \u2014 ${pct(line.before)} unchanged</span>`;
            return (
                `<div data-skill-breakdown-line="${esc(line.skillHrid)}" style="display:flex; justify-content:space-between; gap:10px; padding:2px 0;">` +
                `<span style="color:#aaa;">${esc(line.skillName)} <span style="color:#666;">(Lv ${line.roomLevel})</span></span>` +
                `<span style="white-space:nowrap;">${outcome}</span></div>`
            );
        })
        .join('');
}
