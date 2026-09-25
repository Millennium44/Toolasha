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

    test('a second click inside the flash window still leaves the button at rest afterwards', async () => {
        // The flash used to capture `button.textContent` as "the original" at
        // call time. Click twice inside the 1200ms window and the second call
        // captures '✓' — so the second timer restores the checkmark after the
        // first has already cleared it, and the button reads '✓' for as long as
        // the popup stays open.
        vi.useFakeTimers();
        try {
            const writeText = vi.fn().mockResolvedValue();
            Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

            mentionPopup.open(
                '/chat_channel_types/general',
                [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
                'General',
                () => {}
            );
            const copyBtn = document.querySelector(
                '#mwi-mention-popup-header button[title="Copy mentions to clipboard"]'
            );

            copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(600);
            copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            await vi.advanceTimersByTimeAsync(2000);

            expect(copyBtn.textContent).toBe('⧉');
        } finally {
            vi.useRealTimers();
        }
    });
});

/**
 * A September 2026 patch lets a player delete their own Trade/Recruit
 * messages, on top of moderator deletion. mention-tracker.js drops a deleted
 * message's mention from its log and calls `updateIfOpen` so a popup already
 * showing that mention notices — `open()`'s replace-content path only runs
 * when the popup is re-opened (a badge click), not when the list changes
 * underneath an already-open one.
 */
describe('mention popup: updateIfOpen (deletion refresh)', () => {
    test('refreshes the body and the copy-button source when the popup is open for that channel', async () => {
        mentionPopup.open(
            '/chat_channel_types/general',
            [
                { sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' },
                { sName: 'Another', m: 'yo @Me', t: '2026-01-01T00:01:00.000Z' },
            ],
            'General',
            () => {}
        );
        expect(document.body.textContent).toContain('hi @Me');

        const remaining = [{ sName: 'Another', m: 'yo @Me', t: '2026-01-01T00:01:00.000Z' }];
        mentionPopup.updateIfOpen('/chat_channel_types/general', remaining, 'General');

        expect(document.body.textContent).not.toContain('hi @Me');
        expect(document.body.textContent).toContain('yo @Me');

        // _copyToClipboard reads currentMentions/currentDisplayName, not the DOM.
        const writeText = vi.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const copyBtn = document.querySelector('#mwi-mention-popup-header button[title="Copy mentions to clipboard"]');
        copyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(writeText).toHaveBeenCalledWith('Mentions — General\n[12:00 PM] Another: yo @Me');
        expect(writeText.mock.calls[0][0]).not.toContain('hi @Me');
    });

    test('does nothing when the popup is closed', () => {
        expect(() => mentionPopup.updateIfOpen('/chat_channel_types/general', [], 'General')).not.toThrow();
        expect(document.querySelector('#mwi-mention-popup')).toBeNull();
    });

    test('does nothing when the popup is open for a different channel', () => {
        mentionPopup.open(
            '/chat_channel_types/general',
            [{ sName: 'Someone', m: 'hi @Me', t: '2026-01-01T00:00:00.000Z' }],
            'General',
            () => {}
        );

        mentionPopup.updateIfOpen('/chat_channel_types/party', [], 'Party');

        expect(document.body.textContent).toContain('hi @Me');
        expect(document.querySelector('#mwi-mention-popup-title').textContent).toBe('Mentions — General');
    });
});
