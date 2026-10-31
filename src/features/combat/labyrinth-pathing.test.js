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
    orderBeaconsForPrefixes,
    stageBeaconPlan,
} from './labyrinth-pathing.js';

describe('computeLabyrinthPath', () => {
    // ASCII grids: S = cleared start, E = entrance, . = clearable,
    // X = unclearable (shroud), # = wall, T = treasure, F = floor exit,
    // ? = unrevealed/unknown (clearable, but its type is not yet seen),
    // U = unrevealed and costed as a shroud — the pessimistic posture the panel
    // uses by default, where revealing a room can still turn out to save one
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
                    needsShroud: ch === 'X' || ch === 'U',
                    isTreasure: ch === 'T',
                    isExit: ch === 'F',
                    isUnknown: ch === '?' || ch === 'U',
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

    test('marks the rooms cleared only to reach a chest as a chest branch', () => {
        // S→F runs along the top row (rooms 1, 2). The chest at index 7 hangs off
        // room 4 below the exit line: room 4 is entered only to reach it, so it is
        // a chest-branch room; the exit-critical rooms are not.
        const { tiles, cols } = grid(['S.F', '..#', '.T#']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.chests.has(7)).toBe(true);
        expect(path.chestBranch.has(4)).toBe(true); // the room reached only for the chest
        expect(path.chestBranch.has(1)).toBe(false); // on the way to the exit
        expect(path.chestBranch.has(2)).toBe(false); // the exit approach
        expect(path.chestBranch.has(7)).toBe(false); // the treasure tile itself is not a branch room
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

    test('does not pay a torch for a reveal that cannot shorten the route', () => {
        // The unknown at 3 is already costed as a clearable room, so whatever it
        // turns out to be can only make the route dearer — a step down to
        // uncover it is a room spent for nothing. The direct 2-torch route wins.
        const { tiles, cols } = grid(['S.F', '?..']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
        expect(path.route.has(3)).toBe(false); // no step aside for a useless reveal
    });

    test('does not detour to peek at a shroud too far away to ever help', () => {
        // The unknown in the far corner would cost a shroud, and the way out is
        // already two rooms with none. Even if it turned out to be free ground it
        // sits nowhere near the exit line, so no content behind it can beat the
        // direct route — the peek from room 5 is provably useless.
        const { tiles, cols } = grid(['S.F', '...', '..U']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(2);
        expect(path.route.has(5)).toBe(false); // the room that only peeks at the corner
        expect(path.route.has(8)).toBe(false);
    });

    test('still detours to an unknown that could reveal a cheaper way out', () => {
        // Both ways out cost a shroud today: through the unclearable room at 1,
        // or through the unknown at 3. Revealing 3 could show a clearable room
        // and a shroud-free route, which beats the plan on hand — so the extra
        // rooms are worth it and the detour stands.
        const { tiles, cols } = grid(['SXF', 'U..']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(1);
        expect(path.route.has(3)).toBe(true); // the unknown that might save the shroud
        expect(path.route.has(1)).toBe(false); // the known-unclearable room is not taken
    });

    test('keeps a shroud that lies on the shortest way out', () => {
        // Nothing to prune here: the only route to the exit runs through the
        // unknown, so passing through it costs no extra room.
        const { tiles, cols } = grid(['SUF']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.shrouds).toBe(1);
        expect(path.torches).toBe(2);
        expect(path.route.has(1)).toBe(true);
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

    test('a cleared tile cut off from the entrance is not a free start', () => {
        // The S at index 2 is cleared (a tile shrouded ahead) but the entrance
        // only touches uncleared rooms — you cannot stand on it yet. The plan must
        // cost the room between the entrance and it (index 1), not teleport onto
        // the shroud and route straight to the exit.
        const { tiles, cols } = grid(['E.S.F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.route.has(1)).toBe(true); // the room reaching the isolated clear is on the plan
        expect(path.shrouds).toBe(0);
        expect(path.torches).toBe(3); // rooms 1 and 3 and the exit — not 2, which would skip room 1
    });

    test('a cleared tile connected to the entrance still seeds the route for free', () => {
        // Here the cleared region is contiguous with the entrance (E–S adjacent),
        // so the plan starts at the frontier: only the two rooms out to the exit
        // cost, exactly as before.
        const { tiles, cols } = grid(['ES..F']);
        const path = computeLabyrinthPath(tiles, cols);
        expect(path.route.has(1)).toBe(false); // the cleared S is free, not a costed room
        expect(path.torches).toBe(3); // rooms 2, 3 and the exit
    });

    /**
     * The reveal-detour economy walks past a reveal it can prove useless. Two
     * things it must never do while pruning: cost a shroud, or leave the plan
     * with no way out at all. Both are properties of every floor rather than of
     * a chosen one, so this sweeps every 3x3 floor whose middle rooms are each
     * plain, known-unclearable, or unrevealed-and-costed-as-a-shroud — the
     * pessimistic posture, the only one where a reveal can buy anything.
     *
     * (The bound's admissibility itself — that no content behind a pruned
     * reveal could ever have beaten the route on hand — follows from a reveal
     * only ever dropping a shroud: it cannot make a room free, since only
     * walking it clears it, and cannot take a room off the grid. Pricing the
     * uncovered rooms shroud-free is therefore the best case, and the best case
     * is what `couldShorten` re-routes through.)
     */
    test('pruning a reveal detour never costs a shroud and never loses the exit', () => {
        const N = 9;
        const cols = 3;
        const exitIdx = N - 1;
        const neighbors = (i) => {
            const out = [];
            if (i % cols > 0) out.push(i - 1);
            if (i % cols < cols - 1) out.push(i + 1);
            if (i - cols >= 0) out.push(i - cols);
            if (i + cols < N) out.push(i + cols);
            return out;
        };
        // Fewest shrouds any entrance→exit walk can manage, by exhaustive search
        // rather than by the planner's own routing — an oracle that shared the
        // implementation would prove nothing
        const minShroudsTo = (tiles) => {
            let best = Infinity;
            const walk = (at, visited, shrouds) => {
                if (shrouds >= best) return;
                if (at === exitIdx) {
                    best = shrouds;
                    return;
                }
                for (const nb of neighbors(at)) {
                    if (visited.has(nb)) continue;
                    visited.add(nb);
                    walk(nb, visited, shrouds + (tiles[nb].needsShroud ? 1 : 0));
                    visited.delete(nb);
                }
            };
            walk(0, new Set([0]), 0);
            return best;
        };

        let floors = 0;
        for (let code = 0; code < 3 ** 7; code++) {
            const tiles = [];
            let digits = code;
            for (let i = 0; i < N; i++) {
                if (i === 0 || i === exitIdx) {
                    tiles.push({
                        cleared: false,
                        isEntrance: i === 0,
                        isExit: i === exitIdx,
                        isTreasure: false,
                        needsShroud: false,
                        isUnknown: false,
                    });
                    continue;
                }
                const kind = digits % 3;
                digits = Math.floor(digits / 3);
                tiles.push({
                    cleared: false,
                    isEntrance: false,
                    isExit: false,
                    isTreasure: false,
                    needsShroud: kind !== 0,
                    isUnknown: kind === 2,
                });
            }
            if (!tiles.some((t) => t.isUnknown)) continue;
            floors++;

            const path = computeLabyrinthPath(tiles, cols);
            // A floor with no walls always has a way out, whatever it costs, so
            // pruning must never turn a plan into "no route to the floor exit"
            expect({ code, path: path === null }).toEqual({ code, path: false });
            expect({ code, shrouds: path.shrouds }).toEqual({ code, shrouds: minShroudsTo(tiles) });
        }
        expect(floors).toBeGreaterThan(1000);
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

    /**
     * Why the beacon objective stops chasing routes at two, measured rather
     * than asserted: the entrance and the exit are opposite corners, and a
     * corner has two neighbours. Every route out has to leave through one of
     * them, and no two routes may share a room, so two is the ceiling on every
     * floor the game deals — even one revealed end to end, which is the most
     * passable a grid can ever be. Route count only rises as cells open up, so
     * no beacon placement at any count can beat this.
     */
    test('two routes is the ceiling on every floor size, fully revealed', () => {
        for (const cols of [4, 5, 6, 7, 8]) {
            expect(countDisjointRoutes(new Array(cols * cols).fill(true), cols)).toBe(2);
        }
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

/**
 * How close the beacon planner gets to the best placement there is.
 *
 * A labyrinth floor is at most 8x8, so for the counts people actually place
 * the optimum can simply be enumerated — C(64, 3) is 41,664 placements — and
 * the planner measured against it rather than argued about. Doing that turned
 * up a real gap: relocating one beacon at a time settles at a placement where
 * every single beacon is right given the others, which is not the same as the
 * best placement. The move that pays is usually "shift this beacon and slide
 * its neighbour over to keep the way out covered", and neither half of it is
 * an improvement on its own.
 *
 * The boards below are floors where that gap was measured. Each figure is the
 * exhaustive optimum under the planner's own objective, not a high-water mark.
 */
describe('computeBeaconPlan optimality', () => {
    const COLS = 8;
    const board = (indices) => {
        const revealed = new Array(64).fill(false);
        for (const i of indices) revealed[i] = true;
        return revealed;
    };

    test('a pair move finds the room a one-at-a-time sweep settles short of', () => {
        const revealed = board([0, 1, 2, 3, 8]);
        const plan = computeBeaconPlan(revealed, COLS, 3);

        // 35 is the exhaustive optimum over all 41,664 three-beacon placements
        // once the exit, which is always known, is no longer counted as a gain
        expect(plan.revealedNew).toBe(35);
        expect(plan.corridorOpen).toBe(true);
        expect(plan.routes).toBe(2);
    });

    test('and the same on a four-beacon floor', () => {
        const revealed = board([0, 8, 9, 16, 17]);
        const plan = computeBeaconPlan(revealed, COLS, 4);

        expect(plan.revealedNew).toBe(46); // exhaustive optimum; was 45
        expect(plan.corridorOpen).toBe(true);
    });

    test('and on a floor already lit by an earlier beacon', () => {
        const revealed = board([0, 1, 5, 6, 7, 8, 14, 15, 23, 38, 45, 46, 47, 52, 53, 54, 55, 61, 62, 63]);
        const plan = computeBeaconPlan(revealed, COLS, 4);

        expect(plan.revealedNew).toBe(40); // exhaustive optimum; was 39
        expect(plan.corridorOpen).toBe(true);
    });

    test('floors that were already planned optimally are planned the same way', () => {
        // The wider search only ever accepts a placement the objective calls
        // better, so a floor it had right keeps the answer it had
        expect(computeBeaconPlan(board([0, 1, 4, 5, 8, 9, 13, 16, 17, 18, 19, 20, 21]), COLS, 4).revealedNew).toBe(41);
        expect(computeBeaconPlan(board([0, 1, 2, 3, 8]), COLS, 4).revealedNew).toBe(46);
    });

    test('the same floor gives the same plan every time', () => {
        const revealed = board([0, 1, 2, 3, 8]);
        for (const count of [1, 2, 3, 4, 5, 6]) {
            const first = computeBeaconPlan(revealed, COLS, count);
            for (let again = 0; again < 3; again++) {
                const repeat = computeBeaconPlan(revealed, COLS, count);
                expect(repeat.beacons).toEqual(first.beacons);
                expect(repeat.revealedNew).toBe(first.revealedNew);
            }
        }
    });

    test('planning stays fast enough to recompute as the count changes', () => {
        const revealed = board([0, 1, 2, 3, 8]);
        const started = Date.now();
        for (let i = 0; i < 4; i++) {
            for (const count of [2, 3, 4, 5, 6]) computeBeaconPlan(revealed, COLS, count);
        }
        // Twenty plans: the panel recomputes one per click with auto-calc on,
        // and they measure in tens of milliseconds each
        expect(Date.now() - started).toBeLessThan(3000);
    });
});

describe('computeBeaconPlan exit tile', () => {
    test('the exit is known: a beacon over only the exit gains nothing and is not placed', () => {
        const revealed = new Array(25).fill(true);
        revealed[24] = false;
        const plan = computeBeaconPlan(revealed, 5, 1);

        expect(plan.beacons).toHaveLength(0);
        expect(plan.revealedNew).toBe(0);
    });

    test('the reveal count and covered set exclude the exit', () => {
        // Only the top-right corner (4) is dark besides the exit (24)
        const revealed = new Array(25).fill(true);
        revealed[4] = false;
        revealed[24] = false;
        const plan = computeBeaconPlan(revealed, 5, 1);

        expect(plan.revealedNew).toBe(1);
        expect(plan.covered.has(24)).toBe(false);
        expect(plan.covered.has(4)).toBe(true);
    });
});

/**
 * "Plan for" more beacons than go down now. A player who opens a floor with two
 * beacons and ends up revealing five is locked into a worse five-beacon layout
 * if the two were placed by the best two-beacon plan, because the best two are
 * not the first two of the best five.
 */
describe('planning for more beacons than are placed now', () => {
    const dark = (cols) => {
        const revealed = new Array(cols * cols).fill(false);
        revealed[0] = true;
        return revealed;
    };
    const diamondOf = (c, cols) => {
        const out = [];
        for (let i = 0; i < cols * cols; i++) {
            if (Math.abs((i % cols) - (c % cols)) + Math.abs(Math.floor(i / cols) - Math.floor(c / cols)) <= 2) {
                out.push(i);
            }
        }
        return out;
    };
    /** Lexicographic "a is better than b" on what the prefixes expose */
    const better = (a, b) => {
        if (a.residual !== b.residual) return a.residual < b.residual;
        const ra = Math.min(2, a.routes);
        const rb = Math.min(2, b.routes);
        if (ra !== rb) return ra > rb;
        return a.revealedNew > b.revealedNew;
    };

    test('the best two-beacon plan is not the first two of the best five (the fixture the feature exists for)', () => {
        const revealed = dark(7);
        const two = computeBeaconPlan(revealed, 7, 2);
        const five = computeBeaconPlan(revealed, 7, 5);
        const ordered = orderBeaconsForPrefixes(revealed, 7, five.beacons);

        expect(five.beacons).toHaveLength(5);
        expect(new Set(ordered.beacons.slice(0, 2))).not.toEqual(new Set(two.beacons));
        // Not a subset either: placing the best two locks the floor out of the best five
        expect(two.beacons.every((b) => five.beacons.includes(b))).toBe(false);
    });

    test('orders the plan greedily: each prefix is the best addition among the plan beacons', () => {
        for (const cols of [5, 6, 7]) {
            const revealed = dark(cols);
            const plan = computeBeaconPlan(revealed, cols, 5);
            const { beacons, prefixes } = orderBeaconsForPrefixes(revealed, cols, plan.beacons);

            // Still exactly the plan, and the whole set scores as the plan does
            expect([...beacons].sort((a, b) => a - b)).toEqual([...plan.beacons].sort((a, b) => a - b));
            expect(prefixes).toHaveLength(plan.beacons.length);
            expect(prefixes[prefixes.length - 1].revealedNew).toBe(plan.revealedNew);
            expect(prefixes[prefixes.length - 1].corridorOpen).toBe(plan.corridorOpen);

            for (let j = 0; j < beacons.length; j++) {
                const chosen = prefixes[j];
                for (const alt of beacons.slice(j + 1)) {
                    const trial = orderBeaconsForPrefixes(revealed, cols, [...beacons.slice(0, j), alt], true);
                    expect(better(trial.prefixes[j], chosen)).toBe(false);
                }
            }
        }
    });

    test('the first beacons go toward the way out, one beacon closer each', () => {
        const revealed = dark(7);
        const five = computeBeaconPlan(revealed, 7, 5);
        const { prefixes } = orderBeaconsForPrefixes(revealed, 7, five.beacons);
        expect(prefixes.map((p) => p.residual).slice(0, 3)).toEqual([2, 1, 0]);
    });

    test('keepOrder scores the given order without reordering it', () => {
        const revealed = dark(7);
        const five = computeBeaconPlan(revealed, 7, 5);
        const given = [...five.beacons].reverse();
        expect(orderBeaconsForPrefixes(revealed, 7, given, true).beacons).toEqual(given);
    });

    test('empty input orders nothing', () => {
        expect(orderBeaconsForPrefixes([], 7, [])).toBeNull();
    });

    describe('stageBeaconPlan', () => {
        const stage = (revealed, cols, count, planFor, prior = null) =>
            stageBeaconPlan({
                revealed,
                cols,
                count,
                planFor,
                basePlan: computeBeaconPlan(revealed, cols, count),
                prior,
            });

        test('no plan-for count, or one no bigger than the count, is the ordinary plan', () => {
            const revealed = dark(7);
            expect(stage(revealed, 7, 2, 0)).toBeNull();
            expect(stage(revealed, 7, 2, 2)).toBeNull();
            expect(stage(revealed, 7, 3, 2)).toBeNull();
            expect(stage(revealed, 7, 2, -4)).toBeNull();
            // Automatic mode places the minimum (3 here); planning for 3 is that plan
            expect(stage(revealed, 7, 0, 3)).toBeNull();
        });

        test('two now of five: the five-beacon plan, ordered, with the first two marked now', () => {
            const revealed = dark(7);
            const staged = stage(revealed, 7, 2, 5);
            const five = computeBeaconPlan(revealed, 7, 5);

            expect(staged.nowCount).toBe(2);
            expect(staged.total).toBe(5);
            expect(staged.labels).toEqual(['B1', 'B2', 'B3', 'B4', 'B5']);
            expect(staged.beacons).toEqual(orderBeaconsForPrefixes(revealed, 7, five.beacons).beacons);
            expect(staged.continued).toBe(false);
        });

        test('automatic mode places the shortest prefix that covers the way out', () => {
            const revealed = dark(7);
            const staged = stage(revealed, 7, 0, 5);
            expect(staged.nowCount).toBe(3);
            expect(staged.prefixes[2].corridorOpen).toBe(true);
            expect(staged.prefixes[1].corridorOpen).toBe(false);
        });

        test('automatic mode with the way out already revealed places nothing now and plans the rest for later', () => {
            const revealed = new Array(25).fill(false);
            for (const idx of [0, 1, 2, 3, 4, 9, 14, 19, 24]) revealed[idx] = true;
            const staged = stage(revealed, 5, 0, 2);
            expect(staged.nowCount).toBe(0);
            expect(staged.beacons).toHaveLength(2);
        });

        test('plan-for is clamped to 20', () => {
            const revealed = dark(8);
            const staged = stage(revealed, 8, 2, 99);
            expect(staged.total).toBeLessThanOrEqual(20);
            expect(staged.beacons.length).toBe(computeBeaconPlan(revealed, 8, 20).beacons.length);
        });

        test('after B1 and B2 go down, a re-plan continues the same five-beacon plan', () => {
            const revealed = dark(7);
            const first = stage(revealed, 7, 2, 5);
            const covered = first.prefixes[first.prefixes.length - 1].covered;
            const prior = {
                planFor: 5,
                placedBefore: 0,
                all: first.beacons.map((idx, i) => ({
                    idx,
                    label: first.labels[i],
                    watch: diamondOf(idx, 7).filter((c) => covered.has(c)),
                })),
            };
            const after = revealed.slice();
            for (const b of first.beacons.slice(0, 2)) for (const c of diamondOf(b, 7)) after[c] = true;

            const again = stage(after, 7, 2, 5, prior);
            expect(again.continued).toBe(true);
            expect(again.placedBefore).toBe(2);
            expect(again.total).toBe(5);
            expect(again.labels).toEqual(['B3', 'B4', 'B5']);
            expect(again.beacons).toEqual(first.beacons.slice(2));
            // The count is the floor's: two set and two used leaves none to place now
            expect(again.nowCount).toBe(0);
            // Four set for the floor, two used: the next two go down now
            expect(stage(after, 7, 4, 5, prior).nowCount).toBe(2);

            // A different plan-for count is a fresh plan, not a continuation
            expect(stage(after, 7, 2, 6, prior).continued).toBe(false);
        });

        const priorOf = (staged, planFor, cols) => {
            const covered = staged.prefixes[staged.prefixes.length - 1].covered;
            return {
                planFor,
                placedBefore: staged.placedBefore,
                all: staged.beacons.map((idx, i) => ({
                    idx,
                    label: staged.labels[i],
                    watch: diamondOf(idx, cols).filter((c) => covered.has(c)),
                })),
            };
        };

        test('a plan-for lowered after three are used plans what is left of the new total, labelled on', () => {
            const revealed = dark(7);
            const six = stage(revealed, 7, 0, 6);
            expect(six.labels).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6']);
            const after = revealed.slice();
            for (const b of six.beacons.slice(0, 3)) for (const c of diamondOf(b, 7)) after[c] = true;

            const five = stage(after, 7, 0, 5, priorOf(six, 6, 7));

            // Not the old plan's B4-B6: five in all, three of them already down
            expect(five.continued).toBe(false);
            expect(five.placedBefore).toBe(3);
            expect(five.total).toBeLessThanOrEqual(5);
            expect(five.labels[0]).toBe('B4');
            expect(five.labels).not.toContain('B6');
        });

        test('a re-plan that finds none of a continued plan used keeps the beacons used before it', () => {
            const revealed = dark(7);
            const first = stage(revealed, 7, 2, 5);
            const after = revealed.slice();
            for (const b of first.beacons.slice(0, 2)) for (const c of diamondOf(b, 7)) after[c] = true;
            const continued = stage(after, 7, 2, 5, priorOf(first, 5, 7));
            expect(continued.placedBefore).toBe(2);

            // Nothing more used: still two down, so the floor has three left, not five
            const again = stage(after, 7, 4, 5, priorOf(continued, 5, 7));
            expect(again.placedBefore).toBe(2);
            expect(again.labels[0]).toBe('B3');
            expect(again.total).toBe(5);
        });

        test('a set count takes the used beacons off first, then is held against the bag', () => {
            const revealed = dark(8);
            const first = stage(revealed, 8, 3, 6);
            const after = revealed.slice();
            for (const c of diamondOf(first.beacons[0], 8)) after[c] = true;
            const args = (held) => ({
                revealed: after,
                cols: 8,
                count: 3,
                held,
                planFor: 6,
                basePlan: computeBeaconPlan(after, 8, 3),
                prior: priorOf(first, 6, 8),
            });

            // Three for the floor, one used: two outstanding
            expect(stageBeaconPlan(args(null)).nowCount).toBe(2);
            expect(stageBeaconPlan(args(5)).nowCount).toBe(2);
            // ...of which the bag covers one
            expect(stageBeaconPlan(args(1)).nowCount).toBe(1);
            expect(stageBeaconPlan(args(0)).nowCount).toBe(0);
        });

        test('nothing used yet re-plans fresh', () => {
            const revealed = dark(7);
            const first = stage(revealed, 7, 2, 5);
            const prior = {
                planFor: 5,
                placedBefore: 0,
                all: first.beacons.map((idx, i) => ({ idx, label: first.labels[i], watch: diamondOf(idx, 7) })),
            };
            const again = stage(revealed, 7, 2, 5, prior);
            expect(again.continued).toBe(false);
            expect(again.beacons).toEqual(first.beacons);
        });
    });
});
