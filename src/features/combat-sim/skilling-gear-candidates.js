/**
 * Skilling gear candidates
 *
 * The best piece you are not wearing, per slot, per skill.
 *
 * The skilling advisor only ever offered to *enhance* what was already on —
 * useful, and silent about the two upgrades that actually move a labyrinth
 * skilling room: a celestial tool, and the skill's own outfit. Neither is on the
 * character, so neither was ever a candidate, and an analysis that can only
 * suggest +1 on what you have cannot say "buy the brush".
 *
 * ## Why it is keyed by skill
 *
 * A Milking outfit does nothing in a Crafting room. The analysis runs over every
 * skill at once, and a candidate with no skill on it is applied to all of them —
 * so an outfit would appear to help every room, which is both wrong and the kind
 * of wrong that reads as plausible. Every candidate here carries the skill it
 * belongs to and is applied to that skill's equipment alone.
 *
 * ## What counts as "for this skill"
 *
 * The stats, rather than a list of names. An item is for Milking if its
 * `noncombatStats` carry a milking stat — which is exactly what a celestial
 * milking tool and a milking outfit have in common, and what a name list would
 * have to be updated for on every content patch.
 *
 * ## Which stats, exactly
 *
 * The ones the labyrinth skilling model reads off equipment, and only those.
 * `buildEquipmentBuffsForSkill` turns a kit into exactly two numbers — an
 * `/buff_types/action_speed` from `parseEquipmentSpeedBonuses` and an
 * `/buff_types/efficiency` from `parseEquipmentEfficiencyBonuses` — so a rare
 * find, an essence find or a gathering quantity worn on a piece of gear reaches
 * the room simulation nowhere at all. Counting them meant ranking a rare-find
 * charm above a speed tool, and offering candidates that could only ever come
 * back at +0.00% after a full simulation each.
 */

/**
 * The enhancement level a piece you do not own yet is offered at.
 *
 * Not +0. Nobody buys a celestial tool and leaves it there, so pricing and
 * simulating one at +0 answers a question nobody is asking — and understates
 * both the cost and the gain against every other candidate, which are judged at
 * the level you would actually run them. The same +5 the philosopher's
 * accessories are offered at, for the same reason.
 */
export const NEW_GEAR_LEVEL = 5;

/**
 * Skills whose `<skill>Speed` field the equipment parser will actually read.
 *
 * Mirrors `VALID_SPEED_FIELDS` in `utils/equipment-parser.js`, which is the list
 * the parser checks a field name against before summing it. A field that is not
 * on it is read as nothing, so an item carrying only that field is an item the
 * room simulation cannot see.
 */
const SPEED_SKILLS = new Set([
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'brewing',
    'cooking',
    'alchemy',
    'enhancing',
]);

/**
 * Skills whose `<skill>Efficiency` field the equipment parser will read.
 *
 * Mirrors `VALID_EFFICIENCY_FIELDS`. Enhancing is absent from it in the game's
 * own data — enhancing runs on success rate rather than efficiency — so an
 * `enhancingEfficiency` would be summed by nobody.
 */
const EFFICIENCY_SKILLS = new Set([
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'brewing',
    'cooking',
    'alchemy',
]);

/**
 * The bare skill name, whichever form the caller has.
 *
 * Callers hold skills as hrids (`/skills/milking`) because that is what the
 * equipment map and the level table are keyed by; the stat names here are bare
 * (`milkingSpeed`). Taking only the bare form meant an hrid produced
 * `/skills/milkingSpeed`, which matches nothing, and a tool slot lookup that
 * missed — so every celestial tool and every skill outfit was silently filtered
 * out and the whole feature came back empty without ever erroring.
 *
 * @param {string} skill - `milking` or `/skills/milking`
 * @returns {string} `milking`
 */
function skillName(skill) {
    return String(skill || '')
        .replace('/skills/', '')
        .toLowerCase();
}

/** Equipment types that can hold something for a given skill, by tool slot */
const TOOL_TYPES = {
    milking: '/equipment_types/milking_tool',
    foraging: '/equipment_types/foraging_tool',
    woodcutting: '/equipment_types/woodcutting_tool',
    cheesesmithing: '/equipment_types/cheesesmithing_tool',
    crafting: '/equipment_types/crafting_tool',
    tailoring: '/equipment_types/tailoring_tool',
    cooking: '/equipment_types/cooking_tool',
    brewing: '/equipment_types/brewing_tool',
    alchemy: '/equipment_types/alchemy_tool',
    enhancing: '/equipment_types/enhancing_tool',
};

/**
 * The `noncombatStats` fields that can move one skill's labyrinth room.
 *
 * The skill's own speed and efficiency, plus the two generic skilling ones every
 * skill shares. The generic ones are why an outfit piece with only
 * `skillingSpeed` is still a candidate for every skill rather than for none.
 *
 * Rare find, essence find and gathering quantity are deliberately absent: the
 * kit reaches the room model through `parseEquipmentSpeedBonuses` and
 * `parseEquipmentEfficiencyBonuses` and through nothing else, so a piece
 * carrying only those is a piece the room cannot feel. (Gathering quantity does
 * move a gathering room's double-progress chance — but only the *community*
 * buff's, which arrives as a `/buff_types/gathering` buff rather than off the
 * character's gear.)
 *
 * @param {string} skill - Skill name, e.g. `milking`
 * @returns {Set<string>}
 */
export function relevantStats(skill) {
    const key = skillName(skill);
    const fields = new Set(['skillingSpeed', 'skillingEfficiency']);
    if (SPEED_SKILLS.has(key)) fields.add(`${key}Speed`);
    if (EFFICIENCY_SKILLS.has(key)) fields.add(`${key}Efficiency`);
    return fields;
}

/**
 * Whether this item can change the outcome of this skill's room at all.
 *
 * Read off the item's own stats rather than a list of names, so a tool added in
 * next month's patch is scoped correctly the day it ships and a renamed one does
 * not silently fall out.
 *
 * @param {Object} itemDetail - From `itemDetailMap`
 * @param {string} skill - `cooking` or `/skills/cooking`
 * @returns {boolean}
 */
export function affectsSkill(itemDetail, skill) {
    return skillScore(itemDetail, relevantStats(skill)) > 0;
}

/**
 * A worn kit with the pieces that cannot touch this skill's room taken out.
 *
 * Simming one skill used to weigh every noncombat piece the character had on,
 * whichever skill it belonged to — a Cooking run spent simulations on "Holy
 * Chisel +5 → +7", which is a crafting tool and cannot move a cooking room by
 * any amount. Each of those is a full room evaluation spent proving +0.00%, and
 * a row in the results that reads as a considered "not worth it" rather than as
 * a question that was never worth asking.
 *
 * Only pieces that *have* noncombat stats and have none this skill reads are
 * dropped. A piece with no noncombat stats at all — a combat necklace worn
 * because nothing better is on — stays: it generates no enhancement candidate
 * anyway, and it is what the philosopher's-accessory swap is measured against,
 * so removing it would turn "trade this necklace for the philosopher's one"
 * into "fill an empty slot" and price the trade without its sale.
 *
 * Safe to hand straight to the simulation: everything dropped contributes zero
 * to this skill's speed and efficiency by construction, so the baseline is the
 * number it always was.
 *
 * @param {Object} equipment - Slot → `{ hrid, enhancementLevel }`
 * @param {string} skill - The skill being simmed
 * @param {Object} itemDetailMap - Game data
 * @returns {Object} A new equipment object
 */
export function scopeEquipmentToSkill(equipment = {}, skill, itemDetailMap = {}) {
    const scoped = {};
    for (const [slot, worn] of Object.entries(equipment || {})) {
        if (!worn?.hrid) continue;
        const detail = itemDetailMap[worn.hrid];
        const noncombat = detail?.equipmentDetail?.noncombatStats;
        const hasNoncombat = noncombat && Object.values(noncombat).some((value) => value > 0);
        if (hasNoncombat && !affectsSkill(detail, skill)) continue;
        scoped[slot] = worn;
    }
    return scoped;
}

/**
 * How much one item is worth to one skill, as a single number.
 *
 * A crude sum of the stats that matter, and deliberately so: this only has to
 * rank the candidates well enough to pick which one is worth a simulation, and
 * the simulation is what actually answers the question. A weighting scheme here
 * would be a second, worse model sitting in front of the real one.
 *
 * @param {Object} itemDetail - From `itemDetailMap`
 * @param {Set<string>} stats - From `relevantStats`
 * @returns {number} 0 when the item does nothing for the skill
 */
export function skillScore(itemDetail, stats) {
    const noncombat = itemDetail?.equipmentDetail?.noncombatStats;
    if (!noncombat) return 0;

    let score = 0;
    for (const [field, value] of Object.entries(noncombat)) {
        if (stats.has(field) && value > 0) score += value;
    }
    return score;
}

/**
 * Whether the character can actually wear it.
 *
 * A celestial tool twenty levels out of reach is not an upgrade, it is a
 * shopping list for next month — and it would sit at the top of a ranked list
 * pushing down the things that can be bought today.
 *
 * @param {Object} itemDetail - From `itemDetailMap`
 * @param {Map<string, number>|Object} levels - Skill hrid → level
 * @returns {boolean}
 */
export function canEquip(itemDetail, levels) {
    const read = (hrid) => (levels instanceof Map ? levels.get(hrid) : levels?.[hrid]) ?? 1;
    for (const requirement of itemDetail?.equipmentDetail?.levelRequirements || []) {
        if (!requirement.levelTypeHrid) continue;
        const skillHrid = requirement.levelTypeHrid.replace('/level_types/', '/skills/');
        if (read(skillHrid) < requirement.level) return false;
    }
    return true;
}

/**
 * The best piece for one skill in each slot, where it beats what is worn.
 *
 * One candidate per slot rather than every item that would help: the analysis
 * simulates each candidate, and offering six tiers of the same tool would spend
 * the whole run proving that the best one is the best one.
 *
 * @param {Object} options - Everything this needs
 * @param {string} options.skill - Skill name, e.g. `milking`
 * @param {Object} options.equipment - What that skill currently wears, by slot
 * @param {Object} options.itemDetailMap - Game data
 * @param {Map<string, number>|Object} options.levels - Skill hrid → level
 * @returns {Array<Object>} Candidates, each carrying `skillKey`
 */
export function bestGearForSkill({ skill, equipment = {}, itemDetailMap = {}, levels = new Map() }) {
    const stats = relevantStats(skill);
    const toolType = TOOL_TYPES[skillName(skill)];
    const best = new Map();

    for (const [hrid, detail] of Object.entries(itemDetailMap)) {
        const type = detail?.equipmentDetail?.type;
        if (!type) continue;
        // A tool slot belongs to one skill; offering another skill's tool for it
        // would be offering something that cannot go there
        if (type.endsWith('_tool') && type !== toolType) continue;

        const score = skillScore(detail, stats);
        if (score <= 0) continue;
        if (!canEquip(detail, levels)) continue;

        const standing = best.get(type);
        if (!standing || score > standing.score) best.set(type, { hrid, detail, score });
    }

    const candidates = [];
    for (const [slot, winner] of best) {
        const worn = equipment[slot];
        if (worn?.hrid === winner.hrid) continue;

        // Worn gear is judged at the level it is worn at; the replacement on its
        // own stats, since the enhancement it would be bought at applies to both
        const wornScore = worn ? skillScore(itemDetailMap[worn.hrid], stats) : 0;
        if (wornScore >= winner.score) continue;

        const name = winner.detail.name || winner.hrid.split('/').pop();
        const from = worn ? `${itemDetailMap[worn.hrid]?.name || worn.hrid.split('/').pop()} → ` : '';
        candidates.push({
            skillKey: skill,
            slot,
            // Empty rather than the replacement's own hrid when the slot is
            // bare: the cost is buy-price minus what the piece it replaces
            // sells for, and naming itself there would price it as free
            currentHrid: worn?.hrid || '',
            currentLevel: worn?.enhancementLevel || 0,
            upgradeHrid: winner.hrid,
            upgradeLevel: NEW_GEAR_LEVEL,
            description: `${from}${name} +${NEW_GEAR_LEVEL} (${skillName(skill)})`,
            type: 'skilling_gear',
        });
    }
    return candidates;
}
