/**
 * Shared machinery for the "Totals by Input Item" table that the transmute,
 * coinify and decompose history viewers each render underneath their session
 * list.
 *
 * The three actions have genuinely different economics — transmute is a
 * gamble against a drop table, coinify sells the item to the game for coins,
 * decompose breaks it into a fixed set of materials — so their *columns* are
 * not shared and stay local to each viewer. What is shared is everything
 * around the columns: grouping filtered sessions by input item, pooling groups
 * the game data says are the same bet, the table chrome, the cell styling, the
 * row striping and the footnote legend. Those were the parts that would have
 * been copy-pasted three times and then drifted three ways.
 *
 * Nothing here reads game data or market prices; it is given already-computed
 * groups and already-built rows. That keeps it testable without mocking the
 * game, and keeps each viewer the single place that knows what its own numbers
 * mean.
 */

/**
 * The type scale these three modals share.
 *
 * Before this existed the same panel carried 11px, 13px, 14px, 16px and 24px
 * inline on different elements with no relationship between them, and the
 * session table and totals table simply inherited whatever the page gave them —
 * so a footnote sat five pixels below body text and the whole panel read as
 * three unrelated things stacked. Four steps is enough: a heading one step
 * above body, body, a footnote one step below, and a size for icon-only glyph
 * buttons that need the extra bulk to stay clickable.
 *
 * @type {{heading: string, body: string, note: string, glyph: string}}
 */
export const HISTORY_TYPE_SCALE = {
    heading: '14px',
    body: '13px',
    note: '12px',
    glyph: '16px',
};

/**
 * Group a viewer's filtered sessions by input item.
 *
 * The per-session figures come from the caller's own profit cache, so a totals
 * row and the Profit column of the rows it sums can never disagree about a
 * single session's math.
 *
 * @param {Array<Object>} sessions - The viewer's filtered sessions
 * @param {Object} handlers
 * @param {(session: Object) => Object} handlers.getDetail - Per-session profit detail
 * @param {(inputItemHrid: string) => Object} handlers.createGroup - A zeroed group for an input item
 * @param {(group: Object, session: Object, detail: Object) => void} handlers.accumulate - Fold one session in
 * @param {(group: Object) => Object} [handlers.finalize] - Derive ratios once a group is complete
 * @param {(inputItemHrid: string) => string} handlers.getSortName - Display name, for the A–Z ordering
 * @returns {Array<Object>} One entry per distinct input item, sorted by name
 */
export function groupSessionsByInputItem(sessions, { getDetail, createGroup, accumulate, finalize, getSortName }) {
    const groups = new Map();

    for (const session of sessions) {
        const hrid = session.inputItemHrid;
        let group = groups.get(hrid);
        if (!group) {
            group = createGroup(hrid);
            groups.set(hrid, group);
        }
        accumulate(group, session, getDetail(session));
    }

    const totals = Array.from(groups.values()).map((group) => (finalize ? finalize(group) : group));
    totals.sort((a, b) => getSortName(a.inputItemHrid).localeCompare(getSortName(b.inputItemHrid)));
    return totals;
}

/**
 * Pooled rows for sets of inputs the game data says are the same bet, in
 * addition to (never instead of) the per-item rows.
 *
 * A set of one produces nothing: that is just the per-item row again wearing a
 * different label. An item the key function cannot classify pools with
 * nothing, which is the safe default — a row that might be wrong is worse than
 * a row that is missing.
 *
 * @param {Array<Object>} totals - Per-item groups
 * @param {Object} handlers
 * @param {(inputItemHrid: string) => string|null} handlers.getKey - Equivalence signature, or null
 * @param {(members: Array<Object>) => Object} handlers.buildPooled - Sum a set of equivalent groups
 * @param {(inputItemHrid: string) => string} handlers.getSortName - Display name, for the A–Z ordering
 * @returns {Array<Object>} Zero or more pooled groups
 */
export function poolEquivalentGroups(totals, { getKey, buildPooled, getSortName }) {
    const byKey = new Map();
    for (const group of totals) {
        const key = getKey(group.inputItemHrid);
        if (!key) continue;
        const bucket = byKey.get(key);
        if (bucket) bucket.push(group);
        else byKey.set(key, [group]);
    }

    const pooled = [];
    for (const members of byKey.values()) {
        if (members.length < 2) continue;
        pooled.push(buildPooled(members));
    }
    pooled.sort((a, b) => getSortName(a.memberHrids[0]).localeCompare(getSortName(b.memberHrids[0])));
    return pooled;
}

/** Legend line for the bound prefixes {@link breakEvenBound} puts on Break-even Input. */
export const BREAK_EVEN_BOUND_LEGEND =
    '≥ / ≤ on Break-even Input: a bound, not a figure — ≥ when an output went unpriced (the true value is at ' +
    'least this), ≤ when a catalyst went uncounted (at most this)';

/**
 * How far a group's Break-even Input can be trusted, as a prefix and a tooltip.
 *
 * Break-even is (revenue − catalyst − coin cost) / consumed. An output the
 * market could not price leaves revenue short, so the true break-even is at
 * least the figure shown; a catalyst that was unpriced or never recorded
 * leaves catalyst cost short, so it is at most the figure shown. One gap is a
 * bound; both together pull opposite ways and leave no bound at all.
 *
 * @param {{revenueUnpriced?: boolean, catalystUnpricedSessions?: number, catalystUnrecordedSessions?: number}} group
 * @returns {{prefix: string, noBound: boolean, title: string|undefined}}
 */
export function breakEvenBound(group) {
    const revenueShort = !!group.revenueUnpriced;
    const catalystShort = (group.catalystUnpricedSessions || 0) > 0 || (group.catalystUnrecordedSessions || 0) > 0;
    if (revenueShort && catalystShort) {
        return {
            prefix: '',
            noBound: true,
            title:
                'An unpriced output and an uncounted catalyst pull this figure in opposite directions — ' +
                'no bound can be given.',
        };
    }
    if (revenueShort) {
        return {
            prefix: '≥',
            noBound: false,
            title: 'An output could not be priced, so revenue is short — the true break-even is at least this.',
        };
    }
    if (catalystShort) {
        return {
            prefix: '≤',
            noBound: false,
            title: 'A catalyst was unpriced or not recorded, so its cost is short — the true break-even is at most this.',
        };
    }
    return { prefix: '', noBound: false, title: undefined };
}

/**
 * Create a plain totals-table `<td>` with the shared styling.
 * @param {string} text
 * @param {{color?: string, bold?: boolean, title?: string}} [opts]
 * @returns {HTMLTableCellElement}
 */
export function createTotalsCell(text, opts = {}) {
    const td = document.createElement('td');
    td.textContent = text;
    td.style.cssText = `padding: 6px 10px;${opts.color ? ` color: ${opts.color};` : ''}${opts.bold ? ' font-weight: bold;' : ''}`;
    if (opts.title) td.title = opts.title;
    return td;
}

/**
 * The `style` text for one totals row: striping for ordinary rows, a tint and
 * a dashed top rule for a pooled row so it reads as a summary of the rows
 * above it, and an amber tint for a row whose recorded counts cannot be
 * trusted.
 *
 * @param {number} index - Row index, for the stripe
 * @param {{pooled?: boolean, flagged?: boolean}} [state]
 * @returns {string}
 */
export function totalsRowStyle(index, { pooled = false, flagged = false } = {}) {
    const background = flagged
        ? 'rgba(251,191,36,0.08)'
        : pooled
          ? 'rgba(74,144,226,0.08)'
          : index % 2 === 0
            ? '#2a2a2a'
            : '#252525';
    return `border-bottom: 1px solid #333;${pooled ? ' border-top: 1px dashed #555;' : ''} background: ${background};`;
}

/**
 * Render a totals section — heading, table, rows, footnote legend — into a
 * container, replacing whatever was there.
 *
 * The rows are built by the caller, because what a row says is the one part of
 * this that is genuinely per-action. Everything around them is not.
 *
 * @param {HTMLElement|null} container - The viewer's totals host, or null when
 *   the modal has none (a partial test DOM, for instance) — then nothing is drawn
 * @param {Object} section
 * @param {string} section.heading - Section heading text
 * @param {Array<{label: string, title?: string}>} section.columns - Header cells
 * @param {Array<HTMLTableRowElement>} section.rows - Body rows, in display order
 * @param {Array<string>} [section.legendParts] - Footnote entries; omitted entries draw no legend
 * @param {HTMLElement|null} [section.controls] - Drawn between the heading and the table
 * @param {string|null} [section.emptyText] - With no rows, draw the heading, controls and this line
 *   instead of nothing — a control that emptied the table has to stay reachable to undo it
 * @returns {HTMLTableElement|null} The table, for callers that want to inspect it
 */
export function renderTotalsSection(
    container,
    { heading, columns, rows, legendParts = [], controls = null, emptyText = null }
) {
    if (!container) return null;
    while (container.firstChild) container.removeChild(container.firstChild);
    if (rows.length === 0 && !emptyText) return null;

    const headingEl = document.createElement('div');
    headingEl.textContent = heading;
    headingEl.style.cssText = `color: #fff; font-weight: bold; font-size: ${HISTORY_TYPE_SCALE.heading}; margin: 18px 0 8px;`;
    container.appendChild(headingEl);
    if (controls) container.appendChild(controls);

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'mwi-alchemy-totals-empty';
        empty.textContent = emptyText;
        empty.style.cssText = `color: #888; font-size: ${HISTORY_TYPE_SCALE.body}; padding: 6px 10px;`;
        container.appendChild(empty);
        return null;
    }

    const table = document.createElement('table');
    table.style.cssText = `width: 100%; min-width: max-content; border-collapse: collapse; color: #fff; white-space: nowrap; font-size: ${HISTORY_TYPE_SCALE.body};`;

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.style.background = '#1a1a1a';
    for (const col of columns) {
        const th = document.createElement('th');
        th.textContent = col.label;
        th.style.cssText = 'padding: 8px 10px; text-align: left; border-bottom: 2px solid #555; white-space: nowrap;';
        if (col.title) th.title = col.title;
        headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) tbody.appendChild(row);
    table.appendChild(tbody);
    container.appendChild(table);

    if (legendParts.length > 0) {
        const legend = document.createElement('div');
        // contain: inline-size keeps this long paragraph from sizing the fit-content modal; it wraps to
        // the tables' width instead of stretching the modal to 95vw.
        legend.style.cssText = `color: #888; font-size: ${HISTORY_TYPE_SCALE.note}; margin-top: 6px; contain: inline-size;`;
        legend.textContent = legendParts.join('    ');
        container.appendChild(legend);
    }

    return table;
}
