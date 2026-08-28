/** @vitest-environment happy-dom
 *
 * The pop-out chat window is a separate self-contained document (window.open with its own
 * inline <script>), so its runtime can't be imported and unit-tested directly. What we can
 * check from here is what PopOutChat._buildPopoutHTML() produces: that the clickable-name
 * behavior reuses chat-profile-link.js's exact ANNOUNCE_RE/VALID_NAME_RE (not a hand
 * duplicated copy), that the supporting CSS/JS made it into the template, and that the
 * interpolation didn't produce broken JavaScript.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, def) => def },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterName: () => 'Tester' } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('./chat-block-list.js', () => ({ chatBlockList: { isBlocked: () => false } }));

const { PopOutChat } = await import('./pop-out-chat.js');
const { ANNOUNCE_RE, VALID_NAME_RE } = await import('./chat-profile-link.js');

describe('pop-out chat window: clickable names', () => {
    test('embeds the exact ANNOUNCE_RE and VALID_NAME_RE from chat-profile-link.js', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        expect(html).toContain(`const ANNOUNCE_RE = ${ANNOUNCE_RE};`);
        expect(html).toContain(`const VALID_NAME_RE = ${VALID_NAME_RE};`);
    });

    test('wires up the clickable-name CSS and the shared fill helper', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        expect(html).toContain('.msg-name-link');
        expect(html).toContain('function fillProfileCommand(paneObj, name)');
        // Both the regular sender name and the system-announcement name reuse the helper
        expect(html).toContain('fillProfileCommand(paneObj, msg.sName)');
    });

    test('the generated inner <script> is syntactically valid JavaScript', () => {
        const html = new PopOutChat()._buildPopoutHTML();
        const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
        // Throws a SyntaxError if the regex/name interpolation broke the script. It is never
        // invoked, so this needs none of the popout's runtime globals (BroadcastChannel, DOM).
        expect(() => new Function(script)).not.toThrow();
    });
});

/**
 * BroadcastChannel is shared by every same-origin tab, not scoped per tab or per pop-out
 * window. A second game tab (a second character logged in in another browser tab, common
 * in this genre) runs its own PopOutChat instance on the same two channel names. Without
 * an instance id, that second tab's _onSendChannelMessage would answer the first tab's
 * pop-out handshake and execute sends meant for the first tab's character. These tests
 * exercise the instance-id guard directly (relayChannel/sendChannel are replaced with
 * plain spies — a real BroadcastChannel would fan the same behavior out across instances,
 * which is exactly the bug being guarded against).
 */
describe('pop-out chat window: cross-tab isolation', () => {
    test("_relayPost tags every outgoing message with this tab's pop-out instance id", () => {
        const chat = new PopOutChat();
        chat.relayChannel = { postMessage: vi.fn() };
        chat.popoutInstanceId = 'tab-a-instance';

        chat._relayPost({ type: 'ping' });

        expect(chat.relayChannel.postMessage).toHaveBeenCalledWith({ type: 'ping', instanceId: 'tab-a-instance' });
    });

    test("ignores a send-channel message tagged with a different tab's instance id", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';
        chat._sendInit = vi.fn();
        chat._executeSend = vi.fn();

        // A second game tab's pop-out sent this (its own, different, instance id).
        chat._onSendChannelMessage({ type: 'ready', instanceId: 'tab-b-instance' });
        chat._onSendChannelMessage({
            type: 'send',
            channel: '/chat_channel_types/general',
            text: 'hi',
            instanceId: 'tab-b-instance',
        });

        expect(chat._sendInit).not.toHaveBeenCalled();
        expect(chat._executeSend).not.toHaveBeenCalled();
    });

    test("handles a send-channel message tagged with this tab's own instance id", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';
        chat._sendInit = vi.fn();
        chat._executeSend = vi.fn();

        chat._onSendChannelMessage({ type: 'ready', instanceId: 'tab-a-instance' });
        chat._onSendChannelMessage({
            type: 'send',
            channel: '/chat_channel_types/general',
            text: 'hi',
            instanceId: 'tab-a-instance',
        });

        expect(chat._sendInit).toHaveBeenCalledTimes(1);
        expect(chat._executeSend).toHaveBeenCalledWith('/chat_channel_types/general', 'hi');
    });

    test('ignores send-channel messages entirely before this tab has opened its own pop-out', () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = null;
        chat._sendInit = vi.fn();

        chat._onSendChannelMessage({ type: 'ready', instanceId: 'anything' });

        expect(chat._sendInit).not.toHaveBeenCalled();
    });

    test("the generated pop-out script embeds this tab's instance id and stamps it on every outgoing message", () => {
        const chat = new PopOutChat();
        chat.popoutInstanceId = 'tab-a-instance';

        const html = chat._buildPopoutHTML();

        expect(html).toContain(`const INSTANCE_ID = 'tab-a-instance';`);
        expect(html).toContain(`sendCh.postMessage({ type: 'ready', instanceId: INSTANCE_ID });`);
        expect(html).toContain('instanceId: INSTANCE_ID });');
        expect(html).toContain('if (data.instanceId !== INSTANCE_ID) return;');
    });
});
