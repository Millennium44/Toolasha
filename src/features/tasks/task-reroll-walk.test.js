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
 *
 * The second thing worth pinning down is the money. The walk stops where the
 * shield popup says to stop, and between the two prices it picks the cheaper
 * one in coins — a rule that is only useful if it says out loud which it picked
 * and why.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const stored = vi.hoisted(() => ({ values: {} }));
const market = vi.hoisted(() => ({ cowbellValue: 8000 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        setSetting: (key, value) => {
            settings.values[key] = value;
        },
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
        delete: async (key) => {
            delete stored.values[key];
            return true;
        },
    },
}));
// The walk reads its thresholds through readScoped, whose adopt-once migration
// asks who owns pre-scoping data. The dialog is the consent module's business;
// here the answer is just set.
const consent = vi.hoisted(() => ({ target: null, requested: 0 }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => consent.target,
    requestAdoptionConsent: async () => {
        consent.requested += 1;
        return null;
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 7, getMooPassBuffs: () => [] },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
// The board watcher would re-render the widget on every DOM change a test makes;
// the tests drive the walk directly instead
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('./task-profit-calculator.js', () => ({ getCowbellValue: () => market.cowbellValue }));
const sorter = vi.hoisted(() => ({ sortTasks: vi.fn() }));
vi.mock('./task-sorter.js', () => ({ default: sorter }));

const {
    default: taskRerollWalkFeature,
    verdictForCard,
    preferredRerollOption,
    nextRerollCosts,
    chooseReroll,
} = await import('./task-reroll-walk.js');
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

/**
 * Put the game's "You have N unread tasks" notice at the top of the board.
 * @param {HTMLElement} list - The task list
 * @returns {HTMLElement} The notice
 */
function unreadNotice(list) {
    const notice = document.createElement('div');
    notice.className = 'TasksPanel_unreadTasks__sVdle';
    const button = document.createElement('button');
    button.textContent = 'Read';
    record(button, 'Notice', 'Read');
    notice.appendChild(button);
    list.prepend(notice);
    return notice;
}

/** A resting card's buttons: Go, Reroll and the icon-only trash can */
const AT_REST = ['Go', 'Reroll', ''];
/** The reroll chooser */
const CHOOSER = ['Back', 'MooPass Free Reroll (2)'];

/** A quest for a card, with however many rerolls have been spent on it */
const quest = (actionHrid, coinSpent = 0, cowbellSpent = 0) => ({
    actionHrid,
    coinRerollCount: coinSpent,
    cowbellRerollCount: cowbellSpent,
});

/** Let the walk's own awaits settle — storage is mocked, so these are microtasks */
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** What the widget currently offers */
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
        tasks_rerollWalkCurrency: 'auto',
        tasks_rerollWalkTrashAtLimit: true,
    };
    stored.values = {};
    consent.target = null;
    consent.requested = 0;
    market.cowbellValue = 8000;
    walk.protectedHrids = new Set();
    walk.state = 'idle';
    walk.step = null;
    walk.index = 0;
    walk.hidden = false;
    walk.widget = null;
    // The shield popup's defaults: nothing is blocked until the price ladder caps
    walk.coinThreshold = 320000;
    walk.cowbellThreshold = 32;
    document.body.replaceChildren();
});

afterEach(() => {
    walk.stop();
    vi.useRealTimers();
});

describe('what the next reroll costs', () => {
    test('the ladder doubles per currency and caps where the game caps it', () => {
        expect(nextRerollCosts(quest(MILKING, 0, 0))).toEqual({ coin: 10000, cowbell: 1 });
        expect(nextRerollCosts(quest(MILKING, 2, 3))).toEqual({ coin: 40000, cowbell: 8 });
        expect(nextRerollCosts(quest(MILKING, 9, 9))).toEqual({ coin: 320000, cowbell: 32 });
    });

    test('a card with no readable quest has no price', () => {
        expect(nextRerollCosts(null)).toBe(null);
    });
});

describe('which reroll gets bought', () => {
    const base = { coinThreshold: 320000, cowbellThreshold: 32, cowbellValue: 8000, preference: 'auto' };

    test('a free reroll beats both prices', () => {
        expect(chooseReroll({ ...base, coin: 10000, cowbell: 1, free: true }).currency).toBe('free');
    });

    test('cowbells win when they are worth less in coins, and the label says so', () => {
        const choice = chooseReroll({ ...base, coin: 20000, cowbell: 2 });
        expect(choice.currency).toBe('cowbell');
        expect(choice.costLabel).toBe('2🔔');
        expect(choice.why).toBe('≈16.0K, cheaper than 20.0K🪙');
    });

    test('coins win when the cowbells are dearer', () => {
        const choice = chooseReroll({ ...base, coin: 10000, cowbell: 2 });
        expect(choice.currency).toBe('coin');
        expect(choice.why).toContain('cheaper than 2🔔');
    });

    test('one currency over its threshold leaves the other', () => {
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, cowbellThreshold: 2 })).toMatchObject({
            currency: 'coin',
            why: 'cowbells blocked',
        });
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, coinThreshold: 20000 })).toMatchObject({
            currency: 'cowbell',
            why: 'coins blocked',
        });
    });

    test('both over their thresholds is blocked, whatever they cost', () => {
        const choice = chooseReroll({ ...base, coin: 320000, cowbell: 32 });
        expect(choice.currency).toBe(null);
        expect(choice.why).toBe('both reroll options blocked');
    });

    test('a preference overrides the arithmetic, but not a block', () => {
        expect(chooseReroll({ ...base, coin: 10000, cowbell: 2, preference: 'cowbell' })).toMatchObject({
            currency: 'cowbell',
            why: 'preferred',
        });
        expect(chooseReroll({ ...base, coin: 20000, cowbell: 2, preference: 'coin' })).toMatchObject({
            currency: 'coin',
            why: 'preferred',
        });
        // Asking for cowbells when cowbells are blocked still pays coins
        expect(
            chooseReroll({ ...base, coin: 20000, cowbell: 32, cowbellThreshold: 32, preference: 'cowbell' }).currency
        ).toBe('coin');
    });
});

describe('what the walk decides about one card', () => {
    const choice = { currency: 'cowbell', costLabel: '2🔔', why: 'preferred' };
    const base = { completed: false, isProtected: false, choice, trashAtLimit: true };

    test('a task the player asked to keep is left alone', () => {
        expect(verdictForCard({ ...base, isProtected: true }).action).toBe('skip');
    });

    test('a task waiting to be claimed is never rerolled out from under the reward', () => {
        expect(verdictForCard({ ...base, completed: true }).action).toBe('skip');
    });

    test('a task with an affordable reroll is rerolled, and the reason is the price', () => {
        const verdict = verdictForCard(base);
        expect(verdict.action).toBe('reroll');
        expect(verdict.reason).toBe('2🔔 (preferred)');
    });

    test('a blocked task is discarded, or skipped when that is off', () => {
        const blocked = { currency: null, costLabel: '', why: 'both reroll options blocked' };
        expect(verdictForCard({ ...base, choice: blocked }).action).toBe('trash');
        expect(verdictForCard({ ...base, choice: blocked, trashAtLimit: false }).action).toBe('skip');
    });

    test('a card whose price cannot be read is left alone rather than guessed at', () => {
        expect(verdictForCard({ ...base, choice: null }).action).toBe('skip');
    });
});

describe('which reroll option gets pressed', () => {
    const option = (kind, available = true) => ({ kind, available, cost: kind === 'coin' ? 10000 : 1 });

    test('free before paid', () => {
        expect(preferredRerollOption([option('coin'), option('free')]).kind).toBe('free');
    });

    test('the currency the plan priced is the button pressed', () => {
        expect(preferredRerollOption([option('coin'), option('cowbell')], 'coin').kind).toBe('coin');
        expect(preferredRerollOption([option('coin'), option('cowbell')], 'cowbell').kind).toBe('cowbell');
    });

    test('with no currency named it falls back to cowbells before coins', () => {
        expect(preferredRerollOption([option('coin'), option('cowbell')]).kind).toBe('cowbell');
    });

    test('a spent free reroll is not pressed', () => {
        expect(preferredRerollOption([option('free', false), option('coin')], 'coin').kind).toBe('coin');
    });

    test('nothing on offer is nothing pressed', () => {
        expect(preferredRerollOption([option('free', false)])).toBe(null);
    });
});

describe('planning a walk down the board', () => {
    test('it opens on the first card that needs something, priced', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
        ]);

        await walk.start();

        // First reroll: 10K coins against one cowbell worth ~8K
        expect(chipText()).toContain('Reroll #2 — 1🔔');
        expect(clicks).toEqual([]);
    });

    test('coins are chosen, and named, when the cowbell is the dearer of the two', async () => {
        market.cowbellValue = 30000;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1 — 10.0K🪙');
        expect(chipText()).toContain('cheaper than 1🔔');
    });

    test('a board of nothing but protected tasks finishes without a click', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
            { name: 'Brewing - Coffee', buttons: AT_REST, quest: quest(KEEPER) },
        ]);

        await walk.start();

        expect(chipText()).toBe('✓ Done — 2 kept, 0 rerolled, 0 trashed');
        expect(clicks).toEqual([]);
    });

    test('a threshold edited in the shield popup is in force for the very first plan', async () => {
        // The walk reads the thresholds at start-up and again when a walk
        // starts, to catch an edit made in the shield popup since. Planning
        // before that read has come back plans against the old numbers, and the
        // first card — the one the player is looking at while they change the
        // setting — is exactly the one that gets it wrong.
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        walk.coinThreshold = 320000;
        walk.cowbellThreshold = 32;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toBe('▶ Trash #1 (both reroll options blocked)');
    });

    test('a task both of whose rerolls are blocked is offered for discard', async () => {
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toBe('▶ Trash #1 (both reroll options blocked)');
    });

    test('with discard-at-limit off a blocked task is passed over instead', async () => {
        settings.values.tasks_rerollWalkTrashAtLimit = false;
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING, 2, 2) }]);

        await walk.start();

        expect(chipText()).toContain('1 kept');
    });

    test('a task blocked in one currency still rerolls with the other', async () => {
        stored.values.taskCapCowbellThreshold_7 = 1;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        await walk.start();

        expect(chipText()).toContain('Reroll #1 — 10.0K🪙 (cowbells blocked)');
    });

    test('a chooser refusing one currency pays the other rather than giving up on the card', async () => {
        // While the chooser is open its own buttons are the only prices that can
        // actually be paid. Falling back to the game's price ladder for a
        // currency the chooser is *refusing* — the player cannot afford it, so
        // the game greys the button out — prices a button that does not exist to
        // press: the plan names coins, `preferredRerollOption` finds no pressable
        // coin option, and the walk waits it out and then stops on a board it
        // could have kept walking with cowbells.
        market.cowbellValue = 30000; // so coins would win on price alone
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000', '2'], quest: quest(MILKING) }]);
        [...list.querySelectorAll('button')].find((b) => b.textContent === '10,000').disabled = true;

        await walk.start();
        vi.advanceTimersByTime(5000);

        expect(chipText()).toContain('Reroll #1 — 2🔔');
        expect(clicks).toEqual([]);
    });

    test('an empty board says so rather than offering a press', async () => {
        board([]);

        await walk.start();

        expect(chipText()).toContain('No tasks on the board');
    });
});

describe('the unread notice is read first', () => {
    test('unread tasks are read before anything is rerolled, one press each', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');
        expect(clicks).toEqual([]);

        walk.advance();
        expect(clicks).toEqual(['Notice:Read']);

        // The game reveals the tasks and the notice goes away; the walk resumes
        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(chipText()).toContain('Reroll #1');

        // A notice reappearing mid-walk is not pressed again — indexes must stay put
        unreadNotice(list);
        walk.advance();
        expect(clicks).toEqual(['Notice:Read', 'Milking - Cow:Reroll']);
    });

    test('a board that is nothing but the notice still starts, reads, and finishes', async () => {
        const list = board([]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');

        walk.advance();
        expect(clicks).toEqual(['Notice:Read']);
        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(chipText()).toContain('✓ Done');
    });

    test('reading respects the auto-sort setting: sort runs after the press, before the next plan', async () => {
        settings.values.taskSorter_autoSort = true;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        expect(sorter.sortTasks).not.toHaveBeenCalled(); // not before the board settles

        notice.remove();
        vi.advanceTimersByTime(3000);
        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
        expect(chipText()).toContain('Reroll #1');
    });

    test('with both sort settings off, reading never sorts', async () => {
        settings.values.taskSorter_autoSort = false;
        settings.values.taskSorter_sortAfterRead = false;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).not.toHaveBeenCalled();
    });

    test('sort-after-read is honoured, being the setting written for exactly this moment', async () => {
        // The walk's Read press goes through the React handler, so the sorter's
        // own document-level Read delegate never sees a click and never fires.
        // The walk's compensating sort is the only thing left — and it was
        // asking taskSorter_autoSort, which is the *panel opening* setting.
        // A player with "Sort tasks after reading new ones" on and auto-sort off
        // got no sort at all.
        settings.values.taskSorter_autoSort = false;
        settings.values.taskSorter_sortAfterRead = true;
        sorter.sortTasks.mockClear();
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).toHaveBeenCalledTimes(1);
    });

    test('the post-read sort is forced, so a chooser left open elsewhere cannot swallow it', async () => {
        // An unforced sortTasks() returns without touching the board whenever
        // any card is mid-flow (task-sorter.js `boardHasConfirmingCard`), and a
        // reroll chooser left open is the walk's ordinary resting state: the
        // game keeps the chooser open after a reroll, and the walk only presses
        // Back on cards it is skipping. So the sort the walk asked for after
        // reading was silently dropped on exactly the boards the walk produces.
        settings.values.taskSorter_autoSort = true;
        sorter.sortTasks.mockClear();
        const list = board([
            { name: 'Milking - Cow', buttons: CHOOSER, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        const notice = unreadNotice(list);

        await walk.start();
        walk.advance();
        notice.remove();
        vi.advanceTimersByTime(3000);

        expect(sorter.sortTasks).toHaveBeenCalledWith(true);
    });

    test('a notice a press did not clear is offered again, a bounded few times', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const list = document.querySelector('[class*="TasksPanel_taskList"]');
        unreadNotice(list);

        await walk.start();

        // The notice stays: the click did not reach the game. Three presses, then on.
        for (let press = 1; press <= 3; press++) {
            expect(chipText()).toBe('▶ Read unread tasks');
            walk.advance();
            vi.advanceTimersByTime(3000);
        }
        expect(clicks).toEqual(['Notice:Read', 'Notice:Read', 'Notice:Read']);
        expect(chipText()).toContain('Reroll #1');
    });

    test('a notice already read elsewhere is walked past without a click', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        const notice = unreadNotice(list);

        await walk.start();
        expect(chipText()).toBe('▶ Read unread tasks');

        // Someone pressed the game's own Read before the walk's press
        notice.remove();
        walk.advance();
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('Reroll #1');
    });
});

describe('one press, one game click', () => {
    test('opening the chooser is its own press, and paying is the next', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();
        expect(chipText()).toContain('open the menu');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        // The game opens the chooser; the walk re-reads and offers the payment
        setButtons(list, 1, CHOOSER);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Reroll #1 — free');

        // Nothing pressed itself while that was worked out, however long is left
        vi.advanceTimersByTime(10000);
        expect(clicks).toEqual(['Milking - Cow:Reroll']);

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:Reroll', 'Milking - Cow:MooPass Free Reroll (2)']);

        vi.advanceTimersByTime(10000);
        expect(clicks).toHaveLength(2);
    });

    test('a reroll the game has not answered is never offered for payment a second time', async () => {
        // The board looking exactly as it did before the payment is the one
        // thing that proves the reroll has NOT landed yet: a reroll changes the
        // task. Offering the same card's Pay button again on that evidence
        // charges a second reroll while quoting the first one's price — and the
        // price the player is actually charged is the doubled one, which here is
        // over the threshold they set.
        //
        // This is reachable well inside the server settle window, because any
        // `quests_updated` at all (a combat kill ticking a task's progress will
        // do) cuts the wait to UI_SETTLE_MS.
        stored.values.taskCapCoinThreshold_7 = 20000; // the 10K reroll is allowed; the 20K it becomes is not
        board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);

        await walk.start();
        expect(chipText()).toContain('Reroll #1 — 10.0K🪙');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);

        // The game has not answered: same task, same chooser, same reroll count
        vi.advanceTimersByTime(10000);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual(['Milking - Cow:10,000']);
        expect(chipText()).toContain('walk stopped');
    });

    test('once the reroll does land the walk carries on from the task that arrived', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: ['Back', '10,000'], quest: quest(MILKING) }]);

        await walk.start();
        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:10,000']);

        // The reroll lands: a new task, and the game has taken its coin
        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';
        const questFiber = document.getElementById('root')._reactRootContainer.current.child;
        questFiber.memoizedProps.characterQuest = quest('/actions/cooking/stew', 1, 0);
        vi.advanceTimersByTime(3000);

        expect(chipText()).toContain('Reroll #1 — 10.0K🪙');
        expect(walk.state).toBe('ready');
    });

    test('trashing takes two presses too, and the second is the confirm', async () => {
        stored.values.taskCapCoinThreshold_7 = 10000;
        stored.values.taskCapCowbellThreshold_7 = 1;
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash']);

        setButtons(list, 1, ['Confirm Discard']);
        vi.advanceTimersByTime(200);
        expect(chipText()).toBe('▶ Confirm discard #1');

        walk.advance();
        expect(clicks).toEqual(['Milking - Cow:trash', 'Milking - Cow:Confirm Discard']);
    });

    test('a chooser left open on a card being passed over is closed, one press', async () => {
        walk.protectedHrids = new Set([KEEPER]);
        board([{ name: 'Brewing - Coffee', buttons: CHOOSER, quest: quest(KEEPER) }]);

        await walk.start();
        expect(chipText()).toBe('▶ Close the menu on #1');

        walk.advance();
        expect(clicks).toEqual(['Brewing - Coffee:Back']);
    });

    test('a press with nothing on offer does nothing', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the walk re-evaluates the task the reroll actually landed on', async () => {
        // The point of doing this one press at a time: what arrives may be
        // something the player is keeping, and the walk has to notice
        walk.protectedHrids = new Set([KEEPER]);
        const list = board([{ name: 'Milking - Cow', buttons: CHOOSER, quest: quest(MILKING) }]);
        await walk.start();
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
    test('a card that is no longer in its slot stops it', async () => {
        const list = board([
            { name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) },
            { name: 'Cooking - Stew', buttons: AT_REST, quest: quest('/actions/cooking/stew') },
        ]);
        await walk.start();

        // The board is re-ordered under the plan — the sorter, a completed task
        list.prepend(list.children[1]);

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('walk stopped');
    });

    test('a task that changed under the plan stops it', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        list.children[0].querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
        expect(chipText()).toContain('The task in slot 1 changed');
    });

    test('a button that has gone stops it', async () => {
        const list = board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        list.children[0].querySelector('[class*="RandomTask_action"]').replaceChildren();

        expect(walk.advance()).toBe(false);
        expect(clicks).toEqual([]);
    });

    test('the close button leaves the board exactly as it is', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        await walk.start();

        document.querySelector('.mwi-task-reroll-walk-stop').click();

        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);
        expect(clicks).toEqual([]);
    });
});

describe('the floating walk widget', () => {
    test('it offers to start before anything has been walked', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);

        walk._render();

        expect(chipText()).toBe('▶ Reroll walk');
        expect(clicks).toEqual([]);
    });

    test('the main button becomes the next action once a walk is running', async () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-advance').click();
        // A click handler cannot await the thresholds read; the label arrives
        // with the first plan, a few microtasks later
        await flush();

        expect(chipText()).toContain('Reroll #1 —');
        // Starting a walk is not a game action; the first press only plans
        expect(clicks).toEqual([]);
    });

    test('the header 🎲 shows the widget again after it was closed', () => {
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-stop').click();
        expect(document.getElementById('mwi-task-reroll-walk-chip')).toBe(null);

        walk.toggleWidget();
        expect(document.getElementById('mwi-task-reroll-walk-chip')).not.toBe(null);
    });

    test('the gear shows the thresholds it obeys and binds its own settings', () => {
        walk.coinThreshold = 80000;
        walk.cowbellThreshold = 8;
        board([{ name: 'Milking - Cow', buttons: AT_REST, quest: quest(MILKING) }]);
        walk._render();

        document.querySelector('.mwi-task-reroll-walk-chip-gear').click();
        const drawer = document.querySelector('.mwi-task-reroll-walk-chip-settings');
        expect(drawer.textContent).toContain('80.0K🪙 / 8🔔');
        expect(drawer.textContent).toContain('task-protection popup');

        const box = drawer.querySelector('.mwi-widget-setting-tasks_rerollWalkTrashAtLimit');
        expect(box.checked).toBe(true);
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(settings.values.tasks_rerollWalkTrashAtLimit).toBe(false);

        const pick = drawer.querySelector('.mwi-widget-setting-tasks_rerollWalkCurrency');
        pick.value = 'coin';
        pick.dispatchEvent(new Event('change'));
        expect(settings.values.tasks_rerollWalkCurrency).toBe('coin');
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

    test('the thresholds come from the keys the shield popup writes', async () => {
        stored.values.taskCapCoinThreshold_7 = 40000;
        stored.values.taskCapCowbellThreshold_7 = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(40000);
        expect(walk.cowbellThreshold).toBe(4);
        taskRerollWalkFeature.cleanup();
    });

    test('an alt does not inherit the pre-scoping thresholds, which stay for the main', async () => {
        consent.target = 'someoneElse';
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(320000);
        expect(walk.cowbellThreshold).toBe(32);
        // Untouched: they belong to whoever the user said owns them
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
        expect(stored.values.taskCapCowbellThreshold).toBe(4);
        taskRerollWalkFeature.cleanup();
    });

    test('the chosen character adopts the pre-scoping thresholds and the bare keys go', async () => {
        consent.target = 7;
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(40000);
        expect(walk.cowbellThreshold).toBe(4);
        expect('taskCapCoinThreshold' in stored.values).toBe(false);
        expect('taskCapCowbellThreshold' in stored.values).toBe(false);
        taskRerollWalkFeature.cleanup();
    });

    test('a scoped threshold wins over a leftover bare one', async () => {
        consent.target = 7;
        stored.values.taskCapCoinThreshold_7 = 80000;
        stored.values.taskCapCoinThreshold = 40000;
        walk.isInitialized = false;

        await taskRerollWalkFeature.initialize();

        expect(walk.coinThreshold).toBe(80000);
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
        taskRerollWalkFeature.cleanup();
    });
});
