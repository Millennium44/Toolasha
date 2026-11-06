/** @vitest-environment happy-dom */
/**
 * A Loadouts-panel tooltip names the plain item; Toolasha sets the game's name, stat lines and Market Price to
 * the level the loadout wears. Fixture table: the game's real `enhancementLevelTotalBonusMultiplierTable`
 * (counts 2% steps: +20 reads 50).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ENHANCEMENT_TABLE, FIXTURE_ITEMS } from '../__fixtures__/wire/enhancement-scaling.js';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid],
        getInitClientData: () => ({ enhancementLevelTotalBonusMultiplierTable: game.table }),
    },
}));
vi.mock('./market-data.js', () => ({
    getItemPrices: (hrid, level) => game.prices[`${hrid}:${level}`] ?? null,
}));

const { applyLoadoutLevelToGameLines, restoreLoadoutTooltip } = await import('./loadout-tooltip-rewrite.js');

const GLOVES = '/items/enchanted_gloves';
const SHIELD = '/items/test_shield';

beforeEach(() => {
    game.table = ENHANCEMENT_TABLE;
    game.items = {
        // 10% base, 2% of base per step (1x slot): +20 = 50 steps = +100% of base = 20%
        [GLOVES]: {
            equipmentDetail: {
                noncombatStats: { enhancingSpeed: 0.1, alchemyEfficiency: 0.1 },
                noncombatEnhancementBonuses: { enhancingSpeed: 0.002, alchemyEfficiency: 0.002 },
            },
        },
        [SHIELD]: {
            equipmentDetail: {
                combatStats: { armor: 8, waterResistance: 12.5 },
                combatEnhancementBonuses: { armor: 0.16 },
            },
        },
    };
    game.prices = {
        [`${GLOVES}:0`]: { ask: 8328000000, bid: 8000000000, average: 8164000000 },
        [`${GLOVES}:20`]: { ask: 28000000000, bid: 27000000000, average: 27500000000 },
    };
});

/** The game's tooltip shape: name div, stat rows, Market Price row (label and value in one text node) */
function popper(name, rows, price = 'Market Price: 8,328,000,000') {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__t">
        <div class="ItemTooltipText_name__n"><span>${name}</span></div>
        <div class="ItemTooltipText_equipmentDetail__e">${rows.map((r) => `<div><span>${r}</span></div>`).join('')}</div>
        <div class="ItemTooltipText_marketPrice__m"><span>${price}</span></div></div></div>`;
    document.body.appendChild(el);
    return el;
}

const info = (el, level = 20, extra = {}) => ({
    levelSource: 'loadout',
    enhancementLevel: level,
    nameEl: el.querySelector('div[class*="ItemTooltipText_name"]'),
    ...extra,
});
const text = (el, sel) => el.querySelector(sel).textContent.trim();
const stats = (el) => [...el.querySelectorAll('[class*="equipmentDetail"] span')].map((s) => s.textContent);

describe('loadout level in the game lines', () => {
    test('the name gets +20 once, across two passes', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(text(el, '[class*="ItemTooltipText_name"]')).toBe('Enchanted Gloves +20');
        expect(el.querySelector('[class*="ItemTooltipText_name"] span').title).toContain('+20');
    });

    test('percent stats become the +20 values from the table (10% base, 50 steps x 0.2% = 20%)', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%', 'Alchemy Efficiency: +10%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(stats(el)).toEqual(['Enhancing Speed: +20%', 'Alchemy Efficiency: +20%']);
        // a second pass does not rescale the rescaled figure
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(stats(el)).toEqual(['Enhancing Speed: +20%', 'Alchemy Efficiency: +20%']);
    });

    test('a lower level uses the table step count (+10 reads 14.5: 10% + 14.5 x 0.2% = 12.9%)', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%', 'Alchemy Efficiency: +10.0%']);
        applyLoadoutLevelToGameLines(el, info(el, 10), GLOVES);
        expect(stats(el)).toEqual(['Enhancing Speed: +12.9%', 'Alchemy Efficiency: +12.9%']);
    });

    test('a quantity at the top of a row is never taken for a stat (Celestial Shears: speed 1.05 vs Amount: 1)', () => {
        const SHEARS = '/items/celestial_shears';
        game.items[SHEARS] = FIXTURE_ITEMS[SHEARS];
        const el = document.createElement('div');
        el.className = 'MuiTooltip-popper';
        // The game's own layout (captured on the test server): unclassed rows straight inside the text block
        el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__zFq3A">
            <div class="ItemTooltipText_name__n">Celestial Shears</div><div>Amount: 1</div>
            <div>Sell Price: 1</div><div><div>Foraging Speed: <span>+105%</span></div></div></div></div>`;
        document.body.appendChild(el);
        applyLoadoutLevelToGameLines(el, info(el), SHEARS);
        const rows = [...el.querySelector('[class*="ItemTooltipText_itemTooltipText"]').children].map(
            (r) => r.textContent
        );
        expect(rows).toContain('Amount: 1');
        expect(rows).toContain('Sell Price: 1');
        // 1.05 + 50 steps x 0.021 = 2.1
        expect(rows).toContain('Foraging Speed: +210%');
        el.remove();
    });

    test('an unsigned flat stat in the game layout still scales (the game shows "Armor: 51.84" with no sign)', () => {
        const el = document.createElement('div');
        el.className = 'MuiTooltip-popper';
        el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__zFq3A">
            <div class="ItemTooltipText_name__n">Test Shield</div><div>Amount: 8</div>
            <div><div><span>Armor: </span><span>8</span></div></div></div></div>`;
        document.body.appendChild(el);
        applyLoadoutLevelToGameLines(el, info(el), SHIELD);
        const rows = [...el.querySelector('[class*="ItemTooltipText_itemTooltipText"]').children].map(
            (r) => r.textContent
        );
        expect(rows).toContain('Amount: 8');
        expect(rows).toContain('Armor: 16');
        el.remove();
    });

    const vendorTooltip = (marketLabel) => {
        const el = document.createElement('div');
        el.className = 'MuiTooltip-popper';
        el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__zFq3A">
            <div class="ItemTooltipText_name__n">Enchanted Gloves</div><div>Amount: 1</div>
            <div>Sell Price: 200,000</div><div>${marketLabel}: 8,328,000,000</div></div></div>`;
        document.body.appendChild(el);
        return el;
    };
    const rowsOf = (el) =>
        [...el.querySelector('[class*="ItemTooltipText_itemTooltipText"]').children].map(
            (r) => (r.style.display === 'none' ? '[hidden] ' : '') + r.textContent
        );

    test('an Iron Cow valuing at vendor price: the Market Price row is rewritten, never the Sell Price row', () => {
        // Toolasha's +0 price is the vendor price on every side, the same figure the Sell Price row shows
        game.items[GLOVES].sellPrice = 200000;
        game.prices[`${GLOVES}:0`] = { ask: 200000, bid: 200000, average: 200000 };
        const el = vendorTooltip('Market Price');
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(rowsOf(el)).toContain('Sell Price: 200,000');
        expect(rowsOf(el)).toContain('Market Price: 28,000,000,000');
        el.remove();
    });

    test('with an unknown label, the row showing the vendor price is never taken for the market row', () => {
        game.items[GLOVES].sellPrice = 200000;
        game.prices[`${GLOVES}:0`] = { ask: 200000, bid: 200000, average: 200000 };
        const el = vendorTooltip('Marktpreis');
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(rowsOf(el)).toContain('Sell Price: 200,000');
        el.remove();
    });

    test('a flat stat scales, keeps its format, and a stat with no bonus is left as drawn', () => {
        const el = popper('Test Shield', ['Armor: 8', 'Water Resistance: 12.5'], 'Market Price: 100');
        applyLoadoutLevelToGameLines(el, info(el), SHIELD);
        expect(stats(el)).toEqual(['Armor: 16', 'Water Resistance: 12.5']);
    });

    test('Market Price is replaced with the +20 price in the game number format', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(text(el, '[class*="marketPrice"]')).toBe('Market Price: 28,000,000,000');
    });

    test('Market Price with the label in its own element is matched too', () => {
        const el = popper('Enchanted Gloves', []);
        el.querySelector('[class*="marketPrice"]').innerHTML = '<span>Market Price: </span><span>8,328,000,000</span>';
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(text(el, '[class*="marketPrice"]')).toBe('Market Price: 28,000,000,000');
    });

    test('no +20 price: the row is hidden, never the +0 figure and never 0', () => {
        delete game.prices[`${GLOVES}:20`];
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        const row = el.querySelector('[class*="marketPrice"]');
        expect(row.style.display).toBe('none');
        restoreLoadoutTooltip(el);
        expect(row.style.display).toBe('');
    });

    test('no +20 price, live shape: only the Market Price row hides, never the tooltip text block', () => {
        // As the game draws it (captured on the test server): unclassed rows straight inside the text block, each
        // a div holding one text node
        delete game.prices[`${GLOVES}:20`];
        const el = document.createElement('div');
        el.className = 'MuiTooltip-popper';
        el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__zFq3A">
            <div class="ItemTooltipText_name__n">Enchanted Gloves</div><div>Amount: 1</div>
            <div>Sell Price: 200,000</div><div>Market Price: 8,328,000,000</div></div></div>`;
        document.body.appendChild(el);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        const block = el.querySelector('[class*="ItemTooltipText_itemTooltipText"]');
        const market = [...block.children].find((row) => row.textContent.startsWith('Market Price'));
        expect(block.style.display).toBe('');
        expect(market.style.display).toBe('none');
        expect([...block.children].filter((row) => row.style.display === 'none')).toHaveLength(1);
        el.remove();
    });

    test('a price in another language is found by its +0 figure, not its label', () => {
        const el = popper('附魔手套', ['加速: +10%'], '市场价: 8,328,000,000');
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(text(el, '[class*="marketPrice"]')).toBe('市场价: 28,000,000,000');
    });

    test('no loadout source (the name had +N, or an inventory item): nothing changes', () => {
        const el = popper('Enchanted Gloves +20', ['Enhancing Speed: +20%']);
        const before = el.innerHTML;
        applyLoadoutLevelToGameLines(el, info(el, 20, { levelSource: undefined }), GLOVES);
        expect(el.innerHTML).toBe(before);
    });

    test('level 0: nothing changes', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        const before = el.innerHTML;
        applyLoadoutLevelToGameLines(el, info(el, 0), GLOVES);
        expect(el.innerHTML).toBe(before);
    });

    test('a row that matches no stat, or stats that scale differently, stays as the game drew it', () => {
        game.items[GLOVES].equipmentDetail.noncombatStats.gatheringQuantity = 0.1;
        game.items[GLOVES].equipmentDetail.noncombatEnhancementBonuses.gatheringQuantity = 0.004;
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%', 'Mystery: +7%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(stats(el)).toEqual(['Enhancing Speed: +10%', 'Mystery: +7%']);
    });

    test('a popper reused for another item or level leaves no stale text', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        applyLoadoutLevelToGameLines(el, info(el, 20), GLOVES);
        applyLoadoutLevelToGameLines(el, info(el, 10), GLOVES);
        expect(text(el, '[class*="ItemTooltipText_name"]')).toBe('Enchanted Gloves +10');
        expect(stats(el)).toEqual(['Enhancing Speed: +12.9%']);
        // now a pass that is not a loadout one: the game's own text is back
        applyLoadoutLevelToGameLines(el, info(el, 0, { levelSource: undefined }), GLOVES);
        expect(text(el, '[class*="ItemTooltipText_name"]')).toBe('Enchanted Gloves');
        expect(stats(el)).toEqual(['Enhancing Speed: +10%']);
        expect(text(el, '[class*="marketPrice"]')).toBe('Market Price: 8,328,000,000');
        expect(el.querySelector('[title]')).toBeNull();
    });

    test('text the game rewrote since is not clobbered by a restore', () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        const nameNode = el.querySelector('[class*="ItemTooltipText_name"] span').firstChild;
        nameNode.data = 'Cheese';
        restoreLoadoutTooltip(el);
        expect(nameNode.data).toBe('Cheese');
    });

    test('an error leaves the game lines untouched', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        const before = el.innerHTML;
        game.items[GLOVES] = {
            get equipmentDetail() {
                throw new Error('boom');
            },
        };
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(el.innerHTML).toBe(before);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test("Toolasha's own injected lines are never read as game rows", () => {
        const el = popper('Enchanted Gloves', ['Enhancing Speed: +10%']);
        const injected = document.createElement('div');
        injected.className = 'market-price-injected';
        injected.textContent = 'Ask: 8,328,000,000';
        el.querySelector('[class*="itemTooltipText"]').appendChild(injected);
        applyLoadoutLevelToGameLines(el, info(el), GLOVES);
        expect(injected.textContent).toBe('Ask: 8,328,000,000');
    });
});
