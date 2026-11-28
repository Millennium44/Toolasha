/** @vitest-environment happy-dom
 *
 * The packaged build carries this module in more than one bundle. Whichever copy turns the feature on or
 * off, there is exactly one click listener while it is on and none while it is off, and a switch off then
 * on again brings the links back to life.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = vi.hoisted(() => ({ chat_profileLink: true }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => settings[key] ?? false } }));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../../utils/dom.js', () => ({
    addStyles: () => {},
    removeStyles: (id) => document.getElementById(id)?.remove(),
}));

/** A fresh instance of the module, as a second bundle's copy would be */
async function loadCopy() {
    vi.resetModules();
    return import('./chat-profile-link.js');
}

/** Click listeners live on the document, counted through add and remove */
let live;
let addSpy;
let removeSpy;

beforeEach(() => {
    live = new Set();
    const realAdd = document.addEventListener.bind(document);
    const realRemove = document.removeEventListener.bind(document);
    addSpy = vi.spyOn(document, 'addEventListener').mockImplementation((type, fn, opts) => {
        if (type === 'click') live.add(fn);
        realAdd(type, fn, opts);
    });
    removeSpy = vi.spyOn(document, 'removeEventListener').mockImplementation((type, fn, opts) => {
        if (type === 'click') live.delete(fn);
        realRemove(type, fn, opts);
    });
    document.body.innerHTML =
        '<div class="Chat_chatInputContainer"><input /></div><span id="n">Mate</span><span id="m">Pal</span>';
});

afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
    delete globalThis.__toolashaChatProfileLinkHandler;
    document.body.innerHTML = '';
});

describe('two copies of the module sharing one page', () => {
    test('a copy that did not install the listener can still switch it off and on again', async () => {
        const owner = await loadCopy();
        const other = await loadCopy();

        // The owner's helper arrives first and installs the listener; the other copy only marks a name
        owner.markAsProfileLink(document.getElementById('n'), 'Mate');
        other.markAsProfileLink(document.getElementById('m'), 'Pal');
        expect(live.size).toBe(1);

        // The switch-off reaches the other copy first, and the owner second
        other.default.disable();
        expect(live.size).toBe(0);
        owner.default.disable();
        expect(live.size).toBe(0);

        // Back on, from the copy that never owned it: one live listener again, and a click works
        other.default.initialize();
        expect(live.size).toBe(1);
        const input = document.querySelector('input');
        const span = document.getElementById('m');
        expect(span.classList.contains('mwi-chat-profile-name')).toBe(true);
        span.dispatchEvent(new Event('click', { bubbles: true }));
        expect(input.value).toBe('/profile Pal');

        other.default.disable();
        expect(live.size).toBe(0);
    });

    test('off, on, off, on across both copies never leaves two listeners or none while on', async () => {
        const first = await loadCopy();
        const second = await loadCopy();

        // Whichever copy initializes first, the other only marks names
        for (const [runner, helper] of [
            [first, second],
            [second, first],
            [first, second],
        ]) {
            runner.default.initialize();
            helper.markAsProfileLink(document.getElementById('m'), 'Pal');
            expect(live.size).toBe(1);
            runner.default.disable();
            expect(live.size).toBe(0);
        }
    });

    test('with the setting off, a name marked by another feature installs nothing', async () => {
        settings.chat_profileLink = false;
        try {
            const copy = await loadCopy();
            expect(copy.markAsProfileLink(document.getElementById('n'), 'Mate')).toBe(false);
            expect(live.size).toBe(0);
        } finally {
            settings.chat_profileLink = true;
        }
    });
});
