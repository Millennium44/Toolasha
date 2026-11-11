/**
 * Command palette openers for a phone
 *
 * A phone has no Ctrl+K, so the palette gets two touch-reachable doors, each with its own switch:
 *
 * - **Sidebar entry** - a "Search" row in the game's left navigation, built the way the Overlay
 *   entry is (`overlay-tab-button.js`): an independent row whose label hides when the game collapses
 *   the sidebar. Mobile mode only, like that one; a desktop has the hotkey.
 * - **Settings button** - "Command Palette" at the top of the game's Settings page, beside "Philo
 *   Gamba". It owns its own insertion point rather than riding the Philo feature, which has a setting
 *   of its own: this appears whether or not Philo does, and sits right after Philo when both are there.
 *
 * `commandPalette.initialize()` starts this and `cleanup()` stops it, so a palette that is off shows
 * neither. The two switches (`commandPaletteNavEntry`, `commandPaletteSettingsButton`) are watched
 * live: off removes the element at once, on puts it back without a reload.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { isMobileMode } from '../../utils/mobile.js';
import { styleGameButton } from '../../utils/game-look.js';
import { ensurePhoneCompactButtonStyles } from '../../utils/phone-compact-buttons.js';

const NAV_ITEM_ID = 'toolasha-palette-nav';
const NAV_STYLE_ID = 'toolasha-palette-nav-layout';
const SETTINGS_BUTTON_CLASS = 'mwi-palette-button';
export const NAV_SETTING = 'commandPaletteNavEntry';
export const SETTINGS_BUTTON_SETTING = 'commandPaletteSettingsButton';
export const NAV_TITLE = 'Command palette (Ctrl+K)';

// Same collapsed-sidebar rule as the Overlay entry, inside the game's own phone breakpoint
const NAV_CSS = `
@media only screen and (max-width: 48rem) {
    [class*="NavigationBar_collapsed"] #${NAV_ITEM_ID} > .toolasha-palette-nav-label { display: none; }
    [class*="NavigationBar_collapsed"] #${NAV_ITEM_ID} { justify-content: center; gap: 0 !important; }
}
`;

const SEARCH_ICON =
    '<svg viewBox="0 0 24 24" width="1.1em" height="1.1em" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="6.5"></circle>' +
    '<line x1="15" y1="15" x2="21" y2="21"></line></svg>';

class CommandPaletteButtons {
    constructor() {
        this.active = false;
        this.open = null;
        this.navItem = null;
        this.settingsButton = null;
        this.settingsRow = null;
        this.unregisters = [];
    }

    /**
     * Start watching for the places the buttons go.
     * @param {Function} open - Opens the palette
     */
    start(open) {
        if (this.active) return;
        this.active = true;
        this.open = open;

        const resync = () => this.sync();
        // The nav and the settings page are both rebuilt by the game, so this watches rather than injecting once.
        // Philo Gamba's button is added by its own feature, often after the Settings page and this button, so
        // its arrival is watched too: otherwise the first open after a page load leaves the two on separate rows
        this.unregisters.push(
            domObserver.onClass(
                'CommandPaletteButtons',
                ['SettingsPanel', 'NavigationBar_nav', 'mwi-philo-calc-button'],
                resync
            )
        );
        this.unregisters.push(domObserver.onReady('CommandPaletteButtonsCatchUp', resync));
        for (const key of [NAV_SETTING, SETTINGS_BUTTON_SETTING]) {
            const off = config.onSettingChange?.(key, resync);
            if (typeof off === 'function') this.unregisters.push(off);
        }
        this.sync();
    }

    /** Remove both buttons, their styles, observers and listeners */
    stop() {
        this.active = false;
        this.open = null;
        for (const off of this.unregisters) off?.();
        this.unregisters = [];
        this.removeNavItem();
        this.removeSettingsButton();
    }

    /** Bring both elements in line with the switches and the current page */
    sync() {
        if (!this.active) return;
        if (config.getSetting(NAV_SETTING) !== false && isMobileMode()) this.ensureNavItem();
        else this.removeNavItem();

        if (config.getSetting(SETTINGS_BUTTON_SETTING) !== false) this.ensureSettingsButton();
        else this.removeSettingsButton();
    }

    removeNavItem() {
        this.navItem?.remove();
        this.navItem = null;
        removeStyles(NAV_STYLE_ID);
    }

    removeSettingsButton() {
        this.settingsButton?.remove();
        this.settingsButton = null;
        this.removeSettingsRow();
    }

    /** Leave the independently owned Philo button in place when the palette goes away. */
    removeSettingsRow() {
        const row = this.settingsRow;
        if (row) row.replaceWith(...row.childNodes);
        this.settingsRow = null;
    }

    /** The "Search" row in the left navigation, under the Pinned and Overlay entries when present */
    ensureNavItem() {
        if (this.navItem?.isConnected) return;
        const navLinks = document.querySelector('[class*="NavigationBar_navigationLinks"]');
        if (!navLinks) return;
        this.navItem?.remove();

        addStyles(NAV_CSS, NAV_STYLE_ID);

        const item = document.createElement('div');
        item.id = NAV_ITEM_ID;
        item.setAttribute('role', 'button');
        item.title = NAV_TITLE;
        item.setAttribute('aria-label', NAV_TITLE);
        item.style.cssText = `
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            color: ${config.COLOR_ACCENT};
            border-left: 3px solid transparent;
            user-select: none;
            margin-bottom: 2px;
        `;
        item.innerHTML = `${SEARCH_ICON}<span class="toolasha-palette-nav-label">Search</span>`;
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.open?.();
        });

        const anchor = navLinks.querySelector('#toolasha-overlay-nav') || navLinks.querySelector('.mwi-pinned-nav');
        if (anchor?.parentElement === navLinks) anchor.after(item);
        else navLinks.insertBefore(item, navLinks.firstChild);
        this.navItem = item;
    }

    /** The Settings-page button, right after Philo Gamba when that is there */
    ensureSettingsButton() {
        const panel = document.querySelector('[class*="SettingsPanel"]');
        if (!panel) return;

        let button = this.settingsButton;
        if (!button || !panel.contains(button)) {
            button?.remove();
            button = document.createElement('button');
            button.className = SETTINGS_BUTTON_CLASS;
            button.textContent = 'Command Palette';
            button.title = NAV_TITLE;
            styleGameButton(button, 'primary');
            button.style.margin = '10px';
            ensurePhoneCompactButtonStyles();
            button.addEventListener('click', () => this.open?.());
            this.settingsButton = button;
        }

        const philo = panel.querySelector('.mwi-philo-calc-button');
        if (philo) {
            let row = this.settingsRow;
            if (!row || !panel.contains(row)) {
                this.removeSettingsRow();
                row = document.createElement('div');
                row.className = 'mwi-settings-tool-buttons';
                this.settingsRow = row;
            }
            // Keep the original button and its listeners, including when Philo arrives after us.
            if (philo.parentElement !== row) {
                philo.before(row);
                row.append(philo);
            }
            if (philo.nextElementSibling !== button) philo.after(button);
            return;
        }

        this.removeSettingsRow();
        const anchor = panel.querySelector('.mwi-market-history-button');
        if (anchor) {
            if (anchor.nextElementSibling !== button) anchor.after(button);
        } else if (panel.firstChild !== button) {
            panel.insertBefore(button, panel.firstChild);
        }
    }
}

const commandPaletteButtons = new CommandPaletteButtons();

export default commandPaletteButtons;
