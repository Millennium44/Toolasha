import { describe, expect, test, vi } from 'vitest';

const opts = vi.hoisted(() => ({ on: true }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => opts.on } }));
vi.mock('./damage-tracker.js', () => ({ HIT_TAPE_MS: 60_000, recentHits: () => [] }));

const { hitTapeHTML, hitTapeModel, hitTapeSVG, TAPE_WIDTH } = await import('./hit-tape.js');

describe('the hit tape', () => {
    const now = 100_000;

    test('places each hit by time, newest at the right, sized against the largest', () => {
        const model = hitTapeModel(
            [
                { at: now - 60_000, amount: 50, kind: 'hit' },
                { at: now - 30_000, amount: 200, kind: 'crit' },
                { at: now, amount: 1, kind: 'dot' },
                { at: now - 10_000, amount: 0, kind: 'miss' },
            ],
            now
        );
        // The first is exactly a minute old: off the tape
        expect(model.bars.map((bar) => bar.kind)).toEqual(['crit', 'dot', 'miss']);
        expect(model.max).toBe(200);
        expect(model.bars[0]).toMatchObject({ x: TAPE_WIDTH / 2, height: 1 });
        // A tiny hit still shows; the newest sits on the right edge
        expect(model.bars[1]).toMatchObject({ x: TAPE_WIDTH - 1, height: 0.08 });
        expect(model.bars[2].height).toBe(0.12);
    });

    test('a tape of misses only is drawn without dividing by zero', () => {
        const model = hitTapeModel([{ at: now, amount: 0, kind: 'miss' }], now);
        expect(model.max).toBe(0);
        expect(hitTapeSVG(model)).not.toContain('NaN');
    });

    test('crit gets a gold cap, a miss is hollow, and the setting turns it off', () => {
        const svg = hitTapeSVG(
            hitTapeModel(
                [
                    { at: now - 1000, amount: 10, kind: 'crit' },
                    { at: now, amount: 0, kind: 'miss' },
                ],
                now
            )
        );
        expect(svg).toContain('#ffd24a');
        expect(svg).toContain('fill="none"');

        expect(hitTapeHTML({ now, hits: () => [{ at: now, amount: 5, kind: 'hit' }] })).toContain('data-hit-tape');
        opts.on = false;
        expect(hitTapeHTML({ now, hits: () => [{ at: now, amount: 5, kind: 'hit' }] })).toBe('');
        opts.on = true;
    });
});
