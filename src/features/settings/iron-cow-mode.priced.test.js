/**
 * `needsPrices` in the schema is the one declaration of "this setting shows market prices". Iron Cow keeps its
 * own list of what it locks (changing that list changes what an existing player loses, so the flag cannot drive
 * it), but every priced setting must have had the Iron Cow decision made, one way or the other.
 */

import { describe, test, expect } from 'vitest';

const { settingsGroups } = await import('../../core/settings-schema.js');
const { IRON_COW_SETTINGS, IRON_COW_UNLOCKED_PRICED } = await import('./iron-cow-mode.js');

const flagged = new Set();
for (const group of Object.values(settingsGroups)) {
    for (const [id, definition] of Object.entries(group.settings)) {
        if (definition.needsPrices) flagged.add(id);
    }
}

describe('iron cow mode accounts for every priced setting', () => {
    test('every setting Iron Cow locks declares needsPrices', () => {
        const unflagged = [...IRON_COW_SETTINGS].filter((id) => !flagged.has(id));
        expect(
            unflagged,
            `IRON_COW_SETTINGS lists ${unflagged.join(', ')} without \`needsPrices: true\` in settings-schema.js. ` +
                'Add the flag to the setting (Essentials must not hold it, and a default-on one belongs in the Market preset).'
        ).toEqual([]);
    });

    test('every needsPrices setting is locked by Iron Cow or recorded as left alone', () => {
        const undecided = [...flagged].filter((id) => !IRON_COW_SETTINGS.has(id) && !IRON_COW_UNLOCKED_PRICED.has(id));
        expect(
            undecided,
            `New needsPrices setting(s) Iron Cow has not decided on: ${undecided.join(', ')}. A no-marketplace ` +
                'player has no prices for it. Add it to IRON_COW_SETTINGS (locked off in the mode) or to ' +
                'IRON_COW_UNLOCKED_PRICED (stays available) in iron-cow-mode.js.'
        ).toEqual([]);
    });

    test('the two sets do not overlap and name only flagged settings', () => {
        for (const id of IRON_COW_UNLOCKED_PRICED) {
            expect(IRON_COW_SETTINGS.has(id), `${id} is both locked and recorded as left alone`).toBe(false);
            expect(flagged.has(id), `${id} is in IRON_COW_UNLOCKED_PRICED but not flagged needsPrices`).toBe(true);
        }
    });
});
