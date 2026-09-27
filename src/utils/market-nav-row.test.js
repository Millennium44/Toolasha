/**
 * @vitest-environment happy-dom
 *
 * The nav row's wrap rule names every item Toolasha puts in the row and nothing
 * else, and lives in a stylesheet rather than on the game's own element — so
 * removing our items (any path: cleanup, disable, a game re-render) reverts it.
 */

import { test, expect } from 'vitest';
import { allowNavRowToWrap, NAV_ROW_WRAP_STYLE_ID, OUR_NAV_ROW_ITEMS } from './market-nav-row.js';

test('installs one rule, scoped to a nav row holding one of our items', () => {
    allowNavRowToWrap();
    allowNavRowToWrap();

    const sheets = document.querySelectorAll(`#${NAV_ROW_WRAP_STYLE_ID}`);
    expect(sheets).toHaveLength(1);
    const css = sheets[0].textContent;
    expect(css).toContain('[class*="MarketplacePanel_marketNavButtonContainer"]:has(');
    for (const sel of OUR_NAV_ROW_ITEMS) expect(css).toContain(`> ${sel}`);
    expect(css).toContain('flex-wrap: wrap');
});
