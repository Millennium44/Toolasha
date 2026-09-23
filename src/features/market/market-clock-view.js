/**
 * Market Clock View
 *
 * The "When it trades" section of the Market History viewer: one item's price
 * and traded volume by hour of the player's day and by day of their week, drawn
 * from the pooled price history (`mooket/market-history-api.js`).
 *
 * Drawn as plain DOM grids rather than Chart.js: Chart is an optional
 * `@require` that may be missing at startup, and a 24-cell strip reads better as
 * a heat row than as a chart anyway.
 *
 * It reads the same third-party pool as the History panel and is governed by the
 * same switch (`market_pooledHistory`). With that switch off it says so and
 * fetches nothing.
 */

import config from '../../core/config.js';
import marketHistoryAPI from './mooket/market-history-api.js';
import { describeCooldown } from './mooket/market-history-data.js';
import {
    buildMarketClock,
    summarizeClock,
    MIN_HOUR_SAMPLES,
    MIN_WEEKDAY_SAMPLES,
    FLAT_THRESHOLD,
} from './market-clock-stats.js';
import { isTwelveHourClock } from '../../utils/formatters.js';

/** Ranges offered, in days. Weekday buckets need weeks, so nothing shorter than a month. */
export const CLOCK_RANGES = [30, 90, 180];

/** The range a fresh panel opens on */
export const DEFAULT_CLOCK_RANGE = 90;

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SELECT_STYLE = `
    padding: 4px 8px;
    border: 1px solid #555;
    border-radius: 4px;
    background: #1a1a1a;
    color: #fff;
`;

/**
 * Label for an hour bucket in the player's clock format.
 * @param {number} hour - 0–23
 * @param {boolean} twelveHour - 12-hour clock
 * @returns {string} e.g. "14:00" or "2 PM"
 */
export function hourLabel(hour, twelveHour) {
    if (!twelveHour) return `${String(hour).padStart(2, '0')}:00`;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return `${hour % 12 === 0 ? 12 : hour % 12} ${suffix}`;
}

/**
 * A fractional deviation as a signed percentage.
 * @param {number} value - e.g. -0.0123
 * @returns {string} e.g. "-1.2%"
 */
export function formatDeviation(value) {
    const percent = value * 100;
    const rounded = Math.abs(percent) < 0.05 ? 0 : percent;
    return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

function el(doc, tag, cssText = '', text = '') {
    const node = doc.createElement(tag);
    if (cssText) node.style.cssText = cssText;
    if (text) node.textContent = text;
    return node;
}

/**
 * Background for a cell: green where the bucket is good for the player on that
 * row (cheap ask, dear bid, busy), red where it is bad, scaled against the
 * largest solid bucket on the row so a flat row stays nearly colorless.
 */
function cellBackground(goodness, scale) {
    if (!scale || !goodness) return 'transparent';
    const strength = Math.min(1, Math.abs(goodness) / scale) * 0.55;
    return goodness > 0 ? `rgba(46, 204, 113, ${strength.toFixed(3)})` : `rgba(231, 76, 60, ${strength.toFixed(3)})`;
}

/**
 * One grid: a label column and a column per bucket, rows for ask, bid,
 * volume and sample count.
 *
 * @param {Document} doc - Owning document
 * @param {Array<Object>} buckets - `hours` or `weekdays` from buildMarketClock
 * @param {Object} options
 * @param {Array<string>} options.labels - Column labels, one per bucket
 * @param {number} options.minSamples - Below this a cell is drawn as thin
 * @param {boolean} options.hasVolume - Draw the volume row
 * @param {Object} options.summary - summarizeClock result, for outlining the winners
 * @returns {HTMLTableElement}
 */
function renderGrid(doc, buckets, { labels, minSamples, hasVolume, summary }) {
    const table = el(doc, 'table', 'border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 11px;');
    table.className = 'mwi-market-clock-grid';

    const head = el(doc, 'tr');
    head.appendChild(el(doc, 'th', 'width: 72px;'));
    for (const label of labels) {
        head.appendChild(
            el(doc, 'th', 'color: #8fb4ff; font-weight: normal; padding: 2px 0; text-align: center;', label)
        );
    }
    table.appendChild(head);

    const rows = [
        { key: 'ask', label: 'Ask (buy)', sign: -1, winner: summary.cheapestAsk },
        { key: 'bid', label: 'Bid (sell)', sign: 1, winner: summary.dearestBid },
    ];
    if (hasVolume) rows.push({ key: 'volume', label: 'Volume', sign: 1, winner: summary.busiest });

    for (const spec of rows) {
        const goodnessOf = (value) => (spec.key === 'volume' ? value - 1 : value) * spec.sign;
        const solid = buckets.filter((b) => b[spec.key].value !== null && b[spec.key].n >= minSamples);
        const scale = Math.max(0, ...solid.map((b) => Math.abs(goodnessOf(b[spec.key].value))));

        const tr = el(doc, 'tr');
        tr.dataset.row = spec.key;
        tr.appendChild(
            el(doc, 'th', 'color: #aaa; font-weight: normal; text-align: left; padding: 3px 4px;', spec.label)
        );
        for (const bucket of buckets) {
            const { value, n } = bucket[spec.key];
            const td = el(doc, 'td', 'text-align: center; padding: 3px 0; border: 1px solid rgba(74, 158, 255, 0.12);');
            td.dataset.index = String(bucket.index);
            if (value === null) {
                td.textContent = '–';
                td.style.color = '#555';
                td.title = 'No data';
            } else {
                td.textContent = spec.key === 'volume' ? `${value.toFixed(1)}×` : formatDeviation(value);
                if (n < minSamples) {
                    td.classList.add('mwi-market-clock-thin');
                    td.style.color = '#666';
                    td.style.opacity = '0.45';
                    td.title = `Only ${n} sample${n === 1 ? '' : 's'} — too few to call a pattern`;
                } else {
                    td.style.background = cellBackground(goodnessOf(value), scale);
                    td.title = `${n} samples`;
                    if (spec.winner && !spec.winner.flat && spec.winner.index === bucket.index) {
                        td.classList.add('mwi-market-clock-best');
                        td.style.outline = '1px solid #8fb4ff';
                        td.style.outlineOffset = '-1px';
                    }
                }
            }
            tr.appendChild(td);
        }
        table.appendChild(tr);
    }

    const countRow = el(doc, 'tr');
    countRow.dataset.row = 'samples';
    countRow.appendChild(
        el(doc, 'th', 'color: #777; font-weight: normal; text-align: left; padding: 3px 4px;', 'Samples')
    );
    for (const bucket of buckets) {
        const n = Math.max(bucket.ask.n, bucket.bid.n);
        const td = el(doc, 'td', `text-align: center; color: ${n < minSamples ? '#a55' : '#777'};`, String(n));
        countRow.appendChild(td);
    }
    table.appendChild(countRow);

    return table;
}

/**
 * The plain-words line over a grid: which bucket to buy in, sell in, and when
 * it is busiest — or that no bucket stands out.
 */
function summaryLines(summary, { nameOf, unit, reference, hasVolume }) {
    const lines = [];
    const { cheapestAsk, dearestBid, busiest } = summary;
    const flatNote = `no ${unit} stands out (all within ${(FLAT_THRESHOLD * 100).toFixed(1)}%)`;

    if (!cheapestAsk && !dearestBid) return [`Not enough history to compare ${unit}s — try a longer range.`];

    if (cheapestAsk) {
        lines.push(
            cheapestAsk.flat
                ? `Buying: ${flatNote}.`
                : `Cheapest to buy: ${nameOf(cheapestAsk.index)} — ask ${formatDeviation(cheapestAsk.value)} vs ${reference} (${cheapestAsk.n} samples).`
        );
    }
    if (dearestBid) {
        lines.push(
            dearestBid.flat
                ? `Selling: ${flatNote}.`
                : `Dearest to sell: ${nameOf(dearestBid.index)} — bid ${formatDeviation(dearestBid.value)} vs ${reference} (${dearestBid.n} samples).`
        );
    }
    if (hasVolume && busiest) {
        lines.push(
            busiest.flat
                ? `Volume: no ${unit} is busier than another.`
                : `Busiest: ${nameOf(busiest.index)} — ${busiest.value.toFixed(1)}× an average ${unit} (${busiest.n} samples).`
        );
    }
    return lines;
}

/**
 * Draw a computed market clock.
 *
 * @param {Object} clock - Result of buildMarketClock
 * @param {Object} options
 * @param {boolean} options.hasVolume - The source reports volume
 * @param {string} options.sourceLabel - Which pool the rows came from
 * @param {string} [options.timeZone] - The zone the buckets were cut in, for the caption
 * @param {boolean} [options.twelveHour=false] - Label hours on a 12-hour clock
 * @param {Document} [options.doc=document] - Owning document
 * @returns {HTMLElement}
 */
export function renderMarketClock(clock, { hasVolume, sourceLabel, timeZone, twelveHour = false, doc = document }) {
    const root = el(doc, 'div', 'display: flex; flex-direction: column; gap: 12px;');
    root.className = 'mwi-market-clock-body';

    const sections = [
        {
            title: 'By hour of day',
            buckets: clock.hours,
            labels: clock.hours.map((b) => (twelveHour ? hourLabel(b.index, true).replace(' ', '') : String(b.index))),
            minSamples: MIN_HOUR_SAMPLES,
            nameOf: (index) => hourLabel(index, twelveHour),
            unit: 'hour',
            reference: 'its day',
        },
        {
            title: 'By day of week',
            buckets: clock.weekdays,
            labels: WEEKDAY_SHORT,
            minSamples: MIN_WEEKDAY_SAMPLES,
            nameOf: (index) => WEEKDAY_NAMES[index],
            unit: 'day',
            reference: 'its week',
        },
    ];

    for (const section of sections) {
        const block = el(doc, 'div');
        block.className = `mwi-market-clock-section mwi-market-clock-${section.unit}`;
        block.appendChild(el(doc, 'div', 'color: #8fb4ff; font-weight: bold; margin-bottom: 4px;', section.title));

        const summary = summarizeClock(section.buckets, section.minSamples);
        const summaryBox = el(doc, 'div', 'color: #ccc; font-size: 12px; margin-bottom: 6px; line-height: 1.5;');
        summaryBox.className = 'mwi-market-clock-summary';
        for (const line of summaryLines(summary, { ...section, hasVolume })) {
            summaryBox.appendChild(el(doc, 'div', '', line));
        }
        block.appendChild(summaryBox);
        block.appendChild(renderGrid(doc, section.buckets, { ...section, hasVolume, summary }));
        root.appendChild(block);
    }

    const first = clock.firstTime ? new Date(clock.firstTime * 1000).toLocaleDateString() : '?';
    const last = clock.lastTime ? new Date(clock.lastTime * 1000).toLocaleDateString() : '?';
    const caption = el(doc, 'div', 'color: #888; font-size: 11px; line-height: 1.5;');
    caption.className = 'mwi-market-clock-caption';
    caption.textContent =
        `${clock.rowCount} sightings over ${clock.dayCount} days (${first} – ${last}) from ${sourceLabel}. ` +
        `Server times are UTC; buckets are in your time zone${timeZone ? ` (${timeZone})` : ''}. ` +
        'Prices are measured against their own day (hours) or surrounding week (days), so a trend does not ' +
        'read as a pattern; an empty side of the book is skipped, never counted as a price. ' +
        `Greyed cells have fewer than ${MIN_HOUR_SAMPLES} (hours) or ${MIN_WEEKDAY_SAMPLES} (days) samples.` +
        (hasVolume ? '' : ' This source reports no volume, so there is no volume row.');
    root.appendChild(caption);

    return root;
}

/**
 * The section as mounted in the viewer: item and range pickers over the grids.
 */
export class MarketClockPanel {
    /**
     * @param {Object} options
     * @param {Array<{itemHrid: string, enhancementLevel: number, name: string}>} options.items - Pickable items
     * @param {{itemHrid: string, enhancementLevel: number}|null} [options.initial] - Item to open on
     * @param {Document} [options.doc=document] - Owning document
     */
    constructor({ items, initial = null, doc = document }) {
        this.doc = doc;
        this.items = items;
        this.days = DEFAULT_CLOCK_RANGE;
        this.loadToken = 0;
        const start = initial
            ? items.findIndex(
                  (i) => i.itemHrid === initial.itemHrid && i.enhancementLevel === (initial.enhancementLevel || 0)
              )
            : -1;
        this.selected = items.length ? Math.max(0, start) : -1;
        this.element = this.build();
    }

    build() {
        const doc = this.doc;
        const panel = el(
            doc,
            'div',
            `
            margin-bottom: 15px;
            padding: 12px;
            border: 1px solid rgba(74, 158, 255, 0.3);
            border-radius: 6px;
            background: rgba(20, 24, 40, 0.6);
        `
        );
        panel.className = 'mwi-market-clock';

        const bar = el(
            doc,
            'div',
            'display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px;'
        );
        bar.appendChild(el(doc, 'span', 'color: #8fb4ff; font-weight: bold;', 'When it trades'));

        const itemSelect = el(doc, 'select', SELECT_STYLE);
        itemSelect.className = 'toolasha-select mwi-market-clock-item';
        this.items.forEach((item, index) => {
            const option = el(
                doc,
                'option',
                '',
                item.enhancementLevel ? `${item.name} +${item.enhancementLevel}` : item.name
            );
            option.value = String(index);
            option.selected = index === this.selected;
            itemSelect.appendChild(option);
        });
        itemSelect.addEventListener('change', () => {
            this.selected = Number(itemSelect.value);
            this.load();
        });

        const rangeSelect = el(doc, 'select', SELECT_STYLE);
        rangeSelect.className = 'toolasha-select mwi-market-clock-range';
        for (const days of CLOCK_RANGES) {
            const option = el(doc, 'option', '', `${days} days`);
            option.value = String(days);
            option.selected = days === this.days;
            rangeSelect.appendChild(option);
        }
        rangeSelect.addEventListener('change', () => {
            this.days = Number(rangeSelect.value);
            this.load();
        });

        bar.appendChild(itemSelect);
        bar.appendChild(rangeSelect);
        panel.appendChild(bar);

        this.status = el(doc, 'div', 'color: #aaa; font-size: 12px;');
        this.status.className = 'mwi-market-clock-status';
        panel.appendChild(this.status);

        this.body = el(doc, 'div');
        panel.appendChild(this.body);
        return panel;
    }

    setStatus(text) {
        this.status.textContent = text;
        this.status.style.display = text ? '' : 'none';
    }

    clearBody() {
        while (this.body.firstChild) this.body.removeChild(this.body.firstChild);
    }

    /**
     * Fetch the selected item's history and draw it. A later call supersedes an
     * earlier one still in flight, so a slow answer for the previous pick cannot
     * draw over the current one.
     * @returns {Promise<void>}
     */
    async load() {
        const token = ++this.loadToken;
        this.clearBody();

        if (!marketHistoryAPI.enabled) {
            this.setStatus(
                'This view reads the pooled price history, which is off. Turn on "Market: Price history panel" ' +
                    'in Toolasha settings to use it — it talks to a third-party server.'
            );
            return;
        }
        const item = this.items[this.selected];
        if (!item) {
            this.setStatus('No items in your market history to look up yet.');
            return;
        }

        const source = marketHistoryAPI.currentSource();
        this.setStatus(`Loading ${this.days} days of history…`);
        let rows = null;
        try {
            rows = await marketHistoryAPI.fetchHistory(item.itemHrid, item.enhancementLevel || 0, this.days);
        } catch (error) {
            console.error('[MarketClock] Fetching history failed:', error);
        }
        if (token !== this.loadToken) return;

        if (rows === null) {
            const cooling = marketHistoryAPI.cooldownRemainingMs(source.key);
            this.setStatus(
                cooling > 0
                    ? `The pooled history server is refusing requests — retrying in ${describeCooldown(cooling)}.`
                    : 'Could not load history for this item.'
            );
            return;
        }
        if (!rows.length) {
            this.setStatus(`${source.label} has no history for this item.`);
            return;
        }

        this.setStatus('');
        let timeZone = '';
        try {
            timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
        } catch {
            timeZone = '';
        }
        const clock = buildMarketClock(rows, { hasVolume: source.hasVolume });
        this.body.appendChild(
            renderMarketClock(clock, {
                hasVolume: source.hasVolume,
                sourceLabel: source.label,
                timeZone,
                twelveHour: isTwelveHourClock(config.getSettingValue('market_listingTimeFormat', '24hour')),
                doc: this.doc,
            })
        );
    }

    /** Detach, and make any fetch still in flight a no-op */
    destroy() {
        this.loadToken += 1;
        this.element.remove();
    }
}
