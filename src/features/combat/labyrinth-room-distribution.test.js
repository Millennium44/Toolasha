/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const bus = vi.hoisted(() => ({ handlers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1000,
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
        setSettingValue: (key, value) => {
            settings.values[key] = value;
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
    },
}));

vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: () => {},
    saveGeometry: () => {},
    clampPanelToViewport: () => null,
    markPanelInteracted: () => {},
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));

import {
    normalizeBinWidth,
    summarizeRoomDistribution,
    buildAxisLabels,
    buildHistogramSvg,
    BIN_WIDTH_OPTIONS,
    collectFloorChances,
    toggleRoomDistribution,
    refreshRoomDistribution,
    destroyRoomDistribution,
} from './labyrinth-room-distribution.js';

const monster = (level, extra = {}) => ({
    roomType: '/labyrinth_room_types/combat',
    monsterHrid: '/monsters/fly',
    recommendedLevel: level,
    ...extra,
});
const skilling = (level) => ({
    roomType: '/labyrinth_room_types/skilling',
    skillHrid: '/skills/foraging',
    recommendedLevel: level,
});

/** A 3-wide floor: monster rooms, a skilling room, an unrevealed one, a treasure room and a cleared room */
function floor() {
    const rooms = [
        [monster(100), monster(110), skilling(105)],
        [
            { roomType: '/labyrinth_room_types/unknown' },
            { roomType: '/labyrinth_room_types/treasure' },
            monster(90, { isCleared: true }),
        ],
        [monster(120), skilling(95), monster(130)],
    ];
    const results = new Map([
        ['0,0', { clearChance: 0.95 }],
        ['1,0', { clearChance: 0.42 }],
        ['2,0', { clearChance: 1 }],
        ['1,2', { clearChance: 0.5 }],
    ]);
    return { rooms, results, floor: 7 };
}

describe('normalizeBinWidth', () => {
    test('clamps and defaults', () => {
        expect(normalizeBinWidth('25')).toBe(25);
        expect(normalizeBinWidth(1)).toBe(5);
        expect(normalizeBinWidth(500)).toBe(100);
        expect(normalizeBinWidth('x')).toBe(10);
    });
});

describe('summarizeRoomDistribution', () => {
    test('puts 100% in the last bin and 0% in the first', () => {
        const bins = summarizeRoomDistribution([0, 1, 0.5, 0.99], 25);
        expect(bins.map((b) => b.count)).toEqual([1, 0, 1, 2]);
        expect(bins[3].max).toBe(100);
    });

    test('a width that does not divide 100 ends on 100', () => {
        const bins = summarizeRoomDistribution([0.96], 30);
        expect(bins.map((b) => [b.min, b.max])).toEqual([
            [0, 30],
            [30, 60],
            [60, 90],
            [90, 100],
        ]);
        expect(bins[3].count).toBe(1);
    });

    test('ratios sum to one, and an empty input has none', () => {
        const bins = summarizeRoomDistribution([0.1, 0.2, 0.9, 0.95], 10);
        expect(bins.reduce((sum, b) => sum + b.ratio, 0)).toBeCloseTo(1);
        expect(summarizeRoomDistribution([], 10).every((b) => b.count === 0 && b.ratio === 0)).toBe(true);
    });

    test('sorts a shown 50% with the 50s bin, not the 40s', () => {
        const bins = summarizeRoomDistribution([0.496], 10);
        expect(bins[5].count).toBe(1);
    });
});

describe('histogram axis labels', () => {
    const widths = [...BIN_WIDTH_OPTIONS, 30, 15, 7];

    test.each(widths)('bin width %i: labels are unique, span 0 to 100%, and never touch', (binWidth) => {
        const bins = summarizeRoomDistribution([0.1, 0.5, 1], binWidth);
        const labels = buildAxisLabels(bins, 300);
        const texts = labels.map((l) => l.text);
        expect(new Set(texts).size).toBe(texts.length);
        expect(texts[0]).toBe('0');
        expect(texts[texts.length - 1]).toBe('100%');
        for (let i = 1; i < labels.length; i++) {
            expect(labels[i].left - labels[i - 1].right).toBeGreaterThanOrEqual(4);
        }
        expect(labels[0].left).toBeGreaterThanOrEqual(0);
        expect(labels[labels.length - 1].right).toBeLessThanOrEqual(300);
    });

    test.each(widths)('bin width %i: the drawn svg carries exactly those labels', (binWidth) => {
        const bins = summarizeRoomDistribution([0.1, 0.5, 1], binWidth);
        const svg = buildHistogramSvg(bins);
        const axis = [...svg.querySelectorAll('text')]
            .filter((el) => el.getAttribute('y') === '124')
            .map((el) => el.textContent);
        expect(axis).toEqual(buildAxisLabels(bins, 300).map((l) => l.text));
    });
});

describe('histogram bar placement', () => {
    test('a width that does not divide 100 still puts each bar between its own tick edges', () => {
        // 30-wide bins: 0-30, 30-60, 60-90 and a narrow 90-100
        const bins = summarizeRoomDistribution([0.1, 0.4, 0.7, 0.95], 30);
        const svg = buildHistogramSvg(bins);
        const rects = [...svg.querySelectorAll('rect')];
        expect(rects).toHaveLength(4);
        rects.forEach((rect, index) => {
            const left = (bins[index].min / 100) * 300;
            const right = (bins[index].max / 100) * 300;
            expect(Number(rect.getAttribute('x'))).toBeGreaterThanOrEqual(left - 0.06);
            expect(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width'))).toBeLessThanOrEqual(
                right + 0.06
            );
        });
    });
});

describe('collectFloorChances', () => {
    test('judged rooms feed the chances and the rest are reported apart', () => {
        const s = collectFloorChances(floor());
        expect(s.chances.sort()).toEqual([0.42, 0.5, 0.95, 1]);
        expect(s).toMatchObject({ judged: 4, pending: 2, unrevealed: 1, cleared: 1, treasure: 1, floor: 7 });
        expect(s.minLevel).toBe(95);
        expect(s.maxLevel).toBe(110);
    });

    test('a pending room is never counted as 0%', () => {
        const input = floor();
        input.results = new Map();
        const s = collectFloorChances(input);
        expect(s.chances).toEqual([]);
        expect(s.judged).toBe(0);
        expect(s.pending).toBe(6);
        expect(s.mean).toBeNull();
    });

    test('mean and median', () => {
        const s = collectFloorChances(floor());
        expect(s.mean).toBeCloseTo((0.42 + 0.5 + 0.95 + 1) / 4);
        expect(s.median).toBeCloseTo((0.5 + 0.95) / 2);
    });

    test('a flat room list takes its row width from the floor', () => {
        // Floor 1 is a 4-wide grid (MIN(3 + floor, 8)); a flat list carries no row width of its own
        const rooms = Array.from({ length: 16 }, () => skilling(100));
        rooms[1] = monster(100); // col 1, row 0
        rooms[6] = monster(110); // col 2, row 1
        const results = new Map([
            ['1,0', { clearChance: 0.8 }],
            ['2,1', { clearChance: 0.3 }],
        ]);
        const s = collectFloorChances({ rooms, results, floor: 1 });
        expect(s.chances.sort()).toEqual([0.3, 0.8]);
    });

    test('a hidden room is null in roomData and counts as unrevealed', () => {
        const rooms = [
            [{ roomType: '/labyrinth_room_types/entrance', isCleared: true }, null, monster(100)],
            [null, monster(100), null],
            [monster(100), null, { roomType: '/labyrinth_room_types/descend' }],
        ];
        const s = collectFloorChances({ rooms, results: new Map([['2,0', { clearChance: 0.5 }]]), floor: 0 });
        expect(s).toMatchObject({ judged: 1, pending: 2, unrevealed: 4, cleared: 0 });
    });

    test('a revealed exit is left out of every count', () => {
        const rooms = [
            [{ isCleared: true }, monster(100)],
            [monster(100), { roomType: '/labyrinth_room_types/descend' }],
        ];
        const s = collectFloorChances({ rooms, results: new Map(), floor: 0 });
        expect(s.unrevealed).toBe(0);
        expect(s.pending).toBe(2);
        expect(s.pending + s.unrevealed + s.judged + s.cleared + s.treasure).toBe(2 + 0 + 0 + 0 + 0);
    });

    test('tolerates missing input', () => {
        expect(collectFloorChances({ rooms: null, results: null }).judged).toBe(0);
    });
});

describe('the panel', () => {
    const text = () => document.body.textContent;

    beforeEach(() => {
        settings.values = {};
        document.body.innerHTML = '';
    });

    afterEach(() => {
        destroyRoomDistribution();
    });

    test('draws the histogram and counts without a failure', () => {
        toggleRoomDistribution(floor);
        expect(document.querySelector('svg rect')).not.toBeNull();
        expect(document.querySelectorAll('svg rect').length).toBe(10);
        expect(text()).toContain('Floor 7 clear chance');
        expect(text()).toContain('Not calculated yet');
        expect(text()).toContain('Unrevealed');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the bin-width selector persists the setting and redraws', () => {
        toggleRoomDistribution(floor);
        const select = document.querySelector('select');
        select.value = '25';
        select.dispatchEvent(new Event('change'));
        expect(settings.values.labyrinthDistributionBinWidth).toBe(25);
        expect(document.querySelectorAll('svg rect').length).toBe(4);
    });

    test('follows the floor when refreshed', () => {
        const input = floor();
        toggleRoomDistribution(() => input);
        input.results.set('0,2', { clearChance: 0.3 });
        refreshRoomDistribution();
        expect(text()).toMatch(/Judged\s*5/);
    });

    test('says so before a calculation has run', () => {
        const input = floor();
        input.results = new Map();
        toggleRoomDistribution(() => input);
        expect(text()).toContain('No room has been calculated yet');
        expect(document.querySelector('svg')).toBeNull();
    });

    test('says so when no floor is loaded', () => {
        toggleRoomDistribution(() => ({ rooms: null, results: null, floor: 0 }));
        expect(text()).toContain('Open a labyrinth floor');
    });

    test('a second toggle closes it', () => {
        toggleRoomDistribution(floor);
        toggleRoomDistribution(floor);
        expect(document.querySelector('svg')).toBeNull();
    });
});
