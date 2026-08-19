/**
 * @vitest-environment happy-dom
 *
 * The guided reroll walk, held to the one rule that matters.
 *
 * A bulk reroller is exactly the shape of thing this fork does not ship: a
 * button that, once pressed, keeps acting on the game. So the interesting
 * assertions here are not about which card gets rerolled — they are about how
 * many of the game's buttons get clicked per press of ours, which is one, and
 * about what happens when the board is not what the label promised, which is
 * that nothing gets clicked at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const stored = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        isFeatureEnabled: (key) => settings.values[key] ?? false,
        COLOR_ACCENT: '#0f0',
        Z_FLOATING_PANEL: 500,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => stored.values[key] ?? fallback,
        set: async () => {},
        getJSON: async (key, _store, fallback) => stored.values[key] ?? fallback,
        setJSON: async () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 7, getMooPassBuffs: () => [] },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

const { default: taskRerollWalkFeature, verdictForCard, preferredRerollOption } = await import('./task-reroll-walk.js');
const walk = taskRerollWalkFeature.walk;

const MILKING = '/actions/milking/cow';
const KEEPER = '/actions/brewing/coffee';

/** Every click the game's buttons receive, in order */
let clicks = [];

/**
 * Wire a button so pressing it is recorded.
 * @param {HTMLElement} button - The game button
 * @param {string} name - The card's task name
 * @param {string} label - The button's own label
 */
function record(button, name, label) {
    button.addEventListener('click', () => clicks.push(`${name}:${label || 'trash'}`));
}

/**
 * Put a board on the page.
 * @param {Array<{name: string, buttons: Array<string>, quest: Object|null}>} specs - One per card
 * @returns {HTMLElement} The task list
 */
function board(specs) {
    document.body.replaceChildren();
    clicks = [];

    const panel = document.createElement('div');
    panel.className = 'TasksPanel_tasksPanel__abc';
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';
    panel.appendChild(list);
    document.body.appendChild(panel);

    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const rootFiber = { child: null, sibling: null, return: null };
    let lastQuestFiber = null;

    for (const spec of specs) {
        const card = document.createElement('div');
        card.className = 'RandomTask_randomTask__1abc';

        const content = document.createElement('div');
        content.className = 'RandomTask_content__2def';
        const name = document.createElement('div');
        name.className = 'RandomTask_name__3ghi';
        name.textContent = spec.name;
        const progress = document.createElement('div');
        progress.textContent = 'Progress: 0 / 100';
        content.append(name, progress);
        card.appendChild(content);

        const action = document.createElement('div');
        action.className = 'RandomTask_action__4jkl';
        for (const label of spec.buttons) {
            const button = document.createElement('button');
            button.textContent = label;
            record(button, spec.name, label);
            action.appendChild(button);
        }
        card.appendChild(action);
        list.appendChild(card);

        // A fiber above the card's buttons carrying its quest, the way the game
        // does — there is no other route to a card's identity
        const questFiber = { memoizedProps: { characterQuest: spec.quest }, return: null, child: null, sibling: null };
        let previous = null;
        for (const button of card.querySelectorAll('button')) {
            const fiber = { stateNode: button, return: questFiber, child: null, sibling: null };
            if (previous) previous.sibling = fiber;
            else questFiber.child = fiber;
            previous = fiber;
        }
        if (lastQuestFiber) lastQuestFiber.sibling = questFiber;
        else rootFiber.child = questFiber;
        lastQuestFiber = questFiber;
    }

    root._reactRootContainer = { current: rootFiber };
    return list;
}

/** A resting card's buttons: Go, Reroll and the icon-only trash can */
const AT_REST = ['Go', 'Reroll', ''];
/** The reroll chooser */
const CHOOSER = ['Back', 'MooPass Free Reroll (2)'];

/** A quest for a card, with however many rerolls have been spent on it */
const quest = (actionHrid, spent = 0) => ({ actionHrid, coinRerollCount: spent, cowbellRerollCount: 0 });

/** What the chip currently offers */
const chipText = () => document.querySelector('.mwi-task-reroll-walk-advance')?.textContent || '';

/**
 * Swap a card's action row for a different step of the flow.
 * @param {HTMLElement} list - The task list
 * @param {number} slot - 1-based card position
 * @param {Array<string>} labels - The new buttons
 */
function setButtons(list, slot, labels) {
    const card = list.children[slot - 1];
    const name = card.querySelector('[class*="RandomTask_name"]').textContent;
    const action = card.querySelector('[class*="RandomTask_action"]');
    action.replaceChildren(
        ...labels.map((label) => {
            const button = document.createElement('button');
            button.textContent = label;
            record(button, name, label);
            return button;
        })
    );
    // The fiber tree is rebuilt with the buttons, exactly as React does it
    const root = document.getElementById('root');
    const questFiber = [...list.children].reduce((found, element, index) => {
        if (index !== slot - 1) return found;
        let fiber = root._reactRootContainer.current.child;
        for (let i = 0; i < index; i++) fiber = fiber.sibling;
        return fiber;
    }, null);
    let previous = null;
    questFiber.child = null;
    for (const button of action.querySelectorAll('button')) {
        const fiber = { stateNode: button, return: questFiber, child: null, sibling: null };
        if (previous) previous.sibling = fiber;
        else questFiber.child = fiber;
        previous = fiber;
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.values = {
        tasks_rerollWalk: true,
        tasks_rerollWalkMaxRerolls: 3,
        tasks_rerollWalkTrashAtLimit: true,
    };
    stored.values = {};
    walk.protectedHrids = new Set();
    walk.state = 'idle';
    walk.step = null;
    walk.index = 0;
    document.body.replaceChildren();
});

afterEach(() => {
    walk.stop();
    vi.useRealTimers();
});

describe('what the walk decides about one card', () => {
    const base = { completed: false, isProtected: false, rerollsSpent: 0, maxRerolls: 3, trashAtLimit: true };

    test('a task the player asked to keep is left alone', () => {
        expect(verdictForCard({ ...base, isProtected: true }).action).toBe('skip');
    });

    test('a task waiting to be claimed is never rerolled out from under the reward', () => {
        expect(verdictForCard({ ...base, completed: true }).action).toBe('skip');
    });

    test('an unprotected task under its budget is rerolled', () => {
        const verdict = verdictForCard({ ...base, rerollsSpent: 2 });
        expect(verdict.action).toBe('reroll');
        expect(verdict.reason).toBe('2/3');
    });

    test('a task that has used its budget is discarded, or skipped when that is off', () => {
        expect(verdictForCard({ ...base, rerollsSpent: 3 }).action).toBe('trash');
        expect(verdictForCard({ ...base, rerollsSpent: 3, trashAtLimit: false }).action).toBe('skip');
    });

    test('rerolls already spent count against the budget', () => {
        // A task that arrived half-rerolled does not get a fresh three
        expect(verdictForCard({ ...base, rerollsSpent: 5 }).action).toBe('trash');
    });

    test('a card whose quest cannot be read is left alone rather than guessed at', () => {
        expect(verdictForCard({ ...base, rerollsSpent: null }).action).toBe('skip');
    });

    test('a budget of nothing sends every unprotected card to the trash', () => {
        expect(verdictForCard({ ...base, maxRerolls: 0 }).action).toBe('trash');
    });
});

describe('which reroll option gets pressed', () => {
    const option = (kind, available = true) => ({ kind, available, cost: kind === 'coin' ? 10000 : 1 });

    test('free before paid', () => {
        expect(preferredRerollOption([option('coin'), option('free')]).kind).toBe('free');
    });

    test('cowbells before coins', () => {
        expect(preferredRerollOption([option('coin'), option('cowbell')]).kind).toBe('cowbell');
    });

    test('a spent free reroll is not pressed', () => {
        expect(preferredRerollOption([option('free', false), option('coin')]).kind).toBe('coin');
    });

    test('nothing on offer is nothing pressed', () => {
        expect(preferredRerollOption([option('free', false)])).toBe(null);
    });
});

describe('planning a walk down the board', () => {
    test('it opens on the first card that needs something', () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
        ]);

        walk.start();

        expect(chipText()).toContain('Reroll #2 (0/3)');
        expect(clicks).toEqual([]);
    });

    test('a board of nothing but protected tasks finishes without a click', () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
        ]);

        walk.start();

        expect(chipText()).toBe('✓ Done — 2 kept, 0 rerolled, 0 trashed');
        expect(clicks).toEqual([]);
    });

    test('a task at its limit is offered for discard, naming why', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 3) }]);

        walk.start();

        expect(chipText()).toBe('▶ Trash #1 (limit reached)');
    });

    test('with discard-at-limit off it is passed over instead', () => {
        settings.values.tasks_rerollWalkTrashAtLimit = false;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 3) }]);

        walk.start();

        expect(chipText()).toContain('1 kept');
    });

    test('an empty board says so rather than offering a press', () => {
        board([]);

        walk.start();

        expect(chipText()).toContain('No tasks on the board');
    });
});

describe('one press, one game click', () => {
    test('opening the chooser is its own press, and paying is the next', () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk.start();
        expect(chipText()).toBe('▶ Reroll #1 (0/3) — open the menu');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        // The game opens the chooser; the walk re-reads and offers the payment
        setButtons(list, 1, CHOOSER);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Reroll #1 (0/3) — free');

        // Nothing pressed itself while that was worked out, however long is left
        vi.advanceTimersByTime(10000);
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll', 'Milking - Cow:MooPass Free Reroll (2)']);

        vi.advanceTimersByTime(10000);
        expect(clicks).toHaveLength(2);
    });

    test('trashing takes two presses too, and the second is the confirm', () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 3) }]);
        walk.start();

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash']);

        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Confirm discard #1');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash', 'Milking - Cow:Confirm Discard']);
    });

    test('a chooser left open on a card being passed over is closed, one press', () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([{ name: 'Brewing - Coffee', buttons: CHOOSER, quest: quest(KEEPER) }]);

        walk.start();
        expect(chipText()).toBe('▶ Close the menu on #1');

        walk.advance();
        expect(clicks).toEqual(['Brewing - Coffee:Back']);
    });

    test('a press with nothing on offer does nothing', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the walk re-evaluates the task the reroll actually landed on', () => {
        // The point of doing this one press at a time: what arrives may be
        // something the player is keeping, and the walk has to notice
        walk.protectedHrids = new Set([KEEPER]);
        const list = board([{ name: 'Milking - Cow', buttons: CHOOSER, quest: quest(MILKING) }]);
        walk.start();
        walk.advance();
        expect(clicks).toHaveLength(1);

        // The reroll lands on a protected task, chooser still open
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Brewing - Coffee';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest(KEEPER);
        vi.advanceTimersByTime(3000);

        expect(chipText()).toBe('▶ Close the menu on #1');
    });
});

describe('the walk stops rather than clicking the wrong thing', () => {
    test('a card that is no longer in its slot stops it', () => {
        const list = board([
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        walk.start();

        // The board is re-ordered under the plan — the sorter, a completed task
        list.prepend(list.children[1]);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('walk stopped');
    });

    test('a task that changed under the plan stops it', () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk.start();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('The task in slot 1 changed');
    });

    test('a button that has gone stops it', () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk.start();

        list.children[0].querySelector('[class*="RandomTask_action"]').replaceChildren();

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the stop button leaves the board exactly as it is', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk.start();

        document.querySelector('.mwi-task-reroll-walk-stop').click();

        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);
        expect(clicks).toEqual([]);
    });
});

describe('the control only exists when it is turned on', () => {
    test('with the setting off nothing is injected and nothing listens', async () => {
        settings.values.tasks_rerollWalk = false;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.isInitialized).toBe(false);
        taskRerollWalkFeature.cleanup();
    });

    test('with it on the panel gets the walk button, once', async () => {
        walk.isInitialized = false;
        await taskRerollWalkFeature.initialize();

        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        const parent = document.createElement('div');
        parent.appendChild(header);
        document.body.appendChild(parent);

        walk._injectButton(header);
        walk._injectButton(header);

        expect(parent.querySelectorAll('.mwi-task-reroll-walk-btn')).toHaveLength(1);
        taskRerollWalkFeature.cleanup();
    });
});
