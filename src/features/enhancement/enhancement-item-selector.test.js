/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach } from 'vitest';

// Regression coverage for the live-DOM mismatch this module shipped with:
// the enhance item slot is NOT `SkillActionDetail_upgradeItemSelectorInput`
// (that class does not exist) — it is `SkillActionDetail_primaryItemSelectorContainer`,
// the same class alchemy's own primary slot uses. And the open menu is
// portalled all the way to a detached MUI tooltip popper at the document
// root, never nested inside the panel at all, so only the click-tracking
// path can ever find it.
const { findEnhanceItemMenu } = await import('./enhancement-item-selector.js');

/** Builds the enhancing panel shell, with or without the primary slot */
function buildEnhancingPanel({ withPrimarySlot = true, withProtectionSlot = true } = {}) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_enhancingComponent__17bOx';

    if (withPrimarySlot) {
        const primary = document.createElement('div');
        primary.className = 'SkillActionDetail_primaryItemSelectorContainer__nrvNW';
        primary.id = 'primary-slot';
        panel.appendChild(primary);
    }
    if (withProtectionSlot) {
        const protection = document.createElement('div');
        protection.className = 'protectionItemInputContainer_3xYz';
        protection.id = 'protection-slot';
        panel.appendChild(protection);
    }
    document.body.appendChild(panel);
    return panel;
}

/** The menu is portalled to a detached tooltip popper, never inside the panel */
function openPortalledMenu() {
    const popper = document.createElement('div');
    popper.className = 'MuiPopper-root MuiTooltip-popper';
    const tooltip = document.createElement('div');
    tooltip.className = 'MuiTooltip-tooltip';
    const menu = document.createElement('div');
    menu.className = 'ItemSelector_menu__12sEM';
    menu.id = 'the-menu';
    tooltip.appendChild(menu);
    popper.appendChild(tooltip);
    document.body.appendChild(popper);
    return menu;
}

function clickInside(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

describe('findEnhanceItemMenu', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('finds nothing when the enhancing panel is not on the page', () => {
        openPortalledMenu();
        expect(findEnhanceItemMenu()).toBe(null);
    });

    test('finds nothing when the panel has no primary slot', () => {
        buildEnhancingPanel({ withPrimarySlot: false });
        openPortalledMenu();
        expect(findEnhanceItemMenu()).toBe(null);
    });

    test('matches the portalled menu after the primary slot is clicked', () => {
        const panel = buildEnhancingPanel();
        clickInside(panel.querySelector('#primary-slot'));
        const menu = openPortalledMenu();
        expect(findEnhanceItemMenu()).toBe(menu);
    });

    test('does not claim the menu after the protection slot is clicked', () => {
        const panel = buildEnhancingPanel();
        clickInside(panel.querySelector('#protection-slot'));
        openPortalledMenu();
        expect(findEnhanceItemMenu()).toBe(null);
    });

    test('a click inside the menu itself does not overwrite which selector was opened', () => {
        const panel = buildEnhancingPanel();
        clickInside(panel.querySelector('#primary-slot'));
        const menu = openPortalledMenu();
        clickInside(menu); // picking an item, not opening a selector
        expect(findEnhanceItemMenu()).toBe(menu);
    });
});
