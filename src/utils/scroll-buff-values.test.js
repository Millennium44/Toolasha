/**
 * Tests for the hardcoded Labyrinth scroll buff table.
 *
 * The game JSON carries no consumableDetail for scroll items, so these three maps are transcribed
 * from the item descriptions by hand. There is nothing to derive and nothing to compute — the only
 * failure mode is the three drifting apart, or a label quoting a percentage the value does not
 * back. That is what is asserted here.
 */

import { describe, test, expect } from 'vitest';
import { SCROLL_BUFF_VALUES, SCROLL_BUFF_ITEMS, SCROLL_BUFF_LABELS } from './scroll-buff-values.js';

const BUFF_TYPES = Object.keys(SCROLL_BUFF_VALUES);

describe('the three maps describe the same set of scrolls', () => {
    test('every buff type appears in all three', () => {
        expect(Object.keys(SCROLL_BUFF_ITEMS).sort()).toEqual(BUFF_TYPES.slice().sort());
        expect(Object.keys(SCROLL_BUFF_LABELS).sort()).toEqual(BUFF_TYPES.slice().sort());
    });

    test('there are seven of them', () => {
        expect(BUFF_TYPES).toHaveLength(7);
    });

    test('every key is a buff-type hrid', () => {
        for (const buffType of BUFF_TYPES) {
            expect(buffType).toMatch(/^\/buff_types\/[a-z_]+$/);
        }
    });
});

describe('values', () => {
    test('each is a positive decimal ratio, not a percentage', () => {
        // 0.14 means +14%; a 14 here would be read as +1400% by every caller
        for (const [buffType, value] of Object.entries(SCROLL_BUFF_VALUES)) {
            expect(value, buffType).toBeGreaterThan(0);
            expect(value, buffType).toBeLessThanOrEqual(1);
        }
    });
});

describe('item names', () => {
    test('each is a bare item id, with no hrid prefix', () => {
        // Callers build the hrid themselves; a leading slash here would double it
        for (const [buffType, item] of Object.entries(SCROLL_BUFF_ITEMS)) {
            expect(item, buffType).toMatch(/^[a-z_]+$/);
        }
    });

    test('they are distinct, so two buff types cannot claim one item', () => {
        const items = Object.values(SCROLL_BUFF_ITEMS);
        expect(new Set(items).size).toBe(items.length);
    });

    test('each is named after its buff type, still using the old "seal" wording', () => {
        // The game renamed Seals to Scrolls but the item ids did not follow
        for (const [buffType, item] of Object.entries(SCROLL_BUFF_ITEMS)) {
            expect(item).toBe(`seal_of_${buffType.replace('/buff_types/', '')}`);
        }
    });
});

describe('labels', () => {
    test('the percentage in each label is the value it sits next to', () => {
        // The label is what the player reads and the value is what the maths uses; if the two
        // disagree the panel is lying, and nothing else would catch it
        for (const [buffType, label] of Object.entries(SCROLL_BUFF_LABELS)) {
            const quoted = label.match(/\+(\d+(?:\.\d+)?)%/);
            expect(quoted, `${buffType} label has no percentage`).not.toBeNull();
            expect(Number(quoted[1]), buffType).toBeCloseTo(SCROLL_BUFF_VALUES[buffType] * 100, 9);
        }
    });

    test('each label calls the item a Scroll, not a Seal', () => {
        for (const [buffType, label] of Object.entries(SCROLL_BUFF_LABELS)) {
            expect(label, buffType).toMatch(/^Scroll of /);
        }
    });
});
