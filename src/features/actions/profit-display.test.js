import { describe, expect, it } from 'vitest';

import { formatMissingLabel } from './profit-display.js';

describe('formatMissingLabel', () => {
    it('returns the provided value when not missing', () => {
        const label = formatMissingLabel(false, '123/hr');

        expect(label).toBe('123/hr');
    });

    it('returns a missing placeholder when data is missing', () => {
        const label = formatMissingLabel(true, '123/hr');

        expect(label).toBe('-- ⚠');
    });
});
