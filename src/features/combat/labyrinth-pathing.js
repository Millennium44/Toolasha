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

/**
 * A second independent covered route is worth trading rooms for; a third is
 * not — one blocked room can only sever a floor that has a single way out.
 */
const BEACON_ROUTE_TARGET = 2;

/** Stand-in for "no chain of beacons reaches the exit" in the residual ordering */
const RESIDUAL_UNREACHABLE = 999;

/** Minimum-length chains carried out of the beam search as placement seeds */
const CHAIN_CANDIDATES = 40;

/** How many scored seeds get the full re-placement search */
const REFINE_SEEDS = 4;

/** Above this many beacons the search is trimmed rather than left to grow */
const BEACON_SEARCH_WIDE_LIMIT = 6;

/** Lexicographic weight: one shroud outweighs any number of torches */
const PATH_SHROUD_WEIGHT = 1e6;

/**
 * Compute the route from the cleared region (or the entrance) to the floor exit
 * over a flat labyrinth grid. Priorities, lexicographic: fewest shrouds (a
 * shroud instantly clears a room, spent on uncleared tiles below the clearable
 * threshold), then the most unknown rooms uncovered, then fewest torches
 * (uncleared tiles walked). Revealing more of the floor ranks above torches, so
 * the plan will step aside to uncover more rooms — but only a step that pays for
 * itself (see the detour economy below), and never an extra shroud. Treasure
 * rooms are then grafted on greedily whenever they can be
 * reached without an extra shroud — a chest is always worth extra torches,
 * never an extra shroud.
 *
 * The reveal objective sits above the shortest-path cost, not inside it: a
 * single Dijkstra cost cannot rank reveals above torches without negative edges
 * (a room can uncover several unknowns at once). So the base min-shroud route is
 * compared against routes that detour through one revealing room, and the one
 * uncovering the most *unique* unknown rooms (then fewest torches) wins — one
 * detour at a time, so it opens up the floor without carpet-revealing. A
 * sub-torch reveal bonus still breaks ties inside each Dijkstra sub-path.
 *
 * A reveal detour has to earn its rooms. One that costs nothing — an
 * equal-length route that uncovers more — is always taken; one that costs
 * torches is taken only when some possible content behind the rooms it would
 * uncover could make the whole route cheaper than the route already planned.
 * That is decided by re-routing with those rooms priced at the best they could
 * possibly turn out to be, which lower-bounds what the detour could ever buy:
 * if even the best case cannot beat the base route, the reveal is provably
 * useless and the plan walks past it instead of stepping aside for it.
 *
 * The economy prices route COST — shrouds, then torches — and nothing else. It
 * therefore prunes a detour whose only possible payoff is a chest behind the
 * rooms it would uncover, and in the optimistic posture (nothing hidden costed
 * as a shroud) a reveal cannot make a route cheaper at all, so every
 * torch-costing reveal detour is pruned there. That is the intended trade: on a
 * 23-room floor, stepping aside on the chance of a chest is several rooms spent
 * to learn nothing, and the chest graft below still collects every treasure the
 * floor has actually shown.
 *
 * Pure function so the routing logic is testable without DOM or sims.
 * @param {Array<Object|null>} tiles - Flat grid, null = wall; entries carry
 *   { cleared, isEntrance, needsShroud, isTreasure, isExit, isUnknown }
 * @param {number} cols - Grid width
 * @returns {Object|null} { route: Set<number>, chests: Set<number>,
 *   chestBranch: Set<number> (rooms entered only to reach a chest), shrouds,
 *   torches, target } or null when there is no start/exit/route
 */
export function computeLabyrinthPath(tiles, cols) {
    const target = tiles.findIndex((t) => t?.isExit && !t.cleared);
    const targetIdx = target >= 0 ? target : tiles.findIndex((t) => t?.isExit);
    if (targetIdx < 0) return null;

    const neighbors = (idx) => {
        const x = idx % cols;
        const out = [];
        if (x > 0) out.push(idx - 1);
        if (x < cols - 1) out.push(idx + 1);
        if (idx - cols >= 0) out.push(idx - cols);
        if (idx + cols < tiles.length) out.push(idx + cols);
        return out;
    };

    // Sources are the cleared ground you can actually stand on right now: the
    // region flood-connected to the entrance over cleared tiles. A cleared tile
    // cut off from the entrance by uncleared rooms — a tile shrouded deep in the
    // floor, most often — is NOT a free starting point. You can only reach it by
    // paying for the rooms between it and where you already are; treating every
    // cleared tile as a free source let the exit route "teleport" onto an
    // isolated shroud and skip the rooms needed to get there. Such a tile is
    // still free to *traverse* once reached (enterCost stays 0 for any cleared
    // tile); it just cannot seed the search.
    //
    // The flood roots at the entrance (index 0 always carries the flag in a real
    // grid); a grid with no entrance at all roots at its cleared tiles instead,
    // so the region is still whatever ground connects to a legitimate origin.
    const isFreeGround = (idx) => tiles[idx] && (tiles[idx].cleared || tiles[idx].isEntrance);
    const roots = [];
    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i]?.isEntrance) roots.push(i);
    }
    if (!roots.length) {
        for (let i = 0; i < tiles.length; i++) {
            if (tiles[i]?.cleared) roots.push(i);
        }
    }
    const sources = [];
    const seenSource = new Array(tiles.length).fill(false);
    for (const root of roots) {
        if (seenSource[root]) continue;
        seenSource[root] = true;
        const queue = [root];
        while (queue.length) {
            const cur = queue.shift();
            sources.push(cur);
            for (const nb of neighbors(cur)) {
                if (!seenSource[nb] && isFreeGround(nb)) {
                    seenSource[nb] = true;
                    queue.push(nb);
                }
            }
        }
    }
    if (!sources.length) return null;

    // Reveal tie-break: among routes tying on shrouds and torches, prefer the
    // one that uncovers the most unknown rooms rather than Dijkstra's arbitrary
    // wall-hugging pick. Entering a room reveals the unknown rooms next to it
    // (and the room itself when it is the unknown one), so each earns a bonus
    // scaled below a single torch: the most a whole route can earn is
    // (5 tiles) × epsilon < 1, so the bonus never overturns a torch or shroud
    // and only decides between otherwise-equal routes. The per-tile sum can
    // count an unknown adjacent to two route tiles more than once — harmless
    // for a tie-break.
    const revealEpsilon = 1 / (5 * tiles.length + 1);
    const revealScore = (idx) => {
        let score = tiles[idx]?.isUnknown ? 1 : 0;
        for (const nb of neighbors(idx)) {
            if (tiles[nb]?.isUnknown) score++;
        }
        return score;
    };

    // Entering a tile costs shrouds*W + 1 torch when uncleared, less the reveal
    // tie-break bonus; cleared tiles, the entrance, and tiles already on the
    // route are free. Walls are impassable.
    //
    // `bestCase` is the set of still-hidden rooms to price at the best they
    // could possibly turn out to be: one torch, never a shroud. A reveal can
    // only ever tell you a room is cheaper than the pessimistic posture assumed
    // — it cannot make a room free (only walking it clears it) and cannot take
    // a room off the grid — so that is a true lower bound on what a reveal can
    // buy, which is what makes the detour economy below provable rather than a
    // guess.
    const enterCost = (idx, routeSet, bestCase) => {
        const t = tiles[idx];
        if (!t) return null;
        if (t.cleared || t.isEntrance || routeSet.has(idx)) return 0;
        const shroud = t.needsShroud && !bestCase?.has(idx);
        return (shroud ? PATH_SHROUD_WEIGHT : 0) + 1 - revealEpsilon * revealScore(idx);
    };

    const dijkstra = (sourceIndices, routeSet, bestCase) => {
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
                const cost = enterCost(v, routeSet, bestCase);
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

    // Reveal-value candidate selection. A shortest-path cost cannot itself rank
    // "reveal more rooms" above torches without going negative (a room can
    // uncover several unknowns, which would make an edge cheaper than free), so
    // the reveal objective lives one level up: keep the min-shroud base route,
    // then compare it against routes that detour through one revealing room and
    // take whichever uncovers the most *unique* unknown rooms, then the fewest
    // torches. One detour at a time bounds it — the plan will step aside to
    // reveal more of the floor, but never carpet-reveals, and a step that costs
    // torches has to clear the detour economy below. Reveals rank above torches,
    // never a shroud.
    const routeTiles = (set) => [...set].filter((i) => tiles[i] && !tiles[i].cleared && !tiles[i].isEntrance);
    const shroudsOf = (set, bestCase) =>
        routeTiles(set).filter((i) => tiles[i].needsShroud && !bestCase?.has(i)).length;
    const torchesOf = (set) => routeTiles(set).length;
    // Distinct unknown rooms a route uncovers: each route room, and its unknown
    // neighbours, counted once via a set (no double-count of a shared corner).
    const uniqueReveals = (set) => {
        const seen = new Set();
        for (const idx of routeTiles(set)) {
            if (tiles[idx].isUnknown) seen.add(idx);
            for (const nb of neighbors(idx)) if (tiles[nb]?.isUnknown) seen.add(nb);
        }
        return seen.size;
    };
    // Cheapest route from the cleared region to the exit that passes through one
    // room, or null if that room or the exit beyond it is unreachable.
    const routeThrough = (waypoint, bestCase) => {
        const toWp = dijkstra(sources, new Set(), bestCase);
        if (!Number.isFinite(toWp.dist[waypoint])) return null;
        const set = new Set(tracePath(toWp.prev, waypoint, sourceSet));
        const stop = new Set([...sourceSet, ...set]);
        const toExit = dijkstra([...sources, ...set], set, bestCase);
        if (!Number.isFinite(toExit.dist[targetIdx])) return null;
        for (const idx of tracePath(toExit.prev, targetIdx, stop)) set.add(idx);
        return set;
    };

    const minShrouds = shroudsOf(routeSet);
    const baseTorches = torchesOf(routeSet);

    // Rooms a step into `r` would uncover: `r` itself when it is the hidden one,
    // and its hidden neighbours.
    const hiddenAt = (r) => {
        const hidden = new Set();
        if (tiles[r]?.isUnknown) hidden.add(r);
        for (const nb of neighbors(r)) {
            if (tiles[nb]?.isUnknown) hidden.add(nb);
        }
        return hidden;
    };

    // Detour economy. A reveal that costs nothing — a route of the same length
    // that happens to uncover more — is always worth taking. A reveal that costs
    // torches has to be able to pay for itself: only if some possible content
    // behind those rooms could make the whole route cheaper than the best route
    // already known is the detour worth a step. Pricing the rooms `r` would
    // uncover at their best possible outcome (see `enterCost`) and re-routing
    // through `r` gives a lower bound on what the detour could ever cost; when
    // even that cannot beat the base route, no reveal there can, and the detour
    // is provably useless rather than merely unpromising.
    //
    // A grid carrying walls is the one case that cannot be bounded: a wall is
    // indistinguishable from a room the caller chose to treat as impassable, so
    // there is no telling what a reveal would open up. Keep the old
    // reveal-everything behaviour there rather than guessing. (Real labyrinth
    // floors have no walls — every cell is a room — so this is the "avoid
    // unrevealed rooms" posture, where nothing is flagged unknown anyway.)
    const unboundable = tiles.some((t) => !t);
    const couldShorten = (r) => {
        if (unboundable) return true;
        const hidden = hiddenAt(r);
        if (!hidden.size) return false;
        const optimistic = routeThrough(r, hidden);
        if (!optimistic) return false;
        const shrouds = shroudsOf(optimistic, hidden);
        if (shrouds !== minShrouds) return shrouds < minShrouds;
        return torchesOf(optimistic) < baseTorches;
    };

    let bestReveals = uniqueReveals(routeSet);
    let bestTorches = baseTorches;
    for (let r = 0; r < tiles.length; r++) {
        const t = tiles[r];
        if (!t || t.cleared || t.isEntrance || sourceSet.has(r)) continue;
        // Only rooms that would actually uncover something are worth a detour.
        if (!t.isUnknown && !neighbors(r).some((nb) => tiles[nb]?.isUnknown)) continue;
        const cand = routeThrough(r);
        if (!cand || shroudsOf(cand) !== minShrouds) continue; // never an extra shroud
        const reveals = uniqueReveals(cand);
        const torches = torchesOf(cand);
        if (torches > baseTorches && !couldShorten(r)) continue; // a reveal that can never pay
        if (reveals > bestReveals || (reveals === bestReveals && torches < bestTorches)) {
            bestReveals = reveals;
            bestTorches = torches;
            routeSet.clear();
            for (const idx of cand) routeSet.add(idx);
        }
    }

    // Everything routed so far is on the way to the exit; the treasure branches
    // grafted on next are detours you take for loot, not to get out. Snapshot the
    // exit route here so the two can be told apart when the plan is drawn.
    const exitRoute = new Set(routeSet);

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

    // Rooms the plan enters only to reach a chest — on the route but not on the
    // way out, and not a treasure tile themselves. The drawing colours these
    // apart from the exit-critical rooms so an optional loot detour reads as one.
    const chestBranch = new Set();
    for (const idx of routeSet) {
        if (!exitRoute.has(idx) && !tiles[idx]?.isTreasure) chestBranch.add(idx);
    }

    return { route: routeSet, chests, chestBranch, shrouds, torches, target: targetIdx };
}

/**
 * The walk from where you are standing to where the plan starts.
 *
 * A route only ever names the rooms that cost something — the ones still to be
 * fought, shrouded or looted. Once the first few rooms of a floor have been
 * cleared, that means the plan starts somewhere out at the frontier, with the
 * cleared rooms leading up to it drawn as nothing at all, and no way to read
 * off the map which way round to walk. This is those rooms: the shortest walk
 * over already-cleared ground from where you are to the first planned room.
 *
 * Free, by construction — every room on it has been cleared already — so it is
 * never part of the route's torch or shroud bill.
 *
 * @param {Array<Object|null>} tiles - Flat grid, as `computeLabyrinthPath` takes
 * @param {number} cols - Grid width
 * @param {Set<number>|Iterable<number>} route - The planned rooms
 * @param {number} [startIdx] - Where you are standing; the entrance by default
 * @returns {number[]} Rooms to walk through in order, excluding where you are
 *   standing and excluding the planned rooms themselves. Empty when the plan
 *   already starts next to you, and when no cleared ground connects the two.
 */
export function computeApproachPath(tiles, cols, route, startIdx = LABYRINTH_ENTRANCE) {
    const planned = route instanceof Set ? route : new Set(route || []);
    const n = Array.isArray(tiles) ? tiles.length : 0;
    if (!planned.size || !n || !cols) return [];
    if (!Number.isInteger(startIdx) || startIdx < 0 || startIdx >= n) return [];

    const neighbors = (idx) => {
        const x = idx % cols;
        const out = [];
        if (x > 0) out.push(idx - 1);
        if (x < cols - 1) out.push(idx + 1);
        if (idx - cols >= 0) out.push(idx - cols);
        if (idx + cols < n) out.push(idx + cols);
        return out;
    };

    // Standing in the plan, or next to it, is no walk at all
    const touchesPlan = (idx) => planned.has(idx) || neighbors(idx).some((nb) => planned.has(nb));
    if (touchesPlan(startIdx)) return [];

    // Only cleared ground counts: an uncleared room between here and the plan
    // is a room the plan should have costed, not one to be walked through
    const walkable = (idx) => {
        const tile = tiles[idx];
        return !!tile && !planned.has(idx) && (tile.cleared || tile.isEntrance);
    };

    const prev = new Array(n).fill(-1);
    const seen = new Array(n).fill(false);
    seen[startIdx] = true;
    const queue = [startIdx];
    while (queue.length) {
        const cur = queue.shift();
        for (const nb of neighbors(cur)) {
            if (seen[nb] || !walkable(nb)) continue;
            seen[nb] = true;
            prev[nb] = cur;
            if (touchesPlan(nb)) {
                const walk = [];
                for (let at = nb; at >= 0 && at !== startIdx; at = prev[at]) walk.push(at);
                return walk.reverse();
            }
            queue.push(nb);
        }
    }
    return [];
}

/**
 * Count vertex-disjoint entrance→exit routes through passable cells — the
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
 * Grow a placement to `count` beacons by marginal rooms revealed, settling ties
 * toward rooms on the way out. A seed, not an answer: it knows nothing about
 * the way to the exit, and stops early rather than placing a beacon over rooms
 * another beacon already reveals.
 *
 * @param {Object} grid - beaconGrid helpers
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} count - Beacons the placement should end up with
 * @param {number[]} detour - Per-cell detour cost, the tie-break
 * @param {number[]} [preset=[]] - Beacons already placed, kept as they are
 * @returns {number[]} Beacon centers
 */
function growForCoverage(grid, revealed, count, detour, preset = []) {
    const { diamond } = grid;
    const n = revealed.length;

    const beacons = preset.slice(0, count);
    const taken = new Set(beacons);
    const union = new Set();
    for (const c of beacons) {
        for (const d of diamond(c)) {
            if (!revealed[d]) union.add(d);
        }
    }

    while (beacons.length < count) {
        let center = -1;
        let bestRooms = 0;
        let bestCost = Infinity;
        for (let c = 0; c < n; c++) {
            if (taken.has(c)) continue;
            let rooms = 0;
            let cost = 0;
            for (const d of diamond(c)) {
                if (revealed[d] || union.has(d)) continue;
                rooms++;
                cost += detour[d];
            }
            if (rooms > bestRooms || (rooms > 0 && rooms === bestRooms && cost < bestCost)) {
                bestRooms = rooms;
                bestCost = cost;
                center = c;
            }
        }
        if (center < 0) break; // nothing left worth revealing
        beacons.push(center);
        taken.add(center);
        for (const d of diamond(center)) {
            if (!revealed[d]) union.add(d);
        }
    }

    return beacons;
}

/**
 * Rank beacon placements the way the floor is actually played, in this order:
 *
 * 1. **A covered path to the exit**, scored as the beacons a placement still
 *    leaves to be found — 0 means the way out is covered. When the budget can
 *    reach 0, everything that does not is simply inadmissible; only a budget
 *    too small to ever get there needs to know how much closer it got.
 * 2. **A second independent covered route**, so no single blocked room can
 *    sever the way out.
 * 3. **Rooms revealed**, then how far off the way out those rooms sit.
 *
 * Route counting treats unrevealed rooms as blocked (they are not — they are
 * walkable, just unknown), so it is capped at two rather than chased.
 *
 * @param {Object} grid - beaconGrid helpers
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} cols - Grid width
 * @param {number[]} detour - Per-cell detour cost
 * @param {boolean} gradient - Whether "how much closer" has to be measured
 * @returns {Object} { score, compare, routesOf }
 */
function createPlacementScorer(grid, revealed, cols, detour, gradient) {
    const n = revealed.length;
    const exitIdx = labyrinthExit(n);
    const { neighbors, diamond, regionFrom } = grid;

    /** Beacons still needed after this placement; 0 = the way out is covered */
    const residualOf = (union) => {
        const isOpen = (i) => revealed[i] || union.has(i);
        const startRegion = regionFrom(LABYRINTH_ENTRANCE, isOpen);
        const endRegion = regionFrom(exitIdx, isOpen);
        for (const i of startRegion) {
            if (endRegion.has(i) || neighbors(i).some((nb) => endRegion.has(nb))) return 0;
        }
        if (!gradient) return 1;
        const { minNeeded } = beaconChainReach(grid, n, startRegion, endRegion);
        return Number.isFinite(minNeeded) ? minNeeded : RESIDUAL_UNREACHABLE;
    };

    const score = (centers) => {
        const union = new Set();
        for (const c of centers) {
            for (const d of diamond(c)) {
                if (!revealed[d]) union.add(d);
            }
        }
        let cost = 0;
        for (const d of union) cost += detour[d];
        return { centers: [...centers], union, rooms: union.size, cost, residual: residualOf(union), routes: -1 };
    };

    // Max-flow is the expensive part of a score, and an uncovered way out has
    // no routes to count — so it is computed only when a comparison needs it
    const routesOf = (state) => {
        if (state.routes < 0) {
            if (state.residual > 0) {
                state.routes = 0;
            } else {
                const passable = new Array(n);
                for (let i = 0; i < n; i++) passable[i] = revealed[i] || state.union.has(i);
                state.routes = countDisjointRoutes(passable, cols, exitIdx);
            }
        }
        return state.routes;
    };

    const compare = (a, b) => {
        if (a.residual !== b.residual) return a.residual - b.residual;
        const routes = Math.min(BEACON_ROUTE_TARGET, routesOf(b)) - Math.min(BEACON_ROUTE_TARGET, routesOf(a));
        if (routes !== 0) return routes;
        if (a.rooms !== b.rooms) return b.rooms - a.rooms;
        return a.cost - b.cost;
    };

    return { score, compare, routesOf };
}

/**
 * Re-place one beacon at a time until no single move improves the placement,
 * judged by the full objective rather than by rooms alone: greedy coverage
 * takes the densest spot first even when moving one beacon onto the way out
 * would cover it at the cost of a room or two.
 *
 * @param {Object} scorer - createPlacementScorer result
 * @param {number} n - Cell count
 * @param {number[]} seed - Starting centers
 * @param {number} passes - Sweeps over the placement before settling
 * @returns {Object} Scored placement
 */
function refinePlacement(scorer, n, seed, passes) {
    const centers = [...seed];
    let best = scorer.score(centers);
    for (let pass = 0; pass < passes; pass++) {
        let moved = false;
        for (let slot = 0; slot < centers.length; slot++) {
            const incumbent = centers[slot];
            let chosen = incumbent;
            for (let c = 0; c < n; c++) {
                if (c === incumbent || centers.includes(c)) continue;
                const trial = [...centers];
                trial[slot] = c;
                const scored = scorer.score(trial);
                if (scorer.compare(scored, best) < 0) {
                    best = scored;
                    chosen = c;
                }
            }
            if (chosen !== incumbent) {
                centers[slot] = chosen;
                moved = true;
            }
        }
        if (!moved) break;
    }
    return best;
}

/**
 * Minimum-length beacon chains from the entrance region to the exit region,
 * the ones worth trying first — beam search, widest coverage kept.
 *
 * @param {Object} grid - beaconGrid helpers
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {boolean[]} startOK - Per cell: reveal area touches the entrance region
 * @param {number[]} distToEnd - Per cell: beacons still needed after it
 * @param {number} minNeeded - Chain length
 * @returns {number[][]} Chains, best coverage first
 */
function minimalChains(grid, revealed, startOK, distToEnd, minNeeded) {
    const n = revealed.length;
    const { manhattan, diamond } = grid;
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
    states.sort((a, b) => b.union.size - a.union.size);
    return states.slice(0, CHAIN_CANDIDATES).map((s) => s.chain);
}

/**
 * Plan beacon placements on a labyrinth floor. Beacons reveal a 13-room
 * diamond (Manhattan radius 2), and wherever they go they are judged the same
 * way, in this order:
 *
 * 1. **Cover a path to the exit.** A placement that could have covered one and
 *    does not is inadmissible, whatever it reveals. Only a budget too small to
 *    ever cover one falls back to getting as close as it can, and the caller is
 *    told how many it would take (`minNeeded`, `corridorOpen`).
 * 2. **Cover a second independent route**, so no single blocked room can sever
 *    the way out.
 * 3. **Reveal as many new rooms as possible**, ties settled toward rooms on the
 *    way out.
 *
 * The count is the only thing the two modes disagree about:
 *
 * - **A set count** (`beaconCount > 0`): plan exactly that many. The count is
 *   what you have, not a target to be declared infeasible.
 * - **No count** (`beaconCount === 0`): the fewest that cover a path to the
 *   exit — the minimum is the budget, and the objective above does the rest.
 *
 * Coverage used to be the whole objective for a set count, which is how four
 * beacons could be planned onto the densest dark pockets of a floor while the
 * way out stayed dark. It is now a constraint the placement has to clear first.
 *
 * Pure function so the planning logic is testable without DOM.
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} cols - Grid width
 * @param {number} [beaconCount=0] - Beacons to place; 0 = fewest that cover a path
 * @returns {Object|null} { feasible, beacons: [index...], covered: Set<number>,
 *   revealedNew, minNeeded, routes, corridorOpen } or null on empty input
 */
export function computeBeaconPlan(revealed, cols, beaconCount = 0) {
    const n = revealed.length;
    if (!n || !cols) return null;
    const entranceIdx = LABYRINTH_ENTRANCE;
    const exitIdx = labyrinthExit(n);
    const grid = beaconGrid(n, cols);
    const { neighbors, regionFrom } = grid;

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

    const { startOK, distToEnd, minNeeded } = connected
        ? { startOK: [], distToEnd: [], minNeeded: 0 }
        : beaconChainReach(grid, n, startRegion, endRegion);

    const nothingPlanned = (feasible) => ({
        feasible,
        beacons: [],
        covered: new Set(),
        revealedNew: 0,
        minNeeded,
        routes: connected ? countDisjointRoutes(revealed, cols, exitIdx) : 0,
        corridorOpen: connected,
    });

    // Without a count, the budget is the minimum that covers a path — which is
    // nothing at all when one is already revealed, and nothing possible when no
    // chain of beacons reaches the exit
    if (beaconCount <= 0) {
        if (connected) return nothingPlanned(true);
        if (!Number.isFinite(minNeeded)) return nothingPlanned(false);
    }
    const count = beaconCount > 0 ? beaconCount : minNeeded;

    // A budget that cannot cover a path has to be ranked by how close it gets;
    // one that can treats every placement that fails to as inadmissible
    const coversPath = Number.isFinite(minNeeded) && count >= minNeeded;
    const detour = detourCosts(grid, n, startRegion, exitIdx);
    const scorer = createPlacementScorer(grid, revealed, cols, detour, !coversPath);

    const seeds = [];
    const coverageSeed = growForCoverage(grid, revealed, count, detour, []);
    if (coverageSeed.length) seeds.push(coverageSeed);
    if (!connected && coversPath) {
        const chains = minimalChains(grid, revealed, startOK, distToEnd, minNeeded);
        // Asked for the minimum and there is no chain to be found: the honest
        // answer is that the exit cannot be covered, not a plan that misses it
        if (!chains.length && beaconCount <= 0) return nothingPlanned(false);
        for (const chain of chains) seeds.push(growForCoverage(grid, revealed, count, detour, chain));
    }
    if (!seeds.length) return nothingPlanned(beaconCount > 0);

    // The chain seeds already cover a path, so ranking them settles on route
    // redundancy and rooms; the re-placement search is expensive enough to be
    // spent on the few that come out on top
    const wide = count <= BEACON_SEARCH_WIDE_LIMIT;
    const scored = seeds.map((seed) => scorer.score(seed));
    scored.sort(scorer.compare);
    let best = scored[0];
    for (const seed of scored.slice(0, wide ? REFINE_SEEDS : 2)) {
        const refined = refinePlacement(scorer, n, seed.centers, wide ? BEACON_SWAP_PASSES : 2);
        if (scorer.compare(refined, best) < 0) best = refined;
    }

    return {
        feasible: true,
        beacons: [...best.centers],
        covered: new Set(best.union),
        revealedNew: best.union.size,
        minNeeded,
        routes: scorer.routesOf(best),
        corridorOpen: best.residual === 0,
    };
}
