/**
 * @vitest-environment happy-dom
 *
 * The command palette's two touch openers: a "Search" sidebar entry (phone) and a
 * "Command Palette" button on the game's Settings page, each behind its own switch.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { styleGameButton } from '../../utils/game-look.js';

const settings = vi.hoisted(() => ({ values: {}, listeners: {} }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? true,
        COLOR_ACCENT: '#abc',
        onSettingChange: (key, cb) => {
            (settings.listeners[key] ||= []).push(cb);
            return () => {
                settings.listeners[key] = settings.listeners[key].filter((c) => c !== cb);
            };
        },
    },
}));
const observers = vi.hoisted(() => ({ classCbs: [] }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, cb) => {
            observers.classCbs.push(cb);
            return () => {
                observers.classCbs = observers.classCbs.filter((c) => c !== cb);
            };
        },
        onReady: (_name, cb) => {
            cb();
            return () => {};
        },
    },
}));
const device = vi.hoisted(() => ({ mobile: true }));
vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => device.mobile }));

const buttons = (await import('./command-palette-buttons.js')).default;

const nav = () => document.getElementById('toolasha-palette-nav');
const settingsBtn = () => document.querySelector('.mwi-palette-button');

function setSetting(key, value) {
    settings.values[key] = value;
    for (const cb of settings.listeners[key] || []) cb(value);
}

function buildPage({ philo = false } = {}) {
    document.body.innerHTML =
        '<div class="NavigationBar_navigationLinks__a"><div class="mwi-pinned-nav"></div></div>' +
        '<div class="SettingsPanel_x"><button class="mwi-market-history-button"></button>' +
        (philo ? '<button class="mwi-philo-calc-button">Philo Gamba</button>' : '') +
        '<div>other</div></div>';
}

let opened;
beforeEach(() => {
    settings.values = {};
    settings.listeners = {};
    observers.classCbs = [];
    device.mobile = true;
    opened = vi.fn();
});
afterEach(() => {
    buttons.stop();
    document.body.replaceChildren();
    document.head.replaceChildren();
});

describe('sidebar entry', () => {
    test('is added under Pinned on a phone and opens the palette', () => {
        buildPage();
        buttons.start(opened);
        expect(nav()).not.toBeNull();
        expect(nav().previousElementSibling.className).toBe('mwi-pinned-nav');
        expect(nav().textContent).toBe('Search');
        expect(nav().title).toBe('Command palette (Ctrl+K)');
        nav().click();
        expect(opened).toHaveBeenCalledTimes(1);
    });

    test('not on a desktop', () => {
        device.mobile = false;
        buildPage();
        buttons.start(opened);
        expect(nav()).toBeNull();
    });

    test('setting off removes it, on restores it without a reload', () => {
        buildPage();
        buttons.start(opened);
        setSetting('commandPaletteNavEntry', false);
        expect(nav()).toBeNull();
        setSetting('commandPaletteNavEntry', true);
        expect(nav()).not.toBeNull();
    });

    test('is put back when the game re-renders the nav', () => {
        buildPage();
        buttons.start(opened);
        nav().remove();
        observers.classCbs.forEach((cb) => cb());
        expect(nav()).not.toBeNull();
    });
});

describe('settings button', () => {
    test.each([true, false])('sizes to its label without Philo (mobile: %s)', (mobile) => {
        device.mobile = mobile;
        buildPage();
        buttons.start(opened);
        const style = getComputedStyle(settingsBtn());
        expect(style.width).toBe('fit-content');
        expect(style.maxWidth).toBe('100%');
        expect(style.alignSelf).toBe('flex-start');
        expect(style.justifySelf).toBe('start');
    });

    test('shares the Philo button look and keeps it through repeated rebuilds and toggles', () => {
        buildPage({ philo: true });
        const philo = document.querySelector('.mwi-philo-calc-button');
        styleGameButton(philo, 'primary');
        philo.style.margin = '10px';
        buttons.start(opened);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const expected = getComputedStyle(philo);
            const actual = getComputedStyle(settingsBtn());
            for (const property of [
                'width',
                'maxWidth',
                'alignSelf',
                'justifySelf',
                'height',
                'padding',
                'margin',
                'fontSize',
                'fontWeight',
                'background',
                'borderRadius',
            ]) {
                expect(actual[property], property).toBe(expected[property]);
            }
            settingsBtn().click();
            settingsBtn().remove();
            observers.classCbs.forEach((cb) => cb());
            setSetting('commandPaletteSettingsButton', false);
            expect(settingsBtn()).toBeNull();
            setSetting('commandPaletteSettingsButton', true);
        }

        expect(opened).toHaveBeenCalledTimes(3);
        expect(document.querySelectorAll('.mwi-palette-button')).toHaveLength(1);
        expect(document.querySelectorAll('#mwi-phone-compact-buttons')).toHaveLength(1);
    });

    test('appears without Philo, after the history button, and opens the palette', () => {
        buildPage();
        buttons.start(opened);
        expect(settingsBtn().previousElementSibling.className).toBe('mwi-market-history-button');
        expect(settingsBtn().textContent).toBe('Command Palette');
        settingsBtn().click();
        expect(opened).toHaveBeenCalledTimes(1);
    });

    test('sits right after Philo when both are present, even if Philo arrives later', () => {
        buildPage();
        buttons.start(opened);
        const philo = document.createElement('button');
        philo.className = 'mwi-philo-calc-button';
        document.querySelector('.mwi-market-history-button').after(philo);
        observers.classCbs.forEach((cb) => cb());
        expect(settingsBtn().previousElementSibling).toBe(philo);
        expect(document.querySelectorAll('.mwi-palette-button')).toHaveLength(1);
    });

    test('with Philo already there', () => {
        buildPage({ philo: true });
        buttons.start(opened);
        expect(settingsBtn().previousElementSibling.className).toBe('mwi-philo-calc-button');
    });

    test('is re-inserted when the panel re-renders, and obeys its setting', () => {
        buildPage();
        buttons.start(opened);
        settingsBtn().remove();
        observers.classCbs.forEach((cb) => cb());
        expect(settingsBtn()).not.toBeNull();
        setSetting('commandPaletteSettingsButton', false);
        expect(settingsBtn()).toBeNull();
        setSetting('commandPaletteSettingsButton', true);
        expect(settingsBtn()).not.toBeNull();
    });
});

describe('stop (palette disabled)', () => {
    test('removes both, their styles and listeners', () => {
        buildPage();
        buttons.start(opened);
        buttons.stop();
        expect(nav()).toBeNull();
        expect(settingsBtn()).toBeNull();
        expect(document.getElementById('toolasha-palette-nav-layout')).toBeNull();
        expect(observers.classCbs).toHaveLength(0);
        expect(settings.listeners.commandPaletteNavEntry).toHaveLength(0);
        setSetting('commandPaletteNavEntry', true);
        expect(nav()).toBeNull();
    });
});

describe('through the palette', () => {
    test('palette initialize starts them, cleanup removes them, a disabled palette shows none', async () => {
        const palette = (await import('./command-palette.js')).default;
        buildPage();
        settings.values.commandPalette = false;
        palette.initialize();
        expect(nav()).toBeNull();
        expect(settingsBtn()).toBeNull();

        settings.values.commandPalette = true;
        palette.initialize();
        expect(nav()).not.toBeNull();
        nav().click();
        expect(palette.isOpen).toBe(true);
        palette.cleanup();
        expect(nav()).toBeNull();
        expect(settingsBtn()).toBeNull();
    });
});
