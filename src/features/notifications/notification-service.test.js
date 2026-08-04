/** @vitest-environment happy-dom
 *
 * Tests for how the player gets told, rather than what they are told.
 *
 * Three things here can only be got wrong once and then are wrong forever: a
 * desktop notification fired at a tab you are looking at, the same event
 * repeating until you switch the feature off, and a tab title left with a ❗ on
 * it after you have already come back and dealt with it. Each has a test.
 *
 * The channels are decided from `document.hidden`, which happy-dom exposes as a
 * plain property — so each test states plainly whether the player is looking.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {}, changeHandlers: {} }));
const toast = vi.hoisted(() => ({ shown: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        onSettingChange: (key, cb) => {
            settings.changeHandlers[key] = [...(settings.changeHandlers[key] || []), cb];
        },
    },
}));

vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toast.shown.push({ message, options });
        return { element: {}, dismiss: () => {} };
    },
}));

const {
    default: notificationService,
    TITLE_FLASH_PREFIX,
    NOTIFICATION_SETTING_KEYS,
} = await import('./notification-service.js');

/**
 * The setting hooks the module installed when it was imported.
 *
 * Captured here rather than read in the test, because they are registered once
 * at import — that being the whole point of them — and `beforeEach` clears the
 * recording that catches them.
 */
const settingHooksAtImport = { ...settings.changeHandlers };

/** Say whether the player is looking at the page */
function setHidden(hidden) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    Object.defineProperty(document, 'visibilityState', {
        value: hidden ? 'hidden' : 'visible',
        configurable: true,
    });
}

/**
 * A stand-in for the browser's Notification, recording what was sent.
 * @param {string} permission - What the browser would say
 * @returns {Array<Object>} The notifications constructed
 */
function stubNotificationAPI(permission) {
    const sent = [];
    class FakeNotification {
        constructor(title, options) {
            sent.push({ title, options });
            this.close = vi.fn();
        }
        static permission = permission;
        static requestPermission = vi.fn(async () => 'granted');
    }
    globalThis.Notification = FakeNotification;
    return sent;
}

beforeEach(() => {
    settings.values = {};
    settings.changeHandlers = {};
    toast.shown = [];
    document.title = 'Milky Way Idle';
    setHidden(false);
    notificationService.reset();
    delete globalThis.Notification;
});

afterEach(() => {
    notificationService.reset();
    delete globalThis.Notification;
});

describe('channel selection', () => {
    test('a hidden tab with permission gets a desktop notification', () => {
        settings.values.notifications_browserEnabled = true;
        const sent = stubNotificationAPI('granted');
        setHidden(true);

        const result = notificationService.notify('empty-queue', 'Your action queue is empty!');

        expect(result.fired).toBe(true);
        expect(result.channels).toContain('browser');
        expect(sent).toHaveLength(1);
        expect(sent[0].options.body).toBe('Your action queue is empty!');
        expect(toast.shown).toHaveLength(0);
    });

    test('a visible tab gets a toast instead — a desktop popup for a window you are watching is noise', () => {
        settings.values.notifications_browserEnabled = true;
        const sent = stubNotificationAPI('granted');
        setHidden(false);

        const result = notificationService.notify('empty-queue', 'Your action queue is empty!');

        expect(result.channels).toEqual(['toast']);
        expect(toast.shown[0].message).toBe('Your action queue is empty!');
        expect(sent).toHaveLength(0);
    });

    test('without permission a hidden tab still gets the title, so a refusal is not silence', () => {
        settings.values.notifications_browserEnabled = true;
        const sent = stubNotificationAPI('denied');
        setHidden(true);

        const result = notificationService.notify('empty-queue', 'Queue empty');

        expect(sent).toHaveLength(0);
        expect(result.channels).toEqual(['title']);
        expect(document.title.startsWith(TITLE_FLASH_PREFIX)).toBe(true);
    });

    test('the master switch off means no desktop notification even when permitted', () => {
        settings.values.notifications_browserEnabled = false;
        const sent = stubNotificationAPI('granted');
        setHidden(true);

        notificationService.notify('empty-queue', 'Queue empty');

        expect(sent).toHaveLength(0);
    });
});

describe('de-duplication', () => {
    test('the same event is silent inside its cooldown', () => {
        setHidden(false);

        expect(notificationService.notify('market-listing-filled', 'One finished').fired).toBe(true);
        const second = notificationService.notify('market-listing-filled', 'One finished');

        expect(second.fired).toBe(false);
        expect(second.reason).toBe('cooldown');
        expect(toast.shown).toHaveLength(1);
    });

    test('a different event is not held up by another event cooldown', () => {
        setHidden(false);

        notificationService.notify('market-listing-filled', 'One finished');
        expect(notificationService.notify('empty-queue', 'Queue empty').fired).toBe(true);
        expect(toast.shown).toHaveLength(2);
    });

    test('it speaks again once the cooldown has passed', () => {
        setHidden(false);
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            notificationService.notify('market-listing-filled', 'One finished');

            vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
            expect(notificationService.notify('market-listing-filled', 'Two finished').fired).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a message that reached nobody does not burn the cooldown', () => {
        // A message that could not be delivered must not silence the next
        // attempt, which is the one that might get through
        setHidden(false);
        const failing = vi.spyOn(notificationService, 'showInPage').mockReturnValue(false);

        const first = notificationService.notify('market-listing-filled', 'One finished');
        expect(first.fired).toBe(false);
        expect(first.reason).toBe('no channel available');

        failing.mockRestore();
        expect(notificationService.notify('market-listing-filled', 'One finished').fired).toBe(true);
    });
});

describe('the tab title', () => {
    test('is marked once however many notifications arrive', () => {
        setHidden(true);

        notificationService.notify('empty-queue', 'Queue empty');
        notificationService.notify('market-listing-filled', 'One finished');

        expect(document.title).toBe(`${TITLE_FLASH_PREFIX}Milky Way Idle`);
    });

    test('is put back when the player returns', () => {
        setHidden(true);
        notificationService.notify('empty-queue', 'Queue empty');
        expect(document.title.startsWith(TITLE_FLASH_PREFIX)).toBe(true);

        setHidden(false);
        window.dispatchEvent(new Event('focus'));

        expect(document.title).toBe('Milky Way Idle');
    });

    test('keeps whatever the game has since written into the title', () => {
        // The game renames the tab while you are away; restoring a remembered
        // string would put a stale action name back
        setHidden(true);
        notificationService.notify('empty-queue', 'Queue empty');
        document.title = `${TITLE_FLASH_PREFIX}Chopping - Milky Way Idle`;

        setHidden(false);
        document.dispatchEvent(new Event('visibilitychange'));

        expect(document.title).toBe('Chopping - Milky Way Idle');
    });

    test('stays marked while the player is still away', () => {
        setHidden(true);
        notificationService.notify('empty-queue', 'Queue empty');

        document.dispatchEvent(new Event('visibilitychange'));

        expect(document.title.startsWith(TITLE_FLASH_PREFIX)).toBe(true);
    });
});

describe('asking for permission', () => {
    test('happens when a notification setting is switched on, not at load', () => {
        stubNotificationAPI('default');
        // watchSettings ran at import; every notification setting is hooked
        expect(Object.keys(settingHooksAtImport).sort()).toEqual([...NOTIFICATION_SETTING_KEYS].sort());
        expect(Notification.requestPermission).not.toHaveBeenCalled();

        settingHooksAtImport.notifications_browserEnabled.forEach((cb) => cb(true));

        expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
    });

    test('switching a setting off asks for nothing', () => {
        stubNotificationAPI('default');
        settingHooksAtImport.notifiEmptyAction.forEach((cb) => cb(false));
        expect(Notification.requestPermission).not.toHaveBeenCalled();
    });

    test('a refusal is not asked about again', async () => {
        stubNotificationAPI('denied');
        expect(await notificationService.requestPermission()).toBe(false);
        expect(Notification.requestPermission).not.toHaveBeenCalled();
    });
});
