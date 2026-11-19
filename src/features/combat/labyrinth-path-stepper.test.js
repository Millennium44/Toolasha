/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createPathStepper,
    describeStep,
    findLabyrinthPanel,
    findSupplyButton,
    installPointerShield,
    resetPanelCache,
} from './labyrinth-path-stepper.js';

const COLS = 3;
const room = (over = {}) => ({ isCleared: false, roomType: '/room_types/combat', ...over });

/** Panel instance shaped like the game's: handleRoomClick, state.supplyMode, props.characterLabyrinth */
function makePanel({ rooms, shroudCount = 5, beaconCount = 3, mode = null, floor = 1, valid = () => true } = {}) {
    const grid = rooms || [
        [room({ isCleared: true }), room(), room()],
        [room(), room(), room()],
        [room(), room(), room()],
    ];
    const panel = {
        state: { supplyMode: mode },
        props: { characterLabyrinth: { roomData: grid, shroudCount, beaconCount, currentFloor: floor } },
        handleRoomClick: vi.fn(),
        isValidShroudTarget: (x, y) => valid(x, y),
    };
    return panel;
}

/** Mount the game's DOM plus a fiber tree reaching every element's onClick */
function mount(panel, { useHandlers = {}, roomHandlers = {}, size = COLS } = {}) {
    document.body.innerHTML = '';
    const rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
    const fibers = [];
    const add = (el, onClick) => {
        rootEl.appendChild(el);
        fibers.push({ stateNode: el, memoizedProps: { onClick }, return: null, child: null, sibling: null });
    };
    for (const kind of ['shroud', 'beacon']) {
        const holder = document.createElement('div');
        holder.className = 'LabyrinthPanel_supplyWithButton__x';
        holder.innerHTML = `<svg><use href="/static/items.svg#expert_${kind}"></use></svg>`;
        const button = document.createElement('button');
        button.textContent = 'Use';
        holder.appendChild(button);
        rootEl.appendChild(holder);
        const handler = useHandlers[kind] || (() => (panel.state.supplyMode = kind));
        fibers.push({
            stateNode: button,
            memoizedProps: { onClick: handler },
            return: null,
            child: null,
            sibling: null,
        });
    }
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const cell = document.createElement('div');
            cell.className = 'LabyrinthPanel_roomCell__x';
            cell.dataset.roomX = String(x);
            cell.dataset.roomY = String(y);
            add(cell, roomHandlers[`${x},${y}`] || (() => panel.handleRoomClick(x, y)));
        }
    }
    // panel fiber first, then each element as a sibling chain
    const panelFiber = { stateNode: panel, memoizedProps: {}, return: null, child: fibers[0], sibling: null };
    fibers.forEach((f, i) => {
        f.return = panelFiber;
        f.sibling = fibers[i + 1] || null;
    });
    rootEl._reactRootContainer = { current: { stateNode: null, child: panelFiber, sibling: null } };
}

const shroudPlan = (targets, over = {}) => ({
    floor: 1,
    characterId: 7,
    cols: COLS,
    targets: targets.map((idx) => ({ idx })),
    ...over,
});

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('describeStep: every ending', () => {
    const base = (panel, plan, kind = 'shroud') => describeStep({ kind, plan, panel, characterId: 7 });

    it('no plan', () => {
        expect(base(makePanel(), null)).toMatchObject({ action: 'none', code: 'no-plan' });
    });

    it('no map', () => {
        expect(describeStep({ kind: 'shroud', plan: shroudPlan([1]), panel: null, characterId: 7 })).toMatchObject({
            action: 'none',
            code: 'no-map',
        });
    });

    it('character swap and floor change make the plan stale', () => {
        expect(describeStep({ kind: 'shroud', plan: shroudPlan([1]), panel: makePanel(), characterId: 8 }).code).toBe(
            'stale'
        );
        expect(base(makePanel({ floor: 2 }), shroudPlan([1])).code).toBe('stale');
    });

    it('arms first when the mode is off, picks the room when it is on', () => {
        const armed = base(makePanel(), shroudPlan([1]));
        expect(armed).toMatchObject({ action: 'use', idx: 1, x: 1, y: 0 });
        expect(armed.label).toBe('Use shroud ▸ 2,1');
        const pick = base(makePanel({ mode: 'shroud' }), shroudPlan([1]));
        expect(pick).toMatchObject({ action: 'room', idx: 1 });
        // the other supply is armed: still has to arm this one
        expect(base(makePanel({ mode: 'beacon' }), shroudPlan([1])).action).toBe('use');
    });

    it('skips a room already cleared, and is done when none are left', () => {
        // idx 0 is cleared in the fixture
        expect(base(makePanel(), shroudPlan([0, 4]))).toMatchObject({ action: 'use', idx: 4 });
        expect(base(makePanel(), shroudPlan([0]))).toMatchObject({ action: 'none', code: 'done' });
    });

    it('stops with no shrouds in the bag', () => {
        expect(base(makePanel({ shroudCount: 0 }), shroudPlan([1]))).toMatchObject({ code: 'out-of-stock' });
    });

    it('notes a bag shorter than the steps left, but still steps', () => {
        const step = base(makePanel({ shroudCount: 1 }), shroudPlan([1, 2, 3]));
        expect(step.action).toBe('use');
        expect(step.reason).toContain('1 shrouds for 3 steps');
    });

    it('skips an invalid room for the next valid one, and says why when none is valid', () => {
        const valid = (x, y) => !(x === 1 && y === 0);
        expect(base(makePanel({ valid }), shroudPlan([1, 2]))).toMatchObject({ action: 'use', idx: 2 });
        const blocked = base(makePanel({ valid }), shroudPlan([1]));
        expect(blocked).toMatchObject({ action: 'none', code: 'invalid' });
        expect(blocked.reason).toContain('2,1');
    });

    it('beacons: a placed center is not offered again, and none left is done', () => {
        const plan = { ...shroudPlan([4, 8]), placed: new Set([4]) };
        expect(base(makePanel(), plan, 'beacon')).toMatchObject({ action: 'use', idx: 8 });
        plan.placed.add(8);
        expect(base(makePanel(), plan, 'beacon').code).toBe('done');
        // a beacon room that is cleared is still a valid place for one
        expect(base(makePanel(), shroudPlan([0]), 'beacon').action).toBe('use');
        expect(base(makePanel({ beaconCount: 0 }), shroudPlan([4]), 'beacon').code).toBe('out-of-stock');
    });

    it('a plan with no shrouds says so, and is not "done"', () => {
        const step = base(makePanel(), shroudPlan([]));
        expect(step).toMatchObject({ action: 'none', code: 'nothing-needed' });
        expect(step.reason).toBe('No shrouds on this path');
        // done is for a plan whose shrouds were placed
        expect(base(makePanel(), shroudPlan([0])).code).toBe('done');
    });

    it('beacons staged for later are never reported done while they remain', () => {
        const later = [
            { idx: 1, label: 'B1' },
            { idx: 3, label: 'B2' },
        ];
        const plan = { ...shroudPlan([]), planned: 2, later, placed: new Set() };
        const step = base(makePanel(), plan, 'beacon');
        expect(step).toMatchObject({ action: 'none', code: 'later' });
        expect(step.reason).toContain('B1, B2 are for later');
        plan.placed.add(1);
        plan.placed.add(3);
        expect(base(makePanel(), plan, 'beacon').code).toBe('done');
        expect(base(makePanel(), { ...shroudPlan([]), planned: 0 }, 'beacon').code).toBe('nothing-needed');
    });

    it('duplicates of one room do not make two steps', () => {
        const step = base(makePanel({ shroudCount: 1 }), shroudPlan([1, 1]));
        expect(step.reason).not.toContain('shrouds for');
    });
});

describe('findLabyrinthPanel', () => {
    it('finds the instance that owns handleRoomClick, and returns null with no React root', () => {
        const panel = makePanel();
        mount(panel);
        expect(findLabyrinthPanel()).toBe(panel);
        document.body.innerHTML = '';
        expect(findLabyrinthPanel()).toBeNull();
    });
});

describe('createPathStepper presses', () => {
    let plan;
    let panel;
    let status;
    let changes;
    let stepper;
    let charId;

    const make = (kind = 'shroud') => {
        stepper = createPathStepper({
            getPlan: () => plan,
            getCharacterId: () => charId,
            setStatus: (text, warn) => status.push([text, !!warn]),
            onChange: () => changes.push(1),
        });
        return kind;
    };

    beforeEach(() => {
        charId = 7;
        status = [];
        changes = [];
        plan = shroudPlan([1, 4]);
        panel = makePanel();
        mount(panel);
    });
    afterEach(() => stepper?.dispose());

    it('does nothing at click time: the game is pressed on the next task', async () => {
        make();
        const arm = vi.fn(() => (panel.state.supplyMode = 'shroud'));
        mount(panel, { useHandlers: { shroud: arm } });
        const done = stepper.press('shroud');
        expect(arm).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(0);
        expect(arm).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(100);
        await done;
        expect(status.at(-1)[0]).toContain('ready: press again for room 2,1');
    });

    it('reaches the handlers through the root container fiber: no __react keys, no DOM click', async () => {
        make();
        const arm = vi.fn(() => (panel.state.supplyMode = 'shroud'));
        mount(panel, { useHandlers: { shroud: arm } });
        const button = findSupplyButton('shroud');
        expect(Object.keys(button).some((k) => k.startsWith('__react'))).toBe(false);
        const domClick = vi.spyOn(button, 'click');
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(100);
        await done;
        expect(arm).toHaveBeenCalledTimes(1);
        expect(domClick).not.toHaveBeenCalled();
        expect(findSupplyButton('beacon')).not.toBe(button);
    });

    it('step B presses the planned room and reports a cleared room as shrouded', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        panel.handleRoomClick = vi.fn((x, y) => {
            panel.state.supplyMode = null;
            panel.props.characterLabyrinth.roomData[y][x].isCleared = true;
            stepper.notifyUpdated();
        });
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(panel.handleRoomClick).toHaveBeenCalledWith(1, 0);
        expect(status.at(-1)).toEqual(['Shrouded room 2,1', false]);
    });

    it('a shroud count that does not drop is not read as failure (20% are preserved)', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        panel.handleRoomClick = vi.fn((x, y) => {
            panel.state.supplyMode = null;
            panel.props.characterLabyrinth.roomData[y][x].isCleared = true; // shroudCount stays 5
            stepper.notifyUpdated();
        });
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(panel.props.characterLabyrinth.shroudCount).toBe(5);
        expect(status.at(-1)[1]).toBe(false);
    });

    it('an answered press that left the room uncleared says to retry', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        panel.handleRoomClick = vi.fn(() => {
            panel.state.supplyMode = null;
            stepper.notifyUpdated();
        });
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(1000);
        await done;
        expect(status.at(-1)).toEqual(['Room 2,1 is not cleared, press again to retry', true]);
    });

    it('no answer from the game within the wait says so', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(status.at(-1)).toEqual(['No answer from the game (react press, mode shroud), press again', true]);
    });

    it('the supply that never arms is reported', async () => {
        make();
        mount(panel, { useHandlers: { shroud: () => {} } });
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(2000);
        await done;
        expect(status.at(-1)).toEqual(['The shroud did not arm, press again', true]);
    });

    it('a beacon answered by the game is marked placed and not offered again', async () => {
        make();
        plan = { ...shroudPlan([4, 8]), placed: new Set() };
        plan.targets[0].watch = [5];
        panel.props.characterLabyrinth.roomData[1][2] = null; // the room the beacon will reveal
        panel.state.supplyMode = 'beacon';
        panel.handleRoomClick = vi.fn(() => {
            panel.state.supplyMode = null;
            panel.props.characterLabyrinth.roomData[1][2] = room();
            stepper.notifyUpdated();
        });
        const done = stepper.press('beacon');
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(status.at(-1)[0]).toBe('Beacon placed at room 2,2');
        expect(plan.placed.has(4)).toBe(true);
        expect(stepper.describe('beacon')).toMatchObject({ action: 'use', idx: 8 });
    });

    it('refuses with the reason when there is nothing to do, pressing nothing', async () => {
        make();
        plan = null;
        const arm = vi.fn();
        mount(panel, { useHandlers: { shroud: arm } });
        await stepper.press('shroud');
        expect(arm).not.toHaveBeenCalled();
        expect(status.at(-1)).toEqual(['Press Path first to make a plan', true]);
    });

    it('plan finished is a calm message, not a warning', async () => {
        make();
        plan = shroudPlan([0]);
        await stepper.press('shroud');
        expect(status.at(-1)).toEqual(['Every planned shroud is done', false]);
    });

    it('stops when the plan is replaced between the click and the press', async () => {
        make();
        const arm = vi.fn();
        mount(panel, { useHandlers: { shroud: arm } });
        const done = stepper.press('shroud');
        plan = shroudPlan([2, 4]);
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(arm).not.toHaveBeenCalled();
        expect(status.at(-1)).toEqual(['The map changed since the last step, press again', true]);
    });

    it('stops when the character changes between the click and the press', async () => {
        make();
        const arm = vi.fn();
        mount(panel, { useHandlers: { shroud: arm } });
        const done = stepper.press('shroud');
        charId = 9;
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(arm).not.toHaveBeenCalled();
    });

    it('reports a missing room cell instead of guessing', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        document.querySelector('[data-room-x="1"][data-room-y="0"]').remove();
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(10);
        await done;
        expect(status.at(-1)).toEqual(['Room 2,1 was not found', true]);
    });

    it('ignores a second press while one is in flight (one press, one action)', async () => {
        make();
        const arm = vi.fn(() => (panel.state.supplyMode = 'shroud'));
        mount(panel, { useHandlers: { shroud: arm } });
        const a = stepper.press('shroud');
        const b = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(200);
        await Promise.all([a, b]);
        expect(arm).toHaveBeenCalledTimes(1);
    });

    it('dispose stops a press in flight and clears busy', async () => {
        make();
        panel.state.supplyMode = 'shroud';
        const done = stepper.press('shroud');
        stepper.dispose();
        await vi.advanceTimersByTimeAsync(10000);
        expect(stepper.isBusy()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        void done;
    });
});

describe('live shape: overlays inside the cell, onClick on the cell div, fibers from the root container', () => {
    it('presses the cell div itself (0-based data attributes), not an overlay, and the handler runs', async () => {
        const panel = makePanel({ mode: 'beacon' });
        const onCell = vi.fn(() => {
            panel.state.supplyMode = null;
        });
        mount(panel, { roomHandlers: { '1,0': onCell } });
        const cell = document.querySelector('[data-room-x="1"][data-room-y="0"]');
        for (const cls of ['mwi-labyrinth-path-overlay', 'mwi-labyrinth-beacon-overlay']) {
            const overlay = document.createElement('div');
            overlay.className = cls;
            cell.appendChild(overlay);
        }
        const livePlan = { ...shroudPlan([1]), placed: new Set() };
        const stepper = createPathStepper({
            getPlan: () => livePlan,
            getCharacterId: () => 7,
            setStatus: () => {},
            onChange: () => {},
        });
        const done = stepper.press('beacon');
        await vi.advanceTimersByTimeAsync(10);
        expect(onCell).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        stepper.dispose();
    });

    it('a no-answer status says which route was used and the mode left, so a dropped press can be told apart', async () => {
        const panel = makePanel({ mode: 'beacon' });
        mount(panel, { roomHandlers: { '1,0': () => (panel.state.supplyMode = null) } });
        const status = [];
        const livePlan = { ...shroudPlan([1]), placed: new Set() };
        const stepper = createPathStepper({
            getPlan: () => livePlan,
            getCharacterId: () => 7,
            setStatus: (text) => status.push(text),
            onChange: () => {},
        });
        const done = stepper.press('beacon');
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(status.at(-1)).toBe('No answer from the game (react press, mode off), press again');
        stepper.dispose();
    });
});

describe('installPointerShield', () => {
    it('keeps a pointer release on a step button from the game’s document listener, but not on other elements', () => {
        const panel = makePanel({ mode: 'beacon' });
        mount(panel);
        // The game: a document-level release outside the grid cancels the armed supply
        const gameCancel = () => {
            panel.state.supplyMode = null;
        };
        document.addEventListener('pointerup', gameCancel);
        const button = document.createElement('button');
        button.className = 'mwi-labyrinth-step-beacon';
        document.body.appendChild(button);
        const other = document.createElement('button');
        document.body.appendChild(other);

        const off = installPointerShield();
        button.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(panel.state.supplyMode).toBe('beacon');
        other.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(panel.state.supplyMode).toBeNull();

        panel.state.supplyMode = 'beacon';
        off();
        button.dispatchEvent(new Event('pointerup', { bubbles: true }));
        expect(panel.state.supplyMode).toBeNull();
        document.removeEventListener('pointerup', gameCancel);
    });
});

describe('sparse roomData against a bigger grid on screen', () => {
    // Floor 4 live: 64 cells in the DOM, roomData with only 7 rows, unrevealed rooms null
    const SIZE = 8;
    const sparse = () => {
        const rows = [];
        for (let y = 0; y < 7; y++) {
            rows.push(Array.from({ length: SIZE }, (_, x) => (x < 2 && y < 2 ? room() : null)));
        }
        return rows;
    };
    const plan8 = (targets) => ({ floor: 4, characterId: 7, cols: SIZE, targets: targets.map((idx) => ({ idx })) });
    const withGrid = (panel) => {
        mount(panel, { size: SIZE });
        return panel;
    };

    it('a planned room in a row roomData lacks is not "on the map" wrong: it is unrevealed, said plainly', () => {
        const panel = withGrid(makePanel({ rooms: sparse(), floor: 4 }));
        // (1,7) is idx 57: row 7 does not exist in roomData, but it is a real cell
        const step = describeStep({ kind: 'shroud', plan: plan8([57, 26]), panel, characterId: 7 });
        expect(step.code).toBe('invalid');
        expect(step.reason).not.toContain('not on the map');
        expect(step.reason).toBe(
            'The planned shroud rooms are not revealed yet (the ? mode assumes them): clear or beacon nearer rooms first'
        );
    });

    it('skips unrevealed planned rooms for the next one that is a valid target now', () => {
        const panel = withGrid(makePanel({ rooms: sparse(), floor: 4 }));
        // idx 57 and 26 are unrevealed; idx 9 is (1,1), revealed
        const step = describeStep({ kind: 'shroud', plan: plan8([57, 26, 9]), panel, characterId: 7 });
        expect(step).toMatchObject({ action: 'use', idx: 9, x: 1, y: 1 });
    });

    it('a beacon may go on an unrevealed cell of the grid, and a cell off the grid is refused', () => {
        const panel = withGrid(makePanel({ rooms: sparse(), floor: 4 }));
        expect(describeStep({ kind: 'beacon', plan: plan8([57]), panel, characterId: 7 })).toMatchObject({
            action: 'use',
            idx: 57,
        });
        const off = describeStep({ kind: 'beacon', plan: plan8([8 * 8 + 3]), panel, characterId: 7 });
        expect(off.reason).toContain('outside the grid');
    });
});

describe('review fixes', () => {
    let status;
    let stepper;
    const make = (plan) => {
        stepper = createPathStepper({
            getPlan: () => plan,
            getCharacterId: () => 7,
            setStatus: (text, warn) => status.push([text, !!warn]),
            onChange: () => {},
        });
        return stepper;
    };
    beforeEach(() => {
        status = [];
    });
    afterEach(() => stepper?.dispose());

    it('an unrelated labyrinth_updated does not mark a beacon placed', async () => {
        const panel = makePanel({ mode: 'beacon' });
        mount(panel);
        const plan = { ...shroudPlan([4]), placed: new Set() };
        plan.targets[0].watch = [5];
        panel.props.characterLabyrinth.roomData[1][2] = null;
        panel.handleRoomClick = vi.fn(() => {
            panel.state.supplyMode = null;
            stepper.notifyUpdated(); // a combat tick: nothing was revealed, the count is unchanged
        });
        make(plan);
        const done = stepper.press('beacon');
        await vi.advanceTimersByTimeAsync(2000);
        await done;
        expect(plan.placed.has(4)).toBe(false);
        expect(status.at(-1)).toEqual(['The game answered but no beacon showed at room 2,2, press again', true]);
    });

    it('a dropped beacon count also counts as placed', async () => {
        const panel = makePanel({ mode: 'beacon' });
        mount(panel);
        const plan = { ...shroudPlan([4]), placed: new Set() };
        panel.handleRoomClick = vi.fn(() => {
            panel.state.supplyMode = null;
            panel.props.characterLabyrinth.beaconCount -= 1;
            stepper.notifyUpdated();
        });
        make(plan);
        const done = stepper.press('beacon');
        await vi.advanceTimersByTimeAsync(2000);
        await done;
        expect(plan.placed.has(4)).toBe(true);
    });

    it('a shroud whose isCleared reaches the props after the update is still read as shrouded', async () => {
        const panel = makePanel({ mode: 'shroud' });
        mount(panel);
        panel.handleRoomClick = vi.fn((x, y) => {
            panel.state.supplyMode = null;
            stepper.notifyUpdated();
            setTimeout(() => {
                panel.props.characterLabyrinth.roomData[y][x].isCleared = true;
            }, 200);
        });
        make(shroudPlan([1]));
        const done = stepper.press('shroud');
        await vi.advanceTimersByTimeAsync(2000);
        await done;
        expect(status.at(-1)).toEqual(['Shrouded room 2,1', false]);
    });

    it('a spent bag reads as no beacons left, never as a finished plan', () => {
        const panel = makePanel();
        mount(panel);
        const plan = { ...shroudPlan([]), planned: 0, exhausted: 'spent', placed: new Set() };
        expect(describeStep({ kind: 'beacon', plan, panel, characterId: 7 })).toMatchObject({
            code: 'exhausted',
            label: 'No beacons left',
        });
        expect(
            describeStep({ kind: 'beacon', plan: { ...plan, exhausted: 'not-needed' }, panel, characterId: 7 }).label
        ).toBe('No beacons needed');
    });

    it('a press while one is running says so instead of going quiet', async () => {
        const panel = makePanel();
        mount(panel);
        make(shroudPlan([1]));
        const first = stepper.press('shroud');
        await stepper.press('shroud');
        expect(status.at(-1)).toEqual(['Still working on the last press', false]);
        await vi.advanceTimersByTimeAsync(2000);
        await first;
    });

    it('the panel lookup is cached across refreshes and found again after a remount', () => {
        const panel = makePanel();
        mount(panel);
        let reads = 0;
        const rootEl = document.getElementById('root');
        const container = rootEl._reactRootContainer;
        const real = container.current;
        container.current = new Proxy(real, {
            get(target, prop) {
                if (prop === 'child') reads += 1;
                return target[prop];
            },
        });
        resetPanelCache();
        expect(findLabyrinthPanel()).toBe(panel);
        const afterFirst = reads;
        expect(afterFirst).toBeGreaterThan(0);
        for (let i = 0; i < 5; i++) expect(findLabyrinthPanel()).toBe(panel);
        expect(reads).toBe(afterFirst);

        const next = makePanel();
        mount(next); // new DOM: the cached panel's cells are gone
        expect(findLabyrinthPanel()).toBe(next);
    });
});
