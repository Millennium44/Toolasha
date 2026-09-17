/**
 * Shape contract for `Toolasha.Utils.marketplaceTabs`.
 *
 * An outside caller (another userscript, or a console user) reaches these
 * functions only through the published global — `src/libraries/utils.js`
 * re-exports this whole module as `marketplaceTabs`, and
 * `cross-bundle-globals.test.js` only pins that the *binding* exists, not what
 * shape the functions inside it have. Renaming one of these, or changing how
 * many parameters it takes before its first optional one, breaks that caller
 * silently — the production bundle still builds, lint stays clean, and
 * nothing but a runtime `is not a function` says so.
 *
 * This is a shape test, not a behavior test: it does not call these functions
 * with real arguments or assert what they do (the rest of
 * `marketplace-tabs.test.js` covers that). It only pins that they exist and
 * take the number of *required* parameters they take today, so a signature
 * change fails CI here instead of in someone else's script.
 *
 * `Function.prototype.length` counts parameters up to (not including) the
 * first one with a default value or a rest parameter — so a param gaining a
 * default (as `removeMaterialTabs`'s and `createMaterialTab`'s `options` did,
 * to add an `owner`) does not move that count, but a genuinely new required
 * parameter would.
 */
import { describe, test, expect } from 'vitest';
import * as marketplaceTabs from './marketplace-tabs.js';

/** name -> required-parameter count, as of the owner-scoped removal change */
const EXPECTED_SURFACE = {
    createMaterialTab: 3, // (material, referenceTab, onClickCallback, [options])
    updateTabBadge: 2, // (tab, material)
    visibleTabsContainer: 0, // ([contains])
    navigateToMarketplace: 1, // (itemHrid, [enhancementLevel])
    removeMaterialTabs: 0, // ([options])
    watchTabForAcquisition: 2, // (tab, options)
    ensureClearAllTabsControl: 3, // (container, referenceTab, [onClearAll], [options])
};

describe('Toolasha.Utils.marketplaceTabs published surface', () => {
    for (const [name, requiredParamCount] of Object.entries(EXPECTED_SURFACE)) {
        test(`exports ${name} as a function, unchanged from what an outside caller depends on`, () => {
            expect(
                typeof marketplaceTabs[name],
                `Toolasha.Utils.marketplaceTabs.${name} is missing or renamed — an outside caller reaching it ` +
                    'through the published global would now get "is not a function".'
            ).toBe('function');
            expect(
                marketplaceTabs[name].length,
                `Toolasha.Utils.marketplaceTabs.${name} now takes ${marketplaceTabs[name].length} required ` +
                    `parameter(s), not ${requiredParamCount} — its published signature changed.`
            ).toBe(requiredParamCount);
        });
    }

    test('exports a CAPABILITIES marker an outside caller can check before relying on tab ownership', () => {
        // An unknown option in `options` is silently ignored, so a caller
        // cannot detect owner support just by passing `owner` and seeing what
        // happens — it has to check this marker first. Reading the module's
        // own source text for "owner" is not a substitute: that breaks the
        // moment a build minifies or renames anything.
        expect(
            marketplaceTabs.CAPABILITIES,
            'Toolasha.Utils.marketplaceTabs.CAPABILITIES is missing — an outside caller has no way to detect ' +
                'whether the installed build honors an `owner` it passes.'
        ).toBeTruthy();
        expect(marketplaceTabs.CAPABILITIES.tabOwner).toBe(true);
        expect(Object.isFrozen(marketplaceTabs.CAPABILITIES)).toBe(true);
    });
});
