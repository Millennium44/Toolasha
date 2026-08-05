/** @vitest-environment happy-dom */

/**
 * These selectors are the one place a game rebuild is allowed to break — every
 * other reference to a game class goes through here. A CSS-module hash suffix
 * (`__17bOx`) changes with every build, so an exported value that still carries
 * one is not hardened at all; it just moved the hardcoded literal one file
 * over. This greps the exported strings themselves rather than exercising any
 * particular selector, because the failure mode is textual — a `__` followed
 * by a short hash right before the string ends — not behavioral.
 */

import { describe, test, expect } from 'vitest';
import { GAME, TOOLASHA, ENHANCEMENT, COMBAT_SIM } from './selectors.js';

/**
 * A build hash immediately after a CSS-module local name — `__17bOx`,
 * `__3s24l`, `__32gl_` — always sitting right before the string (or the
 * attribute-selector's closing quote) ends. A bare trailing `__`, used
 * deliberately to disambiguate two prefixes that would otherwise collide, is
 * not a hash and must not trip this.
 */
const HASH_SUFFIX = /__[A-Za-z0-9_-]{3,8}(?=["'\]]|$)/;

/**
 * Every string value in an object, however deep — selectors are always
 * strings, but walking rather than assuming keeps this from silently skipping
 * something if the shape ever grows a nested group.
 * @param {Object} obj - Object to walk
 * @param {string} prefix - Dotted path prefix, for nested objects
 * @returns {Array<[string, string]>} [path, value] pairs for every string found
 */
function collectStrings(obj, prefix = '') {
    const found = [];
    for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') {
            found.push([path, value]);
        } else if (value && typeof value === 'object') {
            found.push(...collectStrings(value, path));
        }
    }
    return found;
}

describe('GAME selectors carry no build hash', () => {
    for (const [path, value] of collectStrings(GAME)) {
        test(`${path} (${value})`, () => {
            expect(value).not.toMatch(HASH_SUFFIX);
        });
    }
});

describe('the rest of selectors.js (sanity — these were never hashed)', () => {
    for (const [path, value] of [
        ...collectStrings(TOOLASHA),
        ...collectStrings(ENHANCEMENT),
        ...collectStrings(COMBAT_SIM),
    ]) {
        test(`${path} (${value})`, () => {
            expect(value).not.toMatch(HASH_SUFFIX);
        });
    }
});

describe('the two prefixes that would otherwise collide with a sibling class', () => {
    // "Item_item" is a prefix of "Item_itemContainer"; "LootLogPanel_actionLoot"
    // is a prefix of "LootLogPanel_actionLoots". Both selectors below keep the
    // trailing "__" (the point where the hash begins) specifically so they do
    // not also match the sibling.
    test('ITEM_ITEM keeps the disambiguating "__" and excludes item containers', () => {
        expect(GAME.ITEM_ITEM).toContain('Item_item__');

        document.body.innerHTML = '<div class="Item_itemContainer__x7kH1"></div><div class="Item_item__2De2O"></div>';
        const matches = document.querySelectorAll(GAME.ITEM_ITEM);
        expect(matches).toHaveLength(1);
        expect(matches[0].className).toBe('Item_item__2De2O');
    });

    test('LOOT_LOG_ENTRY keeps the disambiguating "__" and excludes the container', () => {
        expect(GAME.LOOT_LOG_ENTRY).toContain('LootLogPanel_actionLoot__');

        document.body.innerHTML =
            '<div class="LootLogPanel_actionLoots__3oTid"></div><div class="LootLogPanel_actionLoot__32gl_"></div>';
        const matches = document.querySelectorAll(GAME.LOOT_LOG_ENTRY);
        expect(matches).toHaveLength(1);
        expect(matches[0].className).toBe('LootLogPanel_actionLoot__32gl_');
    });
});

describe('every GAME selector is still a usable selector', () => {
    for (const [path, value] of collectStrings(GAME)) {
        test(`${path} parses without throwing`, () => {
            // A malformed selector throws on first use — this is what actually
            // caught the tag-prefixed entries (`div[class*="..."]`) during the
            // conversion, where a stray character breaks the attribute syntax.
            expect(() => document.querySelectorAll(value)).not.toThrow();
        });
    }
});
