/**
 * Labyrinth Clear Rate Calculator
 * Shows expected clear time and success rate on labyrinth skilling and combat room tiles.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { buildPlayerDTO, buildGameDataPayload, applyLoadoutSnapshotToDTO } from '../combat-sim/combat-sim-adapter.js';
import { runLabyrinthSimulation } from '../combat-sim/combat-sim-runner.js';
import Monster from '../combat-sim/engine/monster.js';
import { setGameData } from '../combat-sim/engine/game-data.js';
import loadoutSnapshot from './loadout-snapshot.js';
import labyrinthRoomLogs from './labyrinth-room-logs.js';
import { getAnnotationContainer, pruneEmptyAnnotationContainers } from './labyrinth-annotations.js';

const ROOM_DURATION = 120;
const BASE_SKILLING_TIME = 10;
const BASE_ENHANCING_TIME = 8;
const UPGRADE_STEP = 0.01;
const UPGRADE_SUCCESS_STEP = 0.005;
const BADGE_CLASS = 'mwi-labyrinth-clear';
const RECOMMEND_CLASS = 'mwi-labyrinth-recommend';
const RECOMMEND_CONTROLS_CLASS = 'mwi-labyrinth-recommend-controls';
const LIVE_PROGRESS_CLASS = 'mwi-labyrinth-live-progress';
const LIVE_PROGRESS_STALE_MS = 5000;
const PREVIEW_ID = 'mwi-labyrinth-preview';
const UPGRADE_MAX_LEVEL = 12;
const TILE_BADGE_CLASS = 'mwi-labyrinth-tile-badge';
const TILE_CONTROLS_CLASS = 'mwi-labyrinth-tile-controls';
const PATH_OVERLAY_CLASS = 'mwi-labyrinth-path-overlay';
const BEACON_OVERLAY_CLASS = 'mwi-labyrinth-beacon-overlay';

/** Beacon reveal radius: Manhattan distance 2 — a 13-room diamond */
const BEACON_RADIUS = 2;

/** Lexicographic weight: one shroud outweighs any number of torches */
const PATH_SHROUD_WEIGHT = 1e6;

/**
 * Clamp a labyrinth skilling/enhancing success rate to the game's bounds:
 * SkillingSuccessRate = MAX(5%, 0.80 * (1 + LevelBonus + Buffs)), capped at 100%
 * @param {number} v - Raw success rate
 * @returns {number}
 */
function clampSuccessChance(v) {
    return Math.min(1, Math.max(0.05, v));
}

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
 * @returns {number} Disjoint route count (capped at 4)
 */
export function countDisjointRoutes(passable, cols) {
    const n = passable.length;
    if (!n || !cols) return 0;
    const walkable = (i) => i === 0 || i === n - 1 || !!passable[i];
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
        addEdge(2 * i, 2 * i + 1, i === 0 || i === n - 1 ? 99 : 1);
        for (const nb of neighbors(i)) {
            if (walkable(nb)) addEdge(2 * i + 1, 2 * nb, 99);
        }
    }

    const source = 1; // entrance out-node
    const sink = 2 * (n - 1); // exit in-node
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
 * Plan beacon placements that reveal a walkable corridor from the entrance to
 * the floor exit while revealing as many new rooms as possible. Beacons reveal
 * a 13-room diamond (Manhattan radius 2). The corridor requirement: a path
 * from the entrance to the exit where every interior room is revealed (already
 * revealed rooms count, so mid-run the plan builds on what's uncovered).
 *
 * Priorities: use the minimum number of beacons that can cover such a corridor
 * (chained so consecutive reveal areas connect), prefer placements whose
 * revealed region offers two independent routes to the exit (no single blocked
 * room can sever it), maximize newly revealed rooms among those (beam search),
 * then spend any extra requested beacons where they add redundancy first and
 * coverage second.
 *
 * Pure function so the planning logic is testable without DOM.
 * @param {boolean[]} revealed - Flat grid of already-revealed rooms
 * @param {number} cols - Grid width
 * @param {number} [beaconCount=0] - Total beacons to place; 0 = minimum needed
 * @returns {Object|null} { feasible, beacons: [index...], covered: Set<number>,
 *   revealedNew, minNeeded, routes } or null on empty input
 */
export function computeBeaconPlan(revealed, cols, beaconCount = 0) {
    const n = revealed.length;
    if (!n || !cols) return null;
    const entranceIdx = 0;
    const exitIdx = n - 1;
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

    // Revealed regions walkable from the entrance and from the exit
    const bfsRegion = (start) => {
        const seen = new Set([start]);
        const queue = [start];
        while (queue.length) {
            const cur = queue.shift();
            for (const nb of neighbors(cur)) {
                if (!seen.has(nb) && revealed[nb]) {
                    seen.add(nb);
                    queue.push(nb);
                }
            }
        }
        return seen;
    };
    const startRegion = bfsRegion(entranceIdx);
    const endRegion = bfsRegion(exitIdx);

    // Already connected without any beacons?
    let connected = false;
    for (const i of startRegion) {
        if (endRegion.has(i) || neighbors(i).some((nb) => endRegion.has(nb))) {
            connected = true;
            break;
        }
    }
    if (connected) {
        return {
            feasible: true,
            beacons: [],
            covered: new Set(),
            revealedNew: 0,
            minNeeded: 0,
            routes: countDisjointRoutes(revealed, cols),
        };
    }

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
    const CHAIN_DIST = 2 * BEACON_RADIUS + 1;
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
                if (distToEnd[other] === Infinity && manhattan(c, other) <= CHAIN_DIST) {
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
    if (!Number.isFinite(minNeeded)) {
        return { feasible: false, beacons: [], covered: new Set(), revealedNew: 0, minNeeded: Infinity, routes: 0 };
    }
    if (beaconCount > 0 && beaconCount < minNeeded) {
        return { feasible: false, beacons: [], covered: new Set(), revealedNew: 0, minNeeded, routes: 0 };
    }
    const targetCount = beaconCount > 0 ? beaconCount : minNeeded;

    // Walkability including a candidate coverage union, for route counting
    const passableWith = (union) => {
        const passable = new Array(n);
        for (let i = 0; i < n; i++) passable[i] = revealed[i] || union.has(i);
        return passable;
    };
    const routesWith = (union) => Math.min(2, countDisjointRoutes(passableWith(union), cols));

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
                if (manhattan(c, last) > CHAIN_DIST) continue;
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
    if (!states.length) {
        return { feasible: false, beacons: [], covered: new Set(), revealedNew: 0, minNeeded, routes: 0 };
    }

    // Among the best chains, prefer ones whose revealed region already offers
    // two independent routes to the exit, then the most coverage
    const finalists = states.slice(0, 40).map((s) => ({ ...s, routes: routesWith(s.union) }));
    finalists.sort((a, b) => b.routes - a.routes || b.union.size - a.union.size);
    const best = finalists[0];

    // Extra beacons: add redundancy first (up to two independent routes),
    // then coverage
    const beacons = [...best.chain];
    const covered = new Set(best.union);
    let routes = best.routes;
    while (beacons.length < targetCount) {
        let bestCenter = -1;
        let bestRoutes = routes;
        let bestGain = 0;
        for (let c = 0; c < n; c++) {
            if (beacons.includes(c)) continue;
            const gain = newCells(c, covered).length;
            if (gain === 0 && routes >= 2) continue;
            let candidateRoutes = routes;
            if (routes < 2 && gain > 0) {
                const union = new Set(covered);
                for (const g of newCells(c, covered)) union.add(g);
                candidateRoutes = routesWith(union);
            }
            if (candidateRoutes > bestRoutes || (candidateRoutes === bestRoutes && gain > bestGain)) {
                bestRoutes = candidateRoutes;
                bestGain = gain;
                bestCenter = c;
            }
        }
        if (bestCenter < 0 || bestGain === 0) break;
        beacons.push(bestCenter);
        for (const gained of newCells(bestCenter, covered)) covered.add(gained);
        routes = routes >= 2 ? routes : routesWith(covered);
    }

    return { feasible: true, beacons, covered, revealedNew: covered.size, minNeeded, routes };
}

class LabyrinthClearRate {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.roomData = null;
        this.wsHandler = null;
        this.combatCache = new Map();
        this.simQueue = [];
        this.simRunning = false;
        this.recommendations = new Map();
        this.recommendRunning = false;
        this._recommendTargetPct = 70;
        this.liveProgressHandler = null;
        this.liveProgressTimeout = null;
        this.snapshotUpdateHandler = null;
        this._settingsFingerprint = null;
        this._snapshotFingerprint = null;
    }

    initialize() {
        if (!config.getSetting('labyrinthClearRate')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        this.wsHandler = (data) => this.onLabyrinthUpdated(data);
        webSocketHook.on('labyrinth_updated', this.wsHandler);

        // Settings fire for every character-setting change — including editing a
        // skip threshold in the automation panel itself — so recommendations are
        // only dropped when something they depend on actually changed (loadout
        // assignments, crates, or loadout contents). The combat cache never needs
        // clearing here: its key already includes loadoutId/roomLevel/crates/hours.
        this.settingHandler = () => {
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        };
        webSocketHook.on('setting_updated', this.settingHandler);

        this.loadoutsHandler = () => {
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        };
        webSocketHook.on('loadouts_updated', this.loadoutsHandler);

        // Snapshot content is not part of buildCombatCacheKey, so sims must be
        // invalidated when loadout gear actually changes — but snapshots also
        // re-broadcast unchanged (e.g. when the lab equips the next room's
        // loadout), so verify content really differs before wiping anything
        this.snapshotUpdateHandler = () => {
            this._invalidateIfInputsChanged();
        };
        loadoutSnapshot.onUpdate(this.snapshotUpdateHandler);

        this.liveProgressHandler = (data) => this.onLiveProgress(data);
        webSocketHook.on('labyrinth_room_progress', this.liveProgressHandler);

        const unregister = domObserver.onClass('LabyrinthClearRate', 'LabyrinthPanel_skipThreshold', () =>
            this.injectOverlays()
        );
        this.unregisterHandlers.push(unregister);

        const unregisterTiles = domObserver.onClass('LabyrinthTileCalc', 'LabyrinthPanel_roomCell', () => {
            this.seedFromCharacterData();
            this.injectTileControls();
            this.pruneClearedTileBadges();
            this.pruneClearedPathOverlays();
            this.scheduleAutoTileCalc();
        });
        this.unregisterHandlers.push(unregisterTiles);
        setTimeout(() => {
            this.seedFromCharacterData();
            this.injectTileControls();
            this.scheduleAutoTileCalc();
        }, 500);

        setTimeout(() => {
            // Seed the invalidation baselines once character data is present
            this._invalidateIfInputsChanged();
            this.injectOverlays();
        }, 500);

        // Skip-threshold cells wrap so the shared annotation line (clear rate,
        // recommendation, best level) sits below the native value/buttons
        // instead of squeezing them into wrapping mid-value
        this.styleEl = document.createElement('style');
        this.styleEl.id = 'mwi-labyrinth-clear-style';
        this.styleEl.textContent = `
            [class*="LabyrinthPanel_automationContent"] { max-width: 36rem !important; }
            [class*="LabyrinthPanel_skipThreshold"] { display: flex; align-items: center; flex-wrap: wrap; }
            .${BADGE_CLASS} { order: 1; }
            .${RECOMMEND_CLASS} { order: 2; }
        `;
        document.head.appendChild(this.styleEl);

        // Prefill the game's skip-threshold edit input with the current value
        this._editClickHandler = (e) => this.onSkipEditClick(e);
        document.addEventListener('click', this._editClickHandler, true);

        this.isInitialized = true;
    }

    /**
     * When the game's Edit button on a skip-threshold row is clicked, fill the
     * number input with the recommended threshold (falling back to the row's
     * current value when no recommendation has been computed), replacing
     * whatever the input holds. Gated behind the labyrinthSkipEditAutofill
     * setting (off by default).
     * @param {MouseEvent} event
     */
    onSkipEditClick(event) {
        if (!config.getSetting('labyrinthSkipEditAutofill')) return;
        const button = event.target?.closest?.('button');
        if (!button || button.textContent.trim() !== 'Edit') return;
        const cell = button.closest('[class*="LabyrinthPanel_skipThreshold"]');
        if (!cell) return;
        const roomHrid = this.extractRoomHrid(cell);
        if (!roomHrid) return;

        const recommended = this.recommendations.get(roomHrid)?.threshold;
        const current = roomHrid.startsWith('/skills/')
            ? this.getSkipThreshold(roomHrid)
            : this.getCombatSkipThreshold(roomHrid);
        const value = Number.isFinite(recommended) && recommended > 0 ? recommended : current;
        if (!(value > 0)) return;

        // React renders the input a beat after the click; retry briefly
        let attempts = 0;
        const tryFill = () => {
            const input = cell.querySelector('input');
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    setter.call(input, String(value));
                } else {
                    input.value = String(value);
                }
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
            if (++attempts < 10) setTimeout(tryFill, 50);
        };
        setTimeout(tryFill, 0);
    }

    disable() {
        if (this.wsHandler) {
            webSocketHook.off('labyrinth_updated', this.wsHandler);
            this.wsHandler = null;
        }

        if (this.settingHandler) {
            webSocketHook.off('setting_updated', this.settingHandler);
            this.settingHandler = null;
        }

        if (this.loadoutsHandler) {
            webSocketHook.off('loadouts_updated', this.loadoutsHandler);
            this.loadoutsHandler = null;
        }

        if (this.liveProgressHandler) {
            webSocketHook.off('labyrinth_room_progress', this.liveProgressHandler);
            this.liveProgressHandler = null;
        }

        if (this.snapshotUpdateHandler) {
            loadoutSnapshot.offUpdate(this.snapshotUpdateHandler);
            this.snapshotUpdateHandler = null;
        }

        this.clearLiveProgress();
        this.hidePreview();
        document.getElementById(PREVIEW_ID)?.remove();
        document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
        document.querySelectorAll(`.${TILE_CONTROLS_CLASS}`).forEach((el) => el.remove());
        if (this.autoTileTimer) {
            clearTimeout(this.autoTileTimer);
            this.autoTileTimer = null;
        }
        if (this.pruneTileTimer) {
            clearTimeout(this.pruneTileTimer);
            this.pruneTileTimer = null;
        }
        this.calculatedTileKeys?.clear();

        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];

        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${RECOMMEND_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${RECOMMEND_CONTROLS_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`.${LIVE_PROGRESS_CLASS}`).forEach((el) => el.remove());
        this.clearPathOverlays();
        this.clearBeaconOverlays();
        this.pathCalcRunning = false;
        pruneEmptyAnnotationContainers();

        if (this._editClickHandler) {
            document.removeEventListener('click', this._editClickHandler, true);
            this._editClickHandler = null;
        }
        if (this.styleEl) {
            this.styleEl.remove();
            this.styleEl = null;
        }

        this.roomData = null;
        this.combatCache.clear();
        this.simQueue = [];
        this.simRunning = false;
        this.recommendations.clear();
        this.recommendRunning = false;
        this._settingsFingerprint = null;
        this._snapshotFingerprint = null;
        this.isInitialized = false;
    }

    onLabyrinthUpdated(data) {
        const previousFloor = this.currentFloor;
        this.currentFloor = Math.max(0, Math.floor(Number(data.labyrinth?.currentFloor) || 0));
        const roomData = data.labyrinth?.roomData;
        if (roomData) {
            this.roomData = roomData;
            this.injectOverlays();
            this.pruneClearedPathOverlays();
            if (previousFloor !== this.currentFloor) {
                this.clearPathOverlays();
                this.clearBeaconOverlays();
                document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
                this.calculatedTileKeys?.clear();
            }
            this.injectTileControls();
            this.pruneClearedTileBadges();
            // Re-run after React repaints the cleared tile (the WS message
            // usually arrives before the DOM updates)
            if (this.pruneTileTimer) clearTimeout(this.pruneTileTimer);
            this.pruneTileTimer = setTimeout(() => {
                this.pruneTileTimer = null;
                this.pruneClearedTileBadges();
            }, 400);

            // Auto-calc newly revealed tiles when enabled (off by default)
            this.scheduleAutoTileCalc();
        }
    }

    /**
     * Get labyrinth upgrade levels from characterInfo
     */
    getLabyrinthUpgrades() {
        const info = dataManager.characterData?.characterInfo;
        if (!info) return { speed: 0, efficiency: 0, success: 0, doubleProgress: 0, experience: 0 };

        return {
            speed: Math.max(0, Math.floor(Number(info.labyrinthSkillActionSpeedLevel) || 0)),
            efficiency: Math.max(0, Math.floor(Number(info.labyrinthSkillingEfficiencyLevel) || 0)),
            success: Math.max(0, Math.floor(Number(info.labyrinthSkillingSuccessLevel) || 0)),
            doubleProgress: Math.max(0, Math.floor(Number(info.labyrinthSkillingDoubleProgressLevel) || 0)),
            experience: Math.max(0, Math.floor(Number(info.labyrinthExperienceLevel) || 0)),
        };
    }

    /**
     * Get crate buff arrays for all equipped crates
     */
    getCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const crateHrids = [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ];

        const allBuffs = [];
        for (const hrid of crateHrids) {
            if (!hrid) continue;
            const buffs = gameData.labyrinthCrateDetailMap[hrid];
            if (Array.isArray(buffs)) {
                allBuffs.push(...buffs);
            }
        }
        return allBuffs;
    }

    /**
     * Get crate buffs for combat rooms (coffee + food only, no tea)
     */
    getCombatCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const crateHrids = [
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ];

        const allBuffs = [];
        for (const hrid of crateHrids) {
            if (!hrid) continue;
            const buffs = gameData.labyrinthCrateDetailMap[hrid];
            if (Array.isArray(buffs)) {
                allBuffs.push(...buffs);
            }
        }
        return allBuffs;
    }

    /**
     * Get crate buffs for tea crate only (used for room-assignment effective level)
     */
    getTeaCrateBuffs() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        const gameData = dataManager.getInitClientData();
        if (!gameData?.labyrinthCrateDetailMap) return [];

        const teaHrid = labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '';
        if (!teaHrid) return [];

        const buffs = gameData.labyrinthCrateDetailMap[teaHrid];
        return Array.isArray(buffs) ? buffs : [];
    }

    /**
     * Get the labyrinth loadout ID for a skill from characterSetting
     */
    getSkillingLoadoutId(skillHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const skillId = skillHrid.replace('/skills/', '');
        const pascal = skillId.charAt(0).toUpperCase() + skillId.slice(1);
        return Number(charSetting[`labyrinthLoadout${pascal}`]) || 0;
    }

    /**
     * Compute equipment noncombat stat buffs from a loadout snapshot's equipment.
     * Replicates the reference's buildLoadoutNoncombatStatTotals + buildSkillingEquipmentBuffsFromTotals.
     * @param {number} loadoutId - Loadout ID
     * @param {string} skillId - e.g. "milking"
     * @returns {Array} Array of buff-like objects with typeHrid and flatBoost/ratioBoost
     */
    getLoadoutEquipmentBuffs(loadoutId, skillId) {
        const snapshot = loadoutSnapshot.snapshots[loadoutId];
        if (!snapshot?.equipment?.length) return [];

        const gameData = dataManager.getInitClientData();
        if (!gameData?.itemDetailMap) return [];

        const enhTable = gameData.enhancementLevelTotalBonusMultiplierTable || {};
        const toolSlot = `/item_locations/${skillId}_tool`;

        const totals = {};
        for (const equip of snapshot.equipment) {
            if (!equip.itemHrid || !equip.itemLocationHrid) continue;

            // Filter tool slots: only include the tool slot matching this skill
            if (equip.itemLocationHrid.endsWith('_tool') && equip.itemLocationHrid !== toolSlot) {
                continue;
            }

            const itemDetail = gameData.itemDetailMap[equip.itemHrid];
            const equipDetail = itemDetail?.equipmentDetail;
            if (!equipDetail) continue;

            const baseStats = equipDetail.noncombatStats || {};
            const enhStats = equipDetail.noncombatEnhancementBonuses || {};
            const enhLevel = equip.enhancementLevel || 0;
            const enhMultiplier = enhTable[enhLevel] ?? enhLevel;

            for (const [key, value] of Object.entries(baseStats)) {
                if (!Number.isFinite(value)) continue;
                totals[key] = (totals[key] || 0) + value;
            }
            for (const [key, value] of Object.entries(enhStats)) {
                if (!Number.isFinite(value)) continue;
                totals[key] = (totals[key] || 0) + value * enhMultiplier;
            }
        }

        // Convert totals to buff array matching the format expected by applyBuff
        const buffs = [];
        const actionSpeed = (totals[`${skillId}Speed`] || 0) + (totals.skillingSpeed || 0);
        const efficiency = (totals[`${skillId}Efficiency`] || 0) + (totals.skillingEfficiency || 0);
        const success = totals[`${skillId}Success`] || 0;
        const gathering = totals.gatheringQuantity || 0;

        if (actionSpeed) buffs.push({ typeHrid: '/buff_types/action_speed', flatBoost: actionSpeed, ratioBoost: 0 });
        if (efficiency) buffs.push({ typeHrid: '/buff_types/efficiency', flatBoost: efficiency, ratioBoost: 0 });
        if (success) buffs.push({ typeHrid: `/buff_types/${skillId}_success`, flatBoost: 0, ratioBoost: success });
        if (gathering) buffs.push({ typeHrid: '/buff_types/gathering', flatBoost: gathering, ratioBoost: 0 });

        return buffs;
    }

    /**
     * Aggregate all buff sources into skilling metrics for a given skill
     * @param {string} skillId - e.g. "woodcutting"
     * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
     */
    getSkillingMetrics(skillId, actionTypeHrid) {
        const metrics = {
            skillLevelBonus: 0,
            efficiencyBonus: 0,
            actionSpeedBonus: 0,
            successBonus: 0,
            doubleProgressBonus: 0,
            gatheringBonus: 0,
            experienceBonus: 0,
        };
        const charData = dataManager.characterData;
        if (!charData) return metrics;

        const skillLevelType = `/buff_types/${skillId}_level`;
        const skillSuccessType = `/buff_types/${skillId}_success`;

        // Equipment buffs come from the labyrinth loadout, not currently worn gear
        const loadoutId = this.getSkillingLoadoutId(`/skills/${skillId}`);
        const loadoutEquipBuffs = loadoutId ? this.getLoadoutEquipmentBuffs(loadoutId, skillId) : null;

        const buffSources = [
            loadoutEquipBuffs || charData.equipmentActionTypeBuffsMap?.[actionTypeHrid],
            charData.communityActionTypeBuffsMap?.[actionTypeHrid],
            charData.houseActionTypeBuffsMap?.[actionTypeHrid],
            charData.guildActionTypeBuffsMap?.[actionTypeHrid],
            charData.achievementActionTypeBuffsMap?.[actionTypeHrid],
            charData.mooPassActionTypeBuffsMap?.[actionTypeHrid],
        ];

        for (const buffs of buffSources) {
            if (!Array.isArray(buffs)) continue;
            for (const buff of buffs) {
                if (!buff?.typeHrid) continue;
                const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                if (amount === 0) continue;
                this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
            }
        }

        const crateBuffs = this.getCrateBuffs();
        for (const buff of crateBuffs) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (amount === 0) continue;
            this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
        }

        const upgrades = this.getLabyrinthUpgrades();
        metrics.actionSpeedBonus += upgrades.speed * UPGRADE_STEP;
        metrics.efficiencyBonus += upgrades.efficiency * UPGRADE_STEP;
        metrics.successBonus += upgrades.success * UPGRADE_SUCCESS_STEP;
        metrics.doubleProgressBonus += upgrades.doubleProgress * UPGRADE_STEP;
        metrics.experienceBonus += upgrades.experience * UPGRADE_STEP;

        return metrics;
    }

    /**
     * Apply a single buff to metrics based on its type
     */
    applyBuff(metrics, typeHrid, amount, skillLevelType, skillSuccessType, skillId) {
        if (typeHrid === skillLevelType) {
            metrics.skillLevelBonus += amount;
        } else if (typeHrid === '/buff_types/efficiency') {
            metrics.efficiencyBonus += amount;
        } else if (typeHrid === '/buff_types/action_speed') {
            metrics.actionSpeedBonus += amount;
        } else if (typeHrid === '/buff_types/labyrinth_double_progress') {
            metrics.doubleProgressBonus += amount;
        } else if (typeHrid === '/buff_types/success_rate' || typeHrid === skillSuccessType) {
            metrics.successBonus += amount;
        } else if (typeHrid === '/buff_types/wisdom') {
            metrics.experienceBonus += amount;
        } else if (
            typeHrid === '/buff_types/gathering' &&
            (skillId === 'milking' || skillId === 'foraging' || skillId === 'woodcutting')
        ) {
            // Official formula: DoubleProgress = Crate + Gathering (the three
            // gathering skills only) + Upgrade — gourmet does not apply in the lab
            metrics.gatheringBonus += amount;
        }
    }

    /**
     * Compute clear stats for a non-enhancing skilling room
     */
    computeSkillingClear(skillHrid, roomLevel) {
        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const metrics = this.getSkillingMetrics(skillId, actionTypeHrid);

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === skillHrid);
        const baseLevel = skill?.level || 1;

        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus + (metrics.gatheringBonus || 0)));

        const workPower = effectiveLevel * (1 + metrics.efficiencyBonus);
        const progressPerSuccess = Math.max(0, Math.floor(workPower));
        const targetProgress = roomLevel * 10;

        const actionSeconds = BASE_SKILLING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));

        const clearStats = this.computeNonEnhancingClearStats(
            attempts,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        );
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'skilling';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.workPower = workPower;
        result.progressPerSuccess = progressPerSuccess;
        result.targetProgress = targetProgress;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        result.skillHrid = skillHrid;
        this.attachSkillingWhatIfs(result, metrics, {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            progressPerSuccess,
            targetProgress,
            roomLevel,
        });
        return result;
    }

    /**
     * Attach what-if clear chances (level up, efficiency/speed tiers, labyrinth
     * upgrades) and XP/hour to a skilling result for the hover preview.
     */
    attachSkillingWhatIfs(result, metrics, params) {
        const {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            progressPerSuccess,
            targetProgress,
        } = params;
        const clampChance = (v) => Math.min(1, Math.max(0, v));
        const upgrades = this.getLabyrinthUpgrades();

        // +1 effective skill level (improves both success chance and work power)
        const nextLevel = effectiveLevel + 1;
        const nextLevelDelta = nextLevel - params.roomLevel;
        const nextLevelBonus = nextLevelDelta >= 0 ? nextLevelDelta * 0.005 : nextLevelDelta * 0.01;
        result.nextLevelClearChance = this.computeNonEnhancingClearStats(
            attempts,
            clampSuccessChance(0.8 * (1 + nextLevelBonus + metrics.successBonus)),
            doubleChance,
            Math.max(0, Math.floor(nextLevel * (1 + metrics.efficiencyBonus))),
            targetProgress
        ).clearChance;

        // Efficiency needed to require one fewer progress unit
        result.efficiencyDelta = null;
        result.efficiencyTierClearChance = null;
        const neededUnits = progressPerSuccess > 0 ? Math.ceil(targetProgress / progressPerSuccess - 1e-9) : 0;
        if (neededUnits > 1 && effectiveLevel > 0) {
            const requiredPerSuccess = Math.ceil(targetProgress / (neededUnits - 1) - 1e-9);
            const requiredEfficiency = requiredPerSuccess / effectiveLevel - 1;
            if (Number.isFinite(requiredEfficiency)) {
                result.efficiencyDelta = Math.max(0, requiredEfficiency - metrics.efficiencyBonus);
                result.efficiencyTierClearChance = this.computeNonEnhancingClearStats(
                    attempts,
                    successChance,
                    doubleChance,
                    requiredPerSuccess,
                    targetProgress
                ).clearChance;
            }
        }

        // Action speed needed to fit one more attempt into the room
        result.speedDelta = Math.max(
            0,
            (BASE_SKILLING_TIME * (attempts + 1)) / ROOM_DURATION - 1 - metrics.actionSpeedBonus
        );
        result.speedTierClearChance = this.computeNonEnhancingClearStats(
            attempts + 1,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        ).clearChance;

        // Next labyrinth upgrade tiers (null when already maxed)
        result.nextSuccessUpgradeClearChance =
            upgrades.success < UPGRADE_MAX_LEVEL
                ? this.computeNonEnhancingClearStats(
                      attempts,
                      clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus + UPGRADE_SUCCESS_STEP)),
                      doubleChance,
                      progressPerSuccess,
                      targetProgress
                  ).clearChance
                : null;
        result.nextDoubleUpgradeClearChance =
            upgrades.doubleProgress < UPGRADE_MAX_LEVEL
                ? this.computeNonEnhancingClearStats(
                      attempts,
                      successChance,
                      clampChance(doubleChance + UPGRADE_STEP),
                      progressPerSuccess,
                      targetProgress
                  ).clearChance
                : null;

        result.xpPerHour =
            Number.isFinite(result.expectedSeconds) && result.expectedSeconds > 0 && result.clearChance > 0
                ? (result.xpPerRoom * 3600) / (result.expectedSeconds + 1 / result.clearChance)
                : 0;
    }

    /**
     * Compute clear stats for an enhancing room
     */
    computeEnhancingClear(roomLevel) {
        const skillId = 'enhancing';
        const actionTypeHrid = '/action_types/enhancing';
        const metrics = this.getSkillingMetrics(skillId, actionTypeHrid);

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === '/skills/enhancing');
        const baseLevel = skill?.level || 1;

        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus));

        const actionSeconds = BASE_ENHANCING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));
        const targetLevel = 5;

        const clearStats = this.computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel);
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'enhancing';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.targetLevel = targetLevel;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        result.skillHrid = '/skills/enhancing';
        this.attachEnhancingWhatIfs(result, metrics, {
            attempts,
            successChance,
            doubleChance,
            levelBonus,
            effectiveLevel,
            targetLevel,
            roomLevel,
        });
        return result;
    }

    /**
     * Attach what-if clear chances and XP/hour to an enhancing result.
     */
    attachEnhancingWhatIfs(result, metrics, params) {
        const { attempts, successChance, doubleChance, levelBonus, effectiveLevel, targetLevel } = params;
        const clampChance = (v) => Math.min(1, Math.max(0, v));
        const upgrades = this.getLabyrinthUpgrades();

        const nextLevelDelta = effectiveLevel + 1 - params.roomLevel;
        const nextLevelBonus = nextLevelDelta >= 0 ? nextLevelDelta * 0.005 : nextLevelDelta * 0.01;
        result.nextLevelClearChance = this.computeEnhancingClearStats(
            attempts,
            clampSuccessChance(0.8 * (1 + nextLevelBonus + metrics.successBonus)),
            doubleChance,
            targetLevel
        ).clearChance;

        result.speedDelta = Math.max(
            0,
            (BASE_ENHANCING_TIME * (attempts + 1)) / ROOM_DURATION - 1 - metrics.actionSpeedBonus
        );
        result.speedTierClearChance = this.computeEnhancingClearStats(
            attempts + 1,
            successChance,
            doubleChance,
            targetLevel
        ).clearChance;

        result.nextSuccessUpgradeClearChance =
            upgrades.success < UPGRADE_MAX_LEVEL
                ? this.computeEnhancingClearStats(
                      attempts,
                      clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus + UPGRADE_SUCCESS_STEP)),
                      doubleChance,
                      targetLevel
                  ).clearChance
                : null;
        result.nextDoubleUpgradeClearChance =
            upgrades.doubleProgress < UPGRADE_MAX_LEVEL
                ? this.computeEnhancingClearStats(
                      attempts,
                      successChance,
                      clampChance(doubleChance + UPGRADE_STEP),
                      targetLevel
                  ).clearChance
                : null;

        result.xpPerHour =
            Number.isFinite(result.expectedSeconds) && result.expectedSeconds > 0 && result.clearChance > 0
                ? (result.xpPerRoom * 3600) / (result.expectedSeconds + 1 / result.clearChance)
                : 0;
    }

    buildResult(clearStats, actionSeconds) {
        const { clearChance, expectedAttemptsOnClear } = clearStats;
        if (clearChance <= 0) {
            return { clearChance: 0, expectedSeconds: Infinity };
        }
        const expectedSecondsOnSuccess = expectedAttemptsOnClear * actionSeconds;
        const expectedSeconds =
            (clearChance * expectedSecondsOnSuccess + (1 - clearChance) * ROOM_DURATION) / clearChance;
        return { clearChance, expectedSeconds };
    }

    /**
     * State machine for non-enhancing rooms.
     * Tracks probability distribution over progress units.
     */
    computeNonEnhancingClearStats(attempts, successChance, doubleChance, progressPerSuccess, targetProgress) {
        if (targetProgress <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (attempts <= 0 || progressPerSuccess <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };
        if (successChance <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };

        const neededUnits = Math.ceil(targetProgress / progressPerSuccess - 1e-9);
        if (neededUnits <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (neededUnits > attempts * 2) return { clearChance: 0, expectedAttemptsOnClear: null };

        const q0 = 1 - successChance;
        const q1 = successChance * (1 - doubleChance);
        const q2 = successChance * doubleChance;

        let stateDist = new Float64Array(neededUnits + 1);
        stateDist[0] = 1;
        let expectedAttemptsNumerator = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const nextDist = new Float64Array(neededUnits + 1);

            for (let units = 0; units <= neededUnits; units++) {
                const prob = stateDist[units];
                if (prob <= 0) continue;

                if (units === neededUnits) {
                    nextDist[neededUnits] += prob;
                    continue;
                }

                nextDist[units] += prob * q0;
                nextDist[Math.min(neededUnits, units + 1)] += prob * q1;
                nextDist[Math.min(neededUnits, units + 2)] += prob * q2;
            }

            const reachedNow = nextDist[neededUnits] - stateDist[neededUnits];
            if (reachedNow > 0) {
                expectedAttemptsNumerator += attempt * reachedNow;
            }

            stateDist = nextDist;
        }

        const clearChance = Math.min(1, Math.max(0, stateDist[neededUnits]));
        const expectedAttemptsOnClear = clearChance > 0 ? expectedAttemptsNumerator / clearChance : null;
        return { clearChance, expectedAttemptsOnClear };
    }

    /**
     * State machine for enhancing rooms.
     * States are enhancement levels 0..targetLevel.
     * Fail: drop to max(0, level-1). Success: +1. Double: +2.
     */
    computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel, startLevel = 0) {
        if (targetLevel <= 0) return { clearChance: 1, expectedAttemptsOnClear: 0 };
        if (attempts <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };
        if (successChance <= 0) return { clearChance: 0, expectedAttemptsOnClear: null };

        const failChance = 1 - successChance;
        const singleChance = successChance * (1 - doubleChance);
        const doubleSuccessChance = successChance * doubleChance;

        let stateDist = new Float64Array(targetLevel + 1);
        stateDist[Math.min(startLevel, targetLevel)] = 1;
        let expectedAttemptsNumerator = 0;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const nextDist = new Float64Array(targetLevel + 1);

            for (let level = 0; level <= targetLevel; level++) {
                const prob = stateDist[level];
                if (prob <= 0) continue;

                if (level === targetLevel) {
                    nextDist[targetLevel] += prob;
                    continue;
                }

                nextDist[Math.max(0, level - 1)] += prob * failChance;
                nextDist[Math.min(targetLevel, level + 1)] += prob * singleChance;
                nextDist[Math.min(targetLevel, level + 2)] += prob * doubleSuccessChance;
            }

            const reachedNow = nextDist[targetLevel] - stateDist[targetLevel];
            if (reachedNow > 0) {
                expectedAttemptsNumerator += attempt * reachedNow;
            }

            stateDist = nextDist;
        }

        const clearChance = Math.min(1, Math.max(0, stateDist[targetLevel]));
        const expectedAttemptsOnClear = clearChance > 0 ? expectedAttemptsNumerator / clearChance : null;
        return { clearChance, expectedAttemptsOnClear };
    }

    /**
     * Get the skip threshold for a skill from characterSetting
     */
    getSkipThreshold(skillHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const skillId = skillHrid.replace('/skills/', '');
        const key = `labyrinthSkip${skillId.charAt(0).toUpperCase()}${skillId.slice(1)}`;
        return Math.max(0, Math.floor(Number(charSetting[key]) || 0));
    }

    /**
     * Get effective level for room assignment (base + tea crate only).
     * The game uses this to determine what room level a skip threshold maps to.
     */
    getEffectiveLevel(skillHrid) {
        const skillId = skillHrid.replace('/skills/', '');

        const skills = dataManager.getSkills();
        const skill = skills?.find((s) => s.skillHrid === skillHrid);
        const baseLevel = skill?.level || 1;

        const teaCrateBuffs = this.getTeaCrateBuffs();
        const skillLevelType = `/buff_types/${skillId}_level`;
        let teaLevelBonus = 0;
        for (const buff of teaCrateBuffs) {
            if (!buff?.typeHrid) continue;
            if (buff.typeHrid === skillLevelType) {
                teaLevelBonus += (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            }
        }

        return baseLevel + teaLevelBonus;
    }

    /**
     * Get the player's effective combat level (used as base for skip threshold calculations).
     * The game computes room level as: playerEffectiveCombatLevel + skipThreshold - 1.
     */
    getPlayerEffectiveCombatLevel() {
        const combatLevel = dataManager.characterData?.combatUnit?.combatDetails?.combatLevel;
        if (!combatLevel) return 100;

        const baseCombatLevel = Math.floor(combatLevel);
        const crateLevelBonus = this._getCrateCombatLevelBonus();
        return baseCombatLevel + crateLevelBonus;
    }

    /**
     * Sum combat level bonuses from equipped labyrinth crates.
     * Looks for /buff_types/combat_level, /buff_types/action_level, and individual
     * skill level types (averaged).
     */
    _getCrateCombatLevelBonus() {
        const crateBuffs = this.getCombatCrateBuffs();
        if (crateBuffs.length === 0) return 0;

        const skillLevelTypes = new Set([
            '/buff_types/stamina_level',
            '/buff_types/intelligence_level',
            '/buff_types/attack_level',
            '/buff_types/defense_level',
            '/buff_types/melee_level',
            '/buff_types/ranged_level',
            '/buff_types/magic_level',
        ]);

        let directLevelBonus = 0;
        let skillLevelSum = 0;
        let skillLevelCount = 0;

        for (const buff of crateBuffs) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (!Number.isFinite(amount) || amount === 0) continue;

            if (buff.typeHrid === '/buff_types/combat_level' || buff.typeHrid === '/buff_types/action_level') {
                directLevelBonus += amount;
            } else if (skillLevelTypes.has(buff.typeHrid)) {
                skillLevelSum += amount;
                skillLevelCount += 1;
            }
        }

        const averagedSkillLevelBonus = skillLevelCount > 0 ? skillLevelSum / skillLevelCount : 0;
        return Math.max(0, directLevelBonus + averagedSkillLevelBonus);
    }

    /**
     * Compute target room level from effective level + skip threshold
     * Matches reference script: floor(effectiveLevel + skipThreshold - 1)
     */
    getTargetRoomLevel(skillHrid) {
        const effectiveLevel = this.getEffectiveLevel(skillHrid);
        const skipThreshold = this.getSkipThreshold(skillHrid);
        if (skipThreshold <= 0) return 0;

        return Math.floor(effectiveLevel + skipThreshold - 1);
    }

    /**
     * Get the skip threshold for a combat room from characterSetting
     */
    getCombatSkipThreshold(monsterHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const monsterName = monsterHrid.replace('/monsters/', '');
        const pascal = monsterName
            .split('_')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join('');
        const key = `labyrinthSkip${pascal}`;
        return Math.max(0, Math.floor(Number(charSetting[key]) || 0));
    }

    /**
     * Compute target room level for a combat room.
     * Uses the player's effective combat level as the base (same as the game).
     */
    getCombatRoomLevel(monsterHrid) {
        if (this.roomData) {
            const room = this.findRoomByMonsterHrid(monsterHrid);
            if (room && !room.isCleared) {
                return Number(room.recommendedLevel || 0);
            }
        }

        const skipThreshold = this.getCombatSkipThreshold(monsterHrid);
        if (skipThreshold <= 0) return 0;

        const effectiveCombatLevel = this.getPlayerEffectiveCombatLevel();
        return Math.floor(effectiveCombatLevel + skipThreshold - 1);
    }

    /**
     * Get the labyrinth loadout ID for a monster from characterSetting
     */
    getLabyrinthLoadoutId(monsterHrid) {
        const charSetting = dataManager.characterData?.characterSetting;
        if (!charSetting) return 0;

        const monsterName = monsterHrid.replace('/monsters/', '');
        const pascal = monsterName
            .split('_')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join('');
        return Number(charSetting[`labyrinthLoadout${pascal}`]) || 0;
    }

    /**
     * Build a player DTO with the labyrinth loadout applied
     */
    buildLabyrinthPlayerDTO(loadoutId) {
        const dto = buildPlayerDTO();
        if (!dto) return null;

        const snapshot = loadoutSnapshot.snapshots[loadoutId];
        if (snapshot?.name) {
            const gameData = buildGameDataPayload();
            applyLoadoutSnapshotToDTO(dto, snapshot.name, gameData);
        }
        return dto;
    }

    /**
     * Build labyrinth combat upgrade buffs from characterInfo
     */
    getLabyrinthCombatBuffs() {
        const info = dataManager.characterData?.characterInfo;
        if (!info) return [];

        const buffs = [];
        const defs = [
            ['labyrinthCombatDamageLevel', 'combat_damage', '/buff_types/damage', 'ratioBoost'],
            ['labyrinthAttackSpeedLevel', 'attack_speed', '/buff_types/attack_speed', 'ratioBoost'],
            ['labyrinthCastSpeedLevel', 'cast_speed', '/buff_types/cast_speed', 'flatBoost'],
            ['labyrinthCriticalRateLevel', 'critical_rate', '/buff_types/critical_rate', 'flatBoost'],
        ];
        for (const [infoKey, uniqueKey, typeHrid, valueKey] of defs) {
            const level = Math.max(0, Math.floor(Number(info[infoKey]) || 0));
            if (level <= 0) continue;
            const buff = {
                uniqueHrid: `/buff_uniques/labyrinth_upgrade_${uniqueKey}`,
                typeHrid,
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
                flatBoost: 0,
                flatBoostLevelBonus: 0,
                startTime: '0001-01-01T00:00:00Z',
                duration: 0,
            };
            buff[valueKey] = level * UPGRADE_STEP;
            buffs.push(buff);
        }
        return buffs;
    }

    /**
     * Get crate HRIDs as an array for the combat sim
     */
    getCrateHrids() {
        const labyrinth = dataManager.characterData?.characterLabyrinth;
        const setting = dataManager.characterData?.characterSetting;
        return [
            labyrinth?.teaCrateItemHrid || setting?.labyrinthTeaCrateHrid || '',
            labyrinth?.coffeeCrateItemHrid || setting?.labyrinthCoffeeCrateHrid || '',
            labyrinth?.foodCrateItemHrid || setting?.labyrinthFoodCrateHrid || '',
        ].filter(Boolean);
    }

    /**
     * Build cache key for a combat sim result
     */
    buildCombatCacheKey(monsterHrid, roomLevel) {
        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const crateHrids = this.getCrateHrids();
        return `${monsterHrid}:${roomLevel}:${loadoutId}:${this.getSimHours()}h:${crateHrids.join(',')}`;
    }

    /**
     * Combat sim hours for labyrinth tile and recommendation calculations
     */
    getSimHours() {
        const raw = Number(config.getSettingValue('labyrinthRecommendSimHours', 3));
        return Math.min(100, Math.max(1, Math.floor(raw) || 3));
    }

    getCachedCombatResult(monsterHrid, roomLevel) {
        return this.combatCache.get(this.buildCombatCacheKey(monsterHrid, roomLevel)) || null;
    }

    /**
     * Run combat sim for a monster room and return clear stats
     */
    async computeCombatClear(monsterHrid, roomLevel) {
        const cacheKey = this.buildCombatCacheKey(monsterHrid, roomLevel);
        if (this.combatCache.has(cacheKey)) return this.combatCache.get(cacheKey);

        const loadoutId = this.getLabyrinthLoadoutId(monsterHrid);
        const dto = this.buildLabyrinthPlayerDTO(loadoutId);
        if (!dto) return { clearChance: 0, expectedSeconds: Infinity, failed: true };

        const gameData = buildGameDataPayload();
        const crateHrids = this.getCrateHrids();
        const labyrinthCombatBuffs = this.getLabyrinthCombatBuffs();

        try {
            const simResult = await runLabyrinthSimulation({
                gameData,
                playerDTOs: [dto],
                zoneHrid: '/actions/combat/fly',
                monsterHrid,
                roomLevel,
                crates: crateHrids,
                hours: this.getSimHours(),
                communityBuffs: { mooPass: false, comExp: 0, comDrop: 0 },
                labyrinthCombatBuffs,
            });

            const attempts = simResult.labyAttemptCount || 1;
            const wins = simResult.encounters || 0;
            const winRate = wins / attempts;
            const totalTime = simResult.simulatedTime / 1e9;
            const avgTime = totalTime / attempts;

            const gameDataLocal = dataManager.getInitClientData();
            const monsterDetail = gameDataLocal?.combatMonsterDetailMap?.[monsterHrid];
            const monsterName = monsterDetail?.name || monsterHrid.replace('/monsters/', '').replace(/_/g, ' ');

            const snapshot = loadoutSnapshot.snapshots[loadoutId];
            const loadoutName = snapshot?.name || `Loadout #${loadoutId}`;

            // Failure reason: deaths mean defense is the problem, otherwise the
            // fights are timing out on the 2-minute limit (insufficient damage)
            const failures = Math.max(0, attempts - wins);
            const deaths = Math.max(0, Number(simResult.deaths?.[dto.hrid || 'player1'] || 0));
            const failedByDeath = Math.min(failures, deaths);
            const failedByTimeout = failures - failedByDeath;
            const failureReason =
                failures > 0 && winRate < 1
                    ? failedByDeath > failedByTimeout
                        ? 'Insufficient Defense'
                        : 'Insufficient Damage'
                    : '';

            const result = {
                clearChance: winRate,
                expectedSeconds: winRate > 0 ? avgTime / winRate : Infinity,
                type: 'combat',
                winRate,
                avgFightSeconds: avgTime,
                monsterName,
                monsterHrid,
                loadoutName,
                roomLevel,
                failureReason,
            };

            // Don't cache 0% results: right after page load the loadout
            // snapshots may not be loaded yet, so a 0% can come from simming
            // with the wrong gear. Leaving it uncached lets a retry correct it.
            if (winRate > 0) {
                this.combatCache.set(cacheKey, result);
            }
            return result;
        } catch (error) {
            if (error?.message === 'Cancelled') {
                // Explicit user Stop — flag it so searches abort instead of
                // treating the kill as a genuine 0% result
                return { clearChance: 0, expectedSeconds: Infinity, failed: true, cancelled: true };
            }
            console.error('[LabyrinthClearRate] Combat sim failed:', error);
            return { clearChance: 0, expectedSeconds: Infinity, failed: true };
        }
    }

    queueCombatSim(monsterHrid, roomLevel, badge) {
        this.simQueue.push({ monsterHrid, roomLevel, badge });
    }

    async processSimQueue() {
        if (this.simRunning) return;
        this.simRunning = true;
        while (this.simQueue.length > 0) {
            const { monsterHrid, roomLevel, badge } = this.simQueue.shift();
            if (!badge.isConnected) continue;
            const result = await this.computeCombatClear(monsterHrid, roomLevel);
            if (badge.isConnected) this.updateBadge(badge, result, roomLevel);
        }
        this.simRunning = false;
    }

    /**
     * Binary search for the maximum skip threshold where clear chance >= targetRate
     */
    findRecommendedThreshold(skillHrid, targetRate) {
        const effectiveLevel = this.getEffectiveLevel(skillHrid);
        const isEnhancing = skillHrid === '/skills/enhancing';
        let low = -300;
        let high = 300;
        let bestThreshold = null;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const roomLevel = Math.floor(effectiveLevel + mid - 1);
            if (roomLevel <= 0) {
                low = mid + 1;
                continue;
            }
            const result = isEnhancing
                ? this.computeEnhancingClear(roomLevel)
                : this.computeSkillingClear(skillHrid, roomLevel);
            if (result.clearChance >= targetRate) {
                bestThreshold = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return bestThreshold;
    }

    /**
     * Async binary search for combat room recommended threshold
     */
    async findRecommendedThresholdCombat(monsterHrid, targetRate) {
        const effectiveCombatLevel = this.getPlayerEffectiveCombatLevel();
        let low = -300;
        let high = 300;
        let bestThreshold = null;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const roomLevel = Math.floor(effectiveCombatLevel + mid - 1);
            if (roomLevel <= 0) {
                low = mid + 1;
                continue;
            }
            const result = await this.computeCombatClear(monsterHrid, roomLevel);
            if (result.cancelled) break;
            if (result.clearChance >= targetRate) {
                bestThreshold = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return bestThreshold;
    }

    /**
     * djb2 string hash — cheap change detection for snapshot contents
     * @private
     */
    _hashString(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
        }
        return String(hash);
    }

    /**
     * Fingerprint of the settings recommendations depend on: labyrinth loadout
     * assignments and crate selections. Skip thresholds are deliberately not
     * included — changing one doesn't change what any room's recommendation is.
     * @private
     */
    _recommendSettingsFingerprint() {
        const charSetting = dataManager.characterData?.characterSetting || {};
        const parts = [];
        for (const [key, value] of Object.entries(charSetting)) {
            if (key.startsWith('labyrinthLoadout')) {
                parts.push(`${key}=${value}`);
            }
        }
        parts.sort();
        parts.push(`crates=${this.getCrateHrids().join(',')}`);
        return parts.join('|');
    }

    /**
     * Fingerprint of loadout snapshot contents (gear + enhancement levels).
     * savedAt is excluded — snapshots are rebuilt with a fresh timestamp every
     * time the game re-broadcasts loadouts (e.g. when the lab equips the next
     * room's loadout), which is not a content change.
     * @private
     */
    _snapshotContentFingerprint() {
        try {
            return this._hashString(
                JSON.stringify(loadoutSnapshot.snapshots || {}, (key, value) => (key === 'savedAt' ? undefined : value))
            );
        } catch {
            // Unhashable → treat as changed so stale sims never survive
            return `err-${Date.now()}`;
        }
    }

    /**
     * Drop recommendations (and, for loadout content changes, cached sims)
     * only when the inputs they were computed from actually changed. Events
     * like setting_updated and snapshot rebuilds fire constantly — on every
     * skip-threshold edit and every lab room switch — and used to wipe
     * minutes of recommendation work for no reason.
     * @private
     * @returns {boolean} True when something was invalidated
     */
    _invalidateIfInputsChanged() {
        const settingsFp = this._recommendSettingsFingerprint();
        const snapshotFp = this._snapshotContentFingerprint();
        let stale = false;

        if (this._settingsFingerprint !== null && settingsFp !== this._settingsFingerprint) {
            stale = true;
        }
        this._settingsFingerprint = settingsFp;

        if (this._snapshotFingerprint !== null && snapshotFp !== this._snapshotFingerprint) {
            stale = true;
            // Snapshot content is not part of the combat cache key — gear
            // changes genuinely invalidate cached sims
            this.combatCache.clear();
        }
        this._snapshotFingerprint = snapshotFp;

        if (stale) {
            this.recommendations.clear();
        }
        return stale;
    }

    /**
     * Run recommendations for all visible rooms
     */
    async runRecommendations() {
        if (this.recommendRunning) return;
        this.recommendRunning = true;
        this.recommendations.clear();
        this.combatCache.clear();
        // Anchor the invalidation baselines to the state this run computes from
        this._settingsFingerprint = this._recommendSettingsFingerprint();
        this._snapshotFingerprint = this._snapshotContentFingerprint();

        const rateInput = document.getElementById('mwi-recommend-target-rate');
        const targetPct = rateInput ? parseInt(rateInput.value, 10) : null;
        this._recommendTargetPct =
            targetPct > 0 && targetPct <= 100 ? targetPct : config.getSetting('labyrinthRecommendTargetRate') || 70;
        const targetRate = this._recommendTargetPct / 100;

        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        const rooms = [];

        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;
            const isSkill = roomHrid.startsWith('/skills/');
            const isMonster = roomHrid.startsWith('/monsters/');
            if (!isSkill && !isMonster) continue;
            rooms.push({ roomHrid, isSkill });
        }

        const button = document.querySelector(`.${RECOMMEND_CONTROLS_CLASS} button`);
        const totalRooms = rooms.length;
        let completed = 0;

        for (const { roomHrid, isSkill } of rooms) {
            if (isSkill) {
                const threshold = this.findRecommendedThreshold(roomHrid, targetRate);
                this.recommendations.set(roomHrid, { threshold });
            } else {
                if (button) button.textContent = `Recommending... (${completed + 1}/${totalRooms})`;
                const threshold = await this.findRecommendedThresholdCombat(roomHrid, targetRate);
                this.recommendations.set(roomHrid, { threshold });
            }
            completed++;
        }

        if (button) button.textContent = 'Recommend';
        this.recommendRunning = false;
        this.injectRecommendationBadges();
    }

    /**
     * Inject recommendation badges onto visible cells
     */
    injectRecommendationBadges() {
        document.querySelectorAll(`.${RECOMMEND_CLASS}`).forEach((el) => el.remove());
        if (this.recommendations.size === 0) return;

        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;

            const rec = this.recommendations.get(roomHrid);
            if (!rec || rec.threshold === null) continue;

            const isSkill = roomHrid.startsWith('/skills/');
            const currentThreshold = isSkill ? this.getSkipThreshold(roomHrid) : this.getCombatSkipThreshold(roomHrid);

            const badge = document.createElement('span');
            badge.className = RECOMMEND_CLASS;
            badge.style.cssText = 'font-size:0.7rem; white-space:nowrap; font-weight:bold;';
            badge.textContent = `Rec: ${rec.threshold >= 0 ? '+' : ''}${rec.threshold}`;

            badge.title = `Recommended skip threshold for ≥${this._recommendTargetPct}% clear rate`;

            if (currentThreshold <= rec.threshold) {
                badge.style.color = '#00c896';
            } else if (currentThreshold <= rec.threshold + 10) {
                badge.style.color = '#f0ad4e';
            } else {
                badge.style.color = '#d9534f';
            }

            getAnnotationContainer(cell).appendChild(badge);
        }
    }

    /**
     * Inject recommend controls (button + target input) into the automation panel
     */
    injectRecommendControls() {
        const defaultRate = config.getSettingValue('labyrinthRecommendTargetRate', 70);

        if (document.querySelector(`.${RECOMMEND_CONTROLS_CLASS}`)) {
            const rateInput = document.getElementById('mwi-recommend-target-rate');
            if (rateInput && !rateInput.dataset.userEdited) rateInput.value = defaultRate;
            return;
        }

        const table = document.querySelector('[class*="LabyrinthPanel_automationTable"]');
        if (!table) return;

        const container = document.createElement('div');
        container.className = RECOMMEND_CONTROLS_CLASS;
        container.style.cssText =
            'display:flex; align-items:center; gap:8px; margin-bottom:6px; font-size:0.8rem; flex-wrap:wrap;';

        const inputStyle =
            'width:50px; background:#1a1a2e; color:#e0e0e0; border:1px solid #555; border-radius:4px; padding:2px 4px; font-size:0.75rem; text-align:center;';
        const labelStyle = 'color:#888; font-size:0.75rem; white-space:nowrap;';

        const rateLabel = document.createElement('span');
        rateLabel.style.cssText = labelStyle;
        rateLabel.textContent = 'Target Win %';

        const rateInput = document.createElement('input');
        rateInput.type = 'number';
        rateInput.id = 'mwi-recommend-target-rate';
        rateInput.min = '1';
        rateInput.max = '100';
        rateInput.step = '1';
        rateInput.value = defaultRate;
        rateInput.style.cssText = inputStyle;
        rateInput.addEventListener('input', () => {
            rateInput.dataset.userEdited = '1';
        });

        const button = document.createElement('button');
        button.textContent = 'Recommend';
        button.style.cssText =
            'padding:2px 10px; cursor:pointer; font-size:0.75rem; border-radius:4px; border:1px solid #555; background:#333; color:#ccc;';
        button.addEventListener('click', () => this.runRecommendations());

        container.appendChild(rateLabel);
        container.appendChild(rateInput);
        container.appendChild(button);
        table.parentNode.insertBefore(container, table);
    }

    /**
     * Handle incoming labyrinth_room_progress WS message
     */
    onLiveProgress(data) {
        if (!config.getSetting('labyrinthLiveProgress')) return;
        this.refreshLiveProgress(data);
    }

    /**
     * Normalize a chance value that may arrive as a ratio (0-1) or percent (0-100)
     * @param {*} value - Raw chance value from the WS message
     * @returns {number} Chance clamped to 0-1
     */
    normalizeChance(value) {
        const n = Number(value) || 0;
        if (n > 1 && n <= 100) {
            return Math.min(1, n / 100);
        }
        return Math.min(1, Math.max(0, n));
    }

    /**
     * Compute live clear estimate from room progress data
     */
    computeLiveEstimate(progress) {
        const isEnhancing = progress.targetLevel != null;
        const successChance = this.normalizeChance(progress.successRate);
        const doubleChance = this.normalizeChance(progress.doubleProgressChance);
        const fallbackMs = (isEnhancing ? BASE_ENHANCING_TIME : BASE_SKILLING_TIME) * 1000;
        const actionTimeMs = Math.max(1, Number(progress.actionTimeMs) || fallbackMs);
        const totalAttempts = Math.max(0, Math.floor((ROOM_DURATION * 1000) / actionTimeMs));
        const actionCounter = Math.max(0, Math.floor(Number(progress.actionCounter) || 0));
        const attemptsLeft = Math.max(0, totalAttempts - actionCounter);

        if (isEnhancing) {
            const targetLevel = Math.max(0, Math.floor(Number(progress.targetLevel) || 0));
            if (targetLevel <= 0) return null;
            const currentLevel = Math.max(0, Math.floor(Number(progress.currentEnhLevel) || 0));
            const clearStats = this.computeEnhancingClearStats(
                attemptsLeft,
                successChance,
                doubleChance,
                targetLevel,
                currentLevel
            );
            return {
                isEnhancing: true,
                clearChance: Math.min(1, Math.max(0, clearStats.clearChance || 0)),
                attemptsLeft,
                actionCounter,
                totalAttempts,
                successChance,
                doubleChance,
                currentLevel,
                targetLevel,
            };
        }

        const progressPerAction = Math.max(0, Number(progress.progressPerAction) || 0);
        const progressPerSuccess = Math.max(0, Math.floor(progressPerAction));
        const targetWorkValue = Math.max(0, Number(progress.targetWorkValue) || 0);
        if (targetWorkValue <= 0) return null;

        let currentWorkValue = Math.max(0, Number(progress.currentWorkValue) || 0);
        if (currentWorkValue <= 0) {
            const ratio = Math.min(1, Math.max(0, Number(progress.currentProgress) || 0));
            if (ratio > 0) currentWorkValue = targetWorkValue * ratio;
        }

        const remainingWork = Math.max(0, targetWorkValue - currentWorkValue);
        const clearStats = this.computeNonEnhancingClearStats(
            attemptsLeft,
            successChance,
            doubleChance,
            progressPerSuccess,
            remainingWork
        );
        return {
            isEnhancing: false,
            clearChance: Math.min(1, Math.max(0, clearStats.clearChance || 0)),
            attemptsLeft,
            actionCounter,
            totalAttempts,
            successChance,
            doubleChance,
            currentWorkValue: Math.round(currentWorkValue),
            targetWorkValue: Math.round(targetWorkValue),
        };
    }

    /**
     * Update or create the live progress overlay
     */
    refreshLiveProgress(progress) {
        if (this.liveProgressTimeout) {
            clearTimeout(this.liveProgressTimeout);
        }
        // Progress messages arrive once per action (~8-10s base) — the stale timeout
        // must outlive the action interval or the display flickers away between actions
        const actionTimeMs = Math.max(1, Number(progress?.actionTimeMs) || BASE_SKILLING_TIME * 1000);
        const staleMs = Math.max(LIVE_PROGRESS_STALE_MS, actionTimeMs * 2 + 2000);
        this.liveProgressTimeout = setTimeout(() => this.clearLiveProgress(), staleMs);

        const estimate = this.computeLiveEstimate(progress);
        if (!estimate) return;

        const host =
            document.querySelector("div[class*='Header_actionName'] div[class*='Header_displayName']") ||
            document.querySelector("div[class*='Header_actionName']");
        if (!host) return;

        let node = host.querySelector(`.${LIVE_PROGRESS_CLASS}`);
        if (!node) {
            node = document.createElement('span');
            node.className = LIVE_PROGRESS_CLASS;
            node.style.cssText = 'color:#fff; font-size:0.875rem;';
            host.appendChild(node);
        }

        const chancePct = (estimate.clearChance * 100).toFixed(1);
        const attemptText = estimate.actionCounter > 0 ? ` | #${estimate.actionCounter}` : '';
        if (estimate.isEnhancing) {
            node.textContent = ` [Clear ${chancePct}% | +${estimate.currentLevel}/+${estimate.targetLevel} | ${estimate.attemptsLeft} left${attemptText}]`;
        } else {
            node.textContent = ` [Clear ${chancePct}% | ${estimate.attemptsLeft} left${attemptText}]`;
        }

        const tooltipLines = [
            `Success: ${(estimate.successChance * 100).toFixed(1)}% | Double: ${(estimate.doubleChance * 100).toFixed(1)}%`,
            `Actions: ${estimate.actionCounter}/${estimate.totalAttempts}`,
        ];
        if (estimate.isEnhancing) {
            tooltipLines.push(`Enhance: +${estimate.currentLevel}/+${estimate.targetLevel}`);
        } else {
            tooltipLines.push(`Progress: ${estimate.currentWorkValue}/${estimate.targetWorkValue}`);
        }
        node.title = tooltipLines.join('\n');
    }

    /**
     * Remove live progress overlay and clear timeout
     */
    clearLiveProgress() {
        if (this.liveProgressTimeout) {
            clearTimeout(this.liveProgressTimeout);
            this.liveProgressTimeout = null;
        }
        document.querySelectorAll(`.${LIVE_PROGRESS_CLASS}`).forEach((el) => el.remove());
    }

    // -------------------------------------------------------------------------
    // Per-tile clear chances on the active run grid
    // -------------------------------------------------------------------------

    /**
     * Find the grid container holding exactly all room cells of the active run
     */
    findRoomGridParent(totalCells) {
        const allCells = Array.from(document.querySelectorAll('div[class*="LabyrinthPanel_roomCell"]'));
        if (!allCells.length) return null;

        const parentCount = new Map();
        for (const cell of allCells) {
            const parent = cell.parentElement;
            if (!parent) continue;
            parentCount.set(parent, (parentCount.get(parent) || 0) + 1);
        }
        for (const [parent, count] of parentCount.entries()) {
            if (count === totalCells) return parent;
        }
        return null;
    }

    /**
     * Get the room cells of the active run in grid order
     */
    findRoomGridCells(totalCells) {
        const parent = this.findRoomGridParent(totalCells);
        if (!parent) return [];
        return Array.from(parent.children).filter((el) =>
            String(el.className || '').includes('LabyrinthPanel_roomCell')
        );
    }

    /**
     * Seed labyrinth state right after a page refresh, before any
     * labyrinth_updated message arrives. Tries the init character data first,
     * then falls back to reading the client's React state (the init payload
     * does not always carry the room grid, but the client state does).
     */
    seedFromCharacterData() {
        if (this.roomData) return;

        let labyrinth = dataManager.characterData?.characterLabyrinth;
        let roomData = this.parseRoomData(labyrinth?.roomData);
        if (!roomData) {
            labyrinth = this.getLabyrinthFromReactState();
            roomData = this.parseRoomData(labyrinth?.roomData);
        }
        if (!roomData) return;

        this.roomData = roomData;
        this.currentFloor = Math.max(0, Math.floor(Number(labyrinth.currentFloor) || 0));
    }

    /**
     * Normalize roomData that may arrive as an array or a JSON string
     */
    parseRoomData(raw) {
        if (Array.isArray(raw) && raw.length) return raw;
        if (typeof raw === 'string' && raw) {
            try {
                const parsed = JSON.parse(raw);
                return Array.isArray(parsed) && parsed.length ? parsed : null;
            } catch {
                return null;
            }
        }
        return null;
    }

    /**
     * Read characterLabyrinth from the game's React component state
     * (same approach as the reference script - the client always holds the
     * current labyrinth grid even when no WS update has arrived yet)
     */
    getLabyrinthFromReactState() {
        try {
            const rootEl = document.getElementById('root');
            const rootFiber =
                rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
            if (!rootFiber) return null;

            const queue = [rootFiber];
            let steps = 0;
            while (queue.length && steps < 20000) {
                const fiber = queue.shift();
                if (!fiber || typeof fiber !== 'object') continue;
                steps++;

                const state = fiber.stateNode?.state;
                if (state && typeof state === 'object' && state.characterLabyrinth) {
                    return state.characterLabyrinth;
                }

                if (fiber.child) queue.push(fiber.child);
                if (fiber.sibling) queue.push(fiber.sibling);
            }
        } catch {
            return null;
        }
        return null;
    }

    /**
     * Debounced auto tile calculation (no-op unless the setting is enabled)
     */
    scheduleAutoTileCalc() {
        if (!config.getSetting('labyrinthAutoCalcTiles')) return;
        if (this.autoTileTimer) clearTimeout(this.autoTileTimer);
        this.autoTileTimer = setTimeout(() => {
            this.autoTileTimer = null;
            this.runTileCalculation({ auto: true });
        }, 800);
    }

    /**
     * Remove clear-chance badges from rooms that have been cleared
     */
    pruneClearedTileBadges() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        const cols = Array.isArray(this.roomData[0]) ? this.roomData[0].length : 0;
        if (!cols || !flatRooms.length) return;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (cells.length !== flatRooms.length) return;

        for (let i = 0; i < flatRooms.length; i++) {
            if (!flatRooms[i]?.isCleared) continue;
            const pruneBadge = cells[i]?.querySelector(`.${TILE_BADGE_CLASS}`);
            if (pruneBadge) this.removeTileBadge(pruneBadge);
        }
    }

    /**
     * Inject the calculate control bar (top-left entries row when available)
     */
    injectTileControls() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        if (!flatRooms.length) return;

        const gridParent = this.findRoomGridParent(flatRooms.length);
        if (!gridParent || !gridParent.parentElement) return;

        const host = this.findEntriesRowHost(gridParent);
        const existing = document.querySelector(`.${TILE_CONTROLS_CLASS}`);
        if (existing && existing.isConnected) {
            const placedCorrectly = host ? existing.parentElement === host : existing.nextElementSibling === gridParent;
            if (placedCorrectly) return;
            existing.remove();
        }

        const container = document.createElement('div');
        container.className = TILE_CONTROLS_CLASS;
        container.style.cssText =
            'display:flex; flex-wrap:wrap; align-items:center; column-gap:6px; row-gap:3px; ' +
            'width:fit-content; max-width:100%; box-sizing:border-box; padding:4px 7px; margin:0 0 6px 0; ' +
            'border-radius:6px; background:rgba(0,0,0,0.62); color:#f0f4ff; box-shadow:0 2px 8px rgba(0,0,0,0.28); user-select:none;';

        const button = document.createElement('button');
        button.className = `${TILE_CONTROLS_CLASS}-button`;
        button.textContent = 'Calculate Labyrinth';
        button.style.cssText =
            'min-width:96px; padding:0 10px; height:20px; border:0; border-radius:5px; background:#3a88ff; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        button.addEventListener('click', () => this.runTileCalculation());
        container.appendChild(button);

        const hoursLabel = document.createElement('span');
        hoursLabel.style.cssText = 'font-size:11px; opacity:0.92; white-space:nowrap;';
        hoursLabel.textContent = 'Sim Hours';
        container.appendChild(hoursLabel);

        const hoursInput = document.createElement('input');
        hoursInput.type = 'number';
        hoursInput.min = '1';
        hoursInput.max = '100';
        hoursInput.step = '1';
        hoursInput.value = String(this.getSimHours());
        hoursInput.style.cssText =
            'width:52px; height:20px; box-sizing:border-box; border:1px solid rgba(150,190,255,0.45); border-radius:4px; ' +
            'background:rgba(20,28,42,0.9); color:#fff; font-size:11px; font-weight:700; text-align:center; outline:none;';
        hoursInput.addEventListener('change', () => {
            const n = Math.min(100, Math.max(1, Math.floor(Number(hoursInput.value) || 3)));
            hoursInput.value = String(n);
            config.setSettingValue('labyrinthRecommendSimHours', n);
            this.combatCache.clear();
        });
        container.appendChild(hoursInput);

        const pathButton = document.createElement('button');
        pathButton.className = `${TILE_CONTROLS_CLASS}-path-button`;
        pathButton.textContent = 'Path';
        pathButton.title =
            'Highlight the best route to the floor exit: fewest shrouds, then most treasure rooms, then fewest torches';
        pathButton.style.cssText =
            'min-width:44px; padding:0 10px; height:20px; border:0; border-radius:5px; background:#8e5bd8; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        pathButton.addEventListener('click', () => this.runPathCalculation());
        container.appendChild(pathButton);

        const pathLabel = document.createElement('span');
        pathLabel.style.cssText = 'font-size:11px; opacity:0.92; white-space:nowrap;';
        pathLabel.textContent = 'Clear ≥';
        pathLabel.title = 'Tiles below this clear chance (%) count as unclearable and cost a shroud on the path';
        container.appendChild(pathLabel);

        const pathInput = document.createElement('input');
        pathInput.className = `${TILE_CONTROLS_CLASS}-path-threshold`;
        pathInput.type = 'number';
        pathInput.min = '1';
        pathInput.max = '100';
        pathInput.step = '1';
        pathInput.value = String(config.getSettingValue('labyrinthPathClearThreshold', 70));
        pathInput.title = pathLabel.title;
        pathInput.style.cssText = hoursInput.style.cssText;
        pathInput.addEventListener('change', () => {
            const n = Math.min(100, Math.max(1, Math.floor(Number(pathInput.value) || 70)));
            pathInput.value = String(n);
            config.setSettingValue('labyrinthPathClearThreshold', n);
        });
        container.appendChild(pathInput);

        const unknownSelect = document.createElement('select');
        unknownSelect.className = `${TILE_CONTROLS_CLASS}-path-unknown`;
        unknownSelect.title = 'How the path treats unrevealed rooms';
        unknownSelect.style.cssText =
            'height:20px; box-sizing:border-box; border:1px solid rgba(150,190,255,0.45); border-radius:4px; ' +
            'background:rgba(20,28,42,0.9); color:#fff; font-size:11px; font-weight:700; outline:none; cursor:pointer;';
        for (const [value, label] of [
            ['clearable', '? Clear'],
            ['shroud', '? Shroud'],
            ['avoid', '? Avoid'],
        ]) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            unknownSelect.appendChild(opt);
        }
        unknownSelect.value = config.getSettingValue('labyrinthPathUnknownMode', 'clearable');
        unknownSelect.addEventListener('change', () => {
            config.setSettingValue('labyrinthPathUnknownMode', unknownSelect.value);
        });
        container.appendChild(unknownSelect);

        const beaconButton = document.createElement('button');
        beaconButton.className = `${TILE_CONTROLS_CLASS}-beacon-button`;
        beaconButton.textContent = 'Beacons';
        beaconButton.title =
            'Plan beacon placements: fewest beacons (or the set amount) whose reveal areas cover a walkable path to the exit, revealing as many rooms as possible';
        beaconButton.style.cssText =
            'min-width:54px; padding:0 10px; height:20px; border:0; border-radius:5px; background:#1d9e83; ' +
            'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
        beaconButton.addEventListener('click', () => this.runBeaconCalculation());
        container.appendChild(beaconButton);

        const beaconInput = document.createElement('input');
        beaconInput.className = `${TILE_CONTROLS_CLASS}-beacon-count`;
        beaconInput.type = 'number';
        beaconInput.min = '0';
        beaconInput.max = '20';
        beaconInput.step = '1';
        beaconInput.value = String(config.getSettingValue('labyrinthBeaconCount', 0));
        beaconInput.title = 'Beacons to place — 0 uses the fewest that cover a path to the exit';
        beaconInput.style.cssText = hoursInput.style.cssText;
        beaconInput.addEventListener('change', () => {
            const n = Math.min(20, Math.max(0, Math.floor(Number(beaconInput.value) || 0)));
            beaconInput.value = String(n);
            config.setSettingValue('labyrinthBeaconCount', n);
        });
        container.appendChild(beaconInput);

        if (config.getSetting('labyrinthRoomLogs')) {
            const logsButton = document.createElement('button');
            logsButton.textContent = 'Logs';
            logsButton.style.cssText =
                'min-width:54px; padding:0 10px; height:20px; border:0; border-radius:5px; background:rgba(77,151,255,0.95); ' +
                'color:#fff; font-size:11px; font-weight:700; line-height:1; white-space:nowrap; cursor:pointer;';
            logsButton.addEventListener('click', () => labyrinthRoomLogs.togglePanel());
            container.appendChild(logsButton);
        }

        const status = document.createElement('span');
        status.className = `${TILE_CONTROLS_CLASS}-status`;
        status.style.cssText = 'font-size:10px; color:#9ab0d8;';
        container.appendChild(status);

        const track = document.createElement('div');
        track.style.cssText =
            'flex:1 1 100%; width:100%; height:5px; border-radius:999px; background:rgba(255,255,255,0.2); overflow:hidden;';
        const bar = document.createElement('div');
        bar.className = `${TILE_CONTROLS_CLASS}-bar`;
        bar.style.cssText =
            'width:0%; height:100%; background:linear-gradient(90deg, #57d08a 0%, #8ed447 100%); transition:width 0.08s linear;';
        track.appendChild(bar);
        container.appendChild(track);

        if (host) {
            container.style.margin = '2px 0 2px 12px';
            host.appendChild(container);
        } else {
            gridParent.parentElement.insertBefore(container, gridParent);
        }
    }

    /**
     * Find the "N / M Entries · Max Path" info row at the top-left of the
     * labyrinth panel so the control bar can live there like the reference UI
     */
    findEntriesRowHost(gridParent) {
        const panelRoot =
            gridParent.closest('[class*="LabyrinthPanel_labyrinthPanel"]') ||
            gridParent.closest('[class*="LabyrinthPanel"]') ||
            gridParent.parentElement;
        if (!panelRoot) return null;

        // Match the element that directly holds the "Max Path" text. The text may
        // share its element with child elements (e.g. the Upgrade button), so
        // check each element's own text nodes rather than only pure leaf nodes.
        let marker = null;
        for (const node of panelRoot.querySelectorAll('div, span')) {
            let ownText = '';
            for (const child of node.childNodes) {
                if (child.nodeType === 3) ownText += child.textContent;
            }
            ownText = ownText.trim();
            if (ownText && ownText.length < 40 && /max path/i.test(ownText)) {
                marker = node;
                break;
            }
        }
        if (!marker) return null;

        let current = marker;
        for (let depth = 0; depth < 3 && current; depth++) {
            if (window.getComputedStyle(current).display.includes('flex')) {
                return current;
            }
            current = current.parentElement;
        }
        return marker.parentElement;
    }

    setTileStatus(message) {
        const status = document.querySelector(`.${TILE_CONTROLS_CLASS}-status`);
        if (status) status.textContent = message || '';
    }

    setTileProgress(ratio) {
        const bar = document.querySelector(`.${TILE_CONTROLS_CLASS}-bar`);
        if (bar) bar.style.width = `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
    }

    setTileButtonRunning(running) {
        const btn = document.querySelector(`.${TILE_CONTROLS_CLASS}-button`);
        if (btn) {
            btn.disabled = running;
            btn.textContent = running ? 'Calculating...' : 'Calculate Labyrinth';
            btn.style.opacity = running ? '0.75' : '1';
        }
    }

    /**
     * Compute and overlay clear chances on every calculable tile of the run grid
     */
    async runTileCalculation(options = {}) {
        const auto = options.auto === true;
        if (this.tileCalcRunning) return;
        if (!this.roomData) {
            if (!auto) this.setTileStatus('No labyrinth data');
            return;
        }

        const rows = this.roomData;
        const flatRooms = rows.flat();
        const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (!cols || cells.length !== flatRooms.length) {
            if (!auto) this.setTileStatus('Grid not found');
            return;
        }

        if (!this.calculatedTileKeys) {
            this.calculatedTileKeys = new Set();
        }
        // Manual runs recalculate everything; auto runs only touch new tiles
        if (!auto) {
            this.calculatedTileKeys.clear();
            this.autoTileRetryCount = 0;
            document.querySelectorAll(`.${TILE_BADGE_CLASS}`).forEach((el) => this.removeTileBadge(el));
        }

        // Gather targets first so the progress bar has a stable total
        const skillingTargets = [];
        const combatTargets = [];
        for (let i = 0; i < flatRooms.length; i++) {
            const room = flatRooms[i];
            const cell = cells[i];
            if (!room || !cell || room.isCleared) continue;

            const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
            if (roomLevel <= 0) continue;

            const tileKey = `${i % cols},${Math.floor(i / cols)}`;
            if (auto && this.calculatedTileKeys.has(tileKey) && cell.querySelector(`.${TILE_BADGE_CLASS}`)) {
                continue;
            }

            if (room.skillHrid) {
                skillingTargets.push({ room, cell, roomLevel, tileKey });
            } else if (room.monsterHrid) {
                combatTargets.push({ room, cell, roomLevel, tileKey });
            }
        }

        const total = skillingTargets.length + combatTargets.length;
        if (!total) {
            if (!auto) this.setTileStatus('No calculable tiles');
            return;
        }

        this.tileCalcRunning = true;
        this.setTileButtonRunning(true);
        this.setTileStatus('');
        this.setTileProgress(0);
        let completed = 0;

        try {
            for (const target of skillingTargets) {
                const result =
                    target.room.skillHrid === '/skills/enhancing'
                        ? this.computeEnhancingClear(target.roomLevel)
                        : this.computeSkillingClear(target.room.skillHrid, target.roomLevel);
                if (result) {
                    this.appendTileBadge(target.cell, result);
                    this.calculatedTileKeys.add(target.tileKey);
                }
                completed++;
                this.setTileProgress(completed / total);
            }

            let combatRetryNeeded = 0;
            for (const target of combatTargets) {
                const result = await this.computeCombatClear(target.room.monsterHrid, target.roomLevel);
                completed++;
                this.setTileProgress(completed / total);

                if (!result || result.failed) {
                    // Sim inputs not ready (e.g. loadout snapshots still loading) —
                    // leave the tile unbadged and unmarked so a retry picks it up
                    combatRetryNeeded++;
                    continue;
                }
                if (!target.cell.isConnected) continue;

                this.appendTileBadge(target.cell, result);
                if (result.clearChance > 0 || !auto) {
                    this.calculatedTileKeys.add(target.tileKey);
                } else {
                    // A 0% right after load is suspicious — keep the key unmarked
                    // so the next auto pass re-sims it with loaded snapshots
                    combatRetryNeeded++;
                }
            }

            this.setTileProgress(1);

            if (auto && combatRetryNeeded > 0 && (this.autoTileRetryCount || 0) < 3) {
                this.autoTileRetryCount = (this.autoTileRetryCount || 0) + 1;
                if (this.autoTileTimer) clearTimeout(this.autoTileTimer);
                this.autoTileTimer = setTimeout(() => {
                    this.autoTileTimer = null;
                    this.runTileCalculation({ auto: true });
                }, 2500);
            } else if (combatRetryNeeded === 0) {
                this.autoTileRetryCount = 0;
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Tile calculation failed:', error);
            this.setTileStatus('Failed');
        } finally {
            this.tileCalcRunning = false;
            this.setTileButtonRunning(false);
        }
    }

    /**
     * Compute and highlight the optimal route to the floor exit.
     * Clear chances come from the same per-tile math as the badges; the
     * clearable threshold is its own setting, separate from the skip
     * recommendation target.
     */
    async runPathCalculation() {
        if (this.pathCalcRunning) return;
        if (!this.roomData) {
            this.setTileStatus('No labyrinth data');
            return;
        }

        const rows = this.roomData;
        const flat = rows.flat();
        const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
        const cells = this.findRoomGridCells(flat.length);
        if (!cols || cells.length !== flat.length) {
            this.setTileStatus('Grid not found');
            return;
        }

        const input = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-threshold`);
        const thresholdPct = Math.min(
            100,
            Math.max(1, Math.floor(Number(input?.value) || config.getSettingValue('labyrinthPathClearThreshold', 70)))
        );
        if (input) input.value = String(thresholdPct);
        config.setSettingValue('labyrinthPathClearThreshold', thresholdPct);
        const threshold = thresholdPct / 100;

        const unknownSelect = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-unknown`);
        const unknownMode = unknownSelect?.value || config.getSettingValue('labyrinthPathUnknownMode', 'clearable');

        this.clearPathOverlays();
        this.pathCalcRunning = true;
        this.setPathButtonRunning(true);

        try {
            // Classify every room and gather clear chances (treasure, the exit,
            // and the entrance are freely enterable; combat needs sims, cached
            // when possible). Position is the reliable structural signal: the
            // grid always starts top-left and exits bottom-right, and
            // unrevealed rooms carry an empty roomType — the exit/treasure
            // types only appear once a room is revealed.
            // Every cell is a room — the labyrinth has no walls. Unrevealed
            // rooms appear as null entries (or empty-typed rooms) in roomData
            // because the server hides their contents, so they are passable
            // unknowns, never obstacles.
            const tiles = new Array(flat.length).fill(null);
            const combatToSim = [];
            for (let i = 0; i < flat.length; i++) {
                const room = flat[i];
                const type = String(room?.roomType || '');
                const tile = {
                    index: i,
                    room,
                    cleared: !!room?.isCleared,
                    isEntrance: i === 0 || /\/(entrance|start)$/.test(type),
                    isTreasure: type.endsWith('/treasure'),
                    isExit: i === flat.length - 1 || /\/(descend|exit|finish|flag|victory)$/.test(type),
                    isUnknown: !room || (!type && !room.skillHrid && !room.monsterHrid && !room.isCleared),
                    clearChance: 1,
                    needsShroud: false,
                };
                tiles[i] = tile;
                if (tile.cleared || tile.isEntrance || tile.isTreasure || tile.isExit || tile.isUnknown) continue;

                const roomLevel = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
                if (room.skillHrid && roomLevel > 0) {
                    const result =
                        room.skillHrid === '/skills/enhancing'
                            ? this.computeEnhancingClear(roomLevel)
                            : this.computeSkillingClear(room.skillHrid, roomLevel);
                    tile.clearChance = result ? result.clearChance : 1;
                } else if (room.monsterHrid && roomLevel > 0) {
                    combatToSim.push({ tile, roomLevel });
                }
            }

            for (let i = 0; i < combatToSim.length; i++) {
                const { tile, roomLevel } = combatToSim[i];
                this.setTileStatus(`Pathing: fight sims ${i + 1}/${combatToSim.length}`);
                const result = await this.computeCombatClear(tile.room.monsterHrid, roomLevel);
                tile.clearChance = result && !result.failed ? result.clearChance : 0;
            }
            for (const tile of tiles) {
                if (tile && !tile.cleared && !tile.isEntrance && !tile.isTreasure && !tile.isExit && !tile.isUnknown) {
                    tile.needsShroud = tile.clearChance < threshold;
                }
            }

            // Unrevealed-room posture: optimistic (clearable, default),
            // pessimistic (each costs a shroud), or avoid (impassable — route
            // through revealed rooms only; entrance/exit always stay passable)
            for (let i = 0; i < tiles.length; i++) {
                const tile = tiles[i];
                if (!tile?.isUnknown || tile.cleared || tile.isEntrance || tile.isExit) continue;
                if (unknownMode === 'shroud') {
                    tile.needsShroud = true;
                } else if (unknownMode === 'avoid') {
                    tiles[i] = null;
                }
            }

            const path = computeLabyrinthPath(tiles, cols);
            if (!path) {
                this.setTileStatus(
                    unknownMode === 'avoid'
                        ? 'No route through revealed rooms — reveal more or change the ? mode'
                        : 'No route to the floor exit'
                );
                return;
            }

            let unknownCount = 0;
            for (const idx of path.route) {
                const tile = tiles[idx];
                const cell = cells[idx];
                if (!tile || tile.cleared || tile.isEntrance || !cell) continue;
                let color;
                let label = '';
                if (tile.isExit) {
                    color = '#c792ff';
                    label = '⚑';
                } else if (tile.isTreasure) {
                    color = '#ffd54f';
                } else if (tile.needsShroud) {
                    color = '#ff5252';
                    label = tile.isUnknown ? 'Shroud?' : 'Shroud';
                } else if (tile.isUnknown) {
                    // Unrevealed room — routed as clearable; reveal to verify
                    color = '#8fb4d8';
                    label = '?';
                } else {
                    color = '#57d08a';
                }
                if (tile.isUnknown && !tile.isExit) unknownCount++;
                this.appendPathOverlay(cell, color, label);
            }

            const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
            const unknownText = unknownCount ? ` · ${plural(unknownCount, 'unrevealed room')}` : '';
            this.setTileStatus(
                `Path: ${plural(path.torches, 'room')} · ${plural(path.shrouds, 'shroud')} · ${plural(path.chests.size, 'chest')}${unknownText}`
            );
        } catch (error) {
            console.error('[LabyrinthClearRate] Path calculation failed:', error);
            this.setTileStatus('Path failed');
        } finally {
            this.pathCalcRunning = false;
            this.setPathButtonRunning(false);
        }
    }

    /**
     * Outline a run-grid tile as part of the computed route
     */
    appendPathOverlay(cell, color, label) {
        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        const overlay = document.createElement('div');
        overlay.className = PATH_OVERLAY_CLASS;
        overlay.style.cssText =
            `position:absolute; inset:0; border:2px solid ${color}; border-radius:6px; ` +
            'pointer-events:none; z-index:8; box-sizing:border-box;';
        if (label) {
            const tag = document.createElement('div');
            tag.style.cssText =
                `position:absolute; top:1px; left:1px; padding:0 3px; border-radius:3px; background:${color}; ` +
                'color:#000; font-size:8px; font-weight:700; line-height:1.4;';
            tag.textContent = label;
            overlay.appendChild(tag);
        }
        cell.appendChild(overlay);
    }

    clearPathOverlays() {
        document.querySelectorAll(`.${PATH_OVERLAY_CLASS}`).forEach((el) => el.remove());
    }

    /**
     * Compute and highlight optimal beacon placements: the fewest beacons (or
     * the configured count) whose reveal areas cover a walkable corridor to
     * the floor exit, revealing as many new rooms as possible.
     */
    runBeaconCalculation() {
        if (!this.roomData) {
            this.setTileStatus('No labyrinth data');
            return;
        }

        const rows = this.roomData;
        const flat = rows.flat();
        const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
        const cells = this.findRoomGridCells(flat.length);
        if (!cols || cells.length !== flat.length) {
            this.setTileStatus('Grid not found');
            return;
        }

        const countInput = document.querySelector(`.${TILE_CONTROLS_CLASS}-beacon-count`);
        const count = Math.min(20, Math.max(0, Math.floor(Number(countInput?.value) || 0)));
        if (countInput) countInput.value = String(count);
        config.setSettingValue('labyrinthBeaconCount', count);

        // A room is revealed when its contents are known (typed room or cleared);
        // the entrance always is
        const revealed = flat.map(
            (room, i) => i === 0 || (!!room && (String(room.roomType || '') !== '' || !!room.isCleared))
        );

        this.clearBeaconOverlays();
        const plan = computeBeaconPlan(revealed, cols, count);
        if (!plan) {
            this.setTileStatus('Beacon planning failed');
            return;
        }
        if (!plan.feasible) {
            this.setTileStatus(
                Number.isFinite(plan.minNeeded)
                    ? `Need at least ${plan.minNeeded} beacons for a covered path`
                    : 'No beacon chain can reach the exit'
            );
            return;
        }
        if (plan.minNeeded === 0) {
            const routeNote = plan.routes >= 2 ? ` (${plan.routes} independent routes)` : '';
            this.setTileStatus(`Path to the exit is already revealed — no beacons needed${routeNote}`);
            return;
        }

        for (const idx of plan.covered) {
            const cell = cells[idx];
            if (cell) this.appendBeaconOverlay(cell, false, '');
        }
        plan.beacons.forEach((idx, i) => {
            const cell = cells[idx];
            if (cell) this.appendBeaconOverlay(cell, true, `B${i + 1}`);
        });

        const minNote = count === 0 ? ' (min)' : '';
        const routeText = plan.routes >= 2 ? `${plan.routes} independent routes` : '1 route';
        this.setTileStatus(
            `Beacons: ${plan.beacons.length}${minNote} · reveals ${plan.revealedNew} new rooms · ${routeText}`
        );
    }

    /**
     * Highlight a tile as beacon coverage (fill) or a beacon center (outline + label)
     */
    appendBeaconOverlay(cell, isCenter, label) {
        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        const overlay = document.createElement('div');
        overlay.className = BEACON_OVERLAY_CLASS;
        overlay.style.cssText = isCenter
            ? 'position:absolute; inset:0; border:2px solid #26d0aa; border-radius:6px; ' +
              'pointer-events:none; z-index:8; box-sizing:border-box;'
            : 'position:absolute; inset:0; background:rgba(38,166,154,0.22); border:1px solid rgba(38,166,154,0.45); ' +
              'border-radius:6px; pointer-events:none; z-index:7; box-sizing:border-box;';
        if (label) {
            const tag = document.createElement('div');
            tag.style.cssText =
                'position:absolute; top:1px; right:1px; padding:0 3px; border-radius:3px; background:#26d0aa; ' +
                'color:#04263f; font-size:8px; font-weight:700; line-height:1.4;';
            tag.textContent = label;
            overlay.appendChild(tag);
        }
        cell.appendChild(overlay);
    }

    clearBeaconOverlays() {
        document.querySelectorAll(`.${BEACON_OVERLAY_CLASS}`).forEach((el) => el.remove());
    }

    /**
     * Remove path outlines from rooms that have been cleared since the route
     * was computed, so the highlight tracks remaining progress
     */
    pruneClearedPathOverlays() {
        if (!this.roomData) return;
        const flatRooms = this.roomData.flat();
        if (!flatRooms.length) return;
        const cells = this.findRoomGridCells(flatRooms.length);
        if (cells.length !== flatRooms.length) return;

        for (let i = 0; i < flatRooms.length; i++) {
            if (!flatRooms[i]?.isCleared) continue;
            cells[i]?.querySelector(`.${PATH_OVERLAY_CLASS}`)?.remove();
        }
    }

    setPathButtonRunning(running) {
        const btn = document.querySelector(`.${TILE_CONTROLS_CLASS}-path-button`);
        if (btn) {
            btn.disabled = running;
            btn.textContent = running ? 'Pathing...' : 'Path';
            btn.style.opacity = running ? '0.75' : '1';
        }
    }

    /**
     * Overlay a clear-chance badge in the corner of a run grid tile
     */
    /**
     * Remove a tile badge and drop its cell's preview binding so cleared or
     * reset tiles stop showing hover tooltips
     * @param {HTMLElement} badge - Badge element inside a tile cell
     */
    removeTileBadge(badge) {
        const cell = badge.parentElement;
        if (cell) cell.__mwiPreviewResult = null;
        badge.remove();
    }

    appendTileBadge(cell, result) {
        cell.querySelector(`.${TILE_BADGE_CLASS}`)?.remove();

        const chance = Math.min(1, Math.max(0, result.clearChance ?? 0));
        const pct = Math.round(chance * 100);

        const badge = document.createElement('div');
        badge.className = TILE_BADGE_CLASS;
        badge.style.cssText =
            'position:absolute; right:1px; bottom:1px; z-index:9; max-width:calc(100% - 2px); padding:1px 3px; ' +
            'border-radius:3px; box-sizing:border-box; display:flex; align-items:baseline; justify-content:flex-end; gap:2px; ' +
            'white-space:nowrap; color:#fff; text-shadow:0 1px 1px rgba(0,0,0,0.55); pointer-events:auto; ' +
            `background:${this.getTileBadgeColor(chance)};`;

        const chanceSpan = document.createElement('span');
        chanceSpan.style.cssText = 'font-size:9px; font-weight:700; line-height:1;';
        chanceSpan.textContent = `${pct}%`;

        const etaSpan = document.createElement('span');
        etaSpan.style.cssText = 'font-size:8px; font-weight:600; line-height:1; opacity:0.95;';
        etaSpan.textContent = this.formatEtaSeconds(result.expectedSeconds ?? result.avgFightSeconds, pct);

        badge.appendChild(chanceSpan);
        badge.appendChild(etaSpan);

        // Rich preview for every tile type, triggered from anywhere in the tile
        this.bindPreview(cell, result);

        const cellStyle = window.getComputedStyle(cell);
        if (cellStyle.position === 'static') {
            cell.style.position = 'relative';
        }
        cell.appendChild(badge);
    }

    getTileBadgeColor(clearChance) {
        if (clearChance >= 0.95) return '#1fbf60';
        if (clearChance >= 0.8) return '#77b82a';
        if (clearChance >= 0.6) return '#d2ac19';
        if (clearChance >= 0.4) return '#d27a1f';
        return '#d84b4b';
    }

    formatEtaSeconds(expectedSeconds, pct) {
        if (pct === 0 || !Number.isFinite(expectedSeconds)) return '999+';
        const seconds = Math.max(0, Math.ceil(expectedSeconds));
        return seconds > 999 ? '999+' : `${seconds}s`;
    }

    findRoomByMonsterHrid(monsterHrid) {
        if (!this.roomData) return null;
        for (const row of this.roomData) {
            for (const cell of row) {
                if (cell && cell.monsterHrid === monsterHrid) {
                    return cell;
                }
            }
        }
        return null;
    }

    /**
     * Inject clear rate overlays onto visible labyrinth room cells
     */
    injectOverlays() {
        const cells = document.querySelectorAll('[class*="LabyrinthPanel_skipThreshold"]');
        if (!cells.length) return;

        document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
        this.simQueue = [];

        for (const cell of cells) {
            const roomHrid = this.extractRoomHrid(cell);
            if (!roomHrid) continue;

            const isSkill = roomHrid.startsWith('/skills/');
            const isMonster = roomHrid.startsWith('/monsters/');
            if (!isSkill && !isMonster) continue;

            if (isSkill) {
                let roomLevel = null;
                if (this.roomData) {
                    const room = this.findRoomByHrid(roomHrid);
                    if (room && !room.isCleared) {
                        roomLevel = Number(room.recommendedLevel || 0);
                    }
                }
                if (!roomLevel) {
                    roomLevel = this.getTargetRoomLevel(roomHrid);
                }
                if (!roomLevel || roomLevel <= 0) continue;

                const isEnhancing = roomHrid === '/skills/enhancing';
                const result = isEnhancing
                    ? this.computeEnhancingClear(roomLevel)
                    : this.computeSkillingClear(roomHrid, roomLevel);

                if (!result) continue;
                this.appendBadge(cell, result, roomLevel);
            } else {
                const roomLevel = this.getCombatRoomLevel(roomHrid);
                if (!roomLevel || roomLevel <= 0) continue;

                const cached = this.getCachedCombatResult(roomHrid, roomLevel);
                if (cached) {
                    this.appendBadge(cell, cached, roomLevel);
                } else {
                    const badge = this.appendPlaceholderBadge(cell);
                    this.queueCombatSim(roomHrid, roomLevel, badge);
                }
            }
        }

        this.processSimQueue();
        this.injectRecommendControls();
        this.injectRecommendationBadges();
    }

    appendBadge(cell, result, roomLevel) {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.style.cssText = 'font-size:0.7rem; white-space:nowrap;';
        this.decorateBadge(badge, result, roomLevel);
        getAnnotationContainer(cell).appendChild(badge);
        return badge;
    }

    /**
     * Apply text (with max reachable floor), color, and hover preview to a badge
     */
    decorateBadge(badge, result, roomLevel) {
        badge.style.color = this.getBadgeColor(result.clearChance);
        const pct = Math.round(result.clearChance * 100);
        const timeText = this.formatTime(result.expectedSeconds);
        const maxFloor = Math.floor((roomLevel || 0) / 20);
        const floorText = maxFloor >= 1 ? `F${maxFloor} · ` : '';
        badge.textContent = pct >= 100 ? `${floorText}${timeText}` : `${floorText}${pct}% ${timeText}`;

        if (result.type === 'skilling' || result.type === 'enhancing') {
            badge.removeAttribute('title');
            this.bindPreview(badge, result);
        } else {
            badge.title = this.formatTooltip(result, roomLevel);
        }
    }

    appendPlaceholderBadge(cell) {
        const badge = document.createElement('span');
        badge.className = BADGE_CLASS;
        badge.style.cssText = 'font-size:0.7rem; white-space:nowrap; color:#999;';
        badge.textContent = '...';
        badge.title = 'Simulating combat...';
        getAnnotationContainer(cell).appendChild(badge);
        return badge;
    }

    updateBadge(badge, result, roomLevel) {
        this.decorateBadge(badge, result, roomLevel);
    }

    /**
     * Find a room in cached roomData matching the extracted HRID
     */
    findRoomByHrid(skillHrid) {
        if (!this.roomData) return null;
        for (const row of this.roomData) {
            for (const cell of row) {
                if (cell && cell.skillHrid === skillHrid) {
                    return cell;
                }
            }
        }
        return null;
    }

    /**
     * Extract skill HRID from a skip threshold cell's row
     */
    extractRoomHrid(cell) {
        try {
            const row = cell.closest('tr');
            if (!row) return null;

            const useEl = row.querySelector('[class*="LabyrinthPanel_roomLabel"] use');
            if (!useEl) return null;

            const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href');
            if (!href) return null;

            const slug = href.split('#')[1];
            if (!slug) return null;

            if (href.includes('skills_sprite')) {
                return `/skills/${slug}`;
            }
            return `/monsters/${slug}`;
        } catch {
            return null;
        }
    }

    /**
     * Bind hover preview events to a badge (result stored on the element so
     * updates replace content without re-binding listeners)
     */
    bindPreview(badge, result) {
        badge.__mwiPreviewResult = result;
        if (badge.__mwiPreviewBound) return;
        badge.__mwiPreviewBound = true;
        badge.style.cursor = 'help';
        const show = (e) => {
            const res = badge.__mwiPreviewResult;
            if (!res) return;
            this.showPreview(res, e.clientX, e.clientY);
        };
        badge.addEventListener('mouseenter', show);
        badge.addEventListener('mousemove', show);
        badge.addEventListener('mouseleave', () => this.hidePreview());
        badge.addEventListener('contextmenu', (e) => {
            const res = badge.__mwiPreviewResult;
            if (!res) return;
            const isCombat = res.type === 'combat';
            if (isCombat ? !res.monsterHrid : !res.skillHrid) return;
            const simButton = document.querySelector('.toolasha-lab-sim-btn');
            if (!simButton) return;
            e.preventDefault();
            const panel = document.getElementById('mwi-lab-sim-panel');
            if (!panel || panel.style.display === 'none') {
                simButton.click();
            }
            // Preconfigure the sim from this tile: combat tiles select the
            // monster (applying its assigned loadout) at the tile's room
            // level; skilling tiles open the Skilling tab at that level
            document.dispatchEvent(
                new CustomEvent('mwi-labsim-open', {
                    detail: isCombat
                        ? { monsterHrid: res.monsterHrid, roomLevel: res.roomLevel }
                        : { skillHrid: res.skillHrid, roomLevel: res.roomLevel },
                })
            );
            this.hidePreview();
        });
    }

    /**
     * Get or create the shared preview tooltip element
     */
    ensurePreviewEl() {
        let el = document.getElementById(PREVIEW_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = PREVIEW_ID;
            el.style.cssText =
                'position:fixed; min-width:180px; max-width:260px; padding:6px 9px; border-radius:6px; ' +
                'border:1px solid rgba(128,170,255,0.45); background:rgba(12,16,24,0.96); color:#f2f7ff; ' +
                `font-size:11px; line-height:1.4; pointer-events:none; display:none; z-index:${config.Z_NOTIFICATION};`;
            document.body.appendChild(el);
        }
        return el;
    }

    /**
     * Show the rich preview for a skilling/enhancing result near the cursor
     */
    showPreview(result, x, y) {
        const el = this.ensurePreviewEl();
        if (this._previewFor !== result) {
            this.renderPreviewContent(el, result);
            this._previewFor = result;
        }
        el.style.display = 'block';

        const offset = 12;
        const margin = 8;
        const width = el.offsetWidth || 200;
        const height = el.offsetHeight || 150;
        let left = x + offset;
        let top = y + offset;
        if (left + width + margin > window.innerWidth) {
            left = Math.max(margin, x - width - offset);
        }
        if (top + height + margin > window.innerHeight) {
            top = Math.max(margin, y - height - offset);
        }
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
    }

    hidePreview() {
        const el = document.getElementById(PREVIEW_ID);
        if (el) el.style.display = 'none';
        this._previewFor = null;
    }

    /**
     * Build the preview tooltip content for a skilling/enhancing result
     */
    renderPreviewContent(el, result) {
        el.textContent = '';
        const pct = (v) => `${(Math.min(1, Math.max(0, v)) * 100).toFixed(1)}%`;
        const deltaPct = (v) => `+${(Math.max(0, v) * 100).toFixed(2)}%`;

        const titleText =
            result.type === 'combat'
                ? `${result.monsterName}`
                : `${result.type === 'enhancing' ? 'Enhancing' : 'Skilling'} Room Preview`;
        const title = document.createElement('div');
        title.style.cssText = 'margin-bottom:4px; font-weight:700; color:#9ec4ff;';
        title.textContent = titleText;
        el.appendChild(title);

        const addRow = (label, value) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; gap:10px; white-space:nowrap;';
            const labelEl = document.createElement('span');
            labelEl.style.opacity = '0.75';
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.style.fontWeight = '700';
            valueEl.textContent = value;
            row.appendChild(labelEl);
            row.appendChild(valueEl);
            el.appendChild(row);
        };

        if (result.type === 'combat') {
            this.renderCombatPreviewRows(addRow, result);
            return;
        }

        if (result.type === 'enhancing') {
            addRow('Target Enhancement', `+${result.targetLevel}`);
        } else {
            const raw = result.workPower;
            const floored = result.progressPerSuccess;
            addRow(
                'Work Power',
                Math.abs(raw - floored) < 1e-9 ? raw.toFixed(2) : `${raw.toFixed(2)} \u2192 ${floored}`
            );
        }
        addRow('Success Rate', pct(result.successChance));
        addRow('Double Progress', pct(result.doubleChance));
        addRow('Actions in 2m', `${result.attempts}`);
        addRow('Action Duration', `${result.actionSeconds.toFixed(2)}s`);
        if (result.xpPerRoom) {
            addRow('EXP / Room', `${result.xpPerRoom.toFixed(1)}`);
        }
        if (result.xpPerHour > 0) {
            addRow('EXP / Hour', `${(result.xpPerHour / 1000).toFixed(1)}K`);
        }
        if (result.type !== 'enhancing') {
            addRow(
                'Efficiency for -1 Progress',
                result.efficiencyDelta === null ? 'Already optimal' : deltaPct(result.efficiencyDelta)
            );
        }
        if (Number.isFinite(result.speedDelta)) {
            addRow('Speed for +1 Action', deltaPct(result.speedDelta));
        }
        if (Number.isFinite(result.nextLevelClearChance)) {
            addRow('Next Level Clear %', pct(result.nextLevelClearChance));
        }
        if (result.type !== 'enhancing') {
            addRow(
                'Efficiency Tier Clear %',
                Number.isFinite(result.efficiencyTierClearChance)
                    ? pct(result.efficiencyTierClearChance)
                    : 'Already optimal'
            );
        }
        if (Number.isFinite(result.speedTierClearChance)) {
            addRow('Speed Tier Clear %', pct(result.speedTierClearChance));
        }
        if (Number.isFinite(result.nextSuccessUpgradeClearChance)) {
            addRow('Next Success Upgrade', pct(result.nextSuccessUpgradeClearChance));
        }
        if (Number.isFinite(result.nextDoubleUpgradeClearChance)) {
            addRow('Next Double Upgrade', pct(result.nextDoubleUpgradeClearChance));
        }

        this.appendExpectedRows(addRow, result.type);
        if (result.skillHrid && document.querySelector('.toolasha-lab-sim-btn')) {
            addRow('Action', 'Right-click to open simulator');
        }
    }

    /**
     * Render the rich combat tile preview: scaled monster stats, abilities,
     * rewards, loadout, and the sim-derived failure reason.
     * @param {Function} addRow - Row builder from renderPreviewContent
     * @param {Object} result - Combat clear result
     */
    renderCombatPreviewRows(addRow, result) {
        const styleName = (hrid) => {
            const tail =
                String(hrid || '')
                    .split('/')
                    .pop() || '';
            return tail.charAt(0).toUpperCase() + tail.slice(1);
        };

        const monster = this.buildScaledMonster(result.monsterHrid, result.roomLevel);
        const gameData = dataManager.getInitClientData();
        const monsterDetail = gameData?.combatMonsterDetailMap?.[result.monsterHrid];

        if (monster) {
            const stats = monster.combatDetails.combatStats;
            const styleHrid = stats.combatStyleHrid || stats.combatStyleHrids?.[0] || '';
            const styleKey = String(styleHrid).split('/').pop() || 'stab';
            const damageTypeHrid = stats.damageType || '/damage_types/physical';

            addRow('Combat Style', styleName(styleHrid));
            addRow('Damage Type', styleName(damageTypeHrid));
            addRow('Attack Interval', `${(stats.attackInterval / 1e9).toFixed(2)}s`);
            addRow('Cast Speed', `${Math.round((stats.castSpeed || 0) * 100)}%`);
            addRow(
                `${styleName(styleHrid)} Accuracy`,
                `${Math.round(monster.combatDetails[`${styleKey}AccuracyRating`] || 0)}`
            );
            addRow(
                `${styleName(styleHrid)} Damage`,
                `${Math.round(monster.combatDetails[`${styleKey}MaxDamage`] || 0)}`
            );
            addRow('Max HP', `${Math.round(monster.combatDetails.maxHitpoints || 0)}`);

            // Evasion vs the player's own combat style, mitigation vs their damage type
            const playerStats = dataManager.characterData?.combatUnit?.combatDetails?.combatStats;
            const playerStyleHrid = playerStats?.combatStyleHrids?.[0] || '/combat_styles/stab';
            const playerStyleKey = String(playerStyleHrid).split('/').pop();
            const playerDamageType = playerStats?.damageType || '/damage_types/physical';
            addRow(
                `${styleName(playerStyleHrid)} Evasion`,
                `${Math.round(monster.combatDetails[`${playerStyleKey}EvasionRating`] || 0)}`
            );
            if (playerDamageType === '/damage_types/physical') {
                addRow('Armor', `${Math.round(monster.combatDetails.totalArmor || 0)}`);
            } else {
                const resistKey = `total${styleName(playerDamageType)}Resistance`;
                addRow(
                    `${styleName(playerDamageType)} Resistance`,
                    `${Math.round(monster.combatDetails[resistKey] || 0)}`
                );
            }
        }

        // Ability list at labyrinth-scaled levels (same floor-scaling as the sim engine)
        if (Array.isArray(monsterDetail?.abilities)) {
            const scale = result.roomLevel > 0 ? result.roomLevel / 100 : 1;
            const abilityMap = gameData?.abilityDetailMap || {};
            for (const ability of monsterDetail.abilities) {
                if (!ability?.abilityHrid) continue;
                const level = Math.max(1, Math.floor((ability.level || 1) * scale));
                const name =
                    abilityMap[ability.abilityHrid]?.name || ability.abilityHrid.split('/').pop().replace(/_/g, ' ');
                addRow(`Lv.${level}`, name);
            }
        }

        this.appendExpectedRows(addRow, 'combat');
        if (result.loadoutName) {
            addRow('Loadout', `"${result.loadoutName}"`);
        }
        addRow('Win Rate', `${(Math.min(1, Math.max(0, result.winRate)) * 100).toFixed(1)}%`);
        if (document.querySelector('.toolasha-lab-sim-btn')) {
            addRow('Action', 'Right-click to open simulator');
        }
        if (result.failureReason) {
            addRow('Failure Reason', result.failureReason);
        }
    }

    /**
     * Build a labyrinth-scaled engine Monster for tooltip stats. Uses the same
     * scaling as the simulation so displayed numbers match simmed numbers.
     * @param {string} monsterHrid
     * @param {number} roomLevel
     * @returns {Monster|null}
     */
    buildScaledMonster(monsterHrid, roomLevel) {
        if (!monsterHrid) return null;
        const cacheKey = `${monsterHrid}|${roomLevel}`;
        if (!this._scaledMonsterCache) this._scaledMonsterCache = new Map();
        if (this._scaledMonsterCache.has(cacheKey)) return this._scaledMonsterCache.get(cacheKey);

        let monster = null;
        try {
            const payload = buildGameDataPayload();
            if (payload) {
                setGameData(payload);
                monster = new Monster(monsterHrid, 0, roomLevel);
                monster.updateCombatDetails();
            }
        } catch (error) {
            console.error('[LabyrinthClearRate] Failed to build scaled monster for preview:', error);
            monster = null;
        }
        this._scaledMonsterCache.set(cacheKey, monster);
        return monster;
    }

    /**
     * Append the expected token/box reward rows for the current floor
     * @param {Function} addRow - Row builder from renderPreviewContent
     * @param {string} [type] - Result type; picks the box label (combat vs skilling)
     */
    appendExpectedRows(addRow, type) {
        const floor = Math.max(0, Math.floor(Number(this.currentFloor) || 0));
        if (floor >= 1) {
            const boxLabel = type === 'combat' ? 'Combat Box Expected' : 'Skilling Box Expected';
            addRow('Token Expected', `${Math.min(floor * 0.05, 0.5).toFixed(2)}`);
            addRow(boxLabel, `${Math.min(floor * 0.01, 0.1).toFixed(2)}`);
        }
    }

    formatTooltip(result, roomLevel) {
        const pct = (v) => `${(v * 100).toFixed(1)}%`;

        if (result.type === 'skilling') {
            return [
                `Success: ${pct(result.successChance)} | Double: ${pct(result.doubleChance)}`,
                `Actions: ${result.attempts} @ ${result.actionSeconds.toFixed(2)}s each`,
                `Work Power: ${Math.floor(result.workPower)} → Progress: ${result.progressPerSuccess}/${result.targetProgress} per success`,
                `Effective Level: ${Math.floor(result.effectiveLevel)} (base ${result.baseLevel} + ${Math.floor(result.effectiveLevel - result.baseLevel)})`,
                `Room Level: ${result.roomLevel} | XP/room: ${result.xpPerRoom}`,
            ].join('\n');
        }

        if (result.type === 'enhancing') {
            return [
                `Success: ${pct(result.successChance)} | Double: ${pct(result.doubleChance)}`,
                `Actions: ${result.attempts} @ ${result.actionSeconds.toFixed(2)}s each`,
                `Target: +${result.targetLevel} | Effective Level: ${Math.floor(result.effectiveLevel)}`,
                `Room Level: ${result.roomLevel}`,
            ].join('\n');
        }

        if (result.type === 'combat') {
            return [
                `Win Rate: ${pct(result.winRate)} | Avg Fight: ${Math.round(result.avgFightSeconds)}s`,
                `Monster: ${result.monsterName} | Room Level: ${result.roomLevel}`,
                `Loadout: "${result.loadoutName}"`,
            ].join('\n');
        }

        const clearPct = Math.round(result.clearChance * 100);
        const timeText = this.formatTime(result.expectedSeconds);
        return `Clear: ${clearPct}% | Expected: ${timeText} | Room level: ${roomLevel}`;
    }

    getBadgeColor(clearChance) {
        if (clearChance >= 0.95) return '#00c896';
        if (clearChance >= 0.7) return '#f0ad4e';
        return '#d9534f';
    }

    /**
     * Compute skilling metrics from override buff arrays instead of live data.
     * @param {string} skillId - e.g. "woodcutting"
     * @param {string} actionTypeHrid - e.g. "/action_types/woodcutting"
     * @param {Object} overrides
     * @param {Array} [overrides.equipmentBuffs] - Equipment buff objects for this action type
     * @param {Array} [overrides.communityBuffs] - Community buff objects
     * @param {Array} [overrides.houseBuffs] - House room buff objects
     * @param {Array} [overrides.crateBuffs] - Crate buff objects
     * @param {Object} [overrides.tokenUpgrades] - {speed, efficiency, success, doubleProgress}
     * @returns {Object} {skillLevelBonus, efficiencyBonus, actionSpeedBonus, successBonus, doubleProgressBonus}
     */
    getSkillingMetricsFromOverrides(skillId, actionTypeHrid, overrides) {
        const metrics = {
            skillLevelBonus: 0,
            efficiencyBonus: 0,
            actionSpeedBonus: 0,
            successBonus: 0,
            doubleProgressBonus: 0,
            gatheringBonus: 0,
            experienceBonus: 0,
        };

        const skillLevelType = `/buff_types/${skillId}_level`;
        const skillSuccessType = `/buff_types/${skillId}_success`;

        const buffSources = [
            overrides.equipmentBuffs,
            overrides.communityBuffs,
            overrides.houseBuffs,
            dataManager.characterData?.achievementActionTypeBuffsMap?.[actionTypeHrid],
            dataManager.characterData?.guildActionTypeBuffsMap?.[actionTypeHrid],
        ];

        for (const buffs of buffSources) {
            if (!Array.isArray(buffs)) continue;
            for (const buff of buffs) {
                if (!buff?.typeHrid) continue;
                const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
                if (amount === 0) continue;
                this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
            }
        }

        for (const buff of overrides.crateBuffs || []) {
            if (!buff?.typeHrid) continue;
            const amount = (buff.flatBoost || 0) + (buff.ratioBoost || 0);
            if (amount === 0) continue;
            this.applyBuff(metrics, buff.typeHrid, amount, skillLevelType, skillSuccessType, skillId);
        }

        const upgrades = overrides.tokenUpgrades || { speed: 0, efficiency: 0, success: 0, doubleProgress: 0 };
        metrics.actionSpeedBonus += upgrades.speed * UPGRADE_STEP;
        metrics.efficiencyBonus += upgrades.efficiency * UPGRADE_STEP;
        metrics.successBonus += upgrades.success * UPGRADE_SUCCESS_STEP;
        metrics.doubleProgressBonus += upgrades.doubleProgress * UPGRADE_STEP;
        metrics.experienceBonus += upgrades.experience * UPGRADE_STEP;

        return metrics;
    }

    /**
     * Compute skilling clear from pre-built metrics and base level.
     * @param {Object} metrics - From getSkillingMetrics() or getSkillingMetricsFromOverrides()
     * @param {number} baseLevel - Character skill level
     * @param {number} roomLevel - Labyrinth room level
     * @returns {Object} Clear result with stats
     */
    computeSkillingClearWithParams(metrics, baseLevel, roomLevel) {
        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus + (metrics.gatheringBonus || 0)));

        const workPower = effectiveLevel * (1 + metrics.efficiencyBonus);
        const progressPerSuccess = Math.max(0, Math.floor(workPower));
        const targetProgress = roomLevel * 10;

        const actionSeconds = BASE_SKILLING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));

        const clearStats = this.computeNonEnhancingClearStats(
            attempts,
            successChance,
            doubleChance,
            progressPerSuccess,
            targetProgress
        );
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'skilling';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.workPower = workPower;
        result.progressPerSuccess = progressPerSuccess;
        result.targetProgress = targetProgress;
        result.roomLevel = roomLevel;
        result.xpPerRoom = roomLevel * 50 * (1 + (metrics.experienceBonus || 0));
        return result;
    }

    /**
     * Compute enhancing clear from pre-built metrics and base level.
     * @param {Object} metrics - From getSkillingMetrics() or getSkillingMetricsFromOverrides()
     * @param {number} baseLevel - Character enhancing level
     * @param {number} roomLevel - Labyrinth room level
     * @returns {Object} Clear result with stats
     */
    computeEnhancingClearWithParams(metrics, baseLevel, roomLevel) {
        const effectiveLevel = baseLevel + metrics.skillLevelBonus;
        const levelDelta = effectiveLevel - roomLevel;
        const levelBonus = levelDelta >= 0 ? levelDelta * 0.005 : levelDelta * 0.01;
        const successChance = clampSuccessChance(0.8 * (1 + levelBonus + metrics.successBonus));
        const doubleChance = Math.min(1, Math.max(0, metrics.doubleProgressBonus));

        const actionSeconds = BASE_ENHANCING_TIME / Math.max(0.05, 1 + metrics.actionSpeedBonus);
        const attempts = Math.max(1, Math.floor(ROOM_DURATION / actionSeconds));
        const targetLevel = 5;

        const clearStats = this.computeEnhancingClearStats(attempts, successChance, doubleChance, targetLevel);
        const result = this.buildResult(clearStats, actionSeconds);
        result.type = 'enhancing';
        result.effectiveLevel = effectiveLevel;
        result.baseLevel = baseLevel;
        result.successChance = successChance;
        result.doubleChance = doubleChance;
        result.attempts = attempts;
        result.actionSeconds = actionSeconds;
        result.targetLevel = targetLevel;
        result.roomLevel = roomLevel;
        return result;
    }

    formatTime(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '—';
        if (seconds >= 9999) return '∞';
        const s = Math.round(seconds);
        if (s < 60) return `~${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return `~${m}:${rem.toString().padStart(2, '0')}`;
    }
}

const labyrinthClearRate = new LabyrinthClearRate();
export default labyrinthClearRate;
