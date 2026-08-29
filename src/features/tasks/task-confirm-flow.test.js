/**
 * @vitest-environment happy-dom
 *
 * What Toolasha is allowed to do to a card that is asking the player a question.
 *
 * The game's task cards are two-step: Reroll opens a chooser, the trash can
 * opens a Confirm Discard, and both sit there waiting on a second click. Two
 * separate things used to go wrong in that gap, and both of them looked
 * identical to the player — the button registers, and then nothing happens.
 *
 * One was a cancelled click: cap protection read a cost out of whatever digits
 * a reroll button's label happened to carry, and the MooPass free reroll shows
 * how many passes are left on it. That count was measured against the cowbell
 * cap, so the free reroll — which costs nothing, and so can never be over any
 * spending cap — was held back like an expensive one.
 *
 * The other was a rebuilt card: the injectors run off timers and mutations, and
 * a pass landing mid-flow reads a card whose Go button and progress line have
 * been replaced by the chooser, decides everything has changed, and tears its
 * own rows out and puts them back.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const stored = vi.hoisted(() => ({ values: {} }));
const observer = vi.hoisted(() => ({ callbacks: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        isFeatureEnabled: (key) => settings.values[key] ?? false,
        onSettingChange: () => {},
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_ACCENT: '#0f0',
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => stored.values[key] ?? fallback,
        set: async () => {},
        getJSON: async (key, _store, fallback) => stored.values[key] ?? fallback,
        getMany: async (keys) => new Map(keys.map((key) => [key, stored.values[key] ?? null])),
        setJSON: async () => {},
        delete: async () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 7,
        characterData: null,
        getInitClientData: () => null,
        on: () => {},
        off: () => {},
    },
}));

// onSocketEvent is reached through the profit display's marketplace import,
// pulled in transitively to read the board's task ratings
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, _classes, cb) => {
            observer.callbacks[name] = cb;
            return () => {};
        },
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (key) => `${key}_7`,
    readScoped: async (_key, _store, fallback) => fallback,
    readScopedFrom: async (base, values, _store, fallback) => values.get(`${base}_7`) ?? fallback,
    writeScoped: async () => true,
}));

const { default: taskRerollProtection } = await import('./task-reroll-protection.js');
const { default: taskRerollTracker } = await import('./task-reroll-tracker.js');
const { stopConfirmSettleWatch } = await import('./task-card-state.js');

const MILKING = '/actions/milking/cow';

/**
 * A task card, in whichever step the labels describe.
 * @param {Array<string>} buttonLabels - Button text for the action row
 * @returns {HTMLElement} The card, already on the board
 */
function cardOnBoard(buttonLabels) {
    const list = document.querySelector('[class*="TasksPanel_taskList"]');

    const element = document.createElement('div');
    element.className = 'RandomTask_randomTask__1abc';

    const content = document.createElement('div');
    content.className = 'RandomTask_content__2def';
    const name = document.createElement('div');
    name.className = 'RandomTask_name__3ghi';
    name.textContent = 'Milking - Cow';
    const progress = document.createElement('div');
    progress.textContent = 'Progress: 0 / 100';
    content.append(name, progress);
    element.appendChild(content);

    const action = document.createElement('div');
    action.className = 'RandomTask_action__4jkl';
    for (const label of buttonLabels) {
        const button = document.createElement('button');
        button.textContent = label;
        action.appendChild(button);
    }
    element.appendChild(action);

    list.appendChild(element);
    return element;
}

/** The button carrying this label */
const buttonNamed = (card, label) => [...card.querySelectorAll('button')].find((b) => b.textContent === label);

/**
 * Give a button the currency sprite the game draws on it.
 *
 * The paid reroll options carry a coin or cowbell icon and a number, and the
 * icon is the only thing that says which — a cowbell cost and a coin cost can
 * be the same digits.
 *
 * @param {HTMLElement} button - The chooser button
 * @param {string} currency - 'coin' or 'cowbell'
 */
function iconOn(button, currency) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/misc_sprite.svg#${currency}`);
    svg.appendChild(use);
    button.insertBefore(svg, button.firstChild);
}

/**
 * Stand a React fiber tree up over the board so the card's quest can be read.
 *
 * Protection identifies a card by walking from one of its buttons up the fiber
 * tree to the `characterQuest` prop — there is no other route, the game puts
 * nothing identifying in the DOM. Without a tree to walk, every card reads as
 * unprotected and every assertion about protection passes for the wrong reason.
 *
 * @param {HTMLElement} card - The card to give a quest to
 * @param {Object} quest - The quest that card is showing
 */
function reactTreeOver(card, quest) {
    // React redraws the action row's buttons on every step of the flow, and the
    // fiber tree is rebuilt with them — a stale tree over new buttons is a card
    // whose quest cannot be read, which is not a state the game is ever in
    document.getElementById('root')?.remove();

    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const questFiber = { memoizedProps: { characterQuest: quest }, return: null };
    let previous = null;
    for (const button of card.querySelectorAll('button')) {
        const fiber = { stateNode: button, return: questFiber, child: null, sibling: null };
        if (previous) previous.sibling = fiber;
        else questFiber.child = fiber;
        previous = fiber;
    }
    root._reactRootContainer = { current: questFiber };
}

/** Click it the way the browser would, and report whether anything cancelled it */
function click(button) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    settings.values = { taskRerollProtection: true };
    stored.values = {};
    document.body.replaceChildren();
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';
    document.body.appendChild(list);
});

afterEach(() => {
    taskRerollProtection.disable();
    taskRerollTracker.cleanup();
    stopConfirmSettleWatch();
    vi.useRealTimers();
});

/**
 * Close a card's chooser, the way pressing Back does.
 * @param {HTMLElement} card - The card mid-flow
 */
function closeChooser(card) {
    const action = card.querySelector('[class*="RandomTask_action"]');
    action.replaceChildren(
        ...['Go', 'Reroll', ''].map((label) => {
            const button = document.createElement('button');
            button.textContent = label;
            return button;
        })
    );
}

/**
 * Cap protection turned on, guarding a card that is already on the board.
 *
 * The card has to exist before the feature starts: the interceptor is wired by
 * the pass over the cards, so a board built afterwards is a board nothing is
 * watching, and every assertion about a cancelled click would pass for the
 * wrong reason.
 * @param {Array<string>} buttonLabels - Button text for the action row
 * @param {number} [coinThreshold=320000] - The cost at which a reroll counts as capped
 * @returns {Promise<HTMLElement>} The card
 */
async function guardedCard(buttonLabels, coinThreshold = 320000) {
    stored.values.taskCapProtection_7 = true;
    stored.values.taskCapCoinThreshold_7 = coinThreshold;
    stored.values.taskCapCowbellThreshold_7 = 1;
    const card = cardOnBoard(buttonLabels);
    reactTreeOver(card, { actionHrid: MILKING, coinRerollCount: 5, cowbellRerollCount: 5 });
    await taskRerollProtection.initialize();
    return card;
}

/**
 * A card the player has explicitly asked to keep, showing its reroll chooser.
 * @param {Array<string>} buttonLabels - Button text for the action row
 * @returns {Promise<HTMLElement>} The card
 */
async function protectedCard(buttonLabels) {
    stored.values.taskProtectedHrids_7 = [MILKING];
    const card = cardOnBoard(buttonLabels);
    reactTreeOver(card, { actionHrid: MILKING, coinRerollCount: 0, cowbellRerollCount: 0 });
    await taskRerollProtection.initialize();
    return card;
}

describe('the game keeps its clicks', () => {
    test('a paid reroll at the cap is still stopped — the feature still works', async () => {
        const card = await guardedCard(['Back', 'Pay 320K', 'MooPass Free Reroll (2)']);

        expect(click(buttonNamed(card, 'Pay 320K')).defaultPrevented).toBe(true);
        expect(card.querySelector('.mwi-reroll-warning')).not.toBe(null);
    });

    test('the MooPass free reroll is not cancelled by cap protection', async () => {
        // The reported symptom, exactly: the chooser opens, the free reroll is
        // pressed, and the click goes nowhere. The label carries the rerolls
        // left on the pass, and that number was being read as a reroll cost and
        // measured against the cowbell cap. A free reroll costs nothing, so
        // a cap on what a reroll may cost has nothing to say about it
        const card = await guardedCard(['Back', 'Pay 320K', 'MooPass Free Reroll (2)']);

        expect(click(buttonNamed(card, 'MooPass Free Reroll (2)')).defaultPrevented).toBe(false);
    });

    test('the free reroll is not cancelled however the build labels it', async () => {
        // The count moves and the wording has changed across builds; a pattern
        // that only knows one of them is a pattern that stops recognising the
        // free reroll on the next deploy
        const loose = await guardedCard(['Back', 'Pay 320K', 'Free Reroll (1)']);
        expect(click(buttonNamed(loose, 'Free Reroll (1)')).defaultPrevented).toBe(false);
    });

    test('pressing the free reroll twice is never blocked on the second press', async () => {
        // Nothing from the paid path's lockdown may leak onto a button that
        // costs nothing — the free reroll works on every click or it is stuck
        const card = await guardedCard(['Back', 'Pay 320K', 'MooPass Free Reroll (2)']);
        const free = buttonNamed(card, 'MooPass Free Reroll (2)');

        expect(click(free).defaultPrevented).toBe(false);
        expect(click(free).defaultPrevented).toBe(false);
        expect(card.querySelector('.mwi-reroll-warning')).toBe(null);
    });

    test('a card the player protected still holds its free reroll back', async () => {
        // The other half of the same rule: protecting a task is a choice about
        // that task, and a free reroll destroys it exactly as a paid one does
        const card = await protectedCard(['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);

        expect(click(buttonNamed(card, 'MooPass Free Reroll (2)')).defaultPrevented).toBe(true);
    });

    test('and holds back a free reroll labelled with nothing but the word', async () => {
        const card = await protectedCard(['Back', 'Pay 10K', 'Free']);

        expect(click(buttonNamed(card, 'Free')).defaultPrevented).toBe(true);
    });

    test('Back out of the chooser is never cancelled', async () => {
        const card = await guardedCard(['Back', 'Pay 320K', 'MooPass Free Reroll (2)']);

        expect(click(buttonNamed(card, 'Back')).defaultPrevented).toBe(false);
    });

    test('Confirm Discard is never cancelled', async () => {
        const card = await guardedCard(['Confirm Discard']);

        expect(click(buttonNamed(card, 'Confirm Discard')).defaultPrevented).toBe(false);
    });

    test('the trash can is never cancelled', async () => {
        // Icon-only, so it carries no text to match on either way
        const card = await guardedCard(['Go', 'Reroll', '']);
        const trash = [...card.querySelectorAll('button')].find((b) => !b.textContent);

        expect(click(trash).defaultPrevented).toBe(false);
    });

    test('a paid reroll the build draws as an icon and a number is still guarded', async () => {
        // Cap protection recognised a paid reroll by its label starting with
        // "Pay". The chooser in the user's devtools capture words nothing that
        // way — the paid options are a currency icon and a number — so the cap
        // was guarding a button the game does not draw, and every real paid
        // reroll went through untouched however high the cost had climbed
        const card = await guardedCard(['Back', '320,000', '32']);
        const coin = buttonNamed(card, '320,000');
        iconOn(coin, 'coin');
        iconOn(buttonNamed(card, '32'), 'cowbell');

        expect(click(coin).defaultPrevented).toBe(true);
        expect(card.querySelector('.mwi-reroll-warning')).not.toBe(null);
    });

    test('and the cowbell option is measured against the cowbell cap, not the coin one', async () => {
        // 32 cowbells is at the cowbell cap and nowhere near the coin one; read
        // off magnitude alone it looks like a trivial cost
        const card = await guardedCard(['Back', '32'], 320000);
        const cowbell = buttonNamed(card, '32');
        iconOn(cowbell, 'cowbell');

        expect(click(cowbell).defaultPrevented).toBe(true);
    });

    test('a protected task cannot be rerolled with coins behind protection’s back', async () => {
        const card = await protectedCard(['Back', '10,000', 'MooPass Free Reroll']);
        const coin = buttonNamed(card, '10,000');
        iconOn(coin, 'coin');

        expect(click(coin).defaultPrevented).toBe(true);
    });

    test('a blocked reroll goes through on the confirming click', async () => {
        vi.useFakeTimers();
        const card = await guardedCard(['Back', 'Pay 320K']);

        click(buttonNamed(card, 'Pay 320K'));
        vi.advanceTimersByTime(3000);

        expect(click(buttonNamed(card, 'Pay 320K')).defaultPrevented).toBe(false);
    });

    test('a lockdown timer that outlives disable() does not arm a confirmed bypass', async () => {
        // The scenario: a player clicks a protected/capped reroll (arming the
        // 3s lockdown timer), then switches character before it fires — the
        // same "character switches mid-flow" shape as the reconnect races
        // elsewhere in this audit. disable() used to tear down the dataset
        // and the document listener but had no way to cancel the in-flight
        // timer (it lived only in a WeakMap, which cannot be iterated), so it
        // fired anyway and stamped `mwiRerollConfirmed = '1'` onto the card.
        // If the same DOM node is reused for the arriving character's board
        // (or the feature simply reinitializes for the same one), the next
        // click on that card's reroll button reads as already-confirmed and
        // is let straight through — a reroll nobody actually confirmed.
        vi.useFakeTimers();
        const card = await guardedCard(['Back', 'Pay 320K']);

        click(buttonNamed(card, 'Pay 320K'));
        expect(card.dataset.mwiRerollLocked).toBe('1');

        taskRerollProtection.disable();
        expect(card.dataset.mwiRerollLocked).toBeUndefined();

        // The lockdown timer's 3s elapses after teardown; it must not still
        // be armed
        vi.advanceTimersByTime(3000);
        expect(card.dataset.mwiRerollConfirmed).toBeUndefined();

        // Reinitializing (as a character switch would) and clicking the same
        // button again must run the full lockdown again, not fast-path
        // through a stale "confirmed" flag
        await taskRerollProtection.initialize();
        expect(click(buttonNamed(card, 'Pay 320K')).defaultPrevented).toBe(true);
        expect(card.dataset.mwiRerollConfirmed).toBeUndefined();
    });

    test('switching the feature off takes the interceptor off the document', async () => {
        const card = await guardedCard(['Back', 'Pay 320K']);

        taskRerollProtection.disable();

        // A listener bound to the document, not to a card, survives everything
        // else the feature cleans up unless it is removed by name
        expect(click(buttonNamed(card, 'Pay 320K')).defaultPrevented).toBe(false);
    });
});

describe('a card mid-flow is left alone', () => {
    test('the reroll-spend line is not inserted while the chooser is open', () => {
        const card = cardOnBoard(['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        const before = [...card.querySelector('[class*="RandomTask_content"]').childNodes];

        taskRerollTracker.updateAllTaskDisplays();

        const content = card.querySelector('[class*="RandomTask_content"]');
        expect(content.querySelector('.mwi-reroll-cost-display')).toBe(null);
        expect([...content.childNodes]).toEqual(before);
    });

    test('nor while the discard confirmation is up', () => {
        const card = cardOnBoard(['Confirm Discard']);

        taskRerollTracker.updateAllTaskDisplays();

        expect(card.querySelector('.mwi-reroll-cost-display')).toBe(null);
    });

    test('and it goes in again once the card is back at rest', () => {
        const card = cardOnBoard(['Go', 'Reroll', '']);

        taskRerollTracker.updateAllTaskDisplays();

        expect(card.querySelector('.mwi-reroll-cost-display')).not.toBe(null);
    });

    test('and it goes in when the chooser closes, without waiting for a new card', async () => {
        // The half that was missing. The game leaves the chooser open after a
        // reroll, and closing it adds an action row, not a card — so none of
        // the observers that would have run this pass again ever fire, and the
        // line the skip declined to draw stayed undrawn for the session.
        vi.useFakeTimers();
        const card = cardOnBoard(['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        await taskRerollTracker.initialize();

        taskRerollTracker.updateAllTaskDisplays();
        expect(card.querySelector('.mwi-reroll-cost-display')).toBe(null);

        closeChooser(card);
        vi.advanceTimersByTime(300);

        expect(card.querySelector('.mwi-reroll-cost-display')).not.toBe(null);
    });

    test('but a card whose task changed under the chooser is redrawn at once', async () => {
        // Paying for a reroll does not close the chooser: the game puts the new
        // task above it and waits. Under the plain skip every row Toolasha draws
        // went on describing the task that had just been thrown away, for as
        // long as the player kept rerolling — the reported "the estimate is
        // still the old task's until I press Back".
        const card = cardOnBoard(['Go', 'Reroll', '']);
        await taskRerollTracker.initialize();

        taskRerollTracker.updateAllTaskDisplays();
        expect(card.querySelector('.mwi-reroll-cost-display')).not.toBe(null);

        // The chooser opens over the same task: still left alone
        const action = card.querySelector('[class*="RandomTask_action"]');
        action.replaceChildren(
            ...['Back', 'Pay 10K', 'MooPass Free Reroll (2)'].map((label) => {
                const button = document.createElement('button');
                button.textContent = label;
                return button;
            })
        );
        card.querySelector('.mwi-reroll-cost-display').remove();
        taskRerollTracker.updateAllTaskDisplays();
        expect(card.querySelector('.mwi-reroll-cost-display')).toBe(null);

        // The reroll lands — same chooser, different task
        card.querySelector('[class*="RandomTask_name"]').textContent = 'Cooking - Stew';
        taskRerollTracker.updateAllTaskDisplays();

        expect(card.querySelector('.mwi-reroll-cost-display')).not.toBe(null);
    });

    test('the cap edge shows while the chooser is still open', async () => {
        // A card mid-flow (its reroll chooser open) whose task has spent its
        // rerolls to the cap gets the orange edge now, not only once Back is
        // pressed — the edge is an inset shadow that cannot disturb the click the
        // player is in the middle of.
        vi.useFakeTimers();
        const card = await guardedCard(['Back', 'Pay 320K', 'MooPass Free Reroll (2)']);

        expect(card.style.boxShadow).toContain('251, 146, 60');
    });

    test('the protected edge shows the instant a reroll lands, before the chooser is closed', async () => {
        // The request: the green edge should move to the task the reroll landed
        // on right away rather than waiting for the menu to be closed. The card
        // is mid-flow here and the task on it is one the player asked to keep, so
        // its edge is already green.
        vi.useFakeTimers();
        const card = await protectedCard(['Back', '10,000', 'MooPass Free Reroll']);

        expect(card.style.boxShadow).toContain('76, 175, 80');
    });

    test('a card that appears is bordered at once, not a beat after the board opens', async () => {
        // The report: the protected green edge only turned up a moment after the
        // Task Board opened. The card-appeared observer now paints the card
        // synchronously; the 150 ms pass is a fallback. With fake timers never
        // advanced, the edge must already be there off the observer's own call.
        vi.useFakeTimers();
        stored.values.taskProtectedHrids_7 = [MILKING];
        await taskRerollProtection.initialize();

        const card = cardOnBoard(['Reroll', 'Go', '']);
        reactTreeOver(card, { actionHrid: MILKING, coinRerollCount: 0, cowbellRerollCount: 0 });

        observer.callbacks.TaskRerollProtection(card);

        expect(card.style.boxShadow).toContain('76, 175, 80');
    });

    test('the outline reset is held back on a card mid-flow', async () => {
        // The border edge is redrawn mid-flow now, but the legacy outline reset
        // is not: task-auto-reroll draws its "worth rerolling" outline the same
        // way, and two features stripping and redrawing it on a card the player
        // is mid-click on is the flicker this defers. The outline and its badge
        // survive the pass.
        const card = cardOnBoard(['Back', 'Pay 10K']);
        card.style.setProperty('outline', '2px solid rgba(239, 68, 68, 0.7)', 'important');
        const badge = document.createElement('div');
        badge.className = 'mwi-autoreroll-badge';
        card.appendChild(badge);

        await taskRerollProtection.initialize();

        expect(card.style.outline).toContain('239, 68, 68');
        expect(card.querySelector('.mwi-autoreroll-badge')).toBe(badge);
    });
});
