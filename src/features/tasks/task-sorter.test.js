/**
 * @vitest-environment happy-dom
 *
 * Sorting after Read, built rather than reasoned about.
 *
 * The sorting arithmetic is not what breaks here. What breaks is the listener:
 * the card holding the Read button is drawn and thrown away by the game every
 * time the unread count changes, so anything bound to one instance of it stops
 * working at the next render — and stops working silently, which is the worst
 * way for a sort to fail.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        isFeatureEnabled: () => false,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('./task-icons.js', () => ({ default: {} }));
vi.mock('./task-icon-filters.js', () => ({ default: { addFilterBar: () => {} } }));
vi.mock('./task-reroll-protection.js', () => ({ default: { isProtected: () => false } }));

const { default: taskSorter } = await import('./task-sorter.js');

/**
 * A task board with the cards named, in the order given.
 * @param {Array<string>} names - Task headings, e.g. 'Defeat - Slashy'
 * @returns {HTMLElement} The task list
 */
function board(names) {
    const panel = document.createElement('div');
    panel.className = 'TasksPanel_tasksPanel__abc';

    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';

    for (const name of names) {
        const cardEl = document.createElement('div');
        cardEl.className = 'RandomTask_randomTask__1abc';
        const heading = document.createElement('div');
        heading.className = 'RandomTask_name__2def';
        heading.textContent = name;
        cardEl.appendChild(heading);
        list.appendChild(cardEl);
    }

    panel.appendChild(list);
    document.body.appendChild(panel);
    return list;
}

/**
 * The game's Read button, inside the tasks panel.
 * @param {HTMLElement} list - The task list
 * @returns {HTMLElement}
 */
function readButton(list) {
    const button = document.createElement('button');
    button.textContent = 'Read';
    list.parentElement.appendChild(button);
    return button;
}

const order = (list) => [...list.querySelectorAll('[class*="RandomTask_name"]')].map((el) => el.textContent);

beforeEach(() => {
    vi.useFakeTimers();
    settings.values = { taskSorter_sortAfterRead: true, taskSorter_sortMode: 'skill' };
    document.body.replaceChildren();
    taskSorter.initialize();
});

afterEach(() => {
    taskSorter.cleanup();
    vi.useRealTimers();
});

describe('sorting after Read', () => {
    test('a board read into disorder is put back in order', () => {
        // New tasks arrive at the end however the rest was arranged, which is
        // the whole reason this exists
        const list = board(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);

        readButton(list).click();
        vi.advanceTimersByTime(500);

        expect(order(list)).toEqual(['Milking - Cow', 'Cooking - Stew', 'Defeat - Slashy']);
    });

    test('it waits for the tasks to arrive rather than guessing how long they take', async () => {
        // A fixed delay sorts everything except the tasks that were just read,
        // on any machine slower than the one it was written on
        const list = board(['Defeat - Slashy']);

        readButton(list).click();
        // Well past any fixed delay a guess would have used
        await vi.advanceTimersByTimeAsync(1500);

        const late = document.createElement('div');
        late.className = 'RandomTask_randomTask__1abc';
        const heading = document.createElement('div');
        heading.className = 'RandomTask_name__2def';
        heading.textContent = 'Milking - Cow';
        late.appendChild(heading);
        list.appendChild(late);

        await vi.advanceTimersByTimeAsync(500);
        expect(order(list)).toEqual(['Milking - Cow', 'Defeat - Slashy']);
    });

    test('with the option off it leaves the board alone', () => {
        settings.values.taskSorter_sortAfterRead = false;
        const list = board(['Defeat - Slashy', 'Milking - Cow']);

        readButton(list).click();
        vi.advanceTimersByTime(500);

        expect(order(list)).toEqual(['Defeat - Slashy', 'Milking - Cow']);
    });

    test('a Read button somewhere else in the game is not this one', () => {
        const list = board(['Defeat - Slashy', 'Milking - Cow']);

        const elsewhere = document.createElement('button');
        elsewhere.textContent = 'Read';
        document.body.appendChild(elsewhere);
        elsewhere.click();
        vi.advanceTimersByTime(500);

        expect(order(list)).toEqual(['Defeat - Slashy', 'Milking - Cow']);
    });

    test('it survives the card being redrawn, which the game does constantly', () => {
        // Bound to the button rather than delegated, this is the test that
        // fails: the second card is a different element
        const list = board(['Defeat - Slashy', 'Milking - Cow']);

        readButton(list).remove();
        readButton(list).click();
        vi.advanceTimersByTime(500);

        expect(order(list)).toEqual(['Milking - Cow', 'Defeat - Slashy']);
    });

    test('a card mid-reroll holds the sort back', () => {
        // Sorting re-appends every card, which takes the one the player is
        // part-way through out of the DOM and puts it back — the click they are
        // about to make lands on a card that has been rebuilt under it
        const list = board(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);
        const before = [...list.children];
        const chooser = document.createElement('button');
        chooser.textContent = 'MooPass Free Reroll';
        list.children[0].appendChild(chooser);

        readButton(list).click();
        vi.advanceTimersByTime(500);

        expect([...list.children]).toEqual(before);
    });

    test('and the sort happens once the card is back at rest', () => {
        const list = board(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);
        const chooser = document.createElement('button');
        chooser.textContent = 'MooPass Free Reroll';
        list.children[0].appendChild(chooser);

        readButton(list).click();
        vi.advanceTimersByTime(500);
        chooser.remove();
        taskSorter.sortTasks();

        expect(order(list)).toEqual(['Milking - Cow', 'Cooking - Stew', 'Defeat - Slashy']);
    });

    test('cleanup stops it listening', () => {
        const list = board(['Defeat - Slashy', 'Milking - Cow']);
        taskSorter.cleanup();

        readButton(list).click();
        vi.advanceTimersByTime(500);

        expect(order(list)).toEqual(['Defeat - Slashy', 'Milking - Cow']);
    });
});

describe('a board the player asked to keep sorted', () => {
    /**
     * Start the sorter over with auto-sort set one way or the other.
     * @param {boolean} autoSort - Whether the player has asked for a sorted board
     */
    function restart(autoSort) {
        taskSorter.cleanup();
        settings.values.taskSorter_autoSort = autoSort;
        taskSorter.initialize();
    }

    /**
     * A board whose first card is showing its reroll chooser.
     * @returns {{list: HTMLElement, chooser: HTMLElement}} The board and the chooser
     */
    function boardMidReroll() {
        const list = board(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);
        const chooser = document.createElement('button');
        chooser.textContent = 'MooPass Free Reroll';
        list.children[0].appendChild(chooser);
        return { list, chooser };
    }

    test('sorts itself once the reroll the player was making is finished', () => {
        // The gap this closes: a reroll is the commonest way a sorted board
        // stops being sorted, and the pass that would have fixed it is the one
        // the chooser held back. Nothing re-ran when the chooser closed, so an
        // auto-sorted board sat unsorted until the panel was reopened.
        restart(true);
        const { list, chooser } = boardMidReroll();

        taskSorter.sortTasks();
        expect(order(list)).toEqual(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);

        chooser.remove();
        vi.advanceTimersByTime(1000);

        expect(order(list)).toEqual(['Milking - Cow', 'Cooking - Stew', 'Defeat - Slashy']);
    });

    test('with auto-sort off the board waits for the button', () => {
        // Sorting is something the player does, and re-ordering the board a
        // second after they closed a chooser is not what they pressed anything
        // for
        restart(false);
        const { list, chooser } = boardMidReroll();

        taskSorter.sortTasks();
        chooser.remove();
        vi.advanceTimersByTime(1000);

        expect(order(list)).toEqual(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);
    });

    test('a direct Sort press is honoured at once, reroll chooser open and all', () => {
        // The automatic passes defer while a card is mid-flow, but pressing the
        // button is the player asking for order right now — force sorts through.
        restart(false);
        const { list } = boardMidReroll();

        taskSorter.sortTasks(true);

        expect(order(list)).toEqual(['Milking - Cow', 'Cooking - Stew', 'Defeat - Slashy']);
    });

    test('cleanup takes the subscription with it', () => {
        restart(true);
        const { list, chooser } = boardMidReroll();

        taskSorter.sortTasks();
        taskSorter.cleanup();
        chooser.remove();
        vi.advanceTimersByTime(1000);

        expect(order(list)).toEqual(['Defeat - Slashy', 'Cooking - Stew', 'Milking - Cow']);
    });
});
