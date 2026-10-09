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

// Matches the native client's "[M/D H:MM:SS AM/PM]" or "[H:MM:SS AM/PM]" timestamp text. The
// client builds the string as "[" + time + "] ", so the span's own text carries a trailing space
// after the closing bracket (the locale may also put a narrow no-break space before AM/PM).
// The trailing whitespace is captured and preserved, never treated as absent.
const TIMESTAMP_RE = /^\[(?:(\d{1,2}\/\d{1,2})\s+)?(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\](\s*)$/i;

/**
 * Reformat a single timestamp span's text according to the current date/time settings.
 * No-op if the text doesn't match the expected AM/PM pattern (already reformatted, or unrecognized).
 * @param {Element} span
 */
function processTimestampNode(span) {
    const current = span.textContent;
    const match = current.match(TIMESTAMP_RE);
    if (!match) return;

    const [, datePart, hourStr, minuteStr, secondStr, meridiem, trailingSpace] = match;
    const use24h = !isTwelveHourClock(config.getSettingValue('market_listingTimeFormat', '24hour'));
    const dateFormat = config.getSettingValue('market_listingDateFormat', 'MM-DD');

    let hour = parseInt(hourStr, 10);
    if (meridiem.toUpperCase() === 'PM' && hour !== 12) hour += 12;
    if (meridiem.toUpperCase() === 'AM' && hour === 12) hour = 0;

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
        const dateText = dateFormat === 'DD-MM' ? `${paddedDay}/${paddedMonth}` : `${paddedMonth}/${paddedDay}`;
        newText = `[${dateText} ${timeText}]`;
    }

    newText += trailingSpace;
    // 12-hour output is still matched by the pattern; writing identical text would re-fire the
    // observer for nothing, so only touch the DOM when the text actually changes.
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
