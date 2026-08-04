/** @vitest-environment happy-dom
 *
 * The mention popup renders a sender name per row (mention.sName). It should reuse
 * chat-profile-link's markAsProfileLink helper for the "/profile <name>" click behavior
 * rather than re-implementing it — this test asserts the wiring, not the click behavior
 * itself (that's covered by chat-profile-link.test.js).
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { COLOR_ACCENT: '#d7b7ff', Z_FLOATING_PANEL: 1000, getSetting: () => true },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/formatters.js', () => ({ formatDateTime: () => '12:00 PM' }));

const markAsProfileLinkMock = vi.fn((el, name) => {
    el.classList.add('mwi-chat-profile-name');
    el.dataset.mwiProfileName = name;
    return true;
});
vi.mock('./chat-profile-link.js', () => ({ markAsProfileLink: markAsProfileLinkMock }));

const { default: mentionPopup } = await import('./mention-popup.js');

afterEach(() => {
    mentionPopup.close();
    document.body.innerHTML = '';
    markAsProfileLinkMock.mockClear();
});

describe('mention popup sender names', () => {
    test('each rendered mention runs its sender name through markAsProfileLink', () => {
        mentionPopup.open(
            '/chat_channel_types/general',
            [
                { sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' },
                { sName: 'Another', m: 'yo @Me', t: '2026-01-01T00:01:00.000Z' },
            ],
            'General',
            () => {}
        );

        expect(markAsProfileLinkMock).toHaveBeenCalledWith(expect.any(HTMLElement), 'Someone');
        expect(markAsProfileLinkMock).toHaveBeenCalledWith(expect.any(HTMLElement), 'Another');
        expect(markAsProfileLinkMock).toHaveBeenCalledTimes(2);
    });

    test('the decorated span keeps showing the sender name as its text', () => {
        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            () => {}
        );

        const decorated = document.querySelector('.mwi-chat-profile-name');
        expect(decorated).not.toBeNull();
        expect(decorated.textContent).toBe('Someone');
    });

    test('re-opening for a new channel re-decorates the new rows without erroring', () => {
        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            () => {}
        );
        markAsProfileLinkMock.mockClear();

        mentionPopup.open(
            '/chat_channel_types/trade',
            [{ sName: 'Buyer', m: 'wtb @Me', t: '2026-01-01T00:02:00.000Z' }],
            'Trade',
            () => {}
        );

        expect(markAsProfileLinkMock).toHaveBeenCalledWith(expect.any(HTMLElement), 'Buyer');
        expect(document.querySelectorAll('.mwi-chat-profile-name')).toHaveLength(1);
    });
});
