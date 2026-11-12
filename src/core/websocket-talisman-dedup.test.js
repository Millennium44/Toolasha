import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('websocket dedup list', () => {
    test('talismans_updated is never deduplicated', () => {
        const source = readFileSync(new URL('./websocket.js', import.meta.url), 'utf8');
        const block = source.slice(source.indexOf('const SKIP_DEDUP_TYPES'));
        expect(block.slice(0, block.indexOf(']);'))).toContain("'talismans_updated'");
    });
});
