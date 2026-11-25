/**
 * Labyrinth path stepper: carries out the Path planner's shroud plan, and the
 * Beacons planner's placements, one game action per press.
 *
 * The plan is never recomputed here. The planner hands over the rooms it marked
 * (`getPlan(kind)`), and every press re-reads the game's own panel (the class
 * component that owns `handleRoomClick`) before acting:
 *
 * - step A presses the supply's "Use" button (client state only: `supplyMode`);
 * - step B presses the next planned room, which makes the game send the use.
 *
 * Each press is delivered with `clickThroughReact(el, { reactFirst: true })` on
 * the live element, found again after Toolasha's own click handler has
 * returned, and the next press waits for the game to re-render. A press whose
 * plan, floor or character no longer matches does nothing and says why.
 *
 * The Route step adds the next room of the drawn route to the game's own path (the queue the map fills when
 * a room is pressed), one room per press. A press-and-release on the map ends in
 * `props.updateLabyrinthPathHandler([{ x, y }], false)`; the step makes that same call after the game's own
 * checks (`isRoomPathable`, the path cap, not cleared, not already queued), because faking the drag would
 * unqueue a room that is already in the path and would pick up any room the real mouse crossed meanwhile.
 * The game answers with a `labyrinth_updated` whose `pathData` is a JSON string, `[{"x":1,"y":0}]`
 * (0-based, seen on the test server 2026-11-24). A refusal is silent, so the room being in `pathData` is the
 * only proof.
 *
 * The game marks a message as automated (`isAuto`) when it is sent within 100 ms of an untrusted click and
 * no trusted click (its `exceeded(100)` check in `messageSend`), and such a message is not acted on. A real
 * press on a step button is a trusted click, and the call goes out on the next task, well inside that
 * window, so one real press is one game action. A test that presses the button with `element.click()` gets
 * "No answer from the game": live checks must use a real mouse click.
 *
 * Expert shrouds always succeed but have a chance to be preserved, so a shroud
 * count that stays put proves nothing: a shroud worked when the room reads
 * `isCleared` in the live props. A beacon worked when the game answered with a
 * `labyrinth_updated` and put the mode back to null.
 */

import { clickThroughReact } from '../../utils/react-click.js';
import { isRoomRevealed } from './labyrinth-pathing.js';
import { labyrinthGridSize } from './labyrinth-formulas.js';

const ROOM_CELL_SELECTOR = 'div[class*="LabyrinthPanel_roomCell"]';
const SUPPLY_HOLDER_SELECTOR = 'div[class*="LabyrinthPanel_supplyWithButton"]';
const RENDER_WAIT_MS = 1500;
const RESULT_WAIT_MS = 4000;
const POLL_MS = 50;
const UPDATE_GRACE_MS = 600;

/** Revealed rooms among the plan indexes `watch`, read from the live labyrinth props */
function countRevealed(lab, watch, cols) {
    if (!lab?.roomData || !cols) return 0;
    return watch.filter((i) => isRoomRevealed(lab.roomData?.[Math.floor(i / cols)]?.[i % cols])).length;
}

let panelCache = null;

/** Forget the cached panel; the next lookup walks the tree again */
export function resetPanelCache() {
    panelCache = null;
}

/**
 * The game's labyrinth panel instance, found by walking the fiber tree for the
 * node that owns `handleRoomClick` (DOM nodes carry no `__react*` keys).
 * @returns {Object|null}
 */
export function findLabyrinthPanel() {
    if (typeof document === 'undefined') return null;
    // The instance outlives every refresh, and the fiber walk covers the whole React tree, so keep it until the
    // map it rendered is gone from the page (a remount builds new cells, which disconnects the probe)
    if (panelCache && panelCache.probe.isConnected) return panelCache.panel;
    panelCache = null;
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;
    const stack = [rootFiber];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        const node = fiber.stateNode;
        if (node && typeof node.handleRoomClick === 'function') {
            const probe = document.querySelector(ROOM_CELL_SELECTOR);
            if (probe) panelCache = { panel: node, probe };
            return node;
        }
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
}

/**
 * The supply's "Use" button, matched by the sprite suffix (`#expert_shroud`,
 * `#something_beacon`) because the tier varies.
 * @param {'shroud'|'beacon'} kind
 * @returns {Element|null}
 */
export function findSupplyButton(kind) {
    for (const holder of document.querySelectorAll(SUPPLY_HOLDER_SELECTOR)) {
        const use = holder.querySelector('use');
        const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
        if (href.endsWith(`#${kind}`) || href.endsWith(`_${kind}`)) return holder.querySelector('button');
    }
    return null;
}

/**
 * The live room cell at a grid position.
 * @param {number} x
 * @param {number} y
 * @returns {Element|null}
 */
export function findRoomCell(x, y) {
    return document.querySelector(`${ROOM_CELL_SELECTOR}[data-room-x="${x}"][data-room-y="${y}"]`);
}

/** 1-based "column,row" for a player; the data attributes are 0-based. */
function where(x, y) {
    return `${x + 1},${y + 1}`;
}

/**
 * Whether the game would accept this room as a target for this supply.
 * Shroud: the panel's own `isValidShroudTarget`, falling back to
 * not-cleared and revealed when the panel does not expose it. Beacon: inside
 * the grid.
 */
function targetCheck(panel, kind, x, y, lab) {
    // On the map means in the grid: a cell on screen, or inside the floor's grid size. roomData is sparse
    // (unrevealed rows and columns are missing or null), so its bounds say nothing about the grid.
    const size = labyrinthGridSize(lab?.currentFloor);
    if (!findRoomCell(x, y) && !(x >= 0 && y >= 0 && x < size && y < size)) {
        return { ok: false, why: `room ${where(x, y)} is outside the grid` };
    }
    if (kind === 'beacon') return { ok: true };
    const room = lab?.roomData?.[y]?.[x];
    if (!room) return { ok: false, unrevealed: true, why: `room ${where(x, y)} is not revealed yet` };
    if (room.isCleared) return { ok: false, why: `room ${where(x, y)} is already cleared`, cleared: true };
    let ok;
    if (typeof panel.isValidShroudTarget === 'function') {
        try {
            ok = !!panel.isValidShroudTarget(x, y, lab, lab.roomData);
        } catch {
            ok = false;
        }
    } else {
        ok = isRoomRevealed(room);
    }
    return ok
        ? { ok: true }
        : {
              ok: false,
              unrevealed: !isRoomRevealed(room),
              why: `a shroud cannot be used on room ${where(x, y)} right now`,
          };
}

/**
 * What the next press would do, from the live panel. Pure over its inputs.
 *
 * @param {Object} args
 * @param {'shroud'|'beacon'} args.kind
 * @param {Object|null} args.plan - { floor, characterId, cols, targets: [{ idx }], placed?: Set<number> }
 * @param {Object|null} args.panel - The game's panel instance
 * @param {number|null} args.characterId - Current character
 * @returns {{ action: 'use'|'room'|'none', label: string, reason: string, idx?: number, x?: number, y?: number,
 *   code: string }}
 */
export function describeStep({ kind, plan, panel, characterId }) {
    const noun = kind === 'shroud' ? 'Shroud' : 'Beacon';
    const none = (code, label, reason = label) => ({ action: 'none', code, label, reason });
    if (!plan)
        return none('no-plan', `${noun} ▸`, `Press ${kind === 'shroud' ? 'Path' : 'Beacons'} first to make a plan`);
    const lab = panel?.props?.characterLabyrinth;
    if (!panel || !lab?.roomData) return none('no-map', `${noun} ▸`, 'Open the labyrinth map to continue the plan');
    if (plan.characterId !== characterId) {
        return none('stale', `${noun} ▸`, 'The plan is for another character, press Path again');
    }
    if (plan.floor !== lab.currentFloor) {
        return none('stale', `${noun} ▸`, 'The plan is for another floor, press the planner again');
    }
    if (plan.exhausted) {
        return plan.exhausted === 'spent'
            ? none(
                  'exhausted',
                  'No beacons left',
                  'All beacons set for this floor are used, raise the count to plan more'
              )
            : none('exhausted', 'No beacons needed', 'The path to the exit is already revealed, no beacons needed');
    }
    const cols = plan.cols;
    const placed = plan.placed || new Set();
    const seen = new Set();
    const remaining = plan.targets.filter((t) => {
        if (placed.has(t.idx) || seen.has(t.idx)) return false;
        seen.add(t.idx);
        const x = t.idx % cols;
        const y = Math.floor(t.idx / cols);
        const room = lab.roomData?.[y]?.[x];
        if (kind === 'shroud' && room?.isCleared) return false;
        return true;
    });
    if (!remaining.length) {
        const planned = plan.planned ?? plan.targets.length;
        if (planned === 0) {
            return none(
                'nothing-needed',
                kind === 'shroud' ? 'No shrouds needed' : 'No beacons planned',
                kind === 'shroud' ? 'No shrouds on this path' : 'No beacons are planned on this floor'
            );
        }
        // Planned beacons the planner staged for later are still outstanding, never "done"
        const later = (plan.later || []).filter((t) => !placed.has(t.idx));
        if (later.length) {
            const names = later.map((t, i) => t.label || `B${i + 1}`).join(', ');
            return none(
                'later',
                `${noun} ▸ later`,
                `${names} ${later.length === 1 ? 'is' : 'are'} for later: the planner stages a beacon as later when a path ` +
                    'to the exit is already open or the Beacons count is lower than the plan. Raise the Beacons count ' +
                    'and press Beacons again to place it now'
            );
        }
        return none(
            'done',
            `${noun} plan done`,
            kind === 'shroud' ? 'Every planned shroud is done' : 'Every planned beacon is placed'
        );
    }
    const stock = Math.max(0, Math.floor(Number(kind === 'shroud' ? lab.shroudCount : lab.beaconCount) || 0));
    if (stock <= 0)
        return none('out-of-stock', `No ${kind}s left`, `You have no ${kind}s left; ${remaining.length} planned`);

    let target = null;
    let firstWhy = '';
    let allUnrevealed = true;
    for (const t of remaining) {
        const x = t.idx % cols;
        const y = Math.floor(t.idx / cols);
        const check = targetCheck(panel, kind, x, y, lab);
        if (check.ok) {
            target = { idx: t.idx, x, y };
            break;
        }
        if (!firstWhy) firstWhy = check.why;
        if (!check.unrevealed) allUnrevealed = false;
    }
    if (!target && kind === 'shroud' && allUnrevealed) {
        return none(
            'invalid',
            `${noun} ▸ blocked`,
            'The planned shroud rooms are not revealed yet (the ? mode assumes them): clear or beacon nearer rooms first'
        );
    }
    if (!target) return none('invalid', `${noun} ▸ blocked`, firstWhy[0].toUpperCase() + firstWhy.slice(1));

    const short = stock < remaining.length ? ` (${stock} ${kind}s for ${remaining.length} steps)` : '';
    const mode = panel.state?.supplyMode ?? null;
    const base = { idx: target.idx, x: target.x, y: target.y, code: 'ready' };
    if (mode === kind) {
        return {
            ...base,
            action: 'room',
            label: `${noun} room ${where(target.x, target.y)}`,
            reason: `Press to ${kind === 'shroud' ? 'shroud' : 'place a beacon at'} room ${where(target.x, target.y)}${short}`,
        };
    }
    return {
        ...base,
        action: 'use',
        label: `Use ${kind} ▸ ${where(target.x, target.y)}`,
        reason: `Press to arm the ${kind}, then press again to pick room ${where(target.x, target.y)}${short}`,
    };
}

/** The game's default when the character carries no path cap */
const DEFAULT_PATH_CAP = 3;

/**
 * The game's queued path as a list of rooms. `pathData` arrives as a JSON string; an array is taken as is.
 * @param {string|Array|null|undefined} pathData
 * @returns {Array<{x: number, y: number}>|null} The rooms, or null when it cannot be read
 */
export function parseGamePath(pathData) {
    if (pathData == null || pathData === '') return [];
    let path = pathData;
    if (typeof path === 'string') {
        try {
            path = JSON.parse(path);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(path)) return null;
    return path.filter((r) => r && Number.isInteger(r.x) && Number.isInteger(r.y)).map((r) => ({ x: r.x, y: r.y }));
}

/**
 * What the next Route press would do, from the live panel. Pure over its inputs.
 *
 * The next room is the first room of the route, in walking order, that is neither cleared nor already in the
 * game's path. It is never skipped: a room that needs a shroud, or that the game will not take, stops the
 * step and says so.
 *
 * @param {Object} args
 * @param {Object|null} args.plan - { floor, characterId, cols, route: number[], targets: [{ idx }] }
 * @param {Object|null} args.panel - The game's panel instance
 * @param {number|null} args.characterId - Current character
 * @returns {{ action: 'path'|'none', label: string, reason: string, code: string, idx?: number, x?: number,
 *   y?: number }}
 */
export function describeRouteStep({ plan, panel, characterId }) {
    const none = (code, label, reason = label, at = {}) => ({ action: 'none', code, label, reason, ...at });
    if (!plan) return none('no-plan', 'Route ▸', 'Press Path first to draw a route');
    const lab = panel?.props?.characterLabyrinth;
    if (!panel || !lab?.roomData) return none('no-map', 'Route ▸', 'Open the labyrinth map to continue the route');
    if (plan.characterId !== characterId) {
        return none('stale', 'Route ▸', 'The route is for another character, press Path again');
    }
    if (plan.floor !== lab.currentFloor)
        return none('stale', 'Route ▸', 'The route is for another floor, press Path again');
    const route = Array.isArray(plan.route) ? plan.route : [];
    if (!route.length) return none('nothing-needed', 'No route rooms', 'The route has no rooms to enter');
    const path = parseGamePath(lab.pathData);
    if (!path) return none('no-path', 'Route ▸ blocked', "The game's path could not be read, press Path again");
    const cols = plan.cols;
    const inPath = new Set(path.map((r) => r.y * cols + r.x));
    const seen = new Set();
    const open = route.filter((idx) => {
        if (seen.has(idx) || idx === 0) return false;
        seen.add(idx);
        return !lab.roomData?.[Math.floor(idx / cols)]?.[idx % cols]?.isCleared;
    });
    if (!open.length) return none('done', 'Route done', 'Every room of the route is cleared');
    const next = open.find((idx) => !inPath.has(idx));
    if (next === undefined) {
        return none('queued', 'Route queued', "Every room of the route is in the game's path");
    }
    const x = next % cols;
    const y = Math.floor(next / cols);
    const at = { idx: next, x, y };
    if (panel.state?.supplyMode) {
        return none('armed', 'Route ▸ blocked', `Use or cancel the armed ${panel.state.supplyMode} first`, at);
    }
    if ((plan.targets || []).some((t) => t.idx === next)) {
        return none(
            'shroud-first',
            'Route ▸ shroud',
            `Room ${where(x, y)} needs a shroud first: use the Shroud step`,
            at
        );
    }
    const cap = Math.max(1, Math.floor(Number(panel.props?.characterInfo?.labyrinthPathCap) || DEFAULT_PATH_CAP));
    if (path.length >= cap) {
        return none(
            'cap',
            'Max Path full',
            `The game's path is full (${path.length} of ${cap}): room ${where(x, y)} is next once a queued room is cleared`,
            at
        );
    }
    let pathable = true;
    if (typeof panel.isRoomPathable === 'function') {
        try {
            pathable = !!panel.isRoomPathable(x, y, lab, path, labyrinthGridSize(lab.currentFloor));
        } catch {
            pathable = false;
        }
    }
    if (!pathable) {
        return none(
            'not-pathable',
            'Route ▸ blocked',
            `The game will not take room ${where(x, y)} yet: it is not next to a cleared or queued room, or your skip ` +
                'settings would skip it',
            at
        );
    }
    if (typeof panel.props?.updateLabyrinthPathHandler !== 'function') {
        return none('no-handler', 'Route ▸ blocked', `Press room ${where(x, y)} on the map by hand`, at);
    }
    return {
        ...at,
        action: 'path',
        code: 'ready',
        label: `Route ▸ ${where(x, y)}`,
        reason:
            `Press to add room ${where(x, y)} to the game's path (${path.length + 1} of ${cap}), the same as pressing it ` +
            'on the map. A labyrinth run in progress enters queued rooms in order.',
    };
}

const STEP_BUTTON_SELECTOR = '.mwi-labyrinth-step-shroud, .mwi-labyrinth-step-beacon, .mwi-labyrinth-step-route';
const SHIELDED_EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'touchstart', 'touchend'];

/**
 * Keep presses on the step buttons from reaching the game's document-level pointer handlers.
 * With a supply armed the game treats a pointer release anywhere outside the room grid as "cancel" (it keeps
 * `supplyPointerStartedOnGrid` for that), so a real finger or mouse press on a step button would disarm the supply
 * before the second press could pick the room. The click itself is untouched. Listens on window in the capture
 * phase, ahead of the game, and only for events that start inside a step button.
 * @returns {function(): void} Removes the listeners
 */
export function installPointerShield() {
    if (typeof window === 'undefined') return () => {};
    const stop = (event) => {
        if (event.target instanceof Element && event.target.closest(STEP_BUTTON_SELECTOR)) event.stopPropagation();
    };
    for (const type of SHIELDED_EVENTS) window.addEventListener(type, stop, true);
    return () => {
        for (const type of SHIELDED_EVENTS) window.removeEventListener(type, stop, true);
    };
}

/**
 * Create the stepper. The planner supplies the plans and takes the status text;
 * the stepper owns presses, waits and the button labels.
 *
 * @param {Object} deps
 * @param {function('shroud'|'beacon'): Object|null} deps.getPlan
 * @param {function(): number|null} deps.getCharacterId
 * @param {function(string, boolean=): void} deps.setStatus
 * @param {function(): void} deps.onChange - Labels should be redrawn
 * @returns {Object}
 */
export function createPathStepper({ getPlan, getCharacterId, setStatus, onChange }) {
    let busy = false;
    let disposed = false;
    let generation = 0;
    let updatedWaiters = [];
    const timers = new Set();

    const sleep = (ms) =>
        new Promise((resolve) => {
            const t = setTimeout(() => {
                timers.delete(t);
                resolve();
            }, ms);
            timers.add(t);
        });

    const waitFor = async (predicate, ms) => {
        const end = Date.now() + ms;
        while (!disposed) {
            if (predicate()) return true;
            if (Date.now() >= end) return false;
            await sleep(POLL_MS);
        }
        return false;
    };

    const describe = (kind) =>
        kind === 'route'
            ? describeRouteStep({ plan: getPlan('route'), panel: findLabyrinthPanel(), characterId: getCharacterId() })
            : describeStep({ kind, plan: getPlan(kind), panel: findLabyrinthPanel(), characterId: getCharacterId() });

    /** One Route press: add the next route room to the game's path, then wait for the game to show it there */
    const pressRoute = async () => {
        const step = describe('route');
        if (step.action === 'none') {
            setStatus(step.reason, !['done', 'queued', 'nothing-needed'].includes(step.code));
            onChange();
            return;
        }
        busy = true;
        const myGeneration = ++generation;
        const plan = getPlan('route');
        const characterId = getCharacterId();
        onChange();
        try {
            // After Toolasha's own click handler has returned
            await sleep(0);
            if (disposed || myGeneration !== generation) return;
            const again = describe('route');
            if (again.action !== 'path' || again.idx !== step.idx || getPlan('route') !== plan) {
                setStatus('The map changed since the last step, press again', true);
                return;
            }
            const panel = findLabyrinthPanel();
            let updated = false;
            updatedWaiters.push(() => {
                updated = true;
            });
            try {
                panel.props.updateLabyrinthPathHandler([{ x: step.x, y: step.y }], false);
            } catch {
                setStatus(`The press did not reach the game, press room ${where(step.x, step.y)} by hand`, true);
                return;
            }
            const queued = () =>
                (parseGamePath(findLabyrinthPanel()?.props?.characterLabyrinth?.pathData) || []).some(
                    (r) => r.x === step.x && r.y === step.y
                );
            const end = Date.now() + RESULT_WAIT_MS;
            let seenAt = null;
            let worked = false;
            while (!disposed) {
                if (queued()) {
                    worked = true;
                    break;
                }
                const now = Date.now();
                if (updated && seenAt === null) seenAt = now;
                if (now >= end || (seenAt !== null && now - seenAt >= UPDATE_GRACE_MS)) break;
                await sleep(POLL_MS);
            }
            if (disposed || myGeneration !== generation) return;
            if (getCharacterId() !== characterId || getPlan('route') !== plan) return;
            setStatus(
                worked
                    ? `Room ${where(step.x, step.y)} added to the game's path`
                    : updated
                      ? `The game did not take room ${where(step.x, step.y)}, press again or press it on the map`
                      : 'No answer from the game, press again',
                !worked
            );
        } finally {
            updatedWaiters = [];
            busy = false;
            if (!disposed) onChange();
        }
    };

    /** The game answered with a labyrinth_updated; called by the planner's handler. */
    const notifyUpdated = () => {
        const waiters = updatedWaiters;
        updatedWaiters = [];
        for (const w of waiters) w();
    };

    const press = async (kind) => {
        if (disposed) return;
        if (busy) {
            setStatus('Still working on the last press');
            return;
        }
        if (kind === 'route') {
            await pressRoute();
            return;
        }
        const step = describe(kind);
        if (step.action === 'none') {
            setStatus(step.reason, !['done', 'later', 'nothing-needed', 'exhausted'].includes(step.code));
            onChange();
            return;
        }
        busy = true;
        const myGeneration = ++generation;
        const plan = getPlan(kind);
        const characterId = getCharacterId();
        onChange();
        try {
            // After Toolasha's own click handler has returned
            await sleep(0);
            if (disposed || myGeneration !== generation) return;
            const again = describe(kind);
            if (again.action !== step.action || again.idx !== step.idx || getPlan(kind) !== plan) {
                setStatus('The map changed since the last step, press again', true);
                return;
            }
            const el = step.action === 'use' ? findSupplyButton(kind) : findRoomCell(step.x, step.y);
            if (!el) {
                setStatus(
                    step.action === 'use'
                        ? `The ${kind} button was not found`
                        : `Room ${where(step.x, step.y)} was not found`,
                    true
                );
                return;
            }
            let updated = false;
            const onUpdated = () => {
                updated = true;
            };
            updatedWaiters.push(onUpdated);
            const beforeLab = findLabyrinthPanel()?.props?.characterLabyrinth;
            const watch = (plan.targets || []).find((t) => t.idx === step.idx)?.watch || [];
            const revealedBefore = countRevealed(beforeLab, watch, plan.cols);
            const beaconsBefore = Number(beforeLab?.beaconCount) || 0;
            const how = clickThroughReact(el, { reactFirst: true });
            if (how === 'none') {
                setStatus('The press did not reach the game, press it by hand', true);
                return;
            }
            const panelNow = () => findLabyrinthPanel();
            // Waits for `signal`, and once the game's update has arrived allows a short grace for the panel's
            // props to catch up before calling it a miss
            const settle = async (signal) => {
                const end = Date.now() + RESULT_WAIT_MS;
                let seenAt = null;
                while (!disposed) {
                    if (signal()) return true;
                    const now = Date.now();
                    if (updated && seenAt === null) seenAt = now;
                    if (now >= end || (seenAt !== null && now - seenAt >= UPDATE_GRACE_MS)) return false;
                    await sleep(POLL_MS);
                }
                return false;
            };
            if (step.action === 'use') {
                const armed = await waitFor(() => panelNow()?.state?.supplyMode === kind, RENDER_WAIT_MS);
                if (disposed) return;
                setStatus(
                    armed
                        ? `${kind === 'shroud' ? 'Shroud' : 'Beacon'} ready: press again for room ${where(step.x, step.y)}`
                        : `The ${kind} did not arm, press again`,
                    !armed
                );
                return;
            }
            const labNow = () => panelNow()?.props?.characterLabyrinth;
            const isCleared = () => !!labNow()?.roomData?.[step.y]?.[step.x]?.isCleared;
            // A beacon went down when the rooms it was planned to reveal gained revealed rooms (the planner's own
            // signal), or the bag dropped. The count alone is not enough, a beacon may be preserved.
            const beaconDown = () =>
                countRevealed(labNow(), watch, plan.cols) > revealedBefore ||
                (Number(labNow()?.beaconCount) || 0) < beaconsBefore;
            const worked = await settle(kind === 'shroud' ? isCleared : beaconDown);
            const answered = updated;
            if (disposed || myGeneration !== generation) return;
            if (getCharacterId() !== characterId || getPlan(kind) !== plan) return;
            if (kind === 'shroud') {
                const cleared = worked;
                setStatus(
                    cleared
                        ? `Shrouded room ${where(step.x, step.y)}`
                        : answered
                          ? `Room ${where(step.x, step.y)} is not cleared, press again to retry`
                          : `No answer from the game (${how} press, mode ${panelNow()?.state?.supplyMode ?? 'off'}), press again`,
                    !cleared
                );
            } else if (worked) {
                plan.placed = plan.placed || new Set();
                plan.placed.add(step.idx);
                setStatus(`Beacon placed at room ${where(step.x, step.y)}`);
            } else {
                setStatus(
                    answered
                        ? `The game answered but no beacon showed at room ${where(step.x, step.y)}, press again`
                        : `No answer from the game (${how} press, mode ${panelNow()?.state?.supplyMode ?? 'off'}), press again`,
                    true
                );
            }
        } finally {
            updatedWaiters = [];
            busy = false;
            if (!disposed) onChange();
        }
    };

    const dispose = () => {
        disposed = true;
        generation++;
        for (const t of timers) clearTimeout(t);
        timers.clear();
        updatedWaiters = [];
        busy = false;
    };

    return { describe, press, notifyUpdated, dispose, isBusy: () => busy };
}

export default {
    findLabyrinthPanel,
    findSupplyButton,
    findRoomCell,
    describeStep,
    describeRouteStep,
    parseGamePath,
    createPathStepper,
};
