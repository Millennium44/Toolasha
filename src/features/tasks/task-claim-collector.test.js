/**
 * @vitest-environment happy-dom
 *
 * The header's Claim Reward proxy: one press, one claim, through the game's
 * React handler.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const reactClick = vi.hoisted(() => ({ clickThroughReact: vi.fn(() => 'react') }));
vi.mock('../../utils/react-click.js', () => reactClick);
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
// onReady runs its callback at once, as the real observer does when it is already attached
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (_name, callback) => {
            callback();
            return () => {};
        },
    },
}));

const { default: collector } = await import('./task-claim-collector.js');

function board(labels) {
    document.body.replaceChildren();
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';
    const buttons = labels.map((label) => {
        const button = document.createElement('button');
        button.className = 'Button_button__1Fe9z Button_buy__3Xyz';
        button.textContent = label;
        list.appendChild(button);
        return button;
    });
    document.body.appendChild(list);
    return buttons;
}

describe('the Claim Reward proxy', () => {
    beforeEach(() => {
        reactClick.clickThroughReact.mockClear();
    });

    test('presses the first claim button through the React handler, once', () => {
        const buttons = board(['Claim Reward', 'Claim Reward']);
        const domClick = vi.fn();
        buttons[0].addEventListener('click', domClick);

        collector._claimNext();

        expect(reactClick.clickThroughReact).toHaveBeenCalledTimes(1);
        expect(reactClick.clickThroughReact).toHaveBeenCalledWith(buttons[0], { reactFirst: true });
        // The collector itself no longer calls .click(); the helper owns delivery
        expect(domClick).not.toHaveBeenCalled();
    });

    test('presses nothing when no claim is on the board', () => {
        board(['Reroll']);
        collector._claimNext();
        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();
    });

    /**
     * A list of task cards shaped as the game draws them: each card is a RandomTask_randomTask node with its
     * buttons in an action row, `[label, className, disabled?]` each. When a card names a `quest`, the React
     * tree is built beside it as the game's is: the card's fiber holds `characterQuest` and the button fibers
     * hang under it.
     */
    function cards(specs) {
        document.body.replaceChildren();
        const root = document.createElement('div');
        root.id = 'root';
        const rootFiber = { stateNode: null, return: null, child: null, sibling: null };
        let previousCard = null;
        const list = document.createElement('div');
        list.className = 'TasksPanel_taskList__xyz';
        const made = specs.map(({ buttons: labels, quest }) => {
            const card = document.createElement('div');
            card.className = 'RandomTask_randomTask__abc';
            const action = document.createElement('div');
            action.className = 'RandomTask_action__def';
            const cardFiber = { stateNode: card, return: rootFiber, child: null, sibling: null };
            if (quest) cardFiber.memoizedProps = { characterQuest: quest };
            let previousButton = null;
            const buttons = labels.map(([label, className, disabled]) => {
                const button = document.createElement('button');
                button.className = className;
                button.textContent = label;
                button.disabled = Boolean(disabled);
                action.appendChild(button);
                const fiber = { stateNode: button, return: cardFiber, child: null, sibling: null };
                if (previousButton) previousButton.sibling = fiber;
                else cardFiber.child = fiber;
                previousButton = fiber;
                return button;
            });
            if (previousCard) previousCard.sibling = cardFiber;
            else rootFiber.child = cardFiber;
            previousCard = cardFiber;
            card.appendChild(action);
            list.appendChild(card);
            return buttons;
        });
        root._reactRootContainer = { current: rootFiber };
        document.body.append(root, list);
        return made;
    }
    const BUY = 'Button_button__1Fe9z Button_buy__3Xyz';
    const GO = 'Button_button__1Fe9z Button_success__6d6kU';
    const DONE = { status: '/quest_status/in_progress', goalCount: 100, currentCount: 100 };
    const HALF = { status: '/quest_status/in_progress', goalCount: 100, currentCount: 40 };
    const card = (quest, ...buttons) => ({ quest, buttons });

    test('English is as it always was: the exact label on a green button is a claim, with no quest read', () => {
        const [, [claim]] = cards([card(null, ['Go', GO]), card(null, ['Claim Reward', BUY])]);

        collector._claimNext();

        expect(reactClick.clickThroughReact).toHaveBeenCalledTimes(1);
        expect(reactClick.clickThroughReact).toHaveBeenCalledWith(claim, { reactFirst: true });
    });

    test('a translated claim on a card whose quest is complete is listed and pressed', () => {
        const [, [claim]] = cards([card(HALF, ['前往', GO]), card(DONE, ['领取奖励', BUY])]);

        collector._claimNext();

        expect(reactClick.clickThroughReact).toHaveBeenCalledTimes(1);
        expect(reactClick.clickThroughReact).toHaveBeenCalledWith(claim, { reactFirst: true });
    });

    test('a lone green button on an incomplete, claimed or discarded quest is never a claim', () => {
        cards([
            card(HALF, ['领取奖励', BUY]),
            card({ ...DONE, status: '/quest_status/claimed' }, ['领取奖励', BUY]),
            card({ ...DONE, status: '/quest_status/discarded' }, ['领取奖励', BUY]),
            card({ status: '/quest_status/in_progress' }, ['领取奖励', BUY]),
        ]);

        collector._claimNext();

        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();
    });

    test('with the quest unreadable, a translated green button is not a claim', () => {
        cards([card(null, ['领取奖励', BUY])]);
        collector._claimNext();
        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();

        cards([card(DONE, ['领取奖励', BUY])]);
        document.getElementById('root')._reactRootContainer = undefined;
        collector._claimNext();
        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();
    });

    test('a translated reroll chooser is never read as a claim, whatever the quest says', () => {
        // Pay buttons in a translated chooser: green, numbered, on a card with no rerollOption container
        cards([
            card(DONE, ['返回', GO], ['支付 10K', BUY], ['支付 1', BUY]),
            card(DONE, ['支付 10K', BUY]),
            card(HALF, ['支付 1', BUY]),
        ]);

        collector._claimNext();

        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();
    });

    test('a card with two green buttons is not a translated claim, and a button outside any card is not one', () => {
        cards([card(DONE, ['领取奖励', BUY], ['其他', BUY])]);
        const orphan = document.createElement('button');
        orphan.className = BUY;
        orphan.textContent = '领取奖励';
        document.querySelector('.TasksPanel_taskList__xyz').appendChild(orphan);

        collector._claimNext();

        expect(reactClick.clickThroughReact).not.toHaveBeenCalled();
    });

    test('a disabled claim and a reroll opener are skipped; the next enabled claim is taken', () => {
        const [, , [claim]] = cards([
            card(DONE, ['Claim Reward', BUY, true]),
            card(HALF, ['Reroll', BUY]),
            card(DONE, ['Claim Reward', BUY]),
            card(DONE, ['Claim Reward', 'Button_button__1Fe9z']),
        ]);

        collector._claimNext();

        expect(reactClick.clickThroughReact).toHaveBeenCalledWith(claim, { reactFirst: true });
    });

    test('the proxy counts the English claims and the proven translated ones, and nothing else', () => {
        cards([
            card(DONE, ['领取奖励', BUY]),
            card(HALF, ['领取奖励', BUY]),
            card(null, ['Claim Reward', BUY]),
            card(DONE, ['支付 10K', BUY]),
            card(HALF, ['前往', GO]),
        ]);
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        collector.disable();
        collector.initialize();

        expect(document.getElementById('mwi-claim-proxy-btn').textContent).toBe('Claim Reward (2)');
        collector.disable();
    });

    test('a Tasks panel that is already open gets its button when the feature starts', () => {
        board(['Claim Reward']);
        const header = document.createElement('div');
        header.className = 'TasksPanel_taskSlotCount__abc';
        document.body.appendChild(header);

        collector.disable();
        collector.initialize();

        const proxy = document.getElementById('mwi-claim-proxy-btn');
        expect(proxy).not.toBeNull();
        expect(proxy.textContent).toBe('Claim Reward');

        collector.disable();
        expect(document.getElementById('mwi-claim-proxy-btn')).toBeNull();
    });
});
