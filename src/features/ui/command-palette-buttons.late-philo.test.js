/**
 * @vitest-environment happy-dom
 *
 * The Settings-page Command Palette button with the real DOM observer: Philo Gamba's button is
 * often added after the Settings page and this button, and the two must still end up on one row.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? true,
        COLOR_ACCENT: '#abc',
        onSettingChange: () => () => {},
    },
}));
const device = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => device.mobile }));

const domObserver = (await import('../../core/dom-observer.js')).default;
const buttons = (await import('./command-palette-buttons.js')).default;

/** Let the MutationObserver deliver, and any re-placement it triggers settle */
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function settingsPage() {
    document.body.innerHTML =
        '<div class="SettingsPanel_settingsPanel__x"><button class="mwi-market-history-button"></button>' +
        '<div>other</div></div>';
    return document.querySelector('[class*="SettingsPanel"]');
}

function addPhilo(panel, onClick) {
    const philo = document.createElement('button');
    philo.className = 'mwi-philo-calc-button';
    philo.textContent = 'Philo Gamba';
    philo.addEventListener('click', onClick);
    panel.querySelector('.mwi-market-history-button').after(philo);
    return philo;
}

const row = () => document.querySelector('.mwi-settings-tool-buttons');
const paletteButton = () => document.querySelector('.mwi-palette-button');

let opened;
beforeEach(() => {
    settings.values = {};
    opened = vi.fn();
    document.body.replaceChildren();
    domObserver.start();
});
afterEach(() => {
    buttons.stop();
    domObserver.stop();
    domObserver.handlers = [];
    document.body.replaceChildren();
    document.head.replaceChildren();
});

describe.each([
    ['desktop', false],
    ['phone', true],
])('Philo Gamba arriving after the palette button (%s)', (_label, mobile) => {
    test('the two end up side by side in one row, once', async () => {
        device.mobile = mobile;
        const panel = settingsPage();
        buttons.start(opened);
        await settle();
        expect(paletteButton()).not.toBeNull();
        expect(row()).toBeNull();

        const philoClick = vi.fn();
        const philo = addPhilo(panel, philoClick);
        await settle();

        expect(row()).not.toBeNull();
        expect([...row().children]).toEqual([philo, paletteButton()]);
        expect(document.querySelectorAll('.mwi-settings-tool-buttons')).toHaveLength(1);
        expect(document.querySelectorAll('.mwi-palette-button')).toHaveLength(1);

        // Both buttons keep their own handlers after the move
        philo.click();
        paletteButton().click();
        expect(philoClick).toHaveBeenCalledTimes(1);
        expect(opened).toHaveBeenCalledTimes(1);

        // Settled: a further turn of the observer changes nothing
        const before = panel.innerHTML;
        await settle();
        expect(panel.innerHTML).toBe(before);
    });
});

test('after stop, a late Philo Gamba is left alone; after a restart it is joined again', async () => {
    const panel = settingsPage();
    buttons.start(opened);
    await settle();
    buttons.stop();
    const philo = addPhilo(panel, () => {});
    await settle();
    expect(row()).toBeNull();
    expect(philo.parentElement).toBe(panel);

    buttons.start(opened);
    await settle();
    expect([...row().children]).toEqual([philo, paletteButton()]);
});
