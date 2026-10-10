/**
 * Chat 24hr Timestamps
 * Reformats native chat message timestamps using the user's Market date/time
 * format settings (market_listingTimeFormat / market_listingDateFormat) instead of the
 * browser's default locale (which is often 12-hour AM/PM).
 *
 * Idea and approach credit: the "MilkyWayIdle 24hr Timestamps" userscript by Opzon (see
 * docs/GREASYFORK.md). No code is copied; this is a re-implementation on the shared DOM observer.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { isTwelveHourClock } from '../../utils/formatters.js';

// Matches the native client's "[M/D H:MM:SS AM/PM]" or "[H:MM:SS AM/PM]" timestamp text (the
// day period is absent when the browser locale is already 24-hour, and comes first, in AM/PM or
// the CJK forms, in some locales: ko "오후 9:31:23", zh "下午9:31:23", ja "午後9:31:23"). The
// client builds the string as "[" + time + "] ", so the span's own text carries a trailing space
// after the closing bracket (the locale may also put a narrow no-break space before AM/PM).
// The trailing whitespace is captured and preserved, never treated as absent.
const PERIOD = 'AM|PM|上午|下午|午前|午後|오전|오후';
const TIMESTAMP_RE = new RegExp(
    String.raw`^\[(?:(\d{1,2}/\d{1,2})\s+)?(?:(${PERIOD})\s*)?(\d{1,2}):(\d{2}):(\d{2})(?:\s*(${PERIOD}))?\](\s*)$`,
    'i'
);
const PM_PERIODS = new Set(['PM', '下午', '午後', '오후']);

// What the client wrote and what we wrote over it, per span. Once rewritten, the text is no longer
// the native form, so a later resweep (a changed setting) must start from the native text again.
const rewritten = new WeakMap();

/**
 * Reformat a single timestamp span's text according to the current date/time settings.
 * Always starts from the native text, so every resweep applies the current settings.
 * No-op if the text doesn't match the expected pattern (unrecognized).
 * @param {Element} span
 */
function processTimestampNode(span) {
    const current = span.textContent;
    const record = rewritten.get(span);
    // Our own output is not the native text; anything else is a fresh native value (the client
    // re-rendered the span)
    const native = record && record.out === current ? record.native : current;
    const match = native.match(TIMESTAMP_RE);
    if (!match) return;

    const [, datePart, leadPeriod, hourStr, minuteStr, secondStr, trailPeriod, trailingSpace] = match;
    const period = leadPeriod || trailPeriod;
    const use24h = !isTwelveHourClock(config.getSettingValue('market_listingTimeFormat', '24hour'));
    const dateFormat = config.getSettingValue('market_listingDateFormat', 'MM-DD');

    let hour = parseInt(hourStr, 10);
    if (period) {
        const isPm = PM_PERIODS.has(period.toUpperCase());
        if (isPm && hour !== 12) hour += 12;
        if (!isPm && hour === 12) hour = 0;
    }

    let timeText;
    if (use24h) {
        timeText = `${String(hour).padStart(2, '0')}:${minuteStr}:${secondStr}`;
    } else {
        const hour12 = hour % 12 === 0 ? 12 : hour % 12;
        const outMeridiem = hour < 12 ? 'AM' : 'PM';
        timeText = `${hour12}:${minuteStr}:${secondStr} ${outMeridiem}`;
    }

    let newText = `[${timeText}]`;
    if (datePart) {
        const [month, day] = datePart.split('/');
        const paddedMonth = month.padStart(2, '0');
        const paddedDay = day.padStart(2, '0');
        const dateText = dateFormat === 'DD-MM' ? `${paddedDay}-${paddedMonth}` : `${paddedMonth}-${paddedDay}`;
        newText = `[${dateText} ${timeText}]`;
    }

    newText += trailingSpace;
    // Writing identical text would re-fire the observer for nothing, so only touch the DOM when
    // the text actually changes.
    rewritten.set(span, { native, out: newText });
    if (newText === current) return;
    span.textContent = newText;
}

/**
 * Re-process all timestamp spans currently in the DOM. Used on initialize() and whenever
 * the user changes the time/date format settings, so already-rendered messages update too.
 */
function reprocessAllTimestamps() {
    document.querySelectorAll('[class*="ChatMessage_timestamp"]').forEach(processTimestampNode);
}

/**
 * Put every timestamp we rewrote back to the text the client drew, for a live switch-off.
 * A span whose text is no longer our output was re-rendered by the client and is left alone.
 */
function restoreNativeTimestamps() {
    document.querySelectorAll('[class*="ChatMessage_timestamp"]').forEach((span) => {
        const record = rewritten.get(span);
        if (record && record.out === span.textContent) span.textContent = record.native;
        rewritten.delete(span);
    });
}

class Chat24hrTimestamps {
    constructor() {
        this.isInitialized = false;
        this.unregisterObserver = null;
        this.onSettingChange = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('chat_24hrTimestamps')) return;

        this.isInitialized = true;

        this.unregisterObserver = domObserver.onClass(
            'Chat24hrTimestamps',
            'ChatMessage_timestamp',
            processTimestampNode
        );
        reprocessAllTimestamps();

        this.onSettingChange = () => reprocessAllTimestamps();
        config.onSettingChange('market_listingTimeFormat', this.onSettingChange);
        config.onSettingChange('market_listingDateFormat', this.onSettingChange);
    }

    disable() {
        restoreNativeTimestamps();
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        if (this.onSettingChange) {
            config.offSettingChange('market_listingTimeFormat', this.onSettingChange);
            config.offSettingChange('market_listingDateFormat', this.onSettingChange);
            this.onSettingChange = null;
        }
        this.isInitialized = false;
    }
}

const chat24hrTimestamps = new Chat24hrTimestamps();
export default chat24hrTimestamps;
