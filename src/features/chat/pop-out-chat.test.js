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
