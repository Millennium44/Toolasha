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

describe('mention popup click-outside', () => {
    test('mousedown on an unrelated element outside the popup closes it', () => {
        const onClose = vi.fn();
        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            onClose
        );

        const outside = document.createElement('div');
        document.body.appendChild(outside);
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(document.getElementById('mwi-mention-popup')).toBeNull();
    });

    test('mousedown on the mention badge that opened this popup does not close it', () => {
        // The badge that opens the popup lives on the chat tab, outside the popup
        // container, so it is "outside" by DOM containment. Its own click handler
        // (mention-tracker.js) re-opens/refreshes the popup on 'click', which fires
        // after this 'mousedown' — closing here first would call onClose
        // (clearMentions) and let the badge be removed from the DOM before the
        // reopen ever runs, silently discarding the unread mentions.
        const onClose = vi.fn();
        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            onClose
        );

        const badge = document.createElement('span');
        badge.className = 'mwi-mention-badge';
        document.body.appendChild(badge);
        badge.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

        expect(onClose).not.toHaveBeenCalled();
        expect(document.getElementById('mwi-mention-popup')).not.toBeNull();
    });
});

describe('mention popup copy button', () => {
    test('formatMentionsForCopy renders one "[time] sender: message" line per mention', () => {
        const text = mentionPopup.formatMentionsForCopy(
            [
                { sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' },
                { sName: 'Another', m: 'yo @Me', t: '2026-01-01T00:01:00.000Z' },
            ],
            'General'
        );

        expect(text).toBe('Mentions — General\n[12:00 PM] Someone: hi @Me\n[12:00 PM] Another: yo @Me');
    });

    test('formatMentionsForCopy reports an empty channel instead of an empty body', () => {
        const text = mentionPopup.formatMentionsForCopy([], 'Trade');
        expect(text).toBe('Mentions — Trade\n(no mentions)');
    });

    test('clicking the copy button writes the formatted text to the clipboard', async () => {
        const writeText = vi.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            () => {}
        );

        const copyBtn = document.querySelector('#mwi-mention-popup-header button[title="Copy mentions to clipboard"]');
        expect(copyBtn).not.toBeNull();
        copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(writeText).toHaveBeenCalledWith('Mentions — General\n[12:00 PM] Someone: hi @Me');
    });
});
