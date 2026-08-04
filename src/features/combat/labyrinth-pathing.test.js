/**
 * Tests for labyrinth route and beacon planning.
 *
 * Moved out of labyrinth-clear-rate.test.js with the code they cover. Pure
 * grid maths, so no game, no DOM and no mocks — which is the point of the
 * planners living apart from the panel that draws their answers.
 */

import { describe, test, expect } from 'vitest';

import { computeLabyrinthPath, computeBeaconPlan, countDisjointRoutes } from './labyrinth-pathing.js';

describe('computeLabyrinthPath', () => {
    // ASCII grids: S = cleared start, E = entrance, . = clearable,
    // X = unclearable (shroud), # = wall, T = treasure, F = floor exit
    function grid(rows) {
        const cols = rows[0].length;
        const tiles = [];
        for (const row of rows) {
            for (const ch of row) {
                if (ch === '#') {
                    tiles.push(null);
                    continue;
                }
                tiles.push({
                    cleared: ch === 'S',
                    isEntrance: ch === 'E',
                    needsShroud: ch === 'X',
                    isTreasure: ch === 'T',
                    isExit: ch === 'F',
                });
            }
        }
        return { tiles, cols };
    }

    test('routes straight to the exit', () => {
        const { tiles, cols } = grid(['S.F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
        expect([...path.route].sort()).toEqual([1, 2]);
    });

    test('detours around unclearable tiles instead of spending a shroud', () => {
        const { tiles, cols } = grid(['SXF', '...']);
        const path = computeLabyrinthPath(tiles, cols);
        // 0 shrouds via the bottom row (4 torches) beats 1 shroud (2 torches)
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(4);
        expect(path.route.has(1)).toBe(false);
    });

    test('spends a shroud when the exit is walled off otherwise', () => {
        const { tiles, cols } = grid(['SXF', '###']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(1);
        expect(path.torches).toBe(2);
        expect(path.route.has(1)).toBe(true);
    });

    test('grafts on treasure rooms reachable without shrouds', () => {
        const { tiles, cols } = grid(['S.F', '#T#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.chests.size).toBe(1);
        expect(path.route.has(4)).toBe(true);
        expect(path.torches).toBe(3);
    });

    test('never spends a shroud to reach a chest', () => {
        const { tiles, cols } = grid(['S.F', '#X#', '#T#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.chests.size).toBe(0);
        expect(path.route.has(7)).toBe(false);
        expect(path.torches).toBe(2);
    });

    test('routes from an uncleared entrance on a fresh floor', () => {
        const { tiles, cols } = grid(['E.F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
    });

    test('returns null when no start or exit exists', () => {
        expect(computeLabyrinthPath(grid(['..F']).tiles, 3)).toBeNull();
        expect(computeLabyrinthPath(grid(['S..']).tiles, 3)).toBeNull();
    });
});

describe('computeBeaconPlan', () => {
    const manhattan = (a, b, cols) =>
        Math.abs((a % cols) - (b % cols)) + Math.abs(Math.floor(a / cols) - Math.floor(b / cols));

    test('chains the minimum beacons from entrance to exit on a dark floor', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true; // entrance
        const plan = computeBeaconPlan(revealed, cols, 0);

        expect(plan.feasible).toBe(true);
        expect(plan.minNeeded).toBe(2);
        expect(plan.beacons).toHaveLength(2);
        // First beacon reaches the entrance region, last reaches the exit,
        // consecutive reveal areas connect
        expect(manhattan(0, plan.beacons[0], cols)).toBeLessThanOrEqual(3);
        expect(manhattan(24, plan.beacons[1], cols)).toBeLessThanOrEqual(3);
        expect(manhattan(plan.beacons[0], plan.beacons[1], cols)).toBeLessThanOrEqual(5);
        expect(plan.revealedNew).toBeGreaterThan(0);
    });

    test('needs no beacons when a revealed corridor already exists', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) revealed[idx] = true;
        const plan = computeBeaconPlan(revealed, cols, 0);

        expect(plan.feasible).toBe(true);
        expect(plan.minNeeded).toBe(0);
        expect(plan.beacons).toHaveLength(0);
    });

    test('a count below the corridor minimum still gets a plan', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const plan = computeBeaconPlan(revealed, cols, 1);

        // One beacon cannot chain a covered path, but "where do I put the one
        // beacon I have" is still a question with an answer
        expect(plan.feasible).toBe(true);
        expect(plan.beacons).toHaveLength(1);
        expect(plan.revealedNew).toBeGreaterThan(0);
        expect(plan.corridorOpen).toBe(false);
        expect(plan.minNeeded).toBe(2);
    });

    test('a set count is planned for coverage even when the way out is already open', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) revealed[idx] = true;
        const plan = computeBeaconPlan(revealed, cols, 2);

        // The corridor being open is no reason to plan nothing — the rest of
        // the floor is still dark, and the beacons were already bought
        expect(plan.beacons).toHaveLength(2);
        expect(plan.revealedNew).toBeGreaterThan(0);
        expect(plan.corridorOpen).toBe(true);
        expect(plan.minNeeded).toBe(0);
    });

    test('more beacons reveal more rooms', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const two = computeBeaconPlan(revealed, cols, 2);
        const three = computeBeaconPlan(revealed, cols, 3);

        expect(three.feasible).toBe(true);
        expect(three.beacons).toHaveLength(3);
        expect(three.revealedNew).toBeGreaterThan(two.revealedNew);
    });

    test('places no more beacons than there are rooms left to reveal', () => {
        const cols = 5;
        const revealed = new Array(25).fill(true);
        revealed[12] = false; // one dark room in the middle
        const plan = computeBeaconPlan(revealed, cols, 6);

        expect(plan.beacons).toHaveLength(1);
        expect(plan.revealedNew).toBe(1);
    });

    test('two equally dark pockets, and the beacon lights the one on the way out', () => {
        const cols = 9;
        const idx = (x, y) => y * cols + x;
        const revealed = new Array(81).fill(true);
        const darken = (cx, cy) => {
            for (let y = 0; y < 9; y++) {
                for (let x = 0; x < 9; x++) {
                    if (Math.abs(x - cx) + Math.abs(y - cy) <= 2) revealed[idx(x, y)] = false;
                }
            }
        };
        darken(5, 6); // between the revealed floor and the exit at (8,8)
        darken(6, 2); // the same 13 rooms, but nothing out there is on the way

        const plan = computeBeaconPlan(revealed, cols, 1);
        expect(plan.revealedNew).toBe(13); // both pockets are worth the same
        expect(plan.beacons).toEqual([idx(5, 6)]);
    });
});

describe('countDisjointRoutes', () => {
    test('a single-file corridor is one route', () => {
        const cols = 5;
        const passable = new Array(25).fill(false);
        for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) passable[idx] = true;
        expect(countDisjointRoutes(passable, cols)).toBe(1);
    });

    test('a fully open grid gives two corner-limited routes', () => {
        const passable = new Array(25).fill(true);
        expect(countDisjointRoutes(passable, 5)).toBe(2);
    });

    test('no passable cells means no route', () => {
        const passable = new Array(25).fill(false);
        expect(countDisjointRoutes(passable, 5)).toBe(0);
    });
});

describe('computeBeaconPlan route redundancy', () => {
    test('reports the route count without paying rooms for it', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true;
        const minimal = computeBeaconPlan(revealed, cols, 0);
        expect(minimal.routes).toBeGreaterThanOrEqual(1);

        const extra = computeBeaconPlan(revealed, cols, 4);
        expect(extra.feasible).toBe(true);
        expect(extra.revealedNew).toBeGreaterThanOrEqual(minimal.revealedNew);
    });
});
