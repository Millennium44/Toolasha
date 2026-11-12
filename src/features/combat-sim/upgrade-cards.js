/**
 * Upgrade results as ranked shortlist cards.
 *
 * A presentation of rows the Upgrade tables already hold: nothing here ranks, scores or formats a
 * figure of its own. The table renderers hand over their rows in the order they drew them, with each
 * figure already rendered by the table's own cell function; this module numbers them, keeps the top few,
 * works out what state each one is in, moves every hover-only explanation into the card's Details and
 * draws the result. Everything except `wireUpgradeCards` and `wireViewSwitch` is pure.
 */

import { GAME_COLORS } from '../../utils/game-look.js';

/** Cards shown before "Show all" */
export const UPGRADE_CARD_TOP = 5;

/** What an unpriced or unmeasured figure reads as. Never "0", never "free" */
export const UNKNOWN_TEXT = 'unknown';

/** What "within noise" means, said where the table says it only on hover */
export const WITHIN_NOISE_TEXT = "Smaller than this run's sampling error — sim for longer before trusting it.";

/**
 * One labelled figure for a card.
 * @param {string} label - Visible name
 * @param {string} html - The table's own rendering of the figure
 * @param {'good'|'bad'|'warn'|'neutral'|'muted'} [tone] - Colour of the label's figure
 * @param {string} [title] - The explanation the table keeps in a tooltip
 * @returns {Object} A card figure
 */
export function figure(label, html, tone = 'neutral', title = '') {
    return { label, html, tone, title };
}

/** The two presentations of the results */
export const CARD_VIEWS = Object.freeze(['cards', 'table']);

const esc = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

/**
 * A figure, or the word "unknown" when there is none. A missing price must not read as zero.
 * @param {number|null|undefined} value - The figure
 * @param {Function} format - Formats a finite figure
 * @returns {string}
 */
export function valueOrUnknown(value, format) {
    return Number.isFinite(value) ? format(value) : UNKNOWN_TEXT;
}

/**
 * Tone of a signed change: green when it helps, red when it hurts, neutral when it is nothing.
 * @param {number} value - The change
 * @param {{lowerIsBetter?: boolean, epsilon?: number}} [options] - `lowerIsBetter` for deaths
 * @returns {'good'|'bad'|'neutral'}
 */
export function signTone(value, { lowerIsBetter = false, epsilon = 1e-9 } = {}) {
    if (!Number.isFinite(value) || Math.abs(value) < epsilon) return 'neutral';
    const helps = lowerIsBetter ? value < 0 : value > 0;
    return helps ? 'good' : 'bad';
}

// ---------------------------------------------------------------------------------------------
// The card / table choice
// ---------------------------------------------------------------------------------------------

/**
 * The remembered choice, per form factor: a pick made on a phone must not change a desktop even when the
 * preference record syncs between them. `null` means the player never picked on that form factor.
 * @param {*} saved - What the preference record holds (any shape)
 * @returns {{wide: 'cards'|'table'|null, narrow: 'cards'|'table'|null}}
 */
export function normalizeViewChoices(saved) {
    const valid = (v) => (CARD_VIEWS.includes(v) ? v : null);
    return { wide: valid(saved?.wide), narrow: valid(saved?.narrow) };
}

/**
 * The view to draw: the player's pick for this form factor, else Cards on a narrow window and Table on a wide one.
 * @param {{wide: string|null, narrow: string|null}} choices - From {@link normalizeViewChoices}
 * @param {boolean} narrow - Whether the window is at the phone breakpoint
 * @returns {'cards'|'table'}
 */
export function resolveCardView(choices, narrow) {
    const picked = narrow ? choices?.narrow : choices?.wide;
    if (CARD_VIEWS.includes(picked)) return picked;
    return narrow ? 'cards' : 'table';
}

/**
 * The choices after the player picks a view on this form factor.
 * @param {{wide: string|null, narrow: string|null}} choices - Current choices
 * @param {boolean} narrow - Which form factor the pick was made on
 * @param {string} view - 'cards' or 'table'
 * @returns {{wide: string|null, narrow: string|null}} New object; the other form factor is untouched
 */
export function withViewChoice(choices, narrow, view) {
    const base = normalizeViewChoices(choices);
    if (!CARD_VIEWS.includes(view)) return base;
    return narrow ? { ...base, narrow: view } : { ...base, wide: view };
}

// ---------------------------------------------------------------------------------------------
// Hover-only explanations
// ---------------------------------------------------------------------------------------------

const decode = (text) =>
    String(text)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;/g, "'")
        .replace(/&amp;/g, '&');

const stripTags = (html) =>
    decode(String(html).replace(/<[^>]*>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();

/**
 * Take every `title` tooltip out of a piece of HTML and hand it back as text.
 *
 * A tooltip is unreachable by touch and by keyboard, so the card shows none: the HTML comes back without
 * them and the sentences come back beside the visible words they were attached to, for the Details to print.
 * @param {string} html - Markup built by the table's cell functions
 * @returns {{html: string, titles: Array<{label: string, text: string, tag: string}>}}
 */
export function liftTitles(html) {
    const titles = [];
    let out = String(html ?? '');
    // A tooltip on an element with visible text: the text is its label
    out = out.replace(
        /<(span|button|td|th)\b([^>]*?)\stitle="([^"]*)"([^>]*)>([\s\S]*?)<\/\1>/g,
        (match, tag, before, title, after, inner) => {
            titles.push({ label: stripTags(inner), text: decode(title).trim(), tag });
            return `<${tag}${before}${after}>${inner}</${tag}>`;
        }
    );
    // Whatever is left (an element nested inside another, a self-closing tag)
    out = out.replace(/\stitle="([^"]*)"/g, (match, title) => {
        titles.push({ label: '', text: decode(title).trim(), tag: '' });
        return '';
    });
    return { html: out, titles: titles.filter((t) => t.text) };
}

/** Drop explanations that repeat their own label and exact duplicates */
function dedupeExplanations(list) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
        const text = String(item.text || '').trim();
        if (!text) continue;
        const label = String(item.label || '').trim();
        if (label && text.toLowerCase() === label.toLowerCase()) continue;
        const id = `${label}\u0000${text}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ label, text });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// State of a card
// ---------------------------------------------------------------------------------------------

/**
 * What state a candidate is in, in words and tone. The words are always printed: colour alone does not
 * tell an estimate from a verified result.
 *
 * Priority: running now, then a stored verdict (it outranks any note: a later verify that ended without one
 * says nothing about a row that has one), then a verify that ended without a verdict (stopped, failed, refused),
 * then where the estimate came from (a remembered run, an unpriced row, a plain estimate).
 * @param {Object} input
 * @param {boolean} [input.baseline] - The row is the current setup, not a candidate
 * @param {boolean} [input.pending] - A verify of this card is running
 * @param {{kind: 'stopped'|'failed'|'refused', text?: string}|null} [input.note] - A verify that ended without a verdict
 * @param {Object|null} [input.verdict] - A stored verify verdict `{verdict, stopped, profitLeftOut, mean}`
 * @param {boolean} [input.remembered] - The results were loaded from an earlier session
 * @param {boolean} [input.unpriced] - The row has no price
 * @returns {{kind: string, label: string, tone: 'good'|'bad'|'warn'|'neutral'|'muted'}}
 */
export function cardStateOf({
    baseline = false,
    pending = false,
    note = null,
    verdict = null,
    remembered = false,
    unpriced = false,
} = {}) {
    if (baseline) return { kind: 'baseline', label: 'Baseline', tone: 'muted' };
    if (pending) return { kind: 'pending', label: 'Verifying…', tone: 'neutral' };
    if (verdict) {
        if (verdict.verdict === 'error') return { kind: 'failed', label: 'Verify failed', tone: 'warn' };
        if (verdict.stopped && verdict.verdict !== 'confirmed' && verdict.verdict !== 'worse') {
            return { kind: 'stopped', label: 'Verify stopped', tone: 'warn' };
        }
        const unvalued = verdict.profitLeftOut && verdict.verdict === 'not-confirmed' && !Number.isFinite(verdict.mean);
        if (unvalued) return { kind: 'unvalued', label: 'Verified: profit not valued', tone: 'warn' };
        if (verdict.verdict === 'confirmed') return { kind: 'confirmed', label: 'Verified', tone: 'good' };
        if (verdict.verdict === 'worse') return { kind: 'worse', label: 'Verified: worse', tone: 'bad' };
        return { kind: 'unconfirmed', label: 'Verified: not confirmed', tone: 'neutral' };
    }
    // A busy tap is a message beside the state, never the state
    if (note && note.kind !== 'busy') {
        const labels = { stopped: 'Verify stopped', failed: 'Verify failed', refused: 'Not verified' };
        return { kind: `note-${note.kind}`, label: labels[note.kind] || 'Not verified', tone: 'warn' };
    }
    if (remembered) return { kind: 'remembered', label: 'Remembered estimate', tone: 'muted' };
    if (unpriced) return { kind: 'unpriced', label: 'Estimate, not priced', tone: 'muted' };
    return { kind: 'estimate', label: 'Estimate', tone: 'muted' };
}

// ---------------------------------------------------------------------------------------------
// Entries to cards
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} CardFigure
 * @property {string} label - Visible name of the figure
 * @property {string} html - The table's own rendering of it (may carry tooltips; they are lifted)
 * @property {'good'|'bad'|'warn'|'neutral'|'muted'} [tone]
 * @property {string} [title] - The column's own explanation, which the table shows only on hover
 */

/**
 * @typedef {Object} CardEntry
 * @property {Object} row - The result row (kept by reference so a button acts on exactly this row)
 * @property {string} key - The row's identity (`upgradeRowKey`)
 * @property {string} name - Plain text name
 * @property {string} [nameHtml] - Escaped name with decorative item icons; never raw imported markup
 * @property {string} [notesHtml] - Chips beside the name
 * @property {boolean} [baseline] - The current setup: shown, labelled, never ranked
 * @property {CardFigure} [headline] - The figure under the selected Rank by
 * @property {boolean} [within] - The headline gain is inside the run's sampling error
 * @property {Array<Array<CardFigure>>} [lines] - Rows of figures under the title
 * @property {Array<CardFigure>} [facts] - More figures, for Details
 * @property {string} [detailHtml] - Extra markup for Details (the table's expanded row)
 * @property {string} [actionsHtml] - The Save / Watch / Market buttons
 * @property {Object|null} [verdict] - Stored verify verdict
 * @property {{kind: string, text?: string}|null} [note] - A verify that ended without a verdict
 * @property {boolean} [pending] - A verify of this row is running
 * @property {string} [verdictHtml] - The table's verdict chip
 * @property {boolean} [unpriced] - No price
 * @property {boolean} [offerVerify] - This section can verify the row
 * @property {boolean} [canVerify] - The results can be re-measured now
 * @property {string} [verifyLabel] - "Profit/hr": what a verify measures
 */

/**
 * Turn the table's rows, in the order the table drew them, into cards.
 *
 * Order is never touched: card N is entry N. The top `top` non-baseline entries are shown unless
 * `showAll`; the baseline entry is always shown, as the table always shows it.
 * @param {Object} spec
 * @param {string} spec.section - Section id (gold, levels, unpriced, scrolls, order)
 * @param {Array<CardEntry>} spec.entries - In the table's order
 * @param {number} [spec.top] - Cards shown before Show all
 * @param {boolean} [spec.showAll] - Show every entry
 * @param {Set<string>|null} [spec.open] - Ids of the cards whose Details are open
 * @param {boolean} [spec.remembered] - The results are a remembered run
 * @returns {{section: string, top: number, total: number, shown: number, canToggle: boolean, showAll: boolean, cards: Array<Object>}}
 */
export function buildUpgradeCards({
    section,
    entries,
    top = UPGRADE_CARD_TOP,
    showAll = false,
    open = null,
    remembered = false,
}) {
    // Pass one: every entry's figures with the tooltips lifted out, hidden entries included, so what is
    // generic is judged against the whole section and does not change with Show all
    const prepared = entries.map((entry) => prepareEntry(entry));
    const generic = genericTexts(prepared.filter((p, i) => !entries[i].baseline));

    const seen = new Map();
    let rank = 0;
    let kept = 0;
    const cards = [];
    const rankable = entries.filter((e) => !e.baseline).length;
    const foldedTotal = entries.filter((e) => !e.baseline && e.folded).length;
    entries.forEach((entry, index) => {
        const n = seen.get(entry.key) || 0;
        seen.set(entry.key, n + 1);
        const id = `${section}:${entry.key}${n ? `#${n}` : ''}`;
        // A folded entry (see upgrade-fold.js) is the section's "+N more": drawn, and numbered, only under Show all
        if (!entry.baseline && !showAll && entry.folded) return;
        if (!entry.baseline) rank += 1;
        if (!entry.baseline && !showAll && ++kept > top) return;

        const state = cardStateOf({
            baseline: entry.baseline,
            pending: entry.pending,
            note: entry.note,
            verdict: entry.verdict,
            remembered,
            unpriced: entry.unpriced,
        });
        const { headline, lines, facts, notesHtml, detailHtml, actionsHtml, verdictHtml, lifted } = prepared[index];
        const own = [...lifted];
        if (entry.within) own.push({ label: 'Within noise', text: WITHIN_NOISE_TEXT, kind: 'within' });
        const offered = Boolean(entry.offerVerify) && !entry.baseline;
        let reason = '';
        if (offered && !entry.canVerify) reason = 'Re-run the analysis to verify.';

        cards.push({
            id,
            index,
            row: entry.row,
            rank: entry.baseline ? null : rank,
            baseline: Boolean(entry.baseline),
            name: entry.name,
            // Built by the caller's escaped item-label renderer; keep the plain name for ARIA.
            ...(entry.nameHtml ? { nameHtml: entry.nameHtml } : {}),
            notesHtml,
            headline,
            within: Boolean(entry.within),
            lines,
            facts,
            detailHtml,
            actionsHtml,
            verdictHtml,
            state,
            noteText: entry.note?.text || '',
            // What is true of this row only; the generic meanings are the section's, drawn once
            explain: dedupeExplanations(own.filter((item) => !isGenericItem(item, generic))),
            sectionExplain: entry.baseline ? [] : own.filter((item) => isGenericItem(item, generic)),
            verify: {
                offered,
                enabled: offered && Boolean(entry.canVerify) && !entry.pending,
                again: Boolean(entry.verdict),
                label: entry.verifyLabel || '',
                reason,
            },
            open: Boolean(open?.has(id)),
        });
    });
    return {
        section,
        top,
        total: rankable,
        shown: cards.filter((c) => !c.baseline).length,
        canToggle: rankable > top || foldedTotal > 0,
        folded: foldedTotal,
        showAll: Boolean(showAll),
        glossary: sectionGlossary(cards),
        cards,
    };
}

/**
 * One entry's figures with every tooltip lifted out, and the lifted sentences tagged with where they came from.
 * @param {CardEntry} entry - A card entry
 * @returns {Object} The lifted figures and markup, and `lifted`: `{label, text, kind}` for each sentence
 */
function prepareEntry(entry) {
    const lifted = [];
    // kind: column (a column's own explanation), inline (a tooltip inside a cell), note (a chip beside the name),
    // verdict (the verify chip), button (a control's help, wherever it sits)
    const lift = (html, label, kind) => {
        const out = liftTitles(html);
        for (const t of out.titles) {
            // A blank or dash has no arithmetic to show
            if (t.label === '\u2014' && t.tag !== 'button') continue;
            lifted.push({ label: t.label || label || '', text: t.text, kind: t.tag === 'button' ? 'button' : kind });
        }
        return out.html;
    };
    const liftFigure = (f) => {
        if (!f) return null;
        const html = lift(f.html, f.label, 'inline');
        if (f.title) lifted.push({ label: f.label, text: f.title, kind: 'column' });
        return { label: f.label, html, tone: f.tone || 'neutral' };
    };
    const headline = liftFigure(entry.headline);
    const lines = (entry.lines || []).map((line) => line.map(liftFigure));
    const facts = (entry.facts || []).map(liftFigure);
    return {
        headline,
        lines,
        facts,
        notesHtml: lift(entry.notesHtml || '', '', 'note'),
        detailHtml: lift(entry.detailHtml || '', '', 'inline'),
        actionsHtml: lift(entry.actionsHtml || '', '', 'inline'),
        verdictHtml: lift(entry.verdictHtml || '', 'Verify', 'verdict'),
        lifted,
    };
}

/** Whether a sentence quotes a figure of its own, ignoring the "0.01%" every score column names */
const hasRowNumbers = (text) => /\d/.test(String(text).replace(/0\.01%|1yr/g, ''));

/**
 * Which explanations are the same on every card of a section (the meaning of a column or a button) and which
 * are about one row. Decided from the data, not a list of words:
 * - a chip beside the name, a verify chip, a within-noise note: always about the row;
 * - a column's explanation: generic when the column is on every row and two or more rows carry the identical
 *   sentence, so a figure only some rows have (the ceiling) stays on its rows;
 * - a button's help: generic when two or more rows carry the identical sentence;
 * - a lone row has nothing to compare with: a sentence that quotes no figure of its own is generic;
 * - any other tooltip inside a cell: generic only when every row of the section carries the identical
 *   sentence, so a note that only some rows have (a ceiling, a cost source) stays on the rows it is true of.
 * @param {Array<{lifted: Array<{text: string, kind: string}>}>} prepared - The section's non-baseline entries
 * @returns {Set<string>} The sentences that are generic
 */
function genericTexts(prepared) {
    const holders = new Map();
    const columnRows = new Map();
    prepared.forEach((p, i) => {
        for (const item of p.lifted) {
            const h = holders.get(item.text) || { rows: new Set(), kinds: new Set(), columns: new Set() };
            h.rows.add(i);
            h.kinds.add(item.kind);
            holders.set(item.text, h);
            if (item.kind === 'column') {
                h.columns.add(item.label);
                const rows = columnRows.get(item.label) || new Set();
                rows.add(i);
                columnRows.set(item.label, rows);
            }
        }
    });
    const out = new Set();
    const total = prepared.length;
    for (const [text, h] of holders) {
        if (h.kinds.has('note') || h.kinds.has('verdict')) continue;
        const shared = total < 2 ? !hasRowNumbers(text) : h.rows.size >= 2;
        const onEveryRow = total < 2 || [...h.columns].some((label) => columnRows.get(label).size === total);
        if (h.kinds.has('column') || h.kinds.has('button')) {
            if (shared && (h.kinds.has('button') || onEveryRow)) out.add(text);
        } else if (total >= 2 && h.rows.size === total) {
            out.add(text);
        }
    }
    return out;
}

const isGenericItem = (item, generic) => item.kind !== 'within' && generic.has(item.text);

/**
 * The meanings every card of a section shares, each once, for the cards that are drawn.
 * @param {Array<Object>} cards - Built cards
 * @returns {Array<{label: string, text: string}>}
 */
function sectionGlossary(cards) {
    const byText = new Map();
    for (const card of cards) {
        for (const item of card.sectionExplain) {
            const g = byText.get(item.text) || { labels: new Set(), kind: item.kind };
            g.labels.add(String(item.label || '').trim());
            byText.set(item.text, g);
        }
    }
    const list = [];
    for (const [text, g] of byText) {
        // The same sentence on figures with different values has no one label to quote
        list.push({ label: g.labels.size === 1 ? [...g.labels][0] : '', text });
    }
    const verifyLabels = new Set(cards.filter((c) => c.verify.offered && c.verify.label).map((c) => c.verify.label));
    if (verifyLabels.size) {
        list.push({
            label: 'Verify',
            text: `Re-measures the row on fresh seeds by ${[...verifyLabels].join(' / ')}.`,
        });
    }
    return dedupeExplanations(list);
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

function figureHtml(figure, className) {
    if (!figure) return '';
    return (
        `<span class="${className} mwi-ucard-t-${figure.tone}">` +
        `<span class="mwi-ucard-fl">${esc(figure.label)}</span> <span class="mwi-ucard-fv">${figure.html}</span></span>`
    );
}

/**
 * One card.
 * @param {Object} card - From {@link buildUpgradeCards}
 * @param {string} section - Section id
 * @param {number} position - Index among the drawn cards, for unique element ids
 * @returns {string} HTML
 */
function cardHtml(card, section, position) {
    const detailId = `mwi-ucard-detail-${section}-${position}`;
    const state = card.state;
    const gain = card.headline
        ? `<span class="mwi-ucard-gain mwi-ucard-t-${card.headline.tone}"><span class="mwi-ucard-fl">${esc(card.headline.label)}</span> ` +
          `<strong class="mwi-ucard-fv">${card.headline.html}</strong>` +
          (card.within ? ` <span class="mwi-ucard-within">within noise</span>` : '') +
          `</span>`
        : '';
    const lines = card.lines
        .map((line) => line.filter(Boolean))
        .filter((line) => line.length)
        .map((line) => `<div class="mwi-ucard-line">${line.map((f) => figureHtml(f, 'mwi-ucard-fig')).join('')}</div>`)
        .join('');

    const verify = card.verify;
    const verifyButton = verify.offered
        ? `<button type="button" class="mwi-ucard-verify" data-card-verify="${esc(card.id)}"` +
          ` aria-label="${esc(`${verify.again ? 'Verify again' : 'Verify'}: ${card.name}${verify.label ? ` by ${verify.label}` : ''}`)}"` +
          `${verify.enabled ? '' : ' disabled'}>${verify.again ? 'Verify again' : 'Verify'}</button>`
        : '';

    const facts = card.facts
        .filter(Boolean)
        .map(
            (f) =>
                `<div class="mwi-ucard-fact mwi-ucard-t-${f.tone}"><span class="mwi-ucard-fl">${esc(f.label)}</span> ` +
                `<span class="mwi-ucard-fv">${f.html}</span></div>`
        )
        .join('');
    const explain = card.explain.length
        ? `<div class="mwi-ucard-explain"><div class="mwi-ucard-h">On this row</div>${card.explain
              .map(
                  (e) =>
                      `<p class="mwi-ucard-p">${e.label ? `<strong>${esc(e.label)}:</strong> ` : ''}${esc(e.text)}</p>`
              )
              .join('')}</div>`
        : '';
    const noteText = card.noteText ? `<p class="mwi-ucard-p mwi-ucard-t-warn">${esc(card.noteText)}</p>` : '';

    return (
        `<li class="mwi-ucard" data-card-id="${esc(card.id)}" data-card-state="${state.kind}"` +
        `${card.baseline ? ' data-card-baseline' : ''} data-open="${card.open ? 'true' : 'false'}">` +
        `<div class="mwi-ucard-top">` +
        (card.rank ? `<span class="mwi-ucard-rank">#${card.rank}</span>` : `<span class="mwi-ucard-rank">·</span>`) +
        `<span class="mwi-ucard-name">${card.nameHtml || esc(card.name)}${card.notesHtml}</span>${gain}</div>` +
        lines +
        `<div class="mwi-ucard-foot">` +
        `<span class="mwi-ucard-state mwi-ucard-t-${state.tone}" data-card-state-label>${esc(state.label)}</span>` +
        `${card.verdictHtml}` +
        `<button type="button" class="mwi-ucard-details" data-card-details="${esc(card.id)}" ` +
        `aria-expanded="${card.open ? 'true' : 'false'}" aria-controls="${detailId}">Details ${card.open ? '▴' : '▾'}</button>` +
        `<span class="mwi-ucard-spacer"></span>${verifyButton}</div>` +
        (verify.reason ? `<div class="mwi-ucard-why" data-card-why>${esc(verify.reason)}</div>` : '') +
        `<div class="mwi-ucard-detail" id="${detailId}"${card.open ? '' : ' hidden'}>` +
        `${noteText}${facts}${card.detailHtml}${card.actionsHtml ? `<div class="mwi-ucard-actions">${card.actionsHtml}</div>` : ''}` +
        `${explain}</div></li>`
    );
}

/**
 * The one disclosure per section that holds the meanings every card shares.
 * @param {string} section - Section id
 * @param {Array<{label: string, text: string}>} glossary - From {@link buildUpgradeCards}
 * @param {boolean} open - Whether it is open
 * @returns {string} HTML
 */
function glossaryHtml(section, glossary, open) {
    const id = `mwi-ucards-gloss-${esc(section)}`;
    return (
        `<div class="mwi-ucards-gloss">` +
        `<button type="button" class="mwi-ucards-btn mwi-ucards-gloss-btn" data-card-glossary="${esc(section)}" ` +
        `aria-expanded="${open ? 'true' : 'false'}" aria-controls="${id}">What the columns mean ${open ? '▾' : '▸'}</button>` +
        `<div class="mwi-ucards-gloss-body" id="${id}"${open ? '' : ' hidden'}>` +
        glossary
            .map(
                (e) => `<p class="mwi-ucard-p">${e.label ? `<strong>${esc(e.label)}:</strong> ` : ''}${esc(e.text)}</p>`
            )
            .join('') +
        `</div></div>`
    );
}

/**
 * The cards of one section, with its Rank by and Show all controls.
 * @param {ReturnType<typeof buildUpgradeCards>} model - From {@link buildUpgradeCards}
 * @param {Object} [options]
 * @param {{options: Array<{key: string, label: string}>, selected: string}|null} [options.rankBy] - The section's sort keys
 * @param {boolean} [options.worstFirst] - The sort is currently reversed (a header click on the table)
 * @param {string} [options.emptyText] - Said when there is nothing to show
 * @param {boolean} [options.toggle] - Draw the Show all button (a section with its own leaves it out)
 * @param {boolean} [options.glossaryOpen] - The "What the columns mean" disclosure is open
 * @returns {string} HTML
 */
export function upgradeCardsHtml(
    model,
    {
        rankBy = null,
        worstFirst = false,
        emptyText = 'Nothing to show.',
        toggle: withToggle = true,
        glossaryOpen = false,
    } = {}
) {
    const section = esc(model.section);
    let bar = '';
    if (rankBy) {
        bar +=
            `<label class="mwi-ucards-rank">Rank by ` +
            `<select class="toolasha-select" data-card-rank="${section}" aria-label="Rank by">` +
            rankBy.options
                .map(
                    (o) =>
                        `<option value="${esc(o.key)}"${o.key === rankBy.selected ? ' selected' : ''}>${esc(o.label)}</option>`
                )
                .join('') +
            `</select></label>`;
    }
    if (worstFirst) {
        bar += `<button type="button" class="mwi-ucards-btn" data-card-best-first="${section}">Showing worst first — show best first</button>`;
    }
    if (model.total) {
        bar += `<span class="mwi-ucards-count">${
            model.showAll || !model.canToggle ? `All ${model.total}` : `Top ${model.shown} of ${model.total}`
        }${model.folded && !model.showAll ? `, ${model.folded} folded` : ''}</span>`;
    }
    const glossary = model.glossary?.length ? glossaryHtml(model.section, model.glossary, glossaryOpen) : '';
    const body = model.cards.length
        ? `<ol class="mwi-ucard-list">${model.cards.map((c, i) => cardHtml(c, model.section, i)).join('')}</ol>`
        : `<div class="mwi-ucards-empty">${esc(emptyText)}</div>`;
    const toggle =
        model.canToggle && withToggle
            ? `<button type="button" class="mwi-ucards-btn" data-card-showall="${section}" aria-pressed="${model.showAll}">${
                  model.showAll ? `Show top ${model.top}` : `Show all ${model.total}`
              }</button>`
            : '';
    return `<div class="mwi-ucards" data-upgrade-cards="${section}">${bar ? `<div class="mwi-ucards-bar">${bar}</div>` : ''}${glossary}${body}${toggle}</div>`;
}

/**
 * The Cards | Table switch.
 * @param {'cards'|'table'} view - The view drawn now
 * @param {boolean} narrow - Phone width: the table side reads "Full table"
 * @returns {string} HTML
 */
export function viewSwitchHtml(view, narrow) {
    const button = (key, label) =>
        `<button type="button" class="mwi-ucards-btn" data-card-view="${key}" aria-pressed="${view === key}">${label}</button>`;
    return (
        `<div class="mwi-ucards-switch" role="group" aria-label="Results view">` +
        `${button('cards', 'Cards')}${button('table', narrow ? 'Full table' : 'Table')}</div>`
    );
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

/**
 * Wire the cards under `root`. The elements are replaced on every redraw, so their listeners go with them.
 * @param {Element} root - The results container
 * @param {Object} handlers
 * @param {(id: string, open: boolean) => void} handlers.onToggle - Details opened or closed
 * @param {(id: string) => (boolean|void)} handlers.onVerify - Verify pressed; false when nothing started
 * @param {(section: string) => void} handlers.onShowAll - Show all / Show top pressed
 * @param {(section: string, key: string) => void} handlers.onRank - Rank by changed
 * @param {(section: string) => void} handlers.onBestFirst - Reversed sort put right
 * @param {(section: string, open: boolean) => void} [handlers.onGlossary] - "What the columns mean" opened or closed
 */
export function wireUpgradeCards(root, { onToggle, onVerify, onShowAll, onRank, onBestFirst, onGlossary = () => {} }) {
    root.querySelectorAll('[data-card-details]').forEach((button) => {
        button.addEventListener('click', () => {
            const id = button.getAttribute('data-card-details');
            const open = button.getAttribute('aria-expanded') !== 'true';
            button.setAttribute('aria-expanded', String(open));
            button.textContent = `Details ${open ? '▴' : '▾'}`;
            const detail = root.ownerDocument.getElementById(button.getAttribute('aria-controls'));
            if (detail) detail.hidden = !open;
            button.closest('.mwi-ucard')?.setAttribute('data-open', String(open));
            onToggle(id, open);
        });
    });
    root.querySelectorAll('[data-card-glossary]').forEach((button) => {
        button.addEventListener('click', () => {
            const open = button.getAttribute('aria-expanded') !== 'true';
            button.setAttribute('aria-expanded', String(open));
            button.textContent = `What the columns mean ${open ? '▾' : '▸'}`;
            const body = root.ownerDocument.getElementById(button.getAttribute('aria-controls'));
            if (body) body.hidden = !open;
            onGlossary(button.getAttribute('data-card-glossary'), open);
        });
    });
    root.querySelectorAll('[data-card-verify]').forEach((button) => {
        button.addEventListener('click', () => {
            if (button.disabled) return;
            // Disabled at once: a second tap before the redraw cannot start a second run. A handler that
            // refuses (another run is busy) returns false and the button is given back
            button.disabled = true;
            if (onVerify(button.getAttribute('data-card-verify')) === false) button.disabled = false;
        });
    });
    root.querySelectorAll('[data-card-showall]').forEach((button) => {
        button.addEventListener('click', () => onShowAll(button.getAttribute('data-card-showall')));
    });
    root.querySelectorAll('[data-card-best-first]').forEach((button) => {
        button.addEventListener('click', () => onBestFirst(button.getAttribute('data-card-best-first')));
    });
    root.querySelectorAll('[data-card-rank]').forEach((select) => {
        select.addEventListener('change', () => onRank(select.getAttribute('data-card-rank'), select.value));
    });
}

/**
 * Wire the Cards | Table switch.
 * @param {Element} root - The results container
 * @param {(view: string) => void} onView - A view was picked
 */
export function wireViewSwitch(root, onView) {
    root.querySelectorAll('[data-card-view]').forEach((button) => {
        button.addEventListener('click', () => onView(button.getAttribute('data-card-view')));
    });
}

// ---------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------

export const UPGRADE_CARD_STYLE_ID = 'mwi-upgrade-cards';

/** The stylesheet. Exported so a test can read the rules without a layout engine. */
export const UPGRADE_CARD_CSS = `
    .mwi-ucards-switch { display: inline-flex; margin: 0 0 6px; border: 1px solid ${GAME_COLORS.border}; border-radius: 4px; overflow: hidden; }
    .mwi-ucards-switch .mwi-ucards-btn { border: 0; border-radius: 0; margin: 0; }
    .mwi-ucards-btn { background: ${GAME_COLORS.raised}; color: #8ab4f8; border: 1px solid ${GAME_COLORS.border}; border-radius: 3px;
        padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }
    .mwi-ucards-btn[aria-pressed="true"] { background: ${GAME_COLORS.raisedMore}; color: ${GAME_COLORS.text}; font-weight: 600; }
    .mwi-ucards { margin: 4px 0 6px; min-width: 0; max-width: 100%; }
    .mwi-ucards-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 6px; font-size: 11px; color: ${GAME_COLORS.textDim}; }
    .mwi-ucards-rank select {
        max-width: 100%; background: ${GAME_COLORS.inputBackground}; color: #e0e0e0;
        border: 1px solid ${GAME_COLORS.inputBorder}; border-radius: 3px; padding: 1px 4px;
        font-size: 11px; font-family: inherit;
    }
    .mwi-ucards-empty { color: #888; padding: 10px 0; font-size: 11px; }
    .mwi-ucard-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .mwi-ucard { min-width: 0; box-sizing: border-box; padding: 7px 9px; background: ${GAME_COLORS.raised};
        border: 1px solid ${GAME_COLORS.border}; border-radius: 6px; font-size: 11px; color: #e0e0e0; }
    .mwi-ucard[data-card-baseline] { background: rgba(120,150,190,0.08); }
    .mwi-ucard-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
    .mwi-ucard-rank { color: ${GAME_COLORS.textDim}; font-weight: 600; flex: 0 0 auto; }
    .mwi-ucard-name { flex: 1 1 9em; min-width: 0; overflow-wrap: anywhere; font-weight: 600; font-size: 12px; }
    .mwi-ucard-gain { flex: 0 1 auto; margin-left: auto; text-align: right; overflow-wrap: anywhere; font-size: 12px; }
    .mwi-ucard-within { color: #c9a227; font-size: 10px; }
    .mwi-ucard-line { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 3px; }
    .mwi-ucard-fig { overflow-wrap: anywhere; min-width: 0; }
    .mwi-ucard-fl { color: ${GAME_COLORS.textDim}; font-size: 10px; }
    .mwi-ucard-t-good { color: ${GAME_COLORS.good}; }
    .mwi-ucard-t-bad { color: ${GAME_COLORS.bad}; }
    .mwi-ucard-t-warn { color: #ff9800; }
    .mwi-ucard-t-muted { color: ${GAME_COLORS.textDim}; }
    .mwi-ucard-t-neutral { color: #e0e0e0; }
    .mwi-ucard-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 6px; }
    .mwi-ucard-spacer { flex: 1 1 auto; }
    .mwi-ucard-state { font-size: 10px; font-weight: 600; }
    .mwi-ucard-details, .mwi-ucard-verify { font-family: inherit; font-size: 11px; cursor: pointer; border-radius: 3px; padding: 3px 10px; }
    .mwi-ucard-details { background: transparent; color: #8ab4f8; border: 1px solid transparent; }
    .mwi-ucard-verify { background: rgba(74,158,255,0.2); border: 1px solid rgba(74,158,255,0.4); color: #4a9eff; font-weight: 600; }
    .mwi-ucard-verify[disabled] { opacity: 0.5; cursor: default; }
    .mwi-ucard-why { margin-top: 3px; font-size: 10px; color: ${GAME_COLORS.textDim}; text-align: right; }
    .mwi-ucard-detail { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #333; overflow-wrap: anywhere; }
    .mwi-ucard-detail[hidden] { display: none; }
    .mwi-ucard-detail > div { min-width: 0; }
    .mwi-ucard-fact { margin: 2px 0; }
    .mwi-ucard-h { color: #888; font-weight: 600; margin: 6px 0 2px; }
    .mwi-ucards-gloss { margin: 0 0 6px; }
    .mwi-ucards-gloss-body { margin-top: 4px; padding: 4px 8px; background: ${GAME_COLORS.raised}; border: 1px solid ${GAME_COLORS.border}; border-radius: 4px; }
    .mwi-ucards-gloss-body[hidden] { display: none; }
    .mwi-ucard-p { margin: 2px 0; color: #aaa; font-size: 10px; line-height: 1.4; white-space: pre-line; }
    .mwi-ucard-actions { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    .mwi-ucard-actions button { margin-left: 0 !important; }
    /* A touch screen needs a real target; a mouse does not get oversized buttons */
    @media (pointer: coarse) {
        .mwi-ucard-details, .mwi-ucard-verify, .mwi-ucards-btn, .mwi-ucard-actions button {
            min-height: 34px; min-width: 44px;
        }
        .mwi-ucards-rank select { min-height: 28px; }
        .mwi-ucard-details, .mwi-ucard-verify, .mwi-ucards-btn { padding-left: 12px; padding-right: 12px; }
    }
`;
