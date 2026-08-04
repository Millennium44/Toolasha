/**
 * @vitest-environment happy-dom
 *
 * The action panel's layout fix, checked for what a stylesheet can get wrong.
 *
 * The rules themselves are not testable without a browser laying them out. What
 * is testable, and what would actually break, is scope: every modal in the game
 * shares the `Modal_modal__` class, so a rule that forgets its `:has()` puts a
 * scrollbar and a sticky footer on the marketplace and the settings dialog too.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => settings.values[key] ?? false },
}));

const { default: actionPanelLayout } = await import('./action-panel-layout.js');

const styleEl = () => document.getElementById('toolasha-action-panel-layout');

afterEach(() => {
    actionPanelLayout.disable();
    settings.values = {};
});

describe('the action panel layout', () => {
    test('the option turns it on and off', () => {
        settings.values.actionPanelLayout = false;
        actionPanelLayout.initialize();
        expect(styleEl()).toBeNull();

        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        expect(styleEl()).not.toBeNull();

        actionPanelLayout.disable();
        expect(styleEl()).toBeNull();
    });

    test('no modal rule escapes its :has()', () => {
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();

        const rules = styleEl()
            .textContent.split('}')
            .map((block) => block.split('{')[0].trim())
            .filter(Boolean);

        // Every modal-level rule has to name an action panel, or it reaches the
        // marketplace, the settings dialog and everything else in the game
        for (const selector of rules.filter((rule) => rule.includes('Modal_modal'))) {
            expect(selector).toContain('SkillActionDetail_skillActionDetail');
        }
        expect(rules.some((rule) => rule.includes('Modal_modal'))).toBe(true);
    });

    test('the buttons are pinned and the panel is what scrolls', () => {
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        const css = styleEl().textContent;

        // Scrolling the page instead of the panel is the bug being fixed, and
        // an uncontained overscroll hands the page the scroll at the bottom
        expect(css).toContain('overflow-y: auto');
        expect(css).toContain('overscroll-behavior: contain');
        expect(css).toContain('position: sticky');
    });

    test('it does not add a horizontal scrollbar to pay for the vertical one', () => {
        // Making an element a vertical scroller makes it a horizontal one too,
        // and the vertical bar eats ten pixels of a width everything inside was
        // already sized against. The full-width bar that produces sits right
        // under the pinned buttons and reads as a box around them.
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        const css = styleEl().textContent;

        expect(css).toContain('overflow-x: hidden');
    });

    test('the scrollbar is left as the game draws it', () => {
        // Recolouring it was chasing the wrong thing: the horizontal bar was a
        // width problem, and it is fixed where the oversized blocks are built
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();

        const css = styleEl().textContent;
        expect(css).not.toContain('::-webkit-scrollbar');
        expect(css).not.toContain('scrollbar-width:');
        expect(css).not.toContain('scrollbar-color:');
    });

    test('the pinned strip is not painted at all', () => {
        // Three rounds of "there is a box round the buttons" were all this
        // script painting one. A themed variable came out blue — the game's
        // space scale is a set of visible tints, not a dark background — and
        // the dark literal that replaced it came out black: a filled band
        // across the foot of every skilling action panel. The strip is
        // positioned and nothing else; the colour behind the buttons is the
        // game's.
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        // The comments explain why the paint is gone and would match on their own
        const css = styleEl().textContent.replace(/\/\*[\s\S]*?\*\//g, '');

        expect(css).not.toContain('--color-space');
        expect(css).not.toMatch(/background/i);
        expect(css).not.toMatch(/border-top/i);
        // The pin itself is the feature and stays
        expect(css).toContain('position: sticky');
    });

    test('nothing at any depth may be wider than the panel', () => {
        // A rule for direct children walks past the Cost Summary card, which is
        // inserted beside the item requirements rather than at the top level —
        // and that card is the widest thing in the panel
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        const css = styleEl().textContent;

        expect(css).toContain('max-width: 100%');
        expect(css).toMatch(/SkillActionDetail_skillActionDetail"\] \*\s*\{/);
    });

    test('the grid items are allowed to shrink', () => {
        // The panel's body is a two-column grid, and a grid item defaults to a
        // minimum width of auto — it refuses to be narrower than its longest
        // unbreakable content. So the value column takes whatever the widest
        // label asks for and the grid outgrows the panel. Every block inside
        // measures exactly the column width, which is why they all looked
        // innocent: correctly sized, to a column that was too wide.
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        const css = styleEl().textContent;

        expect(css).toContain('min-width: 0');
        expect(css).toContain('SkillActionDetail_value');
    });

    test('the scrollbar gutter is reserved', () => {
        // The vertical bar otherwise appears after the layout is decided and
        // takes its width out of the column, making every full-width row wider
        // than the column it sits in — a horizontal scrollbar caused by the
        // vertical one
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        expect(styleEl().textContent).toContain('scrollbar-gutter: stable');
    });

    test('cleanup is as thorough as disable', () => {
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        actionPanelLayout.cleanup();
        expect(styleEl()).toBeNull();
    });
});
