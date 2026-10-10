/**
 * Tests for Chat 24hr Timestamps: rewrites native chat timestamp text per the
 * market_listingTimeFormat / market_listingDateFormat settings instead of the browser locale.
 */

/* @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const settingValues = {
    chat_24hrTimestamps: true,
    market_listingTimeFormat: '24hour',
    market_listingDateFormat: 'MM-DD',
};

const settingChangeCallbacks = {};

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => settingValues[key]),
        getSettingValue: vi.fn((key, fallback) => settingValues[key] ?? fallback),
        onSettingChange: vi.fn((key, cb) => {
            (settingChangeCallbacks[key] ||= []).push(cb);
        }),
        offSettingChange: vi.fn((key, cb) => {
            if (!settingChangeCallbacks[key]) return;
            settingChangeCallbacks[key] = settingChangeCallbacks[key].filter((fn) => fn !== cb);
        }),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => () => {}) },
}));

function makeTimestampSpan(text) {
    const span = document.createElement('span');
    span.className = 'ChatMessage_timestamp__1iRZO';
    span.textContent = text;
    document.body.appendChild(span);
    return span;
}

describe('Chat 24hr Timestamps', () => {
    let feature;
    let config;

    beforeEach(async () => {
        vi.resetModules();
        vi.clearAllMocks();
        document.body.innerHTML = '';
        Object.keys(settingChangeCallbacks).forEach((k) => delete settingChangeCallbacks[k]);
        Object.assign(settingValues, {
            chat_24hrTimestamps: true,
            market_listingTimeFormat: '24hour',
            market_listingDateFormat: 'MM-DD',
        });
        config = (await import('../../core/config.js')).default;
        feature = (await import('./chat-24hr-timestamps.js')).default;
    });

    // The live client builds the span's own text as `"[" + time + "] "` (see
    // ChatMessage.render in the client bundle) - the trailing space after `]` is baked into the
    // DOM text itself, not separate markup/CSS spacing. Fixtures below use that real format;
    // a regex anchored on `\]$` (no trailing-space allowance) would never match it, which was
    // the actual bug: the feature silently did nothing against real chat messages.
    test('converts a time-only PM timestamp to 24-hour format', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[21:31:23] ');
    });

    test('converts a time-only AM timestamp, including 12 AM -> 00', () => {
        const span = makeTimestampSpan('[12:05:09 AM] ');
        feature.initialize();
        expect(span.textContent).toBe('[00:05:09] ');
    });

    test('preserves and reorders the date prefix for Guild/Party/Whisper/Moderator messages', () => {
        const span = makeTimestampSpan('[5/22 9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[05-22 21:31:23] ');
    });

    test('respects DD-MM date format setting', () => {
        settingValues.market_listingDateFormat = 'DD-MM';
        const span = makeTimestampSpan('[5/22 9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[22-05 21:31:23] ');
    });

    test('keeps 12-hour format when market_listingTimeFormat is 12hour, just normalizing padding', () => {
        settingValues.market_listingTimeFormat = '12hour';
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[9:31:23 PM] ');
    });

    test('is idempotent: already-converted 24-hour text is left untouched on a second pass', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[21:31:23] ');
        feature.disable();
        feature.initialize();
        expect(span.textContent).toBe('[21:31:23] ');
    });

    test('does nothing when the feature setting is disabled', () => {
        settingValues.chat_24hrTimestamps = false;
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[9:31:23 PM] ');
    });

    test('re-sweeps visible timestamps when the time format setting changes (24h -> 12h round trip)', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[21:31:23] ');

        settingValues.market_listingTimeFormat = '12hour';
        settingChangeCallbacks['market_listingTimeFormat'].forEach((cb) => cb());
        expect(span.textContent).toBe('[9:31:23 PM] ');

        settingValues.market_listingTimeFormat = '24hour';
        settingChangeCallbacks['market_listingTimeFormat'].forEach((cb) => cb());
        expect(span.textContent).toBe('[21:31:23] ');
    });

    test('re-renders already-rewritten timestamps when the date format changes', () => {
        const span = makeTimestampSpan('[5/22 9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[05-22 21:31:23] ');

        settingValues.market_listingDateFormat = 'DD-MM';
        settingChangeCallbacks['market_listingDateFormat'].forEach((cb) => cb());
        expect(span.textContent).toBe('[22-05 21:31:23] ');
    });

    test('converts a native 24-hour timestamp to 12-hour', () => {
        settingValues.market_listingTimeFormat = '12hour';
        const span = makeTimestampSpan('[21:31:23] ');
        feature.initialize();
        expect(span.textContent).toBe('[9:31:23 PM] ');
    });

    test('a span the client re-renders is read as fresh native text', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        span.textContent = '[10:00:00 AM] ';
        settingChangeCallbacks['market_listingDateFormat'].forEach((cb) => cb());
        expect(span.textContent).toBe('[10:00:00] ');
    });

    test('disable() restores the native text it rewrote', () => {
        const span = makeTimestampSpan('[5/22 9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[05-22 21:31:23] ');
        feature.disable();
        expect(span.textContent).toBe('[5/22 9:31:23 PM] ');
    });

    test('disable() leaves a span the client has since re-rendered alone', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        span.textContent = '[10:00:00 AM] ';
        feature.disable();
        expect(span.textContent).toBe('[10:00:00 AM] ');
    });

    test.each([
        ['[PM 9:31:23] ', '[21:31:23] '],
        ['[오후 9:31:23] ', '[21:31:23] '],
        ['[오전 12:05:09] ', '[00:05:09] '],
        ['[下午9:31:23] ', '[21:31:23] '],
        ['[上午12:05:09] ', '[00:05:09] '],
        ['[午後 12:30:00] ', '[12:30:00] '],
        ['[午前9:31:23] ', '[09:31:23] '],
        ['[5/22 오후 9:31:23] ', '[05-22 21:31:23] '],
        ['[9:31:23 午後] ', '[21:31:23] '],
        ['[12:00:00 PM] ', '[12:00:00] '],
        ['[12:00:00 AM] ', '[00:00:00] '],
    ])('converts the localized day-period form %s', (native, expected) => {
        const span = makeTimestampSpan(native);
        feature.initialize();
        expect(span.textContent).toBe(expected);
    });

    test('a day-period-first timestamp converts back to 12-hour', () => {
        settingValues.market_listingTimeFormat = '12hour';
        const span = makeTimestampSpan('[오후 9:31:23] ');
        feature.initialize();
        expect(span.textContent).toBe('[9:31:23 PM] ');
    });

    test('leaves localized-digit timestamps unchanged', () => {
        const span = makeTimestampSpan('[م ٩:٣١:٢٣] ');
        feature.initialize();
        expect(span.textContent).toBe('[م ٩:٣١:٢٣] ');
    });

    test('disable() unregisters the dom observer and setting-change listeners', () => {
        feature.initialize();
        feature.disable();
        expect(config.offSettingChange).toHaveBeenCalledWith('market_listingTimeFormat', expect.any(Function));
        expect(config.offSettingChange).toHaveBeenCalledWith('market_listingDateFormat', expect.any(Function));
    });

    test('ignores spans whose text does not match the expected timestamp pattern', () => {
        const span = makeTimestampSpan('[invalid]');
        feature.initialize();
        expect(span.textContent).toBe('[invalid]');
    });
    test('handles a narrow no-break space before AM/PM', () => {
        const span = makeTimestampSpan('[9:31:23 PM] ');
        feature.initialize();
        expect(span.textContent).toBe('[21:31:23] ');
    });

    test('rewrites messages that arrive later through the observer callback', async () => {
        const domObserver = (await import('../../core/dom-observer.js')).default;
        feature.initialize();
        const callback = domObserver.onClass.mock.calls[0][2];
        const span = makeTimestampSpan('[11:59:59 PM] ');
        callback(span);
        expect(span.textContent).toBe('[23:59:59] ');
    });

    test('does not rewrite the DOM when 12-hour output equals the existing text', () => {
        settingValues.market_listingTimeFormat = '12hour';
        const span = makeTimestampSpan('[9:31:23 PM] ');
        const before = span.firstChild;
        feature.initialize();
        expect(span.firstChild).toBe(before);
    });
});
