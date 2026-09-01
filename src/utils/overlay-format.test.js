/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach } from 'vitest';
import {
    signedPercent,
    shortDuration,
    drawLine,
    row,
    rows,
    glyph,
    GLYPHS,
    ROW_COLORS,
    resetSpriteSheetCache,
} from './overlay-format.js';

describe('signedPercent', () => {
    test('signs both directions', () => {
        expect(signedPercent(12.34).text).toBe('+12.3%');
        expect(signedPercent(-12.34).text).toBe('-12.3%');
    });

    test('a couple of percent either way is not news', () => {
        // Everything sits slightly off whatever it is compared with; colouring
        // that makes a row into a light that is always on
        expect(signedPercent(2).color).toBe(ROW_COLORS.dim);
        expect(signedPercent(-2).color).toBe(ROW_COLORS.dim);
        expect(signedPercent(20).color).toBe(ROW_COLORS.good);
        expect(signedPercent(-20).color).toBe(ROW_COLORS.bad);
    });

    test('the band can be widened for a noisier figure', () => {
        expect(signedPercent(8, 10).color).toBe(ROW_COLORS.dim);
    });
});

describe('shortDuration', () => {
    test('never uses more than two units', () => {
        // "71 days 9h 55m" pushed the label beside it down to a single letter
        expect(shortDuration(45)).toBe('45s');
        expect(shortDuration(12 * 60)).toBe('12m');
        expect(shortDuration(3 * 3600 + 20 * 60)).toBe('3h 20m');
        expect(shortDuration(4 * 86400 + 16 * 3600)).toBe('4d 16h');
    });

    test('drops the small unit once it is noise', () => {
        expect(shortDuration(71 * 86400 + 9 * 3600)).toBe('71d');
        expect(shortDuration(2 * 3600)).toBe('2h');
        expect(shortDuration(5 * 86400)).toBe('5d');
    });

    test('nothing measurable says so rather than showing zero', () => {
        expect(shortDuration(Infinity)).toBe('—');
        expect(shortDuration(NaN)).toBe('—');
        expect(shortDuration(-5)).toBe('—');
    });
});

describe('drawLine', () => {
    test('skips nulls so a segment can be conditional', () => {
        const host = document.createElement('div');
        drawLine(host, [{ text: 'a' }, null, { text: 'b' }]);
        expect(host.children).toHaveLength(2);
    });

    test('an icon segment draws an element rather than its hrid as text', () => {
        const host = document.createElement('div');
        drawLine(host, [{ icon: '/items/smack_book', size: 18 }, { text: '43' }]);

        // Without the game's sprite sheet loaded this is a spacer, but the point
        // stands either way: the hrid must never end up as visible text
        expect(host.children).toHaveLength(2);
        expect(host.textContent).toBe('43');
    });

    test('every line centres, whether or not there is an icon on it', () => {
        // It used to depend, and the fork was the bug: `row` hands this the
        // tile's own full-height content box, so choosing between centre and
        // baseline was choosing where the whole line sat in the tile rather than
        // how the pieces sat against each other. Queue and Coins are both
        // 30-pixel tiles side by side, and only one of them has a coin on it.
        const withIcon = document.createElement('div');
        drawLine(withIcon, [{ icon: '/items/smack_book' }, { text: '43' }]);

        const textOnly = document.createElement('div');
        drawLine(textOnly, [{ text: '43' }, { text: 'books' }]);

        expect(withIcon.style.alignItems).toBe('center');
        expect(textOnly.style.alignItems).toBe(withIcon.style.alignItems);
    });

    test('only the ellipsis segment is allowed to shrink', () => {
        // A truncated number is not a smaller number, it is a wrong one
        const host = document.createElement('div');
        drawLine(host, [{ text: 'Penetrating Strike', ellipsis: true }, { text: '12.0M' }]);

        expect(host.children[0].style.textOverflow).toBe('ellipsis');
        expect(host.children[1].style.flex).toBe('0 0 auto');
    });

    test('a piece that can be clipped can say what it says in full', () => {
        // `MillenniumT…` is a name the tile has stopped telling you, and the
        // tile's own tooltip is about the figure rather than about whose it is
        const host = document.createElement('div');
        drawLine(host, [{ text: 'MillenniumTech', ellipsis: true, title: 'MillenniumTech' }, { text: '12.0M' }]);

        expect(host.children[0].title).toBe('MillenniumTech');
        // And nothing else grows a tooltip it did not ask for
        expect(host.children[1].title).toBe('');
    });
});

describe('a tile drawn as one line', () => {
    /**
     * A tile's content box, which is the full height of the tile.
     * @returns {HTMLElement}
     */
    function contentBox() {
        const box = document.createElement('div');
        Object.assign(box.style, { width: '100%', height: '100%', overflow: 'hidden' });
        return box;
    }

    test('two tiles side by side start their line at the same height', () => {
        // Reported live: the Coins tile sat a few pixels below the Queue tile
        // beside it, because Coins draws a coin sprite and Queue does not
        const queue = contentBox();
        row(queue, [{ text: 'Queue' }, { text: '4h 12m', push: true }]);

        const coins = contentBox();
        row(coins, [glyph('coin'), { text: '1.2M', push: true }]);

        // Both put the line in a box of its own height at the top of the tile,
        // rather than letting the line's own alignment place it in the tile
        expect(queue.style.flexDirection).toBe('column');
        expect(queue.style.justifyContent).toBe('flex-start');
        expect(coins.style.flexDirection).toBe(queue.style.flexDirection);
        expect(coins.style.justifyContent).toBe(queue.style.justifyContent);
        expect(coins.children[0].style.alignItems).toBe(queue.children[0].style.alignItems);
    });

    test('centring is horizontal, so a phrase stays a phrase', () => {
        const host = contentBox();
        row(host, [glyph('coin'), { text: '12' }], { center: true });

        expect(host.children[0].style.justifyContent).toBe('center');
        // Not the tile: centring the column would move the line down the tile
        expect(host.style.justifyContent).toBe('flex-start');
    });

    test('redrawing replaces the line rather than stacking another under it', () => {
        const host = contentBox();
        row(host, [{ text: 'first' }]);
        row(host, [{ text: 'second' }]);

        expect(host.children).toHaveLength(1);
        expect(host.textContent).toBe('second');
    });
});

describe('aligned rows', () => {
    /**
     * @param {Array} lines - Segment arrays
     * @param {Object} [options] - Passed through
     * @returns {HTMLElement}
     */
    const build = (lines, options) => {
        const container = document.createElement('div');
        rows(container, lines, options);
        return container;
    };

    test('the lines share columns, so a short line still lines up', () => {
        // A player row carries three figures and the total carries two; the
        // total belongs under the figure it totals, not at the far edge
        const container = build(
            [
                [{ text: 'You' }, { text: '539.5' }, { text: '96.8%' }],
                [{ text: 'Total' }, { text: '539.5' }],
            ],
            { align: true }
        );

        expect(container.style.display).toBe('grid');
        // Three columns, six cells: the short line is padded rather than ragged
        expect(container.children).toHaveLength(6);
        expect(container.children[4].textContent).toBe('539.5');
        expect(container.children[5].textContent).toBe('');
    });

    test('the first column takes the slack and the figures sit right', () => {
        const container = build([[{ text: 'You' }, { text: '1' }]], { align: true });

        expect(container.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
        expect(container.children[0].style.textAlign).toBe('left');
        expect(container.children[1].style.textAlign).toBe('right');
    });

    test('only the name may be cut, never a figure', () => {
        // "1.2…" reads as a number rather than as a truncation
        const container = build([[{ text: 'A very long name indeed' }, { text: '539.5' }]], { align: true });

        expect(container.children[0].style.textOverflow).toBe('ellipsis');
        expect(container.children[1].style.textOverflow).toBe('clip');
    });

    test('the lines start at the top rather than centred', () => {
        // These tiles sit beside each other with different numbers of lines;
        // centring puts the one line of a Luck tile halfway down the two lines
        // of the DPS tile next to it
        expect(build([[{ text: 'a' }, { text: '1' }]], { align: true }).style.alignContent).toBe('start');
    });

    test('digits are one width, so a column does not shift as it counts', () => {
        expect(build([[{ text: 'a' }, { text: '1' }]], { align: true }).style.fontVariantNumeric).toBe('tabular-nums');
    });

    test('a tile with an icon keeps the independent layout', () => {
        // An icon has no width until it loads, so it cannot size a column
        const container = build([[{ icon: '/items/coin' }, { text: '5' }], [{ text: 'x' }]], { align: true });

        expect(container.style.display).toBe('flex');
    });

    test('without the option nothing changes', () => {
        const container = build([[{ text: 'a' }], [{ text: 'b' }]]);

        expect(container.style.display).toBe('flex');
        expect(container.children).toHaveLength(2);
    });
});

describe('glyphs, as the game draws them or as text', () => {
    /** The game has drawn from a sheet, so its URL is discoverable */
    const drawSprite = (sheet) => {
        document.body.innerHTML = `<svg><use href="/static/media/${sheet}_sprite.abc123.svg#anything"></use></svg>`;
    };

    // The sheet URL is remembered once found, so emptying the page is only half
    // of "the game has drawn nothing yet" — the cache has to go with it
    beforeEach(() => {
        document.body.innerHTML = '';
        resetSpriteSheetCache();
    });

    test('before the game has drawn one, the emoji stands in', () => {
        // Rather than an empty box. The URL carries a build hash and can only be
        // read off an icon the game has already put on the page.
        document.body.innerHTML = '';

        expect(glyph('coin')).toEqual({ text: GLYPHS.coin });
    });

    test("once the sheet is on the page the glyph is the game's own artwork", () => {
        drawSprite('items');

        const segment = glyph('coin');
        expect(segment.icon).toBe('coin');
        expect(segment.sheet).toBe('items');
        expect(segment.text).toBeUndefined();
    });

    test('a skill glyph comes off the skills sheet, not the item one', () => {
        drawSprite('skills');

        expect(glyph('dealt')).toMatchObject({ icon: 'attack', sheet: 'skills' });
    });

    test('a concept the game has no artwork for stays text whatever is loaded', () => {
        // A bid order and a market trend are not objects; OPanel draws these as
        // emoji too
        drawSprite('items');

        expect(glyph('market').text).toBe(GLYPHS.market);
        expect(glyph('watch').text).toBe(GLYPHS.watch);
    });

    test('an unknown name is empty rather than undefined', () => {
        expect(glyph('nonsense')).toEqual({ text: '' });
    });
});

describe('the identical-draw fast path', () => {
    test('an identical draw keeps the same nodes rather than rebuilding them', () => {
        const container = document.createElement('div');
        row(container, [
            { text: 'Coins', color: '#fff' },
            { text: '43T', push: true },
        ]);
        const line = container.firstChild;

        row(container, [
            { text: 'Coins', color: '#fff' },
            { text: '43T', push: true },
        ]);
        expect(container.firstChild).toBe(line);
    });

    test('a changed segment rebuilds', () => {
        const container = document.createElement('div');
        row(container, [{ text: '43T' }]);
        const line = container.firstChild;

        row(container, [{ text: '44T' }]);
        expect(container.firstChild).not.toBe(line);
        expect(container.textContent).toBe('44T');
    });

    test('a caller that appended its own extras is rebuilt, not skipped over them', () => {
        // The child count is part of the comparison: a container no longer
        // holding exactly what the helper drew gets the full rebuild it always
        // got, so nothing stale survives and nothing appended is duplicated
        const container = document.createElement('div');
        row(container, [{ text: 'DPS' }]);
        container.appendChild(document.createElement('span'));

        row(container, [{ text: 'DPS' }]);
        expect(container.childElementCount).toBe(1);
        expect(container.textContent).toBe('DPS');
    });

    test('an icon drawn as a spacer is redrawn once its sheet turns up', () => {
        // What an icon draws depends on state outside the segments: before the
        // game has drawn from the sheet, the icon is a spacer — and the sheet
        // arriving changes nothing in the segments, so an identical signature
        // would keep the spacer on screen for as long as the figure held still
        document.body.innerHTML = '';
        const container = document.createElement('div');
        const draw = () => rows(container, [[{ text: 'boss' }], [{ icon: 'zombie', sheet: 'combat_monsters' }]]);

        draw();
        expect(container.querySelector('svg')).toBeNull();

        document.body.innerHTML =
            '<svg><use href="/static/media/combat_monsters_sprite.abc123.svg#zombie"></use></svg>';
        draw();

        expect(container.querySelector('svg use')).toBeTruthy();
    });

    test('rows() diffs too, and switching shape redraws', () => {
        const container = document.createElement('div');
        rows(container, [[{ text: 'a' }], [{ text: 'b' }]]);
        const first = container.firstChild;
        rows(container, [[{ text: 'a' }], [{ text: 'b' }]]);
        expect(container.firstChild).toBe(first);

        row(container, [{ text: 'a' }]);
        expect(container.textContent).toBe('a');
        expect(container.childElementCount).toBe(1);
    });
});
