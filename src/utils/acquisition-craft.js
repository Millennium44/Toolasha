/** Craft candidates for one target, with explicit inventory and injected services. */
import { priceAcquisitionRoute } from './acquisition-route.js';

/**
 * Calculate Craft alternatives, retaining bought and owned bases until real-cost
 * comparison. Recipes arrive with Artisan-adjusted inputs, never live state.
 * `material` returns {cost, eligibility}; `enhance` returns number|null.
 * @param {Object} context - target {itemHrid, level}, recipe, copies and sellIds
 * @param {Object} services - buy, material, enhance, combineEligibility callbacks
 * @returns {Array<Object>} All priced or explicitly unknown craft alternatives
 */
export function craftAcquisitionRoutes(context, services) {
    const { target, recipe, copies = [], eligibility = { status: 'unknown' } } = context;
    if (!recipe || (target.level > 0 && !recipe.retainAllEnhancement)) return [];
    const outputCount = recipe.outputCount > 0 ? recipe.outputCount : 1;
    const checks = [eligibility];
    let materials = 0;
    const bill = [];
    for (const input of recipe.inputItems || []) {
        const count = input.count || 0;
        if (!(count > 0)) continue;
        const priced = services.material(input.itemHrid, count);
        if (!Number.isFinite(priced?.cost)) materials = null;
        else if (materials !== null) materials += priced.cost;
        checks.push(priced?.eligibility || { status: 'unknown' });
        if (input.itemHrid !== '/items/coin')
            bill.push({ itemHrid: input.itemHrid, enhancementLevel: 0, count: count / outputCount });
    }
    const available = services.combineEligibility(checks);
    const bases = [];
    const baseHrid = recipe.upgradeItemHrid;
    const needsLevel = recipe.retainAllEnhancement ? target.level : 0;
    if (!baseHrid) bases.push({ gross: 0, consumed: [], baseLevel: 0, bill: [] });
    else {
        // Keep the directly shoppable alternative first, including when a base
        // is already owned: the forgone sale can make buying a second one cheaper.
        bases.push({
            gross: services.buy(baseHrid, needsLevel),
            consumed: [],
            baseLevel: needsLevel,
            bill: [{ itemHrid: baseHrid, enhancementLevel: needsLevel, count: 1 / outputCount }],
        });
        for (const copy of copies.filter((copy) => copy.itemHrid === baseHrid && copy.usable !== false)) {
            const run = copy.level < needsLevel ? services.enhance(baseHrid, copy.level, needsLevel) : 0;
            bases.push({ gross: run, consumed: [{ id: copy.id, share: 1 / outputCount }], baseLevel: 0, bill: [] });
        }
        {
            const fresh = services.material(baseHrid, 1);
            const run = needsLevel > 0 ? services.enhance(baseHrid, 0, needsLevel) : 0;
            bases.push({
                gross: Number.isFinite(fresh?.cost) && Number.isFinite(run) ? fresh.cost + run : null,
                consumed: [],
                baseLevel: 0,
                bill: [{ itemHrid: baseHrid, enhancementLevel: 0, count: 1 / outputCount }],
                eligibility: services.combineEligibility([available, fresh?.eligibility || { status: 'unknown' }]),
            });
        }
    }
    return bases.map((base) =>
        priceAcquisitionRoute(
            {
                id: 'craft',
                gross:
                    materials !== null && Number.isFinite(base.gross) ? (materials + base.gross) / outputCount : null,
                consumed: base.consumed,
                upgradeBaseLevel: base.baseLevel,
                eligibility: base.eligibility || available,
                // An input bill, not a cart: expected counts may be fractional and an
                // intermediate may be crafted. Consumers must not turn it into a buy bill.
                materialBill: [...bill, ...base.bill],
            },
            context
        )
    );
}
