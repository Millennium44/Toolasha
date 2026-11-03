import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { checkChangelogFormat, GRANDFATHERED_FROM_RELEASE, MAX_BODY_CHARS } from './changelog-format.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const MARKER = `<!-- shipped in ${GRANDFATHERED_FROM_RELEASE} -->`;

/** A changelog whose unreleased part is `body`, shaped like the real file. */
function changelogWith(body) {
    return `# Changelog\n\n## Unreleased — branch \`main\`\n\n${body}\n\n${MARKER}\n\n- Old flat line, grandfathered.\n`;
}

describe('the real CHANGELOG.md', () => {
    it('keeps every entry since the grandfathered release to a title and a short body', () => {
        const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
        const problems = checkChangelogFormat(changelog);
        // A failure here means a changelog line broke the What's New format:
        // add a `### Title` and a sentence or two. See CLAUDE.md / AGENTS.md.
        expect(problems.join('\n')).toBe('');
    });
});

describe('checkChangelogFormat', () => {
    it('accepts titled entries with a sentence or bullets', () => {
        const text = changelogWith(
            '### First\n\nOne sentence.\n\n<!-- shipped in 9.9.9 -->\n\n### Second\n\n- A bullet.\n- Another.'
        );
        expect(checkChangelogFormat(text)).toEqual([]);
    });

    it('rejects a flat bullet directly under the section heading', () => {
        const problems = checkChangelogFormat(changelogWith('- A bullet with no title.'));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('outside any entry');
        expect(problems[0]).toContain('Add a `### Title` and a sentence or two');
    });

    it('rejects flat bullets directly under a marker, the way 3.74.0 shipped', () => {
        const text = changelogWith('### Titled\n\nBody.\n\n<!-- shipped in 9.9.9 -->\n\n- Flat one.\n- Flat two.');
        const problems = checkChangelogFormat(text);
        expect(problems).toHaveLength(2);
        expect(problems.every((p) => p.includes('outside any entry'))).toBe(true);
    });

    it('rejects an empty title', () => {
        const problems = checkChangelogFormat(changelogWith('###\n\nBody.\n\n### \n\nBody.'));
        expect(problems.filter((p) => p.includes('empty entry title'))).toHaveLength(2);
    });

    it('rejects a title with nothing under it', () => {
        const problems = checkChangelogFormat(changelogWith('### Lonely title\n\n### Next\n\nBody.'));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('has no text under its title');
    });

    it('rejects two entries with the same title, whatever the case', () => {
        const problems = checkChangelogFormat(changelogWith('### Same\n\nBody.\n\n### same\n\nBody.'));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain('repeats the title');
    });

    it('rejects a body past the length limit and accepts one at it', () => {
        const atLimit = 'x'.repeat(MAX_BODY_CHARS);
        expect(checkChangelogFormat(changelogWith(`### Fits\n\n${atLimit}`))).toEqual([]);
        const problems = checkChangelogFormat(changelogWith(`### Too long\n\n${atLimit}x`));
        expect(problems).toHaveLength(1);
        expect(problems[0]).toContain(`${MAX_BODY_CHARS + 1} characters`);
    });

    it('does not check anything below the grandfathered marker', () => {
        const text = changelogWith('### Fine\n\nBody.') + '\n### Fine\n\n- dup and flat\n' + 'y'.repeat(2000);
        expect(checkChangelogFormat(text)).toEqual([]);
    });

    it('does not let a title repeat one that only exists below the grandfathered marker', () => {
        const text = changelogWith('### Old title\n\nBody.') + '\n### Old title\n\nBody.\n';
        expect(checkChangelogFormat(text)).toEqual([]);
    });

    it('says so when the section or the boundary marker is missing', () => {
        expect(checkChangelogFormat('# Changelog\n')[0]).toContain('Could not find');
        expect(checkChangelogFormat('## Unreleased\n\n### A\n\nBody.\n')[0]).toContain('GRANDFATHERED_FROM_RELEASE');
    });

    it('fails on the flat changelog 3.74.0 shipped with', () => {
        const flat = changelogWith(
            '<!-- shipped in 3.74.0 -->\n\n- The sync report now lists every record.\n- The Consumables panel can now plan stock for 2 weeks.'
        );
        expect(checkChangelogFormat(flat).length).toBeGreaterThan(0);
    });
});
