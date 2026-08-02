/**
 * Charm value
 *
 * Which charm of the kind you are wearing buys the most experience per coin.
 *
 * A charm grants a percentage bonus to one skill's experience, scaling with tier
 * and enhancement level. Price scales with neither in any orderly way, so the
 * best charm to buy is neither the highest tier nor the cheapest — it is
 * whichever gives the most bonus per coin, and that is a division across six
 * tiers and twenty enhancement levels that nobody does in their head.
 *
 * ## Within one focus, not across all of them
 *
 * A melee charm and a brewing charm are not alternatives to each other. Ranking
 * every charm in the game together produces a list of things you do not want
 * with the one you do want somewhere in it, which is what this panel did before:
 * it opened on Basic Brewing, Basic Tailoring and Basic Cooking while the
 * character was wearing a Grandmaster Melee.
 *
 * So the panel is scoped to the **family** of the equipped charm — the same
 * focus at every tier and every enhancement level the market is selling.
 *
 * The arithmetic is in `utils/charm-value.js` with tests. This module reads the
 * market and the equipped charm and draws.
 *
 * The model is QCharm's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { loadWhenReady } from '../../utils/deferred-load.js';
import { getItemPrices } from '../../utils/market-data.js';
import { getEnhancementMultiplier } from '../../utils/enhancement-multipliers.js';
import { formatWithSeparator, formatKMB } from '../../utils/formatters.js';
import { itemIcon, linkToMarketplace, row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createPanel, panelCard, panelNote } from '../../utils/simple-panel.js';
import { registerRow } from '../../utils/overlay-rows.js';
import {
    CHARM_TIER_EXPERIENCE,
    charmTier,
    charmFamily,
    charmDisplayName,
    experiencePerMillion,
    splitByUpgrade,
    sortCharmRows,
    shopPrice,
    upgradeValue,
} from '../../utils/charm-value.js';

/**
 * Where the game keeps the equipped charm.
 *
 * An **item location**, not an equipment type. `characterEquipment` is keyed by
 * `/item_locations/…` — asking it for `/equipment_types/charm` returns undefined
 * every time, which is why this panel reported an empty charm slot while a
 * Grandmaster Melee Charm was sitting in it.
 */
const CHARM_SLOT = '/item_locations/charm';

/** The enhancement levels the game allows, which is what the market is scanned over */
const MAX_ENHANCEMENT = 20;

/**
 * What every charm is, for the purpose of enhancement scaling.
 *
 * Stated rather than looked up. `getItemDetails` misses a tier the game has not
 * described to this session, and a miss there does not fail — it silently
 * returns the 1× default and reports a +20 charm as scaling like a sword.
 */
const CHARM_DETAILS = { equipmentDetail: { type: '/equipment_types/charm' } };

/** Which column the table is ordered by, remembered while the panel is open */
let sortColumn = 'perMillion';
let sortDirection = 'desc';

/**
 * Which sections are folded open.
 *
 * Held outside the draw, because the draw is where it would be lost: the panel
 * rebuilds its whole body every few seconds, so a section whose state lived in
 * the DOM would spring back to its default on the next refresh — folding one
 * away and watching it reappear three seconds later, over and over.
 *
 * @type {Object<string, boolean>}
 */
let sectionOpen = {};

const FOLDS_KEY = 'charmPanelFolds';

// Not read at module scope: IndexedDB opens after the libraries evaluate, so a
// read here reliably returns the default and reliably logs that it could not
loadWhenReady(FOLDS_KEY, 'settings', (saved) => Object.assign(sectionOpen, saved), 'the charm panel folds');

/** Remember a fold across sessions, since a panel you keep refolding is a chore */
async function saveFolds() {
    try {
        await storage.setJSON(FOLDS_KEY, sectionOpen, 'settings');
    } catch (error) {
        console.error('[CharmValue] Saving the panel folds failed:', error);
    }
}

/** Put the ordering and the folds back, for a test that must not inherit them */
export function resetCharmSort() {
    sortColumn = 'perMillion';
    sortDirection = 'desc';
    sectionOpen = {};
}

/**
 * One charm at one enhancement level, valued.
 *
 * @param {string} itemHrid - The charm
 * @param {number} enhancementLevel - How enhanced
 * @param {number} price - Its ask, or 0 when nobody is selling it
 * @returns {Object|null} Null when it is not a charm this knows
 */
function charmRow(itemHrid, enhancementLevel, price) {
    const tier = charmTier(itemHrid);
    const base = CHARM_TIER_EXPERIENCE[tier];
    if (!(base > 0)) return null;

    const experience = base * getEnhancementMultiplier(CHARM_DETAILS, enhancementLevel);

    return {
        itemHrid,
        tier,
        enhancementLevel,
        experience,
        price,
        experiencePerMillion: experiencePerMillion(experience, price),
        name: charmDisplayName(itemHrid),
    };
}

/**
 * The charm currently in the slot.
 * @returns {Object|null} From `charmRow`
 */
export function equippedCharm() {
    const worn = dataManager.getEquipment?.()?.get?.(CHARM_SLOT);
    if (!worn?.itemHrid) return null;

    const enhancementLevel = worn.enhancementLevel || 0;
    const ask = getItemPrices(worn.itemHrid, enhancementLevel)?.ask || 0;
    return charmRow(worn.itemHrid, enhancementLevel, ask || shopPrice(worn.itemHrid, enhancementLevel));
}

/**
 * Every charm of the equipped kind that the market is selling.
 *
 * One row per enhancement level rather than one per charm: a Master +3 and a
 * Master +5 are different purchases at different prices, and which of them is
 * worth it is the whole question.
 *
 * @returns {Array<Object>} From `charmRow`, unsorted
 */
export function familyRows() {
    const worn = dataManager.getEquipment?.()?.get?.(CHARM_SLOT);
    const family = charmFamily(worn?.itemHrid);
    if (!family.length) return [];

    const rows = [];
    for (const itemHrid of family) {
        let sold = false;
        for (let level = 0; level <= MAX_ENHANCEMENT; level++) {
            const ask = getItemPrices(itemHrid, level)?.ask;
            if (!(ask > 0)) continue;

            const built = charmRow(itemHrid, level, ask);
            if (built) {
                rows.push(built);
                sold = true;
            }
        }
        // A tier nobody is selling still gets a line: knowing the master charm
        // has no listings is an answer, and a missing row reads as an oversight
        // rather than as an empty market. The trainee tier is never listed and
        // is not unpriced either — the shop sells it at a fixed price.
        if (!sold) {
            const built = charmRow(itemHrid, 0, shopPrice(itemHrid, 0));
            if (built) rows.push(built);
        }
    }
    return rows;
}

/**
 * A block with a heading that folds it away.
 *
 * @param {HTMLElement} body - Where it goes
 * @param {Object} definition - What section this is
 * @param {string} definition.id - Stable key the fold is remembered under. Not
 *   the title: the titles carry the equipped bonus, so they change under you
 * @param {string} definition.title - Heading
 * @param {string} definition.accent - Heading colour
 * @param {boolean} [definition.defaultOpen] - How it starts, the first time only
 * @returns {HTMLElement} The contents, to append rows to
 */
function section(body, { id, title, accent, defaultOpen = true }) {
    const open = sectionOpen[id] ?? defaultOpen;

    const card = panelCard(body, undefined, accent);
    card.style.padding = '0';

    const header = document.createElement('div');
    Object.assign(header.style, {
        color: accent,
        fontWeight: 'bold',
        cursor: 'pointer',
        padding: '6px 9px',
        userSelect: 'none',
    });
    header.dataset.section = id;

    const content = document.createElement('div');
    Object.assign(content.style, { padding: '0 9px 7px', display: open ? 'block' : 'none' });

    header.textContent = `${open ? '▼' : '▶'} ${title}`;
    header.addEventListener('click', () => {
        // Recorded before it is drawn, so the next refresh finds the choice
        // rather than the default
        sectionOpen[id] = !open;
        saveFolds();
        charmPanel.render();
    });

    card.append(header, content);
    return content;
}

/** One row of the charm table's grid */
function tableRow() {
    const line = document.createElement('div');
    Object.assign(line.style, {
        display: 'grid',
        gridTemplateColumns: '22px minmax(0, 1fr) 30px 54px 70px 50px',
        gap: '6px',
        alignItems: 'center',
        padding: '2px 0',
    });
    return line;
}

/**
 * @param {string} text - What it says
 * @param {string} [color] - Ink
 * @returns {HTMLElement}
 */
function cell(text, color) {
    const span = document.createElement('span');
    span.textContent = text;
    Object.assign(span.style, { textAlign: 'right', whiteSpace: 'nowrap' });
    if (color) span.style.color = color;
    return span;
}

/**
 * The table's clickable heading row.
 * @param {Function} redraw - Called after the ordering changes
 * @returns {HTMLElement}
 */
function tableHeading(redraw) {
    const heading = tableRow();
    Object.assign(heading.style, {
        color: 'rgba(232, 236, 245, 0.5)',
        borderBottom: '1px solid rgba(255, 255, 255, 0.10)',
        paddingBottom: '3px',
    });

    const sortable = (label, column) => {
        const span = cell(sortColumn === column ? `${label} ${sortDirection === 'asc' ? '▲' : '▼'}` : label);
        span.style.cursor = 'pointer';
        span.dataset.column = column;
        span.addEventListener('click', () => {
            if (sortColumn === column) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            else {
                sortColumn = column;
                // A name reads best from the bottom tier up; every figure reads
                // best largest first, because that is where the answer is
                sortDirection = column === 'name' ? 'asc' : 'desc';
            }
            redraw();
        });
        return span;
    };

    const name = sortable('Name', 'name');
    name.style.textAlign = 'left';

    heading.append(
        document.createElement('span'),
        name,
        cell('Enh'),
        sortable('Exp%', 'experience'),
        sortable('Ask', 'price'),
        sortable('Exp/M', 'perMillion')
    );
    heading.title = 'Exp/M is the bonus per million coins — the ordering that answers "what should I buy".';
    return heading;
}

/**
 * @param {Object} charm - From `charmRow`
 * @param {Object|null} worn - The equipped charm
 * @returns {HTMLElement}
 */
function charmLine(charm, worn) {
    const line = tableRow();
    const isWorn = worn && charm.itemHrid === worn.itemHrid && charm.enhancementLevel === worn.enhancementLevel;
    if (isWorn) {
        line.style.background = 'rgba(201, 160, 255, 0.14)';
        line.style.borderRadius = '3px';
    }

    const icon = itemIcon(charm.itemHrid, 18);
    linkToMarketplace(icon, charm.itemHrid, navigateToMarketplace);

    const name = document.createElement('span');
    name.textContent = charm.name;
    Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    linkToMarketplace(name, charm.itemHrid, navigateToMarketplace);

    const gain = worn ? upgradeValue(charm, worn).gain : 0;
    line.title =
        `${charm.name} +${charm.enhancementLevel}: +${charm.experience.toFixed(2)}% experience` +
        (charm.price > 0 ? ` for ${formatWithSeparator(Math.round(charm.price))}.` : ', nobody selling.') +
        (isWorn
            ? '\nThis is the one you are wearing.'
            : worn
              ? `\nAgainst yours that is ${gain > 0 ? '+' : ''}${gain.toFixed(2)}%.`
              : '');

    line.append(
        icon,
        name,
        cell(String(charm.enhancementLevel)),
        cell(`${charm.experience.toFixed(2)}%`, ROW_COLORS.good),
        cell(charm.price > 0 ? formatKMB(charm.price) : 'no data', charm.price > 0 ? ROW_COLORS.gold : ROW_COLORS.dim),
        cell(
            charm.experiencePerMillion === null ? '—' : charm.experiencePerMillion.toFixed(2),
            charm.experiencePerMillion === null ? ROW_COLORS.dim : ROW_COLORS.accent
        )
    );
    return line;
}

/**
 * The tier table and the enhancement curve.
 *
 * Every figure in the panel comes out of these two and neither is visible
 * anywhere in the game, so a bonus that looks wrong is otherwise unarguable.
 *
 * @param {HTMLElement} body - Where it goes
 */
function drawGuide(body) {
    const content = section(body, {
        id: 'guide',
        title: 'Charm EXP Guide',
        accent: '#c9a0ff',
        defaultOpen: false,
    });

    const chips = (entries) => {
        const wrap = document.createElement('div');
        Object.assign(wrap.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '4px' });

        for (const text of entries) {
            const chip = document.createElement('span');
            chip.textContent = text;
            Object.assign(chip.style, {
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.10)',
                borderRadius: '3px',
                padding: '2px 7px',
                fontSize: '11px',
            });
            wrap.appendChild(chip);
        }
        content.appendChild(wrap);
    };

    chips(
        Object.entries(CHARM_TIER_EXPERIENCE).map(([tier, base]) => `${tier[0].toUpperCase()}${tier.slice(1)} ${base}%`)
    );

    // Derived from the game's own curve rather than a copied table, so an update
    // to enhancement scaling moves this with every figure below it
    const levels = [];
    for (let level = 0; level <= MAX_ENHANCEMENT; level++) {
        levels.push(`+${level}: ${getEnhancementMultiplier(CHARM_DETAILS, level).toFixed(2)}x`);
    }
    chips(levels);
}

/**
 * Every tier of the charm you are wearing, and what each would cost.
 */
export const charmPanel = createPanel({
    id: 'charmPanel',
    title: 'Charms',
    size: { width: 430, height: 480 },
    accent: '#c9a0ff',
    draw: (body) => {
        const worn = equippedCharm();
        if (!worn) {
            body.appendChild(panelNote('No charm equipped.'));
            body.appendChild(
                panelNote('The panel compares the charm you are wearing against every other tier of the same kind.')
            );
            return;
        }

        drawGuide(body);

        const rows = familyRows();
        const { upgrades, downgrades } = splitByUpgrade(rows, worn.experience);
        const current = `${worn.experience.toFixed(2)}%`;

        for (const [id, title, group, defaultOpen] of [
            ['upgrades', `Charm Upgrades (${current})`, upgrades, true],
            ['downgrades', `Charm Downgrades (${current})`, downgrades, false],
        ]) {
            if (!group.length) continue;

            const content = section(body, { id, title, accent: '#c9a0ff', defaultOpen });
            content.appendChild(tableHeading(() => charmPanel.render()));
            for (const charm of sortCharmRows(group, sortColumn, sortDirection)) {
                content.appendChild(charmLine(charm, worn));
            }
        }

        if (!rows.length) body.appendChild(panelNote('No prices for this charm family yet.'));
    },
});

registerRow({
    key: 'charmValue',
    name: 'Charm Value',
    defaultSize: { width: 230, height: 30 },
    render: (container) => {
        const worn = equippedCharm();
        // The best buy within the family, which is the only comparison worth
        // making — a brewing charm is not an alternative to a melee one
        const upgrades = splitByUpgrade(familyRows(), worn?.experience || 0).upgrades;
        const best = sortCharmRows(upgrades, 'perMillion', 'desc').find((charm) => charm.price > 0);
        if (!best) return blank(container);

        const upgrade = upgradeValue(best, worn);

        row(container, [
            { icon: best.itemHrid, size: 18 },
            { text: best.name, color: ROW_COLORS.dim, ellipsis: true },
            { text: `+${best.experience.toFixed(1)}%`, color: ROW_COLORS.good },
            { text: formatKMB(best.price), color: ROW_COLORS.gold },
        ]);
        container.title =
            `${best.name} +${best.enhancementLevel} is the best experience per coin in your charm family: ` +
            `+${best.experience.toFixed(2)}% for ${formatWithSeparator(Math.round(best.price))}.` +
            (worn
                ? upgrade.gain > 0
                    ? `\nOver your ${worn.name} +${worn.enhancementLevel} that is +${upgrade.gain.toFixed(2)}% gained.`
                    : `\nYour ${worn.name} is already at least as good.`
                : '\nNothing in the charm slot.') +
            '\nDouble-click for the whole family.';
    },
    onOpen: () => charmPanel.toggle(),
});
