import { describe, test, expect } from 'vitest';
import { isOPanelConfig, fromOPanelConfig, toOPanelConfig, ROW_KEY_MAP } from './opanel-config.js';

/** A cut-down version of a real exported OPanel config */
const opanel = {
    config: {
        battleTimer: true,
        kollectionNetWorth: true,
        ewatchCoins: false,
        gwhizTTL: true,
        snapToGrid: true,
        order: ['battleTimer', 'kollectionNetWorth', 'ewatchCoins', 'gwhizTTL'],
        firstLoad: false,
        sizes: {
            battleTimer: { width: 140, height: 30 },
            kollectionNetWorth: { width: 160, height: 30 },
        },
        positions: {
            battleTimer: { x: 10, y: 0 },
            kollectionNetWorth: { x: 130, y: 270 },
        },
    },
    is_locked: true,
    position: { top: 801, left: 1692.933349609375 },
    size: { width: 478, height: 302 },
    zoom_levels: { battleTimer: 100, gwhizTTL: 120 },
};

describe('isOPanelConfig', () => {
    test('recognises one by shape, since OPanel writes no version', () => {
        expect(isOPanelConfig(opanel)).toBe(true);
    });

    test('declines anything else rather than half-reading it', () => {
        expect(isOPanelConfig({ format: 'toolasha-treasure', chests: {} })).toBe(false);
        expect(isOPanelConfig({ config: {} })).toBe(false);
        expect(isOPanelConfig(null)).toBe(false);
    });
});

describe('fromOPanelConfig', () => {
    test('renames the rows that changed name', () => {
        const { settings } = fromOPanelConfig(opanel);
        expect(settings.order).toEqual(['battleTimer', 'netWorth', 'coins', 'timeToLevel']);
    });

    test('carries visibility, including the rows switched off', () => {
        const { settings } = fromOPanelConfig(opanel);
        expect(settings.visible).toMatchObject({ battleTimer: true, netWorth: true, coins: false });
    });

    test('carries positions, sizes and text scales', () => {
        const { settings } = fromOPanelConfig(opanel);
        expect(settings.positions.netWorth).toEqual({ x: 130, y: 270 });
        expect(settings.sizes.battleTimer).toEqual({ width: 140, height: 30 });
        expect(settings.zoom.timeToLevel).toBe(120);
    });

    test('carries the lock and the grid', () => {
        const { settings } = fromOPanelConfig(opanel);
        expect(settings.locked).toBe(true);
        expect(settings.snapToGrid).toBe(true);
    });

    test('returns the panel frame separately, since it is not part of the layout', () => {
        expect(fromOPanelConfig(opanel).geometry).toEqual({ left: 1693, top: 801, width: 478, height: 302 });
    });

    test('names rows it cannot map rather than dropping them quietly', () => {
        // A layout that silently arrives missing three tiles reads as an import
        // that half-worked
        const withStranger = {
            ...opanel,
            config: { ...opanel.config, order: [...opanel.config.order, 'someOtherScript'] },
        };
        const { settings, unknown } = fromOPanelConfig(withStranger);
        expect(unknown).toEqual(['someOtherScript']);
        expect(settings.order).not.toContain('someOtherScript');
    });

    test('does not mistake a display option for a row', () => {
        // `snapToGrid` sits in the same object as the row toggles and is a
        // boolean like they are
        const { settings } = fromOPanelConfig(opanel);
        expect(settings.visible).not.toHaveProperty('snapToGrid');
    });

    test('declines a file that is not OPanel’s', () => {
        expect(fromOPanelConfig({ nope: true })).toBeNull();
    });
});

describe('toOPanelConfig', () => {
    const settings = {
        order: ['battleTimer', 'netWorth'],
        visible: { battleTimer: true, netWorth: false },
        positions: { netWorth: { x: 10, y: 20 } },
        sizes: { netWorth: { width: 160, height: 30 } },
        zoom: { netWorth: 110 },
        locked: false,
        snapToGrid: false,
    };

    test('writes their names back', () => {
        const written = toOPanelConfig(settings);
        expect(written.config.order).toEqual(['battleTimer', 'kollectionNetWorth']);
        expect(written.config.positions.kollectionNetWorth).toEqual({ x: 10, y: 20 });
        expect(written.zoom_levels.kollectionNetWorth).toBe(110);
    });

    test('leaves out rows OPanel has no key for', () => {
        // Writing ours into their file gives MCS something it reads as corrupt
        const extra = { ...settings, order: [...settings.order, 'somethingOnlyWeHave'] };
        expect(toOPanelConfig(extra).config.order).toHaveLength(2);
    });

    test('survives the round trip', () => {
        const round = fromOPanelConfig(toOPanelConfig(settings, { left: 5, top: 6, width: 400, height: 300 }));
        expect(round.settings.order).toEqual(settings.order);
        expect(round.settings.visible).toEqual(settings.visible);
        expect(round.settings.locked).toBe(false);
        expect(round.settings.snapToGrid).toBe(false);
        expect(round.geometry).toEqual({ left: 5, top: 6, width: 400, height: 300 });
    });

    test('survives having nothing to write', () => {
        expect(toOPanelConfig(undefined).config.order).toEqual([]);
    });
});

describe('ROW_KEY_MAP', () => {
    test('maps every OPanel row to a distinct row of ours', () => {
        const ours = Object.values(ROW_KEY_MAP);
        expect(new Set(ours).size).toBe(ours.length);
    });
});
