/**
 * Achievement-tier finisher: what a one-off achievement asks for, in game hrids,
 * and how close the character is to doing it.
 *
 * Pure. The catalog entry (`achievementDetailMap[hrid]`) carries a
 * `steamAchievementId` such as `ach_cook_peach_yogurt` and an English
 * `description` ("Make a Peach Yogurt with Cooking"). The id is parsed as
 * `ach_<verb>_<target>`; the description is only a fallback. Every target is
 * looked up in the game's own action, item and monster maps — by hrid slug
 * first, by English data name second — and anything that does not match exactly
 * one thing is left unresolved rather than guessed.
 */

import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';

/** Production and gathering verbs → the skill whose action type they name */
export const VERB_SKILLS = Object.freeze({
    cook: 'cooking',
    brew: 'brewing',
    craft: 'crafting',
    tailor: 'tailoring',
    cheesesmith: 'cheesesmithing',
    woodcut: 'woodcutting',
    forage: 'foraging',
    milk: 'milking',
});

/** `gather_<item>`: whichever gathering skill's action drops that item */
const GATHERING_SKILLS = ['milking', 'foraging', 'woodcutting'];

/** Alchemy verbs → the alchemy tab, and the item field that makes the item eligible for it */
export const ALCHEMY_VERBS = Object.freeze({
    decompose: 'decompose',
    transmute: 'transmute',
    coinify: 'coinify',
    unrefine: 'unrefine',
});

const ALCHEMY_ELIGIBLE = {
    decompose: (item) =>
        Array.isArray(item?.alchemyDetail?.decomposeItems) && item.alchemyDetail.decomposeItems.length > 0,
    transmute: (item) =>
        Array.isArray(item?.alchemyDetail?.transmuteDropTable) && item.alchemyDetail.transmuteDropTable.length > 0,
    coinify: (item) => item?.alchemyDetail?.isCoinifiable === true,
    unrefine: (item) => Boolean(item?.alchemyDetail?.unrefineDetail),
};

/** Equipment slots that hold a weapon (same set as utils/class-weapon.js) */
const WEAPON_SLOTS = new Set(['/equipment_types/two_hand', '/equipment_types/main_hand']);

const COIN_HRID = '/items/coin';
const INVENTORY_LOCATION = '/item_locations/inventory';

const slugOf = (hrid) =>
    String(hrid || '')
        .split('/')
        .pop();
const toSlug = (name) =>
    String(name || '')
        .trim()
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

/**
 * What an achievement asks for, from its steam id (or, failing that, its description).
 *
 * @param {Object} detail - An `achievementDetailMap` entry
 * @returns {{kind: 'production'|'alchemy'|'combat'|'equip', verb: string, slug: string, tier: number|null}|null}
 *   null when neither names a verb this knows
 */
export function parseAchievement(detail) {
    const steam = String(detail?.steamAchievementId || '');
    const match = /^ach_([a-z]+)_([a-z0-9_]+)$/.exec(steam);
    if (match) {
        const parsed = classify(match[1], match[2]);
        if (parsed) return parsed;
    }
    return parseDescription(String(detail?.description || ''));
}

function classify(verb, rest) {
    if (VERB_SKILLS[verb] || verb === 'gather') return { kind: 'production', verb, slug: rest, tier: null };
    if (ALCHEMY_VERBS[verb]) return { kind: 'alchemy', verb, slug: rest, tier: null };
    // `clear_<dungeon>`; anything that is not a dungeon's hrid (clear_t1_dungeon_10_times) stays unresolved
    if (verb === 'clear') return { kind: 'dungeon', verb, slug: rest, tier: 0 };
    if (verb === 'defeat') {
        const tiered = /^(.+)_t(\d+)$/.exec(rest);
        return {
            kind: 'combat',
            verb,
            slug: rest,
            tier: null,
            tieredSlug: tiered ? tiered[1] : null,
            tieredTier: tiered ? Number(tiered[2]) : null,
        };
    }
    if (verb === 'equip') return { kind: 'equip', verb, slug: rest, tier: null };
    if (verb === 'collect') return { kind: 'rare', verb, slug: rest, tier: null };
    return null;
}

/** English descriptions the game uses for one-off achievements; any other wording is left alone */
function parseDescription(text) {
    let m = /^Make an? (.+?) with (\w+)$/i.exec(text);
    if (m) {
        const verb = Object.keys(VERB_SKILLS).find((key) => VERB_SKILLS[key] === m[2].toLowerCase());
        return verb ? { kind: 'production', verb, slug: toSlug(m[1]), tier: null } : null;
    }
    m = /^(Decompose|Transmute|Coinify|Unrefine) an? (.+?)$/i.exec(text);
    if (m) return { kind: 'alchemy', verb: m[1].toLowerCase(), slug: toSlug(m[2]), tier: null };
    m = /^Defeat (?:T(\d+) )?(.+?) by yourself$/i.exec(text);
    if (m) return { kind: 'combat', verb: 'defeat', slug: toSlug(m[2]), tier: m[1] ? Number(m[1]) : 0 };
    m = /^Collect an? (.+?) from /i.exec(text);
    if (m) return { kind: 'rare', verb: 'collect', slug: toSlug(m[1]), tier: null };
    m = /^Equip any (.+?) weapon\b/i.exec(text);
    if (m) return { kind: 'equip', verb: 'equip', slug: `${toSlug(m[1])}_weapon`, tier: null };
    return null;
}

/** The one entry of a map whose slug or English name matches, or null when none or several do */
function findOne(map, slug, filter = () => true) {
    if (!map || !slug) return null;
    const entries = Object.entries(map).filter(([, value]) => filter(value));
    const bySlug = entries.filter(([hrid]) => slugOf(hrid) === slug);
    if (bySlug.length === 1) return bySlug[0][0];
    if (bySlug.length > 1) return null;
    const byName = entries.filter(([, value]) => toSlug(value?.name) === slug);
    return byName.length === 1 ? byName[0][0] : null;
}

/** The one entry whose slug ends in `_<slug>`, or null when none or several do */
function findBySlugSuffix(map, slug) {
    if (!map || !slug) return null;
    const hits = Object.keys(map).filter((hrid) => slugOf(hrid).endsWith(`_${slug}`));
    return hits.length === 1 ? hits[0] : null;
}

function inputsOf(action) {
    const inputs = [];
    for (const input of action.inputItems || []) {
        if (input?.itemHrid && input.count > 0) inputs.push({ itemHrid: input.itemHrid, count: input.count });
    }
    if (action.upgradeItemHrid) inputs.push({ itemHrid: action.upgradeItemHrid, count: 1 });
    return inputs;
}

function resolveProduction(parsed, data) {
    const gather = parsed.verb === 'gather';
    const skills = gather ? GATHERING_SKILLS : [VERB_SKILLS[parsed.verb]];
    const typeHrids = new Set(skills.map((skill) => `/action_types/${skill}`));
    const actions = data.actionDetailMap || {};
    const ofType = (action) => typeHrids.has(action?.type);
    // `gather_<x>` names the item gathered, never the action
    let actionHrid = gather ? null : findOne(actions, parsed.slug, ofType);
    if (!actionHrid) {
        // The target is the item the action makes or gathers
        const itemHrid = findOne(data.itemDetailMap, parsed.slug);
        if (!itemHrid) return null;
        const makers = Object.entries(actions).filter(
            ([, action]) =>
                ofType(action) &&
                ((action.outputItems || []).some((out) => out?.itemHrid === itemHrid) ||
                    (action.dropTable || []).some((drop) => drop?.itemHrid === itemHrid))
        );
        if (makers.length !== 1) return null;
        actionHrid = makers[0][0];
    }
    const action = actions[actionHrid];
    return {
        kind: 'production',
        actionHrid,
        skillHrid: action.levelRequirement?.skillHrid || `/skills/${action.type.split('/').pop()}`,
        level: action.levelRequirement?.level || 1,
        inputs: inputsOf(action),
    };
}

/** Skill types whose actions drop their items from a table rather than make them from inputs */
const GATHERING_TYPES = new Set(GATHERING_SKILLS.map((skill) => `/action_types/${skill}`));

/** The part of an action a candidate list carries */
function candidateOf(actionHrid, action, extra = {}) {
    return {
        actionHrid,
        skillHrid: action.levelRequirement?.skillHrid || `/skills/${String(action.type).split('/').pop()}`,
        level: action.levelRequirement?.level || 1,
        inputs: inputsOf(action),
        gathering: GATHERING_TYPES.has(action.type),
        ...extra,
    };
}

/** An action a player can start from a skill tab: not combat, not alchemy */
const isSkillAction = (action) =>
    Boolean(action?.type) && action.type !== '/action_types/combat' && action.type !== '/action_types/alchemy';

/**
 * "Collect a <rare item> from ...": every skill action whose rare drop table lists the item, with the
 * chance of one drop per action (duplicate entries for one action are independent rolls).
 */
function resolveRare(parsed, detail, data) {
    const items = data.itemDetailMap || {};
    const suffix = slugOf(detail?.hrid || '').replace(/^collect_/, '');
    let itemHrid = null;
    for (const slug of [suffix, parsed.slug]) {
        if (slug && items[`/items/${slug}`]) {
            itemHrid = `/items/${slug}`;
            break;
        }
    }
    itemHrid ||= findOne(items, parsed.slug);
    if (!itemHrid) return null;
    const candidates = [];
    for (const [actionHrid, action] of Object.entries(data.actionDetailMap || {})) {
        if (!isSkillAction(action)) continue;
        const rates = (action.rareDropTable || [])
            .filter((drop) => drop?.itemHrid === itemHrid && Number(drop.dropRate) > 0)
            .map((drop) => Math.min(1, Number(drop.dropRate)));
        if (rates.length === 0) continue;
        // One entry is its own rate exactly; several are independent rolls
        const dropRate = rates.length === 1 ? rates[0] : 1 - rates.reduce((none, rate) => none * (1 - rate), 1);
        candidates.push(candidateOf(actionHrid, action, { dropRate }));
    }
    if (candidates.length === 0) return null;
    return { kind: 'production', rareItemHrid: itemHrid, candidates: candidates.sort(byAction) };
}

const byAction = (a, b) => a.actionHrid.localeCompare(b.actionHrid);

const levelOf = (item) => {
    const reqs = item?.equipmentDetail?.levelRequirements || [];
    return reqs.length > 0 ? Math.max(...reqs.map((req) => Number(req.level) || 0)) : 0;
};
const COMBAT_SKILLS = new Set(
    ['attack', 'melee', 'defense', 'ranged', 'magic', 'stamina', 'intelligence', 'combat'].map((s) => `/skills/${s}`)
);

/**
 * "Any of" production achievements: which items count. Matched on structure (hrid pattern, equipment
 * slot, level requirement) so a translated game still resolves; the English description only picks the group.
 */
const JEWELRY_SLOTS = new Set(['/equipment_types/neck', '/equipment_types/earrings', '/equipment_types/ring']);

let dungeonItemsCache = { source: null, items: null };

/** Every item hrid that appears anywhere inside a dungeon zone's own data */
function dungeonItems(data) {
    if (dungeonItemsCache.source === data.actionDetailMap) return dungeonItemsCache.items;
    const found = new Set();
    const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
            for (const [key, value] of Object.entries(node)) {
                if (key === 'itemHrid' && typeof value === 'string') found.add(value);
                else walk(value);
            }
        }
    };
    for (const action of Object.values(data.actionDetailMap || {})) {
        if (action?.combatZoneInfo?.isDungeon === true) walk(action);
    }
    dungeonItemsCache = { source: data.actionDetailMap, items: found };
    return found;
}

const ANY_OF_GROUPS = [
    {
        // Celestial tools or the level 90 skilling outfit tops and bottoms
        matches: ({ steam, text }) => /celestial_tool/.test(steam) || /\bcelestial\b.*\b(tool|outfit)\b/i.test(text),
        accepts: (hrid, item) => {
            const slug = slugOf(hrid);
            const type = String(item?.equipmentDetail?.type || '');
            if (slug.startsWith('celestial_') && type.endsWith('_tool')) return true;
            const reqs = item?.equipmentDetail?.levelRequirements || [];
            return (
                /_(top|bottoms)$/.test(slug) &&
                reqs.length > 0 &&
                levelOf(item) === 90 &&
                reqs.every((req) => !COMBAT_SKILLS.has(req.skillHrid))
            );
        },
    },
    {
        // Gluttonous or Guzzling Pouch
        matches: ({ steam, text }) => /pouch/.test(steam) || /\bpouch\b/i.test(text),
        accepts: (hrid, item, { text }) => {
            const m = /\ban? (\w+) or (\w+) pouch\b/i.exec(text);
            const slugs = m ? [`${m[1]}_pouch`, `${m[2]}_pouch`].map((s) => s.toLowerCase()) : null;
            return slugs ? slugs.includes(slugOf(hrid)) : /^(gluttonous|guzzling)_pouch$/.test(slugOf(hrid));
        },
    },
    {
        // Cheesesmith any azure tool
        matches: ({ steam, text }) => /azure_tool/.test(steam) || /\bazure tool\b/i.test(text),
        accepts: (hrid, item) =>
            slugOf(hrid).startsWith('azure_') && String(item?.equipmentDetail?.type || '').endsWith('_tool'),
        actionOk: (action) => action.type === '/action_types/cheesesmithing',
    },
    {
        // Craft any jewelry: crafting actions that make a neck, ear or finger piece
        matches: ({ steam, text }) => /(^|_)jewelry$/.test(steam) || /\bjewelry\b/i.test(text),
        accepts: (hrid, item) => JEWELRY_SLOTS.has(item?.equipmentDetail?.type),
        actionOk: (action) => action.type === '/action_types/crafting',
    },
    {
        // Refine any dungeon or labyrinth equipment: the `_refined` piece, made from the unrefined one
        matches: ({ steam, text }) => /^refine_/.test(steam) || /\brefine any\b/i.test(text),
        accepts: (hrid, item) => /_refined$/.test(slugOf(hrid)) && Boolean(item?.equipmentDetail),
        actionOk: (action, outputs) =>
            Boolean(action.upgradeItemHrid) && (action.outputItems || []).some((out) => outputs.has(out?.itemHrid)),
    },
    {
        // Make any dungeon equipment from its components: crafted equipment with an input found only
        // in a dungeon's own data (its spawns, keys and reward tables)
        matches: ({ steam, text }) => /dungeon_equipment/.test(steam) || /\bdungeon equipment\b/i.test(text),
        accepts: (hrid, item) => Boolean(item?.equipmentDetail) && !/_refined$/.test(slugOf(hrid)),
        actionOk: (action, outputs, data) =>
            action.type === '/action_types/crafting' &&
            !action.upgradeItemHrid &&
            inputsOf(action).some((input) => dungeonItems(data).has(input.itemHrid)),
    },
    {
        // Any Master charm
        matches: ({ steam, text }) => /master_charm/.test(steam) || /\bmaster charm\b/i.test(text),
        accepts: (hrid) => /^master_.+_charm$/.test(slugOf(hrid)),
    },
];

function resolveAnyOf(detail, data) {
    const steam = String(detail?.steamAchievementId || '').replace(/^ach_/, '');
    const text = String(detail?.description || '');
    const group = ANY_OF_GROUPS.find((candidate) => candidate.matches({ steam, text }));
    if (!group || !data?.itemDetailMap) return null;
    const outputs = new Set(
        Object.entries(data.itemDetailMap)
            .filter(([hrid, item]) => group.accepts(hrid, item, { text }))
            .map(([hrid]) => hrid)
    );
    if (outputs.size === 0) return null;
    const candidates = [];
    for (const [actionHrid, action] of Object.entries(data.actionDetailMap || {})) {
        if (!isSkillAction(action) || GATHERING_TYPES.has(action.type)) continue;
        if (group.actionOk && !group.actionOk(action, outputs, data)) continue;
        if ((action.outputItems || []).some((out) => outputs.has(out?.itemHrid))) {
            candidates.push(candidateOf(actionHrid, action));
        }
    }
    if (candidates.length === 0) return null;
    return { kind: 'production', anyOf: true, candidates: candidates.sort(byAction) };
}

function resolveAlchemy(parsed, data) {
    const type = ALCHEMY_VERBS[parsed.verb];
    const itemHrid = findOne(data.itemDetailMap, parsed.slug);
    const item = itemHrid ? data.itemDetailMap[itemHrid] : null;
    if (!item || !ALCHEMY_ELIGIBLE[type](item)) return null;
    const fee = getAlchemyCoinCost(item, type);
    const inputs = [{ itemHrid, count: item.alchemyDetail?.bulkMultiplier || 1 }];
    if (fee > 0) inputs.push({ itemHrid: COIN_HRID, count: fee });
    return {
        kind: 'alchemy',
        actionHrid: `/actions/alchemy/${type}`,
        alchemyType: type,
        itemHrid,
        // Alchemy actions all require level 1; an item above the Alchemy level is the gate
        skillHrid: '/skills/alchemy',
        level: item.itemLevel || 1,
        inputs,
    };
}

function zoneSpawns(action, monsterHrid) {
    const fight = action?.combatZoneInfo?.fightInfo;
    const all = [...(fight?.randomSpawnInfo?.spawns || []), ...(fight?.bossSpawns || [])];
    return all.some((spawn) => spawn?.combatMonsterHrid === monsterHrid);
}

function resolveCombat(parsed, data) {
    const monsters = data.combatMonsterDetailMap;
    let monsterHrid = findOne(monsters, parsed.slug);
    let tier = parsed.tier ?? 0;
    if (!monsterHrid && parsed.tieredSlug) {
        monsterHrid = findOne(monsters, parsed.tieredSlug);
        tier = parsed.tieredTier;
    }
    // The achievement can name the animal where the monster has a longer name
    // (ach_defeat_shoebill is /monsters/giant_shoebill): one monster whose slug ends in it
    if (!monsterHrid) monsterHrid = findBySlugSuffix(monsters, parsed.slug);
    if (!monsterHrid) return null;

    const zones = Object.entries(data.actionDetailMap || {}).filter(
        ([, action]) =>
            action?.type === '/action_types/combat' &&
            !action.combatZoneInfo?.isDungeon &&
            (action.maxDifficulty || 0) >= tier &&
            zoneSpawns(action, monsterHrid)
    );
    if (zones.length === 0) return null;
    // The zone named after the monster (Jerry is /monsters/rat, in /actions/combat/rat), else the earliest
    const named = (hrid) => (slugOf(hrid) === slugOf(monsterHrid) ? 0 : 1);
    zones.sort(([ha, a], [hb, b]) => named(ha) - named(hb) || (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
    const [zoneHrid, zone] = zones[0];
    return {
        kind: 'combat',
        actionHrid: zoneHrid,
        monsterHrid,
        tier,
        requirement: zoneRequirement(zone),
        monsterLevel: Number(monsters[monsterHrid]?.combatDetails?.combatLevel) || null,
    };
}

/** A zone's level requirement; the game sends `{skillHrid: '', level: 0}` for none */
function zoneRequirement(zone) {
    const req = zone?.levelRequirement;
    return req?.skillHrid && req.level > 0 ? { skillHrid: req.skillHrid, level: req.level } : null;
}

function resolveDungeon(parsed, data) {
    const zoneHrid = findOne(
        data.actionDetailMap,
        parsed.slug,
        (action) => action?.type === '/action_types/combat' && action.combatZoneInfo?.isDungeon === true
    );
    if (!zoneHrid) return null;
    return {
        kind: 'combat',
        actionHrid: zoneHrid,
        monsterHrid: null,
        dungeon: true,
        tier: 0,
        requirement: zoneRequirement(data.actionDetailMap[zoneHrid]),
        monsterLevel: null,
    };
}

function resolveEquip(parsed, data) {
    const items = data.itemDetailMap || {};
    const weapon = /^(.+)_weapon$/.exec(parsed.slug);
    let candidates;
    if (weapon) {
        candidates = Object.keys(items).filter(
            (hrid) => slugOf(hrid).startsWith(`${weapon[1]}_`) && WEAPON_SLOTS.has(items[hrid]?.equipmentDetail?.type)
        );
    } else {
        const one = findOne(items, parsed.slug, (item) => Boolean(item?.equipmentDetail));
        candidates = one ? [one] : [];
    }
    if (candidates.length === 0) return null;
    return {
        kind: 'equip',
        candidates: candidates.sort(),
        requirements: Object.fromEntries(
            candidates.map((hrid) => [hrid, items[hrid].equipmentDetail?.levelRequirements || []])
        ),
    };
}

/**
 * Resolve an achievement to the game hrids it is about.
 *
 * @param {Object} detail - An `achievementDetailMap` entry
 * @param {{actionDetailMap?: Object, itemDetailMap?: Object, combatMonsterDetailMap?: Object}} data
 * @returns {Object|null} A resolution (`kind` production / alchemy / combat / equip), or null
 */
export function resolveAchievement(detail, data) {
    const parsed = parseAchievement(detail);
    if (!data) return null;
    // "Any of" achievements name no single target; the verb-and-slug parse can also mistake them for one
    const anyOf = resolveAnyOf(detail, data);
    if (anyOf) return anyOf;
    if (!parsed) return null;
    switch (parsed.kind) {
        case 'rare':
            return resolveRare(parsed, detail, data);
        case 'production':
            return resolveProduction(parsed, data);
        case 'alchemy':
            return resolveAlchemy(parsed, data);
        case 'combat':
            return resolveCombat(parsed, data);
        case 'dungeon':
            return resolveDungeon(parsed, data);
        case 'equip':
            return resolveEquip(parsed, data);
        default:
            return null;
    }
}

/**
 * Count of an item the character holds: +0 inventory stacks only by default.
 * @param {Array|null} inventory - `characterItems`
 * @param {string} itemHrid
 * @param {{anyLocation?: boolean}} [opts] - Every stack at any level and location (equipped too)
 * @returns {number}
 */
export function ownedCount(inventory, itemHrid, { anyLocation = false } = {}) {
    let total = 0;
    for (const row of inventory || []) {
        if (row?.itemHrid !== itemHrid) continue;
        if (!anyLocation) {
            if ((row.itemLocationHrid || INVENTORY_LOCATION) !== INVENTORY_LOCATION) continue;
            if (Number(row.enhancementLevel) > 0) continue;
        }
        total += Number(row.count) || 0;
    }
    return total;
}

function levelCheck(skillLevels, skillHrid, level, combatLevel) {
    const have = skillLevels?.has(skillHrid) ? skillLevels.get(skillHrid) : null;
    if (have !== null) return { met: have >= level, have, need: level, skillHrid };
    // A requirement on something that is not a skill (the zone's combat requirement): the combat level
    if (Number.isFinite(combatLevel) && !skillLevels?.has(skillHrid)) {
        return { met: combatLevel >= level, have: combatLevel, need: level, skillHrid };
    }
    return { met: null, have: null, need: level, skillHrid };
}

/**
 * How ready the character is for a resolved achievement.
 *
 * @param {Object} res - From {@link resolveAchievement}
 * @param {Object} ctx
 * @param {Map<string, number>|null} ctx.skillLevels - skillHrid → level; null when skills are not loaded
 * @param {number|null} ctx.combatLevel
 * @param {Array|null} ctx.inventory - `characterItems`; null when not loaded
 * @param {(itemHrid: string) => number|null} ctx.buyPrice - Buy price, null when unpriced
 * @param {boolean} ctx.ironCow - The character cannot buy from the market
 * @param {(itemHrid: string) => boolean} [ctx.isEstimated] - The price came from the value map, not a book
 * @returns {{levelMet: boolean|null, level: Object|null, owned: boolean|null, shortfall: Array,
 *   cost: number|null, unpriced: string[], buyHrid: string|null, ownedHrid: string|null, estimated: boolean}}
 */
export function readiness(res, ctx) {
    const out = {
        levelMet: null,
        level: null,
        owned: null,
        shortfall: [],
        cost: null,
        unpriced: [],
        buyHrid: null,
        ownedHrid: null,
        estimated: false,
    };
    const isEstimated = (hrid) => ctx.isEstimated?.(hrid) === true;
    if (res.kind === 'combat') {
        out.level = res.requirement
            ? levelCheck(ctx.skillLevels, res.requirement.skillHrid, res.requirement.level, ctx.combatLevel)
            : null;
        // No requirement in the zone's data (`{skillHrid: '', level: 0}`) is met, not unknown
        out.levelMet = out.level ? out.level.met : true;
        out.owned = true;
        return out;
    }

    if (res.kind === 'equip') {
        if (!ctx.inventory) return out;
        const held = res.candidates.find((hrid) => ownedCount(ctx.inventory, hrid, { anyLocation: true }) > 0);
        const levelsFor = (hrid) => {
            const reqs = res.requirements[hrid] || [];
            const checks = reqs.map((req) => levelCheck(ctx.skillLevels, req.skillHrid, req.level || 1, null));
            const unmet = checks.find((check) => check.met === false);
            const unknown = checks.some((check) => check.met === null);
            return { met: unmet ? false : unknown ? null : true, check: unmet || checks[0] || null };
        };
        if (held) {
            const lv = levelsFor(held);
            Object.assign(out, { owned: true, ownedHrid: held, levelMet: lv.met, level: lv.check });
            return out;
        }
        out.owned = false;
        if (ctx.ironCow) {
            const lv = levelsFor(res.candidates[0]);
            Object.assign(out, { levelMet: lv.met, level: lv.check });
            return out;
        }
        const priced = res.candidates
            .map((hrid) => ({ hrid, price: ctx.buyPrice(hrid) }))
            .filter((entry) => Number.isFinite(entry.price));
        if (priced.length === 0) {
            out.unpriced = [...res.candidates];
            const lv = levelsFor(res.candidates[0]);
            Object.assign(out, { levelMet: lv.met, level: lv.check });
            return out;
        }
        priced.sort((a, b) => a.price - b.price || a.hrid.localeCompare(b.hrid));
        const lv = levelsFor(priced[0].hrid);
        Object.assign(out, {
            buyHrid: priced[0].hrid,
            cost: priced[0].price,
            estimated: isEstimated(priced[0].hrid),
            levelMet: lv.met,
            level: lv.check,
        });
        return out;
    }

    if (Array.isArray(res.candidates)) return candidateReadiness(res, ctx, out);
    return actionReadiness(res, ctx, out);
}

/**
 * Production and alchemy: the level, then one action's inputs.
 * @param {Object} res - Has `skillHrid`, `level`, `inputs`
 * @param {Object} ctx
 * @param {Object} out - The result being filled
 * @returns {Object} out
 */
function actionReadiness(res, ctx, out) {
    const isEstimated = (hrid) => ctx.isEstimated?.(hrid) === true;
    out.level = levelCheck(ctx.skillLevels, res.skillHrid, res.level, null);
    out.levelMet = out.level.met;
    if (!ctx.inventory) return out;
    for (const input of res.inputs) {
        const have = ownedCount(ctx.inventory, input.itemHrid);
        if (have < input.count) out.shortfall.push({ itemHrid: input.itemHrid, need: input.count, have });
    }
    out.owned = out.shortfall.length === 0;
    if (out.owned || ctx.ironCow) return out;
    let cost = 0;
    for (const short of out.shortfall) {
        const missing = short.need - short.have;
        // Coins are paid, not bought
        const price = short.itemHrid === COIN_HRID ? 1 : ctx.buyPrice(short.itemHrid);
        if (!Number.isFinite(price)) out.unpriced.push(short.itemHrid);
        else {
            cost += missing * price;
            if (short.itemHrid !== COIN_HRID && isEstimated(short.itemHrid)) out.estimated = true;
        }
    }
    out.cost = out.unpriced.length > 0 ? null : cost;
    out.partialCost = out.unpriced.length > 0 ? cost : null;
    return out;
}

/**
 * Sort group of a remaining row: 0 ready now, 1 level met but needs buying (priced), 2 the same
 * with an unpriced input or no price at all, 3 level unknown, 4 level not met, 5 unresolved.
 * @param {{readiness?: Object|null}} row
 * @returns {number}
 */
export function readinessGroup(row) {
    const ready = row.readiness;
    if (!ready) return 5;
    if (ready.levelMet === false) return 4;
    if (ready.levelMet === null) return 3;
    if (ready.owned === true) return 0;
    if (Number.isFinite(ready.cost)) return 1;
    return 2;
}

/**
 * Order a tier's remaining rows: ready now, then level met but needs buying (cheapest first), then
 * level unknown, then level not met, then unresolved. Stable within a group.
 * @param {Array<{readiness?: Object|null}>} rows
 * @returns {Array}
 */
export function sortRemaining(rows) {
    return rows
        .map((row, index) => ({ row, index, group: readinessGroup(row) }))
        .sort((a, b) => {
            if (a.group !== b.group) return a.group - b.group;
            if (a.group === 1 && a.row.readiness.cost !== b.row.readiness.cost) {
                return a.row.readiness.cost - b.row.readiness.cost;
            }
            return a.index - b.index;
        })
        .map((entry) => entry.row);
}

const emptyReadiness = () => ({
    levelMet: null,
    level: null,
    owned: null,
    shortfall: [],
    cost: null,
    unpriced: [],
    buyHrid: null,
    ownedHrid: null,
    estimated: false,
});

/**
 * Order of candidates whose level is met, best first: owned inputs, then the cheapest priced bill, then
 * a bill with unpriced inputs (fewer unpriced first, never counted as free), then the rest (inventory
 * not loaded, or an Iron Cow that cannot buy: fewer short inputs first). Ties: lower level, then hrid.
 */
function costRank(ready) {
    if (ready.owned === true) return [0, 0, 0];
    if (ready.owned === null) return [3, 0, 0];
    if (Number.isFinite(ready.cost)) return [1, ready.cost, 0];
    if (ready.unpriced.length > 0) return [2, ready.unpriced.length, ready.partialCost || 0];
    return [3, ready.shortfall.length, 0];
}

const compareTuples = (a, b) => {
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
};

/**
 * Readiness of a resolution that offers several actions: picks one for this character and returns that
 * action's readiness with `actionHrid` set (and `dropRate` for a rare-drop target).
 *
 * Rare drop (candidates carry `dropRate`): the highest drop rate whose level is met; ties go to the lower
 * level, then a gathering action (no inputs) before a production one. Any-of production: the met candidate
 * whose inputs are cheapest to complete. With no level met, the lowest-level candidate, shortfall shown.
 */
function candidateReadiness(res, ctx, out) {
    const rare = res.candidates.some((cand) => Number.isFinite(cand.dropRate));
    const scored = res.candidates.map((cand) => {
        const ready = actionReadiness({ ...cand, kind: 'production' }, ctx, emptyReadiness());
        return { cand, ready };
    });
    const met = scored.filter((entry) => entry.ready.levelMet === true);
    let chosen;
    if (met.length > 0) {
        met.sort((a, b) => {
            if (rare) {
                if (a.cand.dropRate !== b.cand.dropRate) return b.cand.dropRate - a.cand.dropRate;
                if (a.cand.level !== b.cand.level) return a.cand.level - b.cand.level;
                if (a.cand.gathering !== b.cand.gathering) return a.cand.gathering ? -1 : 1;
            } else {
                const byCost = compareTuples(costRank(a.ready), costRank(b.ready));
                if (byCost) return byCost;
                if (a.cand.level !== b.cand.level) return a.cand.level - b.cand.level;
            }
            return a.cand.actionHrid.localeCompare(b.cand.actionHrid);
        });
        [chosen] = met;
    } else {
        // Nothing met (or levels unknown): the easiest way in, the likelier drop on a tie
        scored.sort(
            (a, b) =>
                a.cand.level - b.cand.level ||
                (b.cand.dropRate || 0) - (a.cand.dropRate || 0) ||
                a.cand.actionHrid.localeCompare(b.cand.actionHrid)
        );
        [chosen] = scored;
    }
    Object.assign(out, chosen.ready, { actionHrid: chosen.cand.actionHrid });
    if (rare) out.dropRate = chosen.cand.dropRate;
    return out;
}
