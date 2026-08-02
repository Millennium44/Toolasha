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

describe('a round trip through our own section', () => {
    /** A layout with rows OPanel has never heard of, which is every real one */
    const settings = {
        order: ['coins', 'watchlist', 'charmValue', 'manaPerFight', 'dps'],
        visible: { coins: true, watchlist: true, charmValue: false, manaPerFight: true, dps: true },
        positions: {
            coins: { x: 0, y: 0 },
            watchlist: { x: 200, y: 0 },
            charmValue: { x: 0, y: 30 },
            manaPerFight: { x: 200, y: 30 },
            dps: { x: 0, y: 60 },
        },
        sizes: {
            coins: { width: 160, height: 30 },
            watchlist: { width: 220, height: 40 },
            charmValue: { width: 230, height: 30 },
            manaPerFight: { width: 200, height: 30 },
            dps: { width: 200, height: 46 },
        },
        zoom: { watchlist: 0.9 },
        snapToGrid: false,
        locked: false,
        separators: false,
        textScale: 0.8,
    };

    test('every row survives, not only the twenty OPanel names', () => {
        // Rows that arrive without a position get laid out wherever the packer
        // puts them, which is what made an imported layout a jumble
        const read = fromOPanelConfig(toOPanelConfig(settings, null));

        expect(read.settings.order).toEqual(settings.order);
        expect(Object.keys(read.settings.positions).sort()).toEqual(Object.keys(settings.positions).sort());
        expect(read.settings.sizes.watchlist).toEqual({ width: 220, height: 40 });
    });

    test('the switches survive too', () => {
        const read = fromOPanelConfig(toOPanelConfig(settings, null));

        expect(read.settings.snapToGrid).toBe(false);
        expect(read.settings.locked).toBe(false);
        expect(read.settings.separators).toBe(false);
        expect(read.settings.textScale).toBe(0.8);
    });

    test('nothing is reported missing, because nothing is', () => {
        expect(fromOPanelConfig(toOPanelConfig(settings, null)).unknown).toEqual([]);
    });

    test('the file is still readable by MCS', () => {
        // Our section is extra, not a replacement: the OPanel half still carries
        // every row OPanel has a name for
        const file = toOPanelConfig(settings, null);

        expect(file.config.order).toContain('ewatchCoins');
        expect(file.config.order).toContain('dps');
        expect(file.config.sizes.ewatchCoins).toEqual({ width: 160, height: 30 });
    });

    test('an MCS file with no section of ours is still read', () => {
        const theirs = { config: { order: ['ewatchCoins'], sizes: {}, positions: {} } };
        expect(fromOPanelConfig(theirs).settings.order).toEqual(['coins']);
    });

    test('a truncated section of ours falls back to the OPanel half', () => {
        // Worse, but not wrong — which is the right way round
        const file = toOPanelConfig(settings, null);
        file.toolasha.settings.order = [];

        expect(fromOPanelConfig(file).settings.order).toEqual(['coins', 'dps']);
    });
});
