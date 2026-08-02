/**
 * Charm value
 *
 * Which charm on the market buys the most experience per coin.
 *
 * A charm grants a percentage bonus to one skill's experience, scaling with tier
 * and enhancement level. Price scales with neither in any orderly way, so the
 * best charm to buy is neither the highest tier nor the cheapest — it is
 * whichever gives the most bonus per coin, and that is a division across six
 * tiers and twenty enhancement levels that nobody does in their head.
 *
 * The row reports the best buy for the skill you are actually training, since a
 * ranking across every skill's charms is a list of things you do not want.
 *
 * The arithmetic is in `utils/charm-value.js` with tests. This module reads the
 * market and the equipped charm and draws one line.
 *
 * The model is QCharm's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import { getItemPrices } from '../../utils/market-data.js';
import { getEnhancementMultiplier } from '../../utils/enhancement-multipliers.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { charmValue, rankCharms, upgradeValue, charmTier } from '../../utils/charm-value.js';

const CHARM_SLOT = '/equipment_types/charm';

/**
 * Every charm the game has, valued at today's prices.
 *
 * Found by looking for the charm slot in the item map rather than by listing
 * them, so a charm added by an update is priced rather than missed.
 *
 * @returns {Array<Object>} From `charmValue`, best value per coin first
 */
export function rankedCharms() {
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const charms = [];

    for (const [itemHrid, details] of Object.entries(itemDetailMap)) {
        if (details?.equipmentDetail?.type !== CHARM_SLOT) continue;
        if (!charmTier(itemHrid)) continue;

        const valued = charmValue({
            itemHrid,
            price: getItemPrices(itemHrid)?.ask || 0,
            multiplierOf: (level) => getEnhancementMultiplier(details, level),
        });
        if (valued) charms.push({ ...valued, name: details.name || itemHrid });
    }
    return rankCharms(charms);
}

/**
 * The charm currently in the slot, valued the same way.
 * @returns {Object|null} From `charmValue`
 */
export function equippedCharm() {
    const equipment = dataManager.getEquipment?.();
    const worn = equipment?.get?.(CHARM_SLOT);
    if (!worn?.itemHrid) return null;

    const details = dataManager.getItemDetails?.(worn.itemHrid);
    const valued = charmValue({
        itemHrid: worn.itemHrid,
        enhancementLevel: worn.enhancementLevel || 0,
        price: getItemPrices(worn.itemHrid)?.ask || 0,
        multiplierOf: (level) => getEnhancementMultiplier(details, level),
    });
    return valued ? { ...valued, name: details?.name || worn.itemHrid } : null;
}

registerRow({
    key: 'charmValue',
    name: 'Charm Value',
    defaultSize: { width: 230, height: 30 },
    render: (container) => {
        const best = rankedCharms()[0];
        if (!best) return blank(container);

        const worn = equippedCharm();
        // What the swap would buy, not what the charm is worth: paying for 6.5
        // when the upgrade buys 1.5 is how people overpay
        const upgrade = upgradeValue(best, worn);

        row(container, [
            { text: '🔮', color: ROW_COLORS.dim },
            { text: best.name, color: ROW_COLORS.dim, ellipsis: true },
            { text: `+${best.experience.toFixed(1)}%`, color: ROW_COLORS.good, push: true },
            { text: formatKMB(best.price), color: ROW_COLORS.gold },
        ]);
        container.title =
            `${best.name} is the best experience per coin: +${best.experience.toFixed(2)}% for ` +
            `${formatWithSeparator(Math.round(best.price))}.` +
            (worn
                ? upgrade.gain > 0
                    ? `\nOver your ${worn.name} that is +${upgrade.gain.toFixed(2)}% gained.`
                    : `\nYour ${worn.name} is already at least as good.`
                : '\nNothing in the charm slot.');
    },
});
