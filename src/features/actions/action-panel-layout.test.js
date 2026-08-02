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

    test('the pinned strip is painted a dark literal, not a themed variable', () => {
        // var(--color-space-800) is not the dark background the name suggests:
        // the game's space scale is a set of visible tints, so asking for it
        // painted the strip blue above and below the buttons — which is the
        // box that kept coming back
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        const css = styleEl().textContent;

        expect(css).not.toContain('--color-space');
        expect(css).toMatch(/background:\s*#[0-9a-f]{6}/i);
    });

    test('no child may be wider than the panel', () => {
        // One fractionally oversized row — the buttons container measured
        // 321.883 against a 320 panel — is all a horizontal scrollbar needs
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        expect(styleEl().textContent).toContain('max-width: 100%');
    });

    test('cleanup is as thorough as disable', () => {
        settings.values.actionPanelLayout = true;
        actionPanelLayout.initialize();
        actionPanelLayout.cleanup();
        expect(styleEl()).toBeNull();
    });
});
