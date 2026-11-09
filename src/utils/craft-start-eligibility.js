/** Startability is separate from an item's price and from its wear requirements. */
import dataManager from '../core/data-manager.js';
import { resolveActionContext } from './action-context.js';
import { canStartAction } from './efficiency.js';
import { getDrinkConcentration, parseTeaSkillLevelBonus, parseActionLevelBonus } from './tea-parser.js';

/**
 * Resolve the selected setup, optionally modeling an explicitly labeled alternative.
 * Alternatives never change slots or buy tea. Ultra replaces only the skill tea and
 * is offered only when the resolved equipment has a free drink slot.
 * @param {string} actionType - Action type HRID
 * @param {string} variant - current, no-artisan, ultra, or ultra-no-artisan
 * @returns {Object} Context and whether the modeled setup is legal
 */
export function craftStartContext(actionType, variant = 'current') {
    const context = resolveActionContext(actionType);
    const items = dataManager.getInitClientData()?.itemDetailMap;
    let drinks = context.drinks;
    const unknown = !items || !Array.isArray(drinks) || !context.equipment?.get;
    if (unknown) return { ...context, valid: false };
    if ([...context.equipment.values()].some((item) => !items[item?.itemHrid]?.equipmentDetail)) {
        return { ...context, valid: false };
    }
    if (variant.includes('no-artisan')) drinks = drinks.filter((d) => d.itemHrid !== '/items/artisan_tea');
    if (variant.includes('ultra')) {
        const skill = actionType?.split('/').pop();
        const tea = `/items/ultra_${skill}_tea`;
        if (!items[tea]?.consumableDetail?.buffs) return { ...context, valid: false };
        const skillTeas = new Set([`/items/${skill}_tea`, `/items/super_${skill}_tea`, tea]);
        drinks = drinks.filter((d) => !skillTeas.has(d.itemHrid));
        const pouch = context.equipment.get('/item_locations/pouch');
        const extra = items[pouch?.itemHrid]?.equipmentDetail?.combatStats?.drinkSlots || 0;
        if (drinks.length >= Math.min(3, Math.max(1, 1 + extra))) return { ...context, valid: false };
        drinks = [...drinks, { itemHrid: tea }];
    }
    return { ...context, drinks, valid: true };
}

/**
 * Check a recipe with actual local levels and its selected equipment/drinks.
 * Missing levels or tea details are unknown, never an invented level zero.
 * @param {Object} action - Production action detail
 * @param {string} variant - Optional modeled setup
 * @returns {Object} status, message and the exact level requirement/bonuses
 */
export function actionStartEligibility(action, variant = 'current') {
    const unknown = { status: 'unknown', message: 'Craft availability unknown' };
    const requirement = action?.levelRequirement;
    if (!requirement?.skillHrid || !Number.isFinite(requirement.level)) return unknown;
    if (variant.includes('ultra')) {
        const baseline = actionStartEligibility(action, variant.includes('no-artisan') ? 'no-artisan' : 'current');
        if (baseline.status === 'available') return baseline;
    }
    try {
        const skills = dataManager.getSkills?.();
        const skillLevel = Array.isArray(skills)
            ? skills.find((s) => s.skillHrid === requirement.skillHrid)?.level
            : null;
        if (!Number.isFinite(skillLevel)) return unknown;
        const context = craftStartContext(action.type, variant);
        const items = dataManager.getInitClientData()?.itemDetailMap;
        if (!context.valid || context.drinks.some((d) => !items[d.itemHrid]?.consumableDetail?.buffs)) return unknown;
        const concentration = getDrinkConcentration(context.equipment, items);
        const teaSkillLevelBonus = parseTeaSkillLevelBonus(action.type, context.drinks, items, concentration);
        const actionLevelBonus = parseActionLevelBonus(context.drinks, items, concentration);
        if (![concentration, teaSkillLevelBonus, actionLevelBonus].every(Number.isFinite)) return unknown;
        const level = requirement.level;
        const canStart = canStartAction({ requiredLevel: level, skillLevel, teaSkillLevelBonus, actionLevelBonus });
        const skill = requirement.skillHrid.split('/').pop();
        const needed = level + Math.trunc(actionLevelBonus);
        const actual = Math.floor(skillLevel + teaSkillLevelBonus);
        return {
            status: canStart ? 'available' : 'blocked',
            message: canStart
                ? 'Can craft with selected teas'
                : `${action.name || 'Recipe'} needs ${skill} ${needed}; selected setup has ${actual}`,
            skillHrid: requirement.skillHrid,
            level,
            skillLevel,
            teaSkillLevelBonus,
            actionLevelBonus,
            requiredTea: variant.includes('ultra') ? `/items/ultra_${skill}_tea` : null,
        };
    } catch {
        return unknown;
    }
}

/** Combine checks while keeping a known failure distinct from missing data. */
export function combineCraftEligibility(checks) {
    const blocked = checks.filter((check) => check.status === 'blocked');
    const unknown = checks.some((check) => check.status === 'unknown');
    return {
        status: blocked.length ? 'blocked' : unknown ? 'unknown' : 'available',
        message: blocked.length
            ? [...new Set(blocked.map((check) => check.message))].join('; ')
            : unknown
              ? 'Craft availability unknown'
              : 'Can craft with selected teas',
        requiredTeas: [
            ...new Set(checks.flatMap((check) => check.requiredTeas || (check.requiredTea ? [check.requiredTea] : []))),
        ],
        requirements: checks.flatMap((check) => check.requirements || (check.skillHrid ? [check] : [])),
    };
}

/** Check only craft nodes the plan actually chooses, including every intermediate. */
export function craftPlanEligibility(plan, variant = 'current') {
    if (!plan) return combineCraftEligibility([{ status: 'unknown' }]);
    const checks = [];
    const walk = (node) => {
        if (node.strategy !== 'craft') return;
        const action = dataManager.getInitClientData()?.actionDetailMap?.[node.actionHrid];
        checks.push(actionStartEligibility(action, variant));
        for (const child of node.children || []) walk(child);
    };
    walk(plan);
    return combineCraftEligibility(checks);
}
