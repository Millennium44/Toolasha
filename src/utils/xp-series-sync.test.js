import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/storage.js', () => ({ default: {} }));
vi.mock('../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../core/data-manager.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../core/config.js', () => ({ default: { getSetting: () => false, onSettingChange: () => {} } }));
vi.mock('./performance-monitor.js', () => ({ default: { startSpan: () => () => {} } }));

const { foldXPSeriesForPull } = await import('./xp-series-sync.js');
// The guild tracker's own thinning, to record series the way the page does
const { pushXP: pushGuildXP } = await import('../features/guild/guild-xp-tracker.js');

const MIN = 60_000;
const WEEK = 7 * 24 * 60 * MIN;
const SKILL = { windowMs: WEEK, recentMs: 10 * MIN };
const GUILD = { windowMs: WEEK, recentMs: 10 * MIN, keepLast: 2 };
const at = (minutes, xp) => ({ t: minutes * MIN, xp });

describe('foldXPSeriesForPull', () => {
    test('samples inside the span this device covers are not taken back', () => {
        // 18:4 was uploaded as the newest, then thinned here
        const local = { milking: [at(3, 1), at(12, 3), at(26, 5), at(35, 8)] };
        const gist = { milking: [at(3, 1), at(12, 3), at(18, 4)] };

        const folded = foldXPSeriesForPull(local, gist, SKILL);

        expect(folded).toEqual(local);
        expect(folded.milking).toBe(local.milking);
    });

    test('a sample newer than this device has is taken', () => {
        const local = { milking: [at(3, 1), at(35, 8)] };
        const gist = { milking: [at(3, 1), at(40, 9)] };

        expect(foldXPSeriesForPull(local, gist, SKILL).milking).toEqual([at(3, 1), at(35, 8), at(40, 9)]);
    });

    test("another device's older history is taken by a device that started later", () => {
        const local = { milking: [at(600, 50), at(610, 52)] };
        const gist = { milking: [at(0, 10), at(300, 30), at(600, 50)] };

        expect(foldXPSeriesForPull(local, gist, SKILL).milking).toEqual([at(0, 10), at(300, 30), ...local.milking]);
    });

    test("older samples with this device's first XP were thinned here, and are not taken", () => {
        const local = { milking: [at(60, 10), at(70, 12)] };
        const gist = { milking: [at(10, 10), at(30, 10), at(60, 10)] };

        expect(foldXPSeriesForPull(local, gist, SKILL)).toEqual(local);
    });

    test('older samples past the week, or in its last ten minutes, are not taken', () => {
        const last = WEEK / MIN + 100;
        const local = { milking: [at(200, 50), at(last, 60)] };
        const gist = { milking: [at(10, 5), at(95, 6), at(200, 50)] };

        expect(foldXPSeriesForPull(local, gist, SKILL)).toEqual(local);
    });

    test('a series only the gist has is taken unless the caller declines it', () => {
        const local = { a: [at(0, 1)] };
        const gist = { a: [at(0, 1)], b: [at(5, 2)] };

        expect(foldXPSeriesForPull(local, gist, SKILL).b).toEqual([at(5, 2)]);
        expect(foldXPSeriesForPull(local, gist, { ...SKILL, acceptSeries: () => false })).toEqual(local);
    });

    test('the guild rule keeps the two newest samples however old', () => {
        const local = { g: [at(0, 1)] };
        const gist = { g: [at(WEEK / MIN + 60, 5)] };

        expect(foldXPSeriesForPull(local, gist, GUILD).g).toEqual([at(0, 1), at(WEEK / MIN + 60, 5)]);
    });

    test("a gist built from this device's own uploads never changes what it holds", () => {
        // A seeded walk: samples recorded through the guild tracker's thinning,
        // the gist taking a copy of the series now and then, as pushes do
        let seed = 7;
        const random = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        for (let trial = 0; trial < 300; trial++) {
            const local = [];
            const gist = new Map();
            let t = 0;
            let xp = 0;
            const flat = random();
            for (let i = 0; i < 200; i++) {
                t += random() < 0.03 ? random() * 48 * 60 * MIN : random() * 30 * MIN;
                if (random() > flat) xp += Math.floor(random() * 3);
                pushGuildXP(local, { t: Math.round(t), xp });
                if (random() < 0.1) for (const sample of local) gist.set(sample.t, sample);
            }
            const uploaded = [...gist.values()].sort((a, b) => a.t - b.t);

            expect(foldXPSeriesForPull({ g: local }, { g: uploaded }, GUILD).g).toBe(local);
        }
    });
});
