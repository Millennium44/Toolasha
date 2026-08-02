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
import { itemIcon, linkToMarketplace, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';
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

/**
 * Every charm, ranked by what it buys per coin.
 *
 * The row names the winner; the panel is for when you want to see the field —
 * which matters because the winner changes with the market and the second-best
 * is often within a rounding error of it.
 */
export const charmPanel = createPanel({
    id: 'charmPanel',
    title: 'Charms',
    size: { width: 460, height: 420 },
    accent: '#c9a0ff',
    draw: (body) => {
        const charms = rankedCharms();
        const worn = equippedCharm();

        const current = panelCard(body, 'Equipped', '#c9a0ff');
        if (worn) {
            current.append(
                panelLine(worn.name, `+${worn.experience.toFixed(2)}%`, ROW_COLORS.good),
                panelLine('Enhancement', `+${worn.enhancementLevel}`),
                panelLine('Worth', worn.price ? formatKMB(worn.price) : 'no price', ROW_COLORS.gold)
            );
        } else {
            current.appendChild(panelNote('Nothing in the charm slot.'));
        }

        if (!charms.length) {
            body.appendChild(panelNote('No charms priced yet.'));
            return;
        }

        const table = panelCard(body, 'Best value per coin', '#c9a0ff');
        for (const charm of charms.slice(0, 12)) {
            const line = document.createElement('div');
            Object.assign(line.style, { display: 'flex', alignItems: 'center', gap: '7px', padding: '1px 0' });

            const icon = itemIcon(charm.itemHrid, 18);
            linkToMarketplace(icon, charm.itemHrid, navigateToMarketplace);

            const name = document.createElement('span');
            name.textContent = charm.name;
            Object.assign(name.style, {
                flex: '1',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
            });
            linkToMarketplace(name, charm.itemHrid, navigateToMarketplace);

            const bonus = document.createElement('span');
            bonus.textContent = `+${charm.experience.toFixed(2)}%`;
            bonus.style.color = ROW_COLORS.good;

            const price = document.createElement('span');
            price.textContent = charm.price ? formatKMB(charm.price) : 'no price';
            price.style.color = charm.price ? ROW_COLORS.gold : ROW_COLORS.bad;

            // What the swap actually buys, which is the number to pay against —
            // not the charm's whole bonus
            const upgrade = upgradeValue(charm, worn);
            const gain = document.createElement('span');
            gain.textContent = upgrade.gain > 0 ? `+${upgrade.gain.toFixed(2)}%` : '—';
            gain.style.color = upgrade.gain > 0 ? ROW_COLORS.accent : 'rgba(232, 236, 245, 0.4)';
            gain.title = 'What this would gain over the charm you are wearing.';

            line.append(icon, name, bonus, price, gain);
            table.appendChild(line);
        }

        body.appendChild(
            panelNote(
                'Ranked by experience per coin. Ranking by bonus alone always names the grandmaster, which is true and useless.'
            )
        );
    },
});

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
                : '\nNothing in the charm slot.') +
            '\nDouble-click for the whole field.';
    },
    onOpen: () => charmPanel.toggle(),
});
