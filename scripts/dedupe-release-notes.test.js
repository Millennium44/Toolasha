import { describe, it, expect } from 'vitest';
import { dedupeNewestRelease, bulletKey } from './dedupe-release-notes.js';

const CHANGELOG = `# Changelog

## Unreleased — branch \`main\`

### Fork entry

Body.

## [3.77.0](https://example.invalid/compare) (2026-11-06)

### Features

* inventory item tooltips move off the hovered item ([9ef2643](https://example.invalid/c/9ef2643))
* inventory item tooltips move off the hovered item ([608874c](https://example.invalid/c/608874c))
* tabs follow a newer version ([6dcfd58](https://example.invalid/c/6dcfd58))

### Bug Fixes

* merge duplicate tasks fills the combined count ([c28491f](https://example.invalid/c/c28491f))
* merge duplicate tasks fills the combined count ([c57fdca](https://example.invalid/c/c57fdca)), closes [#800](https://example.invalid/i/800)
* inventory item tooltips move off the hovered item ([aaaaaaa](https://example.invalid/c/aaaaaaa))

## [3.76.1](https://example.invalid/compare) (2026-11-05)

### Bug Fixes

- same line twice ([1111111](https://example.invalid/c/1111111))
- same line twice ([2222222](https://example.invalid/c/2222222))
`;

describe('dedupeNewestRelease', () => {
    it('keeps the first of each repeated bullet in the newest section', () => {
        const { text, removed } = dedupeNewestRelease(CHANGELOG);
        expect(removed).toBe(2);
        expect(text).toContain('9ef2643');
        expect(text).not.toContain('608874c');
        expect(text).toContain('c28491f');
        expect(text).not.toContain('c57fdca');
        expect(text).toContain('6dcfd58');
    });

    it('compares within one subsection only', () => {
        // The tooltip line also appears under Bug Fixes: a different section, so it stays
        expect(dedupeNewestRelease(CHANGELOG).text).toContain('aaaaaaa');
    });

    it('leaves published releases and the fork section alone', () => {
        const { text } = dedupeNewestRelease(CHANGELOG);
        expect(text).toContain('1111111');
        expect(text).toContain('2222222');
        expect(text).toContain('### Fork entry');
    });

    it('is a no-op when run again, or with nothing to remove', () => {
        const once = dedupeNewestRelease(CHANGELOG).text;
        expect(dedupeNewestRelease(once)).toEqual({ text: once, removed: 0 });
        expect(dedupeNewestRelease('# Changelog\n')).toEqual({ text: '# Changelog\n', removed: 0 });
    });

    it('compares the text without the commit link or a closes note', () => {
        expect(bulletKey('Fix X ([abc1234](https://x/c/abc1234)), closes [#1](https://x/i/1)')).toBe('fix x');
    });
});
