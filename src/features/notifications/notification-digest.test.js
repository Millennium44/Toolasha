/** @vitest-environment happy-dom
 *
 * Tests for the three things that sit between a feature deciding to say
 * something and a channel saying it.
 *
 * The risk they cover is one-sided. Digest mode and quiet hours can only ever
 * make the script quieter, so every bug in them is a notification that never
 * arrived — invisible, unreportable, and indistinguishable from the feature
 * being switched off. So the assertions are mostly about what still gets
 * through: the critical allow-list surviving both mechanisms, and every held
 * notice reaching the log even when it reaches nothing else.
 *
 * The clock is faked because a fifteen-minute digest window is otherwise a
 * fifteen-minute test.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const toast = vi.hoisted(() => ({ shown: [], refuse: false }));
const log = vi.hoisted(() => ({ entries: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in settings.values ? settings.values[key] : fallback),
        onSettingChange: () => {},
    },
}));

vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toast.shown.push({ message, options });
        // The real one answers null before `document.body` exists, which is the
        // only way a visible page reaches no channel at all
        return toast.refuse ? null : { element: {}, dismiss: () => {} };
    },
}));

vi.mock('./notice-log.js', () => ({
    appendNotice: (entry) => {
        log.entries.push(entry);
        return entry;
    },
}));

const {
    default: notificationService,
    DELIVERY_SETTING_KEYS,
    TITLE_FLASH_PREFIX,
} = await import('./notification-service.js');

/** Say whether the player is looking at the page */
function setHidden(hidden) {
    Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
    Object.defineProperty(document, 'visibilityState', {
        value: hidden ? 'hidden' : 'visible',
        configurable: true,
    });
}

/**
 * A browser that will happily show desktop notifications.
 * @returns {Array<Object>} What was sent to it
 */
function stubNotificationAPI() {
    const sent = [];
    class FakeNotification {
        constructor(title, options) {
            sent.push({ title, options });
            this.close = vi.fn();
        }
        static permission = 'granted';
        static requestPermission = vi.fn(async () => 'granted');
    }
    globalThis.Notification = FakeNotification;
    return sent;
}

beforeEach(() => {
    vi.useFakeTimers();
    settings.values = {
        notifications_browserEnabled: true,
        [DELIVERY_SETTING_KEYS.digestCategories]: 'market, buffs, tasks',
        [DELIVERY_SETTING_KEYS.criticalCategories]: 'combat, queue, consumables',
    };
    toast.shown = [];
    toast.refuse = false;
    log.entries = [];
    notificationService.reset();
    setHidden(false);
    document.title = 'Milky Way Idle';
});

afterEach(() => {
    notificationService.reset();
    vi.useRealTimers();
    delete globalThis.Notification;
});

describe('the log', () => {
    test('every notice is recorded, whatever happens to it afterwards', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });

        expect(log.entries).toHaveLength(1);
        expect(log.entries[0]).toMatchObject({
            key: 'market-undercut-1',
            category: 'market',
            subject: 'Cheese',
            text: 'Cheese undercut.',
            urgency: 'normal',
            channels: ['toast'],
        });
    });

    test('a notice that reached no channel is still logged, and marked as reaching nothing', () => {
        // A page too early to have a body takes no toast, so nothing at all is
        // delivered — and this row is the only record that it happened. The
        // cooldown is deliberately not started either, so the next attempt is
        // the one that might work
        toast.refuse = true;

        const result = notificationService.notify('market-undercut-2', 'Milk undercut.');

        expect(result).toMatchObject({ fired: false, channels: [], reason: 'no channel available' });
        expect(log.entries).toHaveLength(1);
        expect(log.entries[0].channels).toEqual([]);
    });

    test('the subject falls back to the title, and never to the generic one', () => {
        notificationService.notify('skill-levelup:mining:70', 'Mining is 70.', { title: 'Level up' });
        notificationService.notify('ttl-target:cheese:100', 'Target reached.');

        expect(log.entries[0].subject).toBe('Level up');
        expect(log.entries[1].subject).toBe('');
    });

    test('urgency comes from the critical allow-list rather than from the caller', () => {
        notificationService.notify('combat-death', 'You died.');
        notificationService.notify('market-undercut-3', 'Flax undercut.');

        expect(log.entries[0].urgency).toBe('critical');
        expect(log.entries[1].urgency).toBe('normal');
    });
});

describe('digest mode', () => {
    beforeEach(() => {
        settings.values[DELIVERY_SETTING_KEYS.digestEnabled] = true;
        settings.values[DELIVERY_SETTING_KEYS.digestMinutes] = 15;
    });

    test('held notices go out as one summary when the window closes', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        notificationService.notify('market-undercut-2', 'Milk undercut.', { subject: 'Milk' });
        notificationService.notify('market-undercut-3', 'Flax undercut.', { subject: 'Flax' });
        notificationService.notify('community-buff-expiring:xp:1', 'Experience lapsing.', { subject: 'Experience' });

        expect(toast.shown).toHaveLength(0);

        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(toast.shown).toHaveLength(1);
        expect(toast.shown[0].message).toBe('Market: 3 undercuts (Cheese, Milk, Flax) · Buffs: 1 lapsing (Experience)');
    });

    test('each held notice is in the log individually, and the summary is not', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        notificationService.notify('market-undercut-2', 'Milk undercut.', { subject: 'Milk' });
        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(log.entries).toHaveLength(2);
        expect(log.entries.map((entry) => entry.subject)).toEqual(['Cheese', 'Milk']);
        expect(log.entries.every((entry) => entry.channels.includes('digest'))).toBe(true);
    });

    test('the window does not slide, so a steady trickle still gets a summary', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        vi.advanceTimersByTime(10 * 60 * 1000);
        notificationService.notify('market-undercut-2', 'Milk undercut.', { subject: 'Milk' });
        vi.advanceTimersByTime(5 * 60 * 1000);

        expect(toast.shown).toHaveLength(1);
        expect(toast.shown[0].message).toBe('Market: 2 undercuts (Cheese, Milk)');
    });

    test('the next batch starts empty and gets its own window', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        vi.advanceTimersByTime(15 * 60 * 1000);
        notificationService.notify('market-undercut-2', 'Milk undercut.', { subject: 'Milk' });
        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(toast.shown.map((entry) => entry.message)).toEqual([
            'Market: 1 undercut (Cheese)',
            'Market: 1 undercut (Milk)',
        ]);
    });

    test('a category left off the digest list keeps arriving one at a time', () => {
        settings.values[DELIVERY_SETTING_KEYS.digestCategories] = 'buffs';

        notificationService.notify('market-undercut-1', 'Cheese undercut.');
        expect(toast.shown).toHaveLength(1);
        expect(toast.shown[0].message).toBe('Cheese undercut.');
    });

    test('a critical category is never held, however loud the batch around it', () => {
        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        const death = notificationService.notify('combat-death', 'You died in combat.');

        expect(death.channels).toEqual(['toast']);
        expect(death.urgency).toBe('critical');
        expect(toast.shown.map((entry) => entry.message)).toEqual(['You died in combat.']);
    });

    test('a digested notice counts as told, so its feature does not repeat it', () => {
        // Every alert feature keys its "already announced" flag off `fired`; a
        // digested notice that reported `fired: false` would be re-announced on
        // the next tick and again on the one after that
        const result = notificationService.notify('market-undercut-1', 'Cheese undercut.');
        expect(result.fired).toBe(true);
        expect(result.channels).toEqual(['digest']);
        expect(result.reason).toBe('digested');
    });

    test('a nonsense interval falls back rather than firing instantly or never', () => {
        settings.values[DELIVERY_SETTING_KEYS.digestMinutes] = 'soon';
        notificationService.notify('market-undercut-1', 'Cheese undercut.');
        vi.advanceTimersByTime(14 * 60 * 1000);
        expect(toast.shown).toHaveLength(0);
        vi.advanceTimersByTime(60 * 1000);
        expect(toast.shown).toHaveLength(1);
    });

    test('with digesting off, nothing is held', () => {
        settings.values[DELIVERY_SETTING_KEYS.digestEnabled] = false;
        notificationService.notify('market-undercut-1', 'Cheese undercut.');
        expect(toast.shown).toHaveLength(1);
    });

    test('flushing an empty buffer says nothing', () => {
        expect(notificationService.flushDigest()).toMatchObject({ fired: false, message: '' });
        expect(toast.shown).toHaveLength(0);
    });
});

describe('quiet hours', () => {
    beforeEach(() => {
        settings.values[DELIVERY_SETTING_KEYS.quietHoursEnabled] = true;
        settings.values[DELIVERY_SETTING_KEYS.quietHoursStart] = '23:00';
        settings.values[DELIVERY_SETTING_KEYS.quietHoursEnd] = '07:00';
        setHidden(true);
    });

    /** Put the fake clock at a local wall-clock time */
    function setLocalTime(hours, minutes = 0) {
        vi.setSystemTime(new Date(2026, 4, 17, hours, minutes, 0, 0));
    }

    test('inside the window the desktop channel is shut and the tab mark is not', () => {
        const sent = stubNotificationAPI();
        setLocalTime(2, 30);

        const result = notificationService.notify('market-undercut-1', 'Cheese undercut.');

        expect(sent).toHaveLength(0);
        expect(result.channels).toEqual(['title']);
        expect(document.title.startsWith(TITLE_FLASH_PREFIX)).toBe(true);
        expect(log.entries).toHaveLength(1);
    });

    test('outside the window the desktop channel is open again', () => {
        const sent = stubNotificationAPI();
        setLocalTime(12, 0);

        const result = notificationService.notify('market-undercut-1', 'Cheese undercut.');

        expect(sent).toHaveLength(1);
        expect(result.channels).toEqual(['browser', 'title']);
    });

    test('a critical notice wakes you regardless', () => {
        const sent = stubNotificationAPI();
        setLocalTime(3, 0);

        const result = notificationService.notify('combat-death', 'You died in combat.');

        expect(sent).toHaveLength(1);
        expect(result.urgency).toBe('critical');
    });

    test('a visible tab still gets its toast at three in the morning', () => {
        setHidden(false);
        setLocalTime(3, 0);

        notificationService.notify('market-undercut-1', 'Cheese undercut.');

        expect(toast.shown).toHaveLength(1);
    });

    test('with quiet hours off the window is not consulted at all', () => {
        settings.values[DELIVERY_SETTING_KEYS.quietHoursEnabled] = false;
        const sent = stubNotificationAPI();
        setLocalTime(3, 0);

        notificationService.notify('market-undercut-1', 'Cheese undercut.');

        expect(sent).toHaveLength(1);
    });

    test('a digest summary is silenced by quiet hours like anything else', () => {
        settings.values[DELIVERY_SETTING_KEYS.digestEnabled] = true;
        settings.values[DELIVERY_SETTING_KEYS.digestMinutes] = 15;
        const sent = stubNotificationAPI();
        setLocalTime(2, 0);

        notificationService.notify('market-undercut-1', 'Cheese undercut.', { subject: 'Cheese' });
        vi.advanceTimersByTime(15 * 60 * 1000);

        expect(sent).toHaveLength(0);
        expect(document.title.startsWith(TITLE_FLASH_PREFIX)).toBe(true);
    });
});
