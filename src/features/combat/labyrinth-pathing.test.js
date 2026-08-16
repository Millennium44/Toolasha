/**
 * Tests for labyrinth route and beacon planning.
 *
 * Moved out of labyrinth-clear-rate.test.js with the code they cover. Pure
 * grid maths, so no game, no DOM and no mocks — which is the point of the
 * planners living apart from the panel that draws their answers.
 */

import { describe, test, expect } from 'vitest';

import {
    computeLabyrinthPath,
    computeApproachPath,
    computeBeaconPlan,
    countDisjointRoutes,
} from './labyrinth-pathing.js';

describe('computeLabyrinthPath', () => {
    // ASCII grids: S = cleared start, E = entrance, . = clearable,
    // X = unclearable (shroud), # = wall, T = treasure, F = floor exit,
    // ? = unrevealed/unknown (clearable, but its type is not yet seen)
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
                    isUnknown: ch === '?',
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

    test('breaks a tie toward the route that reveals more unknown rooms', () => {
        // Two equal 4-torch, 0-shroud detours around a walled centre: the left
        // column threads an unknown room, the right reveals nothing. The reveal
        // tie-break must take the left one instead of an arbitrary wall-hug.
        const { tiles, cols } = grid(['.S.', '?#.', '.F.']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(4);
        expect(path.route.has(3)).toBe(true); // left column, past the unknown
        expect(path.route.has(5)).toBe(false); // right column, revealing nothing
    });

    test('does not detour when the reveal is already on the way', () => {
        // The unknown sits directly below the middle of the direct path, so the
        // 2-torch route already uncovers it. A detour onto the unknown itself
        // reveals nothing new, so the shorter route wins on torches.
        const { tiles, cols } = grid(['S.F', '.?.']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.torches).toBe(2);
        expect(path.route.has(4)).toBe(false); // the unknown, only on the long way
    });

    test('detours to uncover a new unknown room even at an extra torch', () => {
        // The direct S→F path reveals nothing (the unknown at 3 sits below the
        // cleared start, off the direct line). A one-step-longer route down
        // through room 3 uncovers it. Reveals now rank above torches, so the
        // planner takes the detour despite spending no extra shroud.
        const { tiles, cols } = grid(['S.F', '?..']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.route.has(3)).toBe(true); // stepped down to reveal the unknown
        expect(path.torches).toBe(3); // one more than the 2-torch direct route
    });

    test('will not spend an extra shroud to reveal more', () => {
        // Revealing the unknown at 3 would require shrouding the wall-gap; the
        // reveal objective sits below shrouds, so the plan declines it.
        const { tiles, cols } = grid(['S.F', '#X#', '#?#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.route.has(7)).toBe(false); // the unknown behind the shroud
        expect(path.torches).toBe(2);
    });

    test('returns null when no start or exit exists', () => {
        expect(computeLabyrinthPath(grid(['..F']).tiles, 3)).toBeNull();
        expect(computeLabyrinthPath(grid(['S..']).tiles, 3)).toBeNull();
    });
});

/**
 * The walk up to the plan. A floor with its first rooms already cleared gets a
 * route that starts out at the frontier, and from a live floor 10: "I want it
 * to light up the tiles before the tile I've shrouded as well that make the
 * shortest path".
 */
describe('computeApproachPath', () => {
    // S = cleared, E = entrance, . = uncleared room, # = wall
    function grid(rows) {
        const cols = rows[0].length;
        const tiles = [];
        for (const row of rows) {
            for (const ch of row) {
                tiles.push(ch === '#' ? null : { cleared: ch === 'S', isEntrance: ch === 'E' });
            }
        }
        return { tiles, cols };
    }

    test('lights the cleared rooms between the entrance and the first planned room', () => {
        const { tiles, cols } = grid(['ESS..']);
        // The plan starts at 3, two cleared rooms along
        expect(computeApproachPath(tiles, cols, new Set([3, 4]))).toEqual([1, 2]);
    });

    test('is nothing at all when the plan starts where you are standing', () => {
        const { tiles, cols } = grid(['E....']);
        expect(computeApproachPath(tiles, cols, new Set([1, 2]))).toEqual([]);
    });

    test('takes the shortest way round when cleared ground offers two', () => {
        const { tiles, cols } = grid(['ESS.', 'SS#.', 'SSS.']);
        // Along the top row is two rooms; down and around is four
        expect(computeApproachPath(tiles, cols, new Set([3, 7, 11]))).toEqual([1, 2]);
    });

    test('walks from where the player is standing rather than from the entrance', () => {
        const { tiles, cols } = grid(['ESSS.']);
        expect(computeApproachPath(tiles, cols, new Set([4]), 1)).toEqual([2, 3]);
    });

    test('refuses to walk through a room the plan should have costed', () => {
        // The gap at 2 is uncleared, so there is no free way to the plan
        const { tiles, cols } = grid(['ES..S']);
        expect(computeApproachPath(tiles, cols, new Set([4]))).toEqual([]);
    });

    test('an empty plan has no approach', () => {
        const { tiles, cols } = grid(['ESSSS']);
        expect(computeApproachPath(tiles, cols, new Set())).toEqual([]);
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

/**
 * The objective a set count is planned against, from a live run that went
 * wrong: four beacons were placed on the fattest dark pockets of a floor and
 * the plan's own caption admitted "a covered path to the exit needs 3". Rooms
 * revealed is the last thing a placement is judged on, not the first.
 *
 * Both fixtures below are floors where the *most-rooms* placement is a real,
 * findable answer that leaves the way out dark — so a planner that still hands
 * one back has not been fixed, whatever it says about its intentions.
 */
describe('computeBeaconPlan placement objective', () => {
    const COLS = 9;
    const N = 81;
    const idx = (x, y) => y * COLS + x;

    const diamond = (c) => {
        const out = [];
        for (let i = 0; i < N; i++) {
            const d = Math.abs((i % COLS) - (c % COLS)) + Math.abs(Math.floor(i / COLS) - Math.floor(c / COLS));
            if (d <= 2) out.push(i);
        }
        return out;
    };

    /** What a set of beacon centers would light up on this floor */
    const coverageOf = (revealed, centers) => {
        const union = new Set();
        for (const c of centers) {
            for (const d of diamond(c)) {
                if (!revealed[d]) union.add(d);
            }
        }
        return union;
    };

    /** Whether entrance and exit end up joined through revealed rooms */
    const covered = (revealed, union) => {
        const isOpen = (i) => revealed[i] || union.has(i);
        const seen = new Set([0]);
        const queue = [0];
        while (queue.length) {
            const cur = queue.shift();
            const x = cur % COLS;
            const around = [];
            if (x > 0) around.push(cur - 1);
            if (x < COLS - 1) around.push(cur + 1);
            if (cur - COLS >= 0) around.push(cur - COLS);
            if (cur + COLS < N) around.push(cur + COLS);
            for (const nb of around) {
                if (nb === N - 1) return true;
                if (!seen.has(nb) && isOpen(nb)) {
                    seen.add(nb);
                    queue.push(nb);
                }
            }
        }
        return false;
    };

    /** The placement the old objective would have picked: most rooms, full search */
    const mostRooms = (revealed, count) => {
        let best = null;
        const walk = (from, chosen) => {
            if (chosen.length === count) {
                const union = coverageOf(revealed, chosen);
                if (!best || union.size > best.rooms) {
                    const passable = revealed.map((r, i) => r || union.has(i));
                    best = {
                        centers: [...chosen],
                        rooms: union.size,
                        covered: covered(revealed, union),
                        routes: countDisjointRoutes(passable, COLS),
                    };
                }
                return;
            }
            for (let c = from; c < N; c++) walk(c + 1, [...chosen, c]);
        };
        walk(0, []);
        return best;
    };

    /** A revealed floor split by one dark column, with a fat dark pocket in each half */
    const splitFloor = ({ pinch = false } = {}) => {
        const revealed = new Array(N).fill(true);
        for (let y = 0; y < 9; y++) revealed[idx(4, y)] = false;
        // A single revealed room in the wall: the floor is crossable, but every
        // way out runs through that one room
        if (pinch) revealed[idx(4, 4)] = true;
        // Far enough from the wall (three columns) that no one beacon can light
        // a pocket and breach the wall at the same time
        for (const y of [0, 1, 2]) for (const x of [7, 8]) revealed[idx(x, y)] = false;
        for (const y of [6, 7, 8]) for (const x of [0, 1]) revealed[idx(x, y)] = false;
        return revealed;
    };

    test('a covered path outranks the pockets that reveal more rooms', () => {
        const revealed = splitFloor();

        // The floor really does bait a most-rooms planner: the best two-beacon
        // placement by rooms alone lights both pockets and leaves the wall dark
        const greedy = mostRooms(revealed, 2);
        expect(greedy.rooms).toBe(12);
        expect(greedy.covered).toBe(false);

        const plan = computeBeaconPlan(revealed, COLS, 2);
        expect(plan.corridorOpen).toBe(true);
        expect(covered(revealed, plan.covered)).toBe(true);
        // Rooms were given up for it — which is the whole point of the order
        expect(plan.revealedNew).toBeLessThan(greedy.rooms);
        expect(plan.revealedNew).toBeGreaterThan(0);
    });

    test('one beacon short of the pockets, the manual count answers like the automatic one', () => {
        const revealed = splitFloor();

        const auto = computeBeaconPlan(revealed, COLS, 0);
        const manual = computeBeaconPlan(revealed, COLS, 1);

        expect(auto.minNeeded).toBe(1);
        expect(auto.beacons).toHaveLength(1);
        // The automatic mode already covered the way out; a manual count of the
        // same size is the same question and now gets the same answer
        expect(manual.beacons).toEqual(auto.beacons);
        expect(manual.corridorOpen).toBe(true);
    });

    test('four beacons cover the way out first and light the pockets with what is left', () => {
        const revealed = splitFloor();
        const plan = computeBeaconPlan(revealed, COLS, 4);

        expect(plan.beacons).toHaveLength(4);
        expect(plan.corridorOpen).toBe(true);
        expect(covered(revealed, plan.covered)).toBe(true);
        // Coverage first does not mean coverage only: the spare beacons still
        // go to the dark pockets
        expect(plan.revealedNew).toBeGreaterThanOrEqual(15);
    });

    test('a second independent route outranks a fatter dark pocket', () => {
        const revealed = splitFloor({ pinch: true });

        // Already crossable, so every placement clears the first test — and the
        // most-rooms one leaves the floor hanging on that single pinch room
        const greedy = mostRooms(revealed, 1);
        expect(greedy.covered).toBe(true);
        expect(greedy.routes).toBe(1);

        const plan = computeBeaconPlan(revealed, COLS, 1);
        expect(plan.routes).toBeGreaterThanOrEqual(2);
        expect(plan.revealedNew).toBeLessThan(greedy.rooms);
    });

    test('too few beacons to cover a path still spend themselves getting closer', () => {
        const cols = 5;
        const revealed = new Array(25).fill(false);
        revealed[0] = true; // entrance only: a dark floor needing two beacons

        const plan = computeBeaconPlan(revealed, cols, 1);
        expect(plan.minNeeded).toBe(2);
        expect(plan.corridorOpen).toBe(false);

        // The honest answer for a budget that cannot get there is the one that
        // gets closest: after this beacon, one more would finish the job
        const after = revealed.slice();
        for (const c of plan.covered) after[c] = true;
        expect(computeBeaconPlan(after, cols, 0).minNeeded).toBe(1);
    });
});
