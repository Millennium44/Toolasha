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
        version: 2,
        order: ['battleTimer', 'netWorth'],
        span: { netWorth: 2 },
        visible: { battleTimer: true, netWorth: true },
        zoom: { netWorth: 110 },
        locked: false,
    };

    test('writes their names back', () => {
        const written = toOPanelConfig(settings);
        expect(written.config.order).toEqual(['battleTimer', 'kollectionNetWorth']);
        expect(written.zoom_levels.kollectionNetWorth).toBe(110);
    });

    test('and pixels OPanel can draw, worked out from the order and the spans', () => {
        // This overlay holds no coordinates any more, but MCS reads nothing
        // else — so the export synthesises them rather than closing the door
        const written = toOPanelConfig(settings);

        expect(written.config.positions.battleTimer).toEqual({ x: 0, y: 0 });
        expect(written.config.sizes.battleTimer).toEqual({ width: 220, height: 30 });
        // Two columns wide, so it cannot share the line and starts the next one
        expect(written.config.positions.kollectionNetWorth).toEqual({ x: 0, y: 30 });
        expect(written.config.sizes.kollectionNetWorth).toEqual({ width: 440, height: 30 });
    });

    test('a tile switched off is not given pixels at all', () => {
        const hidden = { ...settings, visible: { battleTimer: true, netWorth: false } };
        expect(toOPanelConfig(hidden).config.positions.kollectionNetWorth).toBeUndefined();
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
        expect(round.settings.span).toEqual(settings.span);
        expect(round.settings.version).toBe(2);
        expect(round.settings.locked).toBe(false);
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
        span: { watchlist: 2, dps: 2 },
        version: 2,
        zoom: { watchlist: 0.9 },
        locked: false,
        separators: false,
        textScale: 0.8,
    };

    test('every row survives, not only the twenty OPanel names', () => {
        // OPanel has a name for a third of our rows; a file written in its
        // shape alone comes back missing the rest
        const read = fromOPanelConfig(toOPanelConfig(settings, null));

        expect(read.settings.order).toEqual(settings.order);
        expect(read.settings.span).toEqual(settings.span);
        expect(read.settings.version).toBe(2);
        // And no pixels, because there are none to carry
        expect(read.settings.positions).toBeUndefined();
        expect(read.settings.sizes).toBeUndefined();
    });

    test('the switches survive too', () => {
        const read = fromOPanelConfig(toOPanelConfig(settings, null));

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
        // Synthesised, since we hold no pixels — but a real rectangle either way
        expect(file.config.sizes.ewatchCoins).toEqual({ width: 220, height: 30 });
        expect(file.config.positions.ewatchCoins).toEqual({ x: 0, y: 0 });
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

    test('it says which half it read', () => {
        // The reader has to know: our own coordinates are final, and OPanel's
        // are measurements of OPanel's tiles that have to be laid out again.
        // Treating ours as theirs repacks a layout that was already right,
        // which is what made an export and a re-import on one character come
        // back different.
        expect(fromOPanelConfig(toOPanelConfig(settings, null)).native).toBe(true);
        expect(fromOPanelConfig({ config: { order: ['dps'], sizes: {}, positions: {} } }).native).toBe(false);
    });
});
