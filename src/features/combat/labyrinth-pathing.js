/**
 * Labyrinth Pathing
 *
 * Route and beacon planning over a labyrinth floor, as pure grid maths: the
 * cheapest way from the cleared region to the floor exit, how many
 * independent ways out a floor still has, and where a set of beacons should
 * go. No DOM, no sims, no character state — everything here takes a flat
 * grid and a width and returns a plan.
 */

/**
 * The floor's fixed corners: entrance top-left, exit bottom-right. Position is
 * the reliable structural signal — unrevealed rooms carry no room type, so a
 * fresh floor has nothing else to key off.
 */
export const LABYRINTH_ENTRANCE = 0;
const labyrinthExit = (n) => n - 1;

/** Beacon reveal radius: Manhattan distance 2 — a 13-room diamond */
export const BEACON_RADIUS = 2;

/** Two beacons chain when their diamonds meet: centers within this far apart */
const BEACON_CHAIN_DIST = 2 * BEACON_RADIUS + 1;

/** Re-placement sweeps over a greedy coverage plan before settling */
const BEACON_SWAP_PASSES = 4;

/** Lexicographic weight: one shroud outweighs any number of torches */
const PATH_SHROUD_WEIGHT = 1e6;

/**
 * Compute the cheapest route from the cleared region (or the entrance) to the
 * floor exit over a flat labyrinth grid. Priorities, lexicographic: fewest
 * shrouds (a shroud instantly clears a room, spent on uncleared tiles below
 * the clearable threshold), then most treasure rooms, then fewest torches
 * (uncleared tiles revealed). Treasure rooms are grafted onto the route
 * greedily whenever they can be reached without an extra shroud — a chest is
 * always worth extra torches, never an extra shroud.
 *
 * Pure function so the routing logic is testable without DOM or sims.
 * @param {Array<Object|null>} tiles - Flat grid, null = wall; entries carry
 *   { cleared, isEntrance, needsShroud, isTreasure, isExit }
 * @param {number} cols - Grid width
 * @returns {Object|null} { route: Set<number>, chests: Set<number>, shrouds,
 *   torches, target } or null when there is no start/exit/route
 */
export function computeLabyrinthPath(tiles, cols) {
    const target = tiles.findIndex((t) => t?.isExit && !t.cleared);
    const targetIdx = target >= 0 ? target : tiles.findIndex((t) => t?.isExit);
    if (targetIdx < 0) return null;

    const sources = [];
    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i]?.cleared || tiles[i]?.isEntrance) sources.push(i);
    }
    if (!sources.length) return null;

    const neighbors = (idx) => {
        const x = idx % cols;
        const out = [];
        if (x > 0) out.push(idx - 1);
        if (x < cols - 1) out.push(idx + 1);
        if (idx - cols >= 0) out.push(idx - cols);
        if (idx + cols < tiles.length) out.push(idx + cols);
        return out;
    };

    // Entering a tile costs shrouds*W + 1 torch when uncleared; cleared
    // tiles, the entrance, and tiles already on the route are free. Walls
    // are impassable.
    const enterCost = (idx, routeSet) => {
        const t = tiles[idx];
        if (!t) return null;
        if (t.cleared || t.isEntrance || routeSet.has(idx)) return 0;
        return (t.needsShroud ? PATH_SHROUD_WEIGHT : 0) + 1;
    };

    const dijkstra = (sourceIndices, routeSet) => {
        const dist = new Array(tiles.length).fill(Infinity);
        const prev = new Array(tiles.length).fill(-1);
        const visited = new Array(tiles.length).fill(false);
        for (const s of sourceIndices) dist[s] = 0;
        for (;;) {
            let u = -1;
            let best = Infinity;
            for (let i = 0; i < tiles.length; i++) {
                if (!visited[i] && dist[i] < best) {
                    best = dist[i];
                    u = i;
                }
            }
            if (u < 0) break;
            visited[u] = true;
            for (const v of neighbors(u)) {
                const cost = enterCost(v, routeSet);
                if (cost === null) continue;
                if (dist[u] + cost < dist[v]) {
                    dist[v] = dist[u] + cost;
                    prev[v] = u;
                }
            }
        }
        return { dist, prev };
    };

    const tracePath = (prev, end, stopSet) => {
        const path = [];
        let cur = end;
        while (cur >= 0 && !stopSet.has(cur)) {
            path.push(cur);
            cur = prev[cur];
        }
        return path;
    };

    // Base route: cleared region → floor exit
    const routeSet = new Set();
    const sourceSet = new Set(sources);
    const base = dijkstra(sources, routeSet);
    if (!Number.isFinite(base.dist[targetIdx])) return null;
    for (const idx of tracePath(base.prev, targetIdx, sourceSet)) routeSet.add(idx);

    // Graft on every treasure room reachable without an extra shroud,
    // cheapest branch (fewest torches) first
    const chests = new Set();
    for (const idx of routeSet) {
        if (tiles[idx]?.isTreasure) chests.add(idx);
    }
    let pool = [];
    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i]?.isTreasure && !tiles[i].cleared && !routeSet.has(i)) pool.push(i);
    }
    while (pool.length) {
        const run = dijkstra([...sourceSet, ...routeSet], routeSet);
        let bestChest = -1;
        let bestCost = Infinity;
        for (const idx of pool) {
            if (run.dist[idx] < bestCost) {
                bestCost = run.dist[idx];
                bestChest = idx;
            }
        }
        if (bestChest < 0 || bestCost >= PATH_SHROUD_WEIGHT) break;
        const stopSet = new Set([...sourceSet, ...routeSet]);
        for (const idx of tracePath(run.prev, bestChest, stopSet)) routeSet.add(idx);
        chests.add(bestChest);
        pool = pool.filter((idx) => !routeSet.has(idx));
    }

    let shrouds = 0;
    let torches = 0;
    for (const idx of routeSet) {
        const t = tiles[idx];
        if (!t || t.cleared || t.isEntrance) continue;
        torches++;
        if (t.needsShroud) shrouds++;
    }

    return { route: routeSet, chests, shrouds, torches, target: targetIdx };
}

/**
 * Count vertex-disjoint entrance→exit routes through passable cells — the
 * number of independent paths that share no interior room (max-flow with
 * unit vertex capacities; entrance and exit are uncapped endpoints). Two or
 * more routes means no single blocked room can sever the way to the exit.
 * @param {boolean[]} passable - Flat grid of walkable cells (entrance/exit
 *   are treated as walkable regardless)
 * @param {number} cols - Grid width
 * @param {number} [exitIdx] - Floor exit; defaults to the top-right corner
 * @returns {number} Disjoint route count (capped at 4)
 */
export function countDisjointRoutes(passable, cols, exitIdx = labyrinthExit(passable.length)) {
    const n = passable.length;
    if (!n || !cols) return 0;
    const walkable = (i) => i === LABYRINTH_ENTRANCE || i === exitIdx || !!passable[i];
    const neighbors = (i) => {
        const out = [];
        if (i % cols > 0) out.push(i - 1);
        if (i % cols < cols - 1) out.push(i + 1);
        if (i - cols >= 0) out.push(i - cols);
        if (i + cols < n) out.push(i + cols);
        return out;
    };

    // Node splitting: cell i → in-node 2i, out-node 2i+1, capacity 1 through
    // interior cells so routes can't share a room
    const cap = new Map();
    const addEdge = (a, b, c) => {
        if (!cap.has(a)) cap.set(a, new Map());
        if (!cap.has(b)) cap.set(b, new Map());
        cap.get(a).set(b, (cap.get(a).get(b) || 0) + c);
        if (!cap.get(b).has(a)) cap.get(b).set(a, 0);
    };
    for (let i = 0; i < n; i++) {
        if (!walkable(i)) continue;
        addEdge(2 * i, 2 * i + 1, i === LABYRINTH_ENTRANCE || i === exitIdx ? 99 : 1);
        for (const nb of neighbors(i)) {
            if (walkable(nb)) addEdge(2 * i + 1, 2 * nb, 99);
        }
    }

    const source = 2 * LABYRINTH_ENTRANCE + 1; // entrance out-node
    const sink = 2 * exitIdx; // exit in-node
    let flow = 0;
    while (flow < 4) {
        const prev = new Map([[source, null]]);
        const queue = [source];
        let found = false;
        while (queue.length && !found) {
            const u = queue.shift();
            for (const [v, residual] of cap.get(u) || []) {
                if (residual > 0 && !prev.has(v)) {
                    prev.set(v, u);
                    if (v === sink) {
                        found = true;
                        break;
                    }
                    queue.push(v);
                }
            }
        }
        if (!found) break;
        let v = sink;
        while (prev.get(v) !== null) {
            const u = prev.get(v);
            cap.get(u).set(v, cap.get(u).get(v) - 1);
            cap.get(v).set(u, (cap.get(v).get(u) || 0) + 1);
            v = u;
        }
        flow++;
    }
    return flow;
}

/**
 * Whether the server has told us anything about a room's contents. The same
 * test the path planner's `isUnknown` uses inverted, so both features agree on
 * which rooms a beacon would still be revealing.
 * @param {Object|null} room - roomData entry
 * @returns {boolean}
 */
export function isRoomRevealed(room) {
    if (!room) return false;
    return !!(String(room.roomType || '') !== '' || room.skillHrid || room.monsterHrid || room.isCleared);
}

/**
 * Grid helpers shared by the two beacon planners: neighbour walks, reveal
 * diamonds, and flood fills.
 * @param {number} n - Cell count
 * @param {number} cols - Grid width
 * @returns {Object} { manhattan, neighbors, diamond, regionFrom }
 */
function beaconGrid(n, cols) {
    const x = (i) => i % cols;
    const y = (i) => Math.floor(i / cols);
    const manhattan = (a, b) => Math.abs(x(a) - x(b)) + Math.abs(y(a) - y(b));

    const neighbors = (i) => {
        const out = [];
        if (x(i) > 0) out.push(i - 1);
        if (x(i) < cols - 1) out.push(i + 1);
        if (i - cols >= 0) out.push(i - cols);
        if (i + cols < n) out.push(i + cols);
        return out;
    };

    const diamondCache = new Map();
    const diamond = (c) => {
        let cells = diamondCache.get(c);
        if (!cells) {
            cells = [];
            for (let i = 0; i < n; i++) {
                if (manhattan(c, i) <= BEACON_RADIUS) cells.push(i);
            }
            diamondCache.set(c, cells);
        }
        return cells;
    };

    /** Flood fill from start through cells the predicate accepts; start is always in. */
    const regionFrom = (start, isOpen) => {
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length) {
            const cur = queue.shift();
            for (const nb of neighbors(cur)) {
                if (!seen.has(nb) && isOpen(nb)) {
                    seen.add(nb);
                    queue.push(nb);
                }
            }
        }
        return seen;
    };

    return { manhattan, neighbors, diamond, regionFrom };
}

/**
 * Fewest beacons whose reveal diamonds chain the entrance region to the exit
 * region, and the reachability data the chain search needs.
 * @param {Object} grid - beaconGrid helpers
 * @param {number} n - Cell count
 * @param {Set<number>} startRegion - Revealed region holding the entrance
 * @param {Set<number>} endRegion - Revealed region holding the exit
 * @returns {Object} { startOK, distToEnd, minNeeded } — minNeeded is Infinity
 *   when no chain reaches the exit
 */
function beaconChainReach(grid, n, startRegion, endRegion) {
    const { manhattan, neighbors, diamond } = grid;

    // A beacon "touches" a region when its reveal area contains a cell in the
    // region or adjacent to it — a path can step between them
    const touchesRegion = (c, region) => {
        for (const d of diamond(c)) {
            if (region.has(d)) return true;
            for (const nb of neighbors(d)) {
                if (region.has(nb)) return true;
            }
        }
        return false;
    };
    const startOK = [];
    const endOK = [];
    for (let c = 0; c < n; c++) {
        startOK[c] = touchesRegion(c, startRegion);
        endOK[c] = touchesRegion(c, endRegion);
    }

    // Two beacons chain when their diamonds intersect or touch (centers within
    // Manhattan distance 5). distToEnd[c] = beacons still needed after c.
    const distToEnd = new Array(n).fill(Infinity);
    let frontier = [];
    for (let c = 0; c < n; c++) {
        if (endOK[c]) {
            distToEnd[c] = 0;
            frontier.push(c);
        }
    }
    while (frontier.length) {
        const next = [];
        for (const c of frontier) {
            for (let other = 0; other < n; other++) {
                if (distToEnd[other] === Infinity && manhattan(c, other) <= BEACON_CHAIN_DIST) {
                    distToEnd[other] = distToEnd[c] + 1;
                    next.push(other);
                }
            }
        }
        frontier = next;
    }

    let minNeeded = Infinity;
    for (let c = 0; c < n; c++) {
        if (startOK[c] && Number.isFinite(distToEnd[c])) {
            minNeeded = Math.min(minNeeded, distToEnd[c] + 1);
        }
    }
    return { startOK, distToEnd, minNeeded };
}

/**
 * How far out of the way each room sits, in rooms: 0 for one directly between
 * the region you have already opened and the floor exit, rising with the
 * detour needed to visit it. Straight Manhattan distances, because the
 * labyrinth has no walls — every cell is a room, so nothing blocks a detour.
 *
 * This only breaks ties between placements that reveal the same number of
 * rooms, never outweighing coverage. Scoring rooms by it directly was tried
 * and dropped: it bought a tidier line of beacons by leaving whole corners of
 * the floor dark, and a revealed room is worth having wherever it sits.
 *
 * @param {Object} grid - beaconGrid helpers
 * @param {number} n - Cell count
 * @param {Set<number>} startRegion - Revealed region holding the entrance
 * @param {number} exitIdx - Floor exit
 * @returns {number[]} Detour in rooms, per cell
 */
function detourCosts(grid, n, startRegion, exitIdx) {
    const { manhattan } = grid;
    const fromStart = new Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) {
        for (const s of startRegion) fromStart[i] = Math.min(fromStart[i], manhattan(i, s));
    }
    const shortest = fromStart[exitIdx];
    return fromStart.map((d, i) => d + manhattan(i, exitIdx) - shortest);
}

/**
 * Place exactly `count` beacons to reveal as much of the floor as possible,
 * settling ties toward rooms on the way out. Greedy by marginal gain, then a
 * re-placement pass per beacon: greedy alone takes the densest spot first even
 * when two beacons placed together would tile the dark region better.
 *
 * @param {Object} grid - beaconGrid helpers
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} count - Beacons to place
 * @param {number[]} detour - Per-cell detour cost, the tie-break
 * @returns {number[]} Beacon centers
 */
function placeBeaconsForCoverage(grid, revealed, count, detour) {
    const { diamond } = grid;
    const n = revealed.length;

    // Rooms revealed first, total detour second — a placement that uncovers
    // more of the floor always wins, however far off the route it sits
    const gainOf = (c, union) => {
        let rooms = 0;
        let cost = 0;
        for (const d of diamond(c)) {
            if (revealed[d] || union.has(d)) continue;
            rooms++;
            cost += detour[d];
        }
        return { rooms, cost };
    };
    const better = (a, b) => a.rooms > b.rooms || (a.rooms === b.rooms && a.cost < b.cost);
    const coverageOf = (centers) => {
        const union = new Set();
        for (const c of centers) {
            for (const d of diamond(c)) {
                if (!revealed[d]) union.add(d);
            }
        }
        return union;
    };
    const bestCenterAgainst = (union, taken, incumbent) => {
        let center = incumbent;
        let best = incumbent >= 0 ? gainOf(incumbent, union) : { rooms: 0, cost: Infinity };
        for (let c = 0; c < n; c++) {
            if (c === incumbent || taken.has(c)) continue;
            const gain = gainOf(c, union);
            if (better(gain, best)) {
                best = gain;
                center = c;
            }
        }
        return best.rooms > 0 ? center : -1;
    };

    const beacons = [];
    while (beacons.length < count) {
        const chosen = bestCenterAgainst(coverageOf(beacons), new Set(beacons), -1);
        if (chosen < 0) break; // nothing left worth revealing
        beacons.push(chosen);
    }

    for (let pass = 0; pass < BEACON_SWAP_PASSES; pass++) {
        let moved = false;
        for (let slot = 0; slot < beacons.length; slot++) {
            const others = beacons.filter((_, i) => i !== slot);
            const chosen = bestCenterAgainst(coverageOf(others), new Set(others), beacons[slot]);
            if (chosen >= 0 && chosen !== beacons[slot]) {
                beacons[slot] = chosen;
                moved = true;
            }
        }
        if (!moved) break;
    }

    return beacons;
}

/**
 * Plan beacon placements on a labyrinth floor. Beacons reveal a 13-room
 * diamond (Manhattan radius 2), and the two questions worth asking of them get
 * different answers:
 *
 * - **A set count** (`beaconCount > 0`): place that many to reveal as much of
 *   the floor as possible, biased toward rooms on the way to the exit. The
 *   answer is always a plan — the count is what you have, not a target to be
 *   declared infeasible.
 * - **No count** (`beaconCount === 0`): the fewest beacons whose reveal areas
 *   chain into a fully revealed corridor from the entrance to the exit,
 *   maximizing new rooms among the minimal chains (beam search).
 *
 * The corridor is a convenience, not a requirement: unrevealed rooms are
 * walkable, so a floor can always be crossed without beacons. That is why it
 * only constrains the mode that asks for it — making it a hard constraint on a
 * set count drags every beacon onto the entrance-to-exit line.
 *
 * Pure function so the planning logic is testable without DOM.
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} cols - Grid width
 * @param {number} [beaconCount=0] - Beacons to place; 0 = minimum for a corridor
 * @returns {Object|null} { feasible, beacons: [index...], covered: Set<number>,
 *   revealedNew, minNeeded, routes, corridorOpen } or null on empty input
 */
export function computeBeaconPlan(revealed, cols, beaconCount = 0) {
    const n = revealed.length;
    if (!n || !cols) return null;
    const entranceIdx = LABYRINTH_ENTRANCE;
    const exitIdx = labyrinthExit(n);
    const grid = beaconGrid(n, cols);
    const { manhattan, neighbors, diamond, regionFrom } = grid;

    // Revealed regions walkable from the entrance and from the exit
    const isRevealed = (i) => revealed[i];
    const startRegion = regionFrom(entranceIdx, isRevealed);
    const endRegion = regionFrom(exitIdx, isRevealed);

    const touches = (region, open) => {
        for (const i of regionFrom(entranceIdx, open)) {
            if (region.has(i) || neighbors(i).some((nb) => region.has(nb))) return true;
        }
        return false;
    };
    const connected = touches(endRegion, isRevealed);

    const passableWith = (union) => {
        const passable = new Array(n);
        for (let i = 0; i < n; i++) passable[i] = revealed[i] || union.has(i);
        return passable;
    };
    const { startOK, distToEnd, minNeeded } = connected
        ? { startOK: [], distToEnd: [], minNeeded: 0 }
        : beaconChainReach(grid, n, startRegion, endRegion);

    // A set count answers "where do I put the beacons I have", so it is planned
    // for coverage whether or not the way out is already open
    if (beaconCount > 0) {
        const detour = detourCosts(grid, n, startRegion, exitIdx);
        const beacons = placeBeaconsForCoverage(grid, revealed, beaconCount, detour);
        const covered = new Set();
        for (const c of beacons) {
            for (const d of diamond(c)) {
                if (!revealed[d]) covered.add(d);
            }
        }
        return {
            feasible: true,
            beacons,
            covered,
            revealedNew: covered.size,
            minNeeded,
            routes: countDisjointRoutes(passableWith(covered), cols),
            corridorOpen: connected || touches(endRegion, (i) => revealed[i] || covered.has(i)),
        };
    }

    if (connected) {
        return {
            feasible: true,
            beacons: [],
            covered: new Set(),
            revealedNew: 0,
            minNeeded: 0,
            routes: countDisjointRoutes(revealed, cols),
            corridorOpen: true,
        };
    }
    if (!Number.isFinite(minNeeded)) {
        return {
            feasible: false,
            beacons: [],
            covered: new Set(),
            revealedNew: 0,
            minNeeded: Infinity,
            routes: 0,
            corridorOpen: false,
        };
    }

    // Beam search over minimum-length chains, maximizing newly revealed rooms
    const newCells = (c, union) => diamond(c).filter((d) => !revealed[d] && !union.has(d));
    const BEAM_WIDTH = 300;
    let states = [];
    for (let c = 0; c < n; c++) {
        if (!startOK[c] || distToEnd[c] > minNeeded - 1) continue;
        states.push({ chain: [c], union: new Set(newCells(c, new Set())) });
    }
    for (let depth = 1; depth < minNeeded; depth++) {
        const expanded = [];
        for (const state of states) {
            const last = state.chain[state.chain.length - 1];
            for (let c = 0; c < n; c++) {
                if (manhattan(c, last) > BEACON_CHAIN_DIST) continue;
                if (state.chain.includes(c)) continue;
                if (distToEnd[c] > minNeeded - depth - 1) continue;
                const union = new Set(state.union);
                for (const gained of newCells(c, state.union)) union.add(gained);
                expanded.push({ chain: [...state.chain, c], union });
            }
        }
        expanded.sort((a, b) => b.union.size - a.union.size);
        states = expanded.slice(0, BEAM_WIDTH);
    }
    states = states.filter((s) => distToEnd[s.chain[s.chain.length - 1]] === 0);
    if (!states.length) {
        return {
            feasible: false,
            beacons: [],
            covered: new Set(),
            revealedNew: 0,
            minNeeded,
            routes: 0,
            corridorOpen: false,
        };
    }

    // Coverage decides between equal-length chains; route redundancy only
    // breaks the ties it leaves. Redundancy counts unrevealed rooms as blocked,
    // which they are not, so it is worth reporting but not worth paying rooms for.
    states.sort((a, b) => b.union.size - a.union.size);
    const finalists = states
        .slice(0, 40)
        .map((s) => ({ ...s, routes: Math.min(2, countDisjointRoutes(passableWith(s.union), cols)) }));
    finalists.sort((a, b) => b.union.size - a.union.size || b.routes - a.routes);
    const best = finalists[0];

    return {
        feasible: true,
        beacons: [...best.chain],
        covered: new Set(best.union),
        revealedNew: best.union.size,
        minNeeded,
        routes: best.routes,
        corridorOpen: true,
    };
}
