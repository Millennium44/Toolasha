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
