/** Read-only shared-route experiment. It cannot change the advisor's ranking. */
import {
    chooseCraftAcquisition,
    priceAcquisitionRoute,
    selectAcquisitionRoute,
} from '../../utils/acquisition-route.js';
import { craftAcquisitionRoutes } from '../../utils/acquisition-craft.js';

/**
 * Compare the existing quote with shared Buy/Craft/Mirror accounting. Unsupported
 * contexts return a reason, never a plausible quote borrowed from local stock.
 * The caller supplies a candidate-scoped inventory snapshot and all services.
 * @param {Object} context - target, copies, sellIds, preference and unsupported reason
 * @param {Object} services - Explicit buy/craft/enhance/Mirror services
 * @returns {Object} Diagnostic comparison; no live state or stored result is changed
 */
export function compareAdvisorAcquisition(context, services) {
    if (context.unsupported) return { status: 'unsupported', reason: context.unsupported };
    const { target, preference = 'auto' } = context;
    const rows = [priceAcquisitionRoute({ id: 'buy', gross: services.buy(target.itemHrid, target.level) }, context)];
    const craft = chooseCraftAcquisition(craftAcquisitionRoutes(context, services));
    if (craft) rows.push(craft);
    const mirror = services.mirror?.(context);
    if (mirror) rows.push(priceAcquisitionRoute({ ...mirror, id: 'mirror' }, context));
    const { chosen } = selectAcquisitionRoute(rows, { preference });
    return {
        status: chosen ? 'priced' : 'unknown',
        route: chosen?.id || null,
        cash: chosen?.cash ?? null,
        real: chosen?.real ?? null,
        preference,
        routes: rows,
        notes: [
            ...(context.notes || []),
            ...(chosen?.warnings || []),
            ...(chosen?.eligibility?.status === 'unknown' ? ['Craft availability is unknown.'] : []),
        ],
    };
}
