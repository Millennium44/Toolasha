import { describe, test, expect } from 'vitest';
import {
    UPGRADE_CARD_CSS,
    UPGRADE_CARD_TOP,
    UNKNOWN_TEXT,
    WITHIN_NOISE_TEXT,
    buildUpgradeCards,
    cardStateOf,
    figure,
    liftTitles,
    normalizeViewChoices,
    resolveCardView,
    signTone,
    upgradeCardsHtml,
    valueOrUnknown,
    viewSwitchHtml,
    withViewChoice,
} from './upgrade-cards.js';

const entry = (name, extra = {}) => ({
    row: { name },
    key: name,
    name,
    headline: figure('Score', '90', 'neutral'),
    ...extra,
});

describe('the card / table choice', () => {
    test('nothing picked: a wide window gets the table and a phone gets cards', () => {
        const none = normalizeViewChoices(undefined);
        expect(none).toEqual({ wide: null, narrow: null });
        expect(resolveCardView(none, false)).toBe('table');
        expect(resolveCardView(none, true)).toBe('cards');
    });

    test('a pick is kept for its own form factor only', () => {
        const onPhone = withViewChoice(normalizeViewChoices(null), true, 'table');
        expect(onPhone).toEqual({ wide: null, narrow: 'table' });
        expect(resolveCardView(onPhone, true)).toBe('table');
        // The desktop sharing the record still gets its own default
        expect(resolveCardView(onPhone, false)).toBe('table');
        const onDesktop = withViewChoice(onPhone, false, 'cards');
        expect(onDesktop).toEqual({ wide: 'cards', narrow: 'table' });
        expect(resolveCardView(onDesktop, false)).toBe('cards');
    });

    test('garbage in a stored record is ignored', () => {
        expect(normalizeViewChoices({ wide: 'grid', narrow: 7 })).toEqual({ wide: null, narrow: null });
        expect(normalizeViewChoices('cards')).toEqual({ wide: null, narrow: null });
        expect(withViewChoice({ wide: 'cards', narrow: null }, true, 'grid')).toEqual({ wide: 'cards', narrow: null });
    });

    test('the table side of the switch reads Full table on a phone', () => {
        expect(viewSwitchHtml('cards', true)).toContain('Full table');
        expect(viewSwitchHtml('cards', false)).not.toContain('Full table');
        expect(viewSwitchHtml('table', false)).toContain('data-card-view="table" aria-pressed="true"');
    });
});

describe('unknown is never zero', () => {
    test('a missing figure reads as unknown', () => {
        const fmt = (v) => `${v}M`;
        expect(valueOrUnknown(null, fmt)).toBe(UNKNOWN_TEXT);
        expect(valueOrUnknown(undefined, fmt)).toBe(UNKNOWN_TEXT);
        expect(valueOrUnknown(NaN, fmt)).toBe(UNKNOWN_TEXT);
        expect(valueOrUnknown(Infinity, fmt)).toBe(UNKNOWN_TEXT);
        expect(valueOrUnknown(0, fmt)).toBe('0M');
    });

    test('a zero change is neutral, a negative one red, a death increase red', () => {
        expect(signTone(0)).toBe('neutral');
        expect(signTone(NaN)).toBe('neutral');
        expect(signTone(-2)).toBe('bad');
        expect(signTone(2)).toBe('good');
        expect(signTone(2, { lowerIsBetter: true })).toBe('bad');
        expect(signTone(-2, { lowerIsBetter: true })).toBe('good');
    });
});

describe('liftTitles', () => {
    test('takes every tooltip out and hands the sentence back with the words it sat on', () => {
        const out = liftTitles(
            '<span style="color:red;" title="Cost of one 0.01% DPS &quot;step&quot;.">12M</span> and ' +
                '<button type="button" title="Add to the watchlist">Watch</button>'
        );
        expect(out.html).not.toContain('title=');
        expect(out.html).toContain('>12M</span>');
        expect(out.titles).toEqual([
            { label: '12M', text: 'Cost of one 0.01% DPS "step".' },
            { label: 'Watch', text: 'Add to the watchlist' },
        ]);
    });

    test('keeps the markup whole when a tooltip sits on an element holding another', () => {
        const html = '<span title="outer">a <span title="inner">b</span></span>';
        const out = liftTitles(html);
        expect(out.html).not.toContain('title=');
        expect(out.titles.map((t) => t.text).sort()).toEqual(['inner', 'outer']);
    });

    test('a tooltip with a line break survives intact', () => {
        const out = liftTitles('<span title="line one\nline two">x</span>');
        expect(out.titles[0].text).toBe('line one\nline two');
    });
});

describe('cardStateOf', () => {
    test('says in words which of the states a card is in', () => {
        expect(cardStateOf({}).label).toBe('Estimate');
        expect(cardStateOf({ remembered: true }).label).toBe('Remembered estimate');
        expect(cardStateOf({ unpriced: true }).label).toBe('Estimate, not priced');
        expect(cardStateOf({ baseline: true }).kind).toBe('baseline');
        expect(cardStateOf({ pending: true, verdict: { verdict: 'confirmed' } }).kind).toBe('pending');
        expect(cardStateOf({ verdict: { verdict: 'confirmed', mean: 5 } }).label).toBe('Verified');
        expect(cardStateOf({ verdict: { verdict: 'worse', mean: -5 } }).tone).toBe('bad');
        expect(cardStateOf({ verdict: { verdict: 'not-confirmed', mean: 1 } }).label).toBe('Verified: not confirmed');
        expect(cardStateOf({ verdict: { verdict: 'error' } }).label).toBe('Verify failed');
        expect(cardStateOf({ verdict: { verdict: 'not-confirmed', stopped: true } }).label).toBe('Verify stopped');
        expect(cardStateOf({ verdict: { verdict: 'not-confirmed', profitLeftOut: true, mean: null } }).kind).toBe(
            'unvalued'
        );
        expect(cardStateOf({ note: { kind: 'stopped' } }).label).toBe('Verify stopped');
        expect(cardStateOf({ note: { kind: 'failed' } }).label).toBe('Verify failed');
        expect(cardStateOf({ note: { kind: 'refused' } }).label).toBe('Not verified');
    });

    test('a verdict outranks a remembered estimate, and a running verify outranks both', () => {
        expect(cardStateOf({ remembered: true, verdict: { verdict: 'confirmed', mean: 1 } }).kind).toBe('confirmed');
        expect(cardStateOf({ remembered: true, pending: true }).kind).toBe('pending');
    });
});

describe('buildUpgradeCards', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => entry(`Item ${i + 1}`));

    test('card N is entry N: order is never touched, ranks follow it', () => {
        const model = buildUpgradeCards({ section: 'gold', entries: [entry('Z last name'), entry('A first name')] });
        expect(model.cards.map((c) => c.name)).toEqual(['Z last name', 'A first name']);
        expect(model.cards.map((c) => c.rank)).toEqual([1, 2]);
    });

    test('shows the top few and everything with Show all, the baseline always', () => {
        const late = Array.from({ length: 7 }, (_, i) => entry(`Late ${i + 1}`));
        const entries = [...many(3), entry('Current', { baseline: true }), ...late];
        const top = buildUpgradeCards({ section: 'order', entries, top: 4 });
        // 4 ranked cards and the baseline
        expect(top.cards.filter((c) => !c.baseline)).toHaveLength(4);
        expect(top.cards.some((c) => c.baseline)).toBe(true);
        expect(top.total).toBe(10);
        expect(top.canToggle).toBe(true);
        const all = buildUpgradeCards({ section: 'order', entries, top: 4, showAll: true });
        expect(all.cards).toHaveLength(11);
        // The baseline does not take a rank, and does not use up the top
        expect(all.cards.find((c) => c.baseline).rank).toBeNull();
        expect(all.cards.filter((c) => !c.baseline).map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test('exactly the top count means nothing to expand', () => {
        const model = buildUpgradeCards({ section: 'gold', entries: many(UPGRADE_CARD_TOP) });
        expect(model.canToggle).toBe(false);
        expect(upgradeCardsHtml(model)).not.toContain('data-card-showall');
        const one = buildUpgradeCards({ section: 'gold', entries: many(1) });
        expect(one.cards).toHaveLength(1);
        expect(upgradeCardsHtml(one)).not.toContain('data-card-showall');
    });

    test('two identical candidates stay two cards with their own ids', () => {
        const model = buildUpgradeCards({
            section: 'gold',
            entries: [entry('Ring +3'), entry('Ring +3'), entry('Ring +3')],
            open: new Set(['gold:Ring +3#1']),
        });
        const ids = model.cards.map((c) => c.id);
        expect(new Set(ids).size).toBe(3);
        expect(model.cards.map((c) => c.open)).toEqual([false, true, false]);
    });

    test('an empty result set draws the empty text and no controls', () => {
        const model = buildUpgradeCards({ section: 'gold', entries: [] });
        const html = upgradeCardsHtml(model, { emptyText: 'No upgrades to show.' });
        expect(html).toContain('No upgrades to show.');
        expect(html).not.toContain('<li');
        expect(html).not.toContain('data-card-showall');
    });

    test('every tooltip is moved into the Details and the card carries none', () => {
        const model = buildUpgradeCards({
            section: 'gold',
            entries: [
                entry('Ring', {
                    headline: figure(
                        'Cost',
                        '<span title="Pays for itself.">+4M</span>',
                        'good',
                        'What the upgrade nets out at.'
                    ),
                    lines: [[figure('Time', '3h', 'neutral', 'Hours to afford.')]],
                    notesHtml: '<span title="Cost assumes a fresh book.">fresh book</span>',
                    detailHtml: '<span title="Counted as free.">ceiling</span>',
                    actionsHtml:
                        '<button type="button" title="Opens the marketplace with a tab for each">Market</button>',
                    verdictHtml: '<span title="Re-measured on fresh seeds: +1">✓ confirmed</span>',
                }),
            ],
        });
        const html = upgradeCardsHtml(model);
        expect(html).not.toMatch(/title="/);
        const text = model.cards[0].explain.map((e) => e.text);
        expect(text).toEqual(
            expect.arrayContaining([
                'Pays for itself.',
                'What the upgrade nets out at.',
                'Hours to afford.',
                'Cost assumes a fresh book.',
                'Counted as free.',
                'Opens the marketplace with a tab for each',
                'Re-measured on fresh seeds: +1',
            ])
        );
        // ...and they are printed in the Details
        expect(html).toContain('Pays for itself.');
    });

    test('a gain inside the noise is labelled and explained', () => {
        const model = buildUpgradeCards({ section: 'gold', entries: [entry('Ring', { within: true })] });
        const html = upgradeCardsHtml(model);
        expect(html).toContain('within noise');
        expect(html).toContain(WITHIN_NOISE_TEXT);
    });

    test('Verify is offered, enabled only when it can run, and reads Verify again after a verdict', () => {
        const base = { offerVerify: true, canVerify: true, verifyLabel: 'Profit/hr' };
        const fresh = buildUpgradeCards({ section: 'gold', entries: [entry('A', base)] }).cards[0];
        expect(fresh.verify).toMatchObject({ offered: true, enabled: true, again: false, reason: '' });
        const verified = buildUpgradeCards({
            section: 'gold',
            entries: [entry('A', { ...base, verdict: { verdict: 'confirmed', mean: 1 } })],
        }).cards[0];
        expect(verified.verify.again).toBe(true);
        const remembered = buildUpgradeCards({
            section: 'gold',
            entries: [entry('A', { ...base, canVerify: false })],
            remembered: true,
        }).cards[0];
        expect(remembered.verify.enabled).toBe(false);
        expect(remembered.verify.reason).toBe('Re-run the analysis to verify.');
        expect(remembered.state.label).toBe('Remembered estimate');
        const running = buildUpgradeCards({ section: 'gold', entries: [entry('A', { ...base, pending: true })] })
            .cards[0];
        expect(running.verify.enabled).toBe(false);
        expect(running.state.label).toBe('Verifying…');
        const none = buildUpgradeCards({ section: 'levels', entries: [entry('A', { offerVerify: false })] }).cards[0];
        expect(none.verify.offered).toBe(false);
        expect(
            upgradeCardsHtml({ section: 'levels', cards: [none], total: 1, shown: 1, canToggle: false })
        ).not.toContain('data-card-verify');
        // the baseline is never verified
        const baseline = buildUpgradeCards({
            section: 'order',
            entries: [entry('Current', { ...base, baseline: true })],
        }).cards[0];
        expect(baseline.verify.offered).toBe(false);
    });
});

describe('the markup', () => {
    const model = buildUpgradeCards({
        section: 'gold',
        entries: [
            entry('A very long item name that would run off a narrow screen "quoted" <b>&</b> and keep going', {
                offerVerify: true,
                canVerify: true,
                verifyLabel: 'Profit/hr',
                detailHtml: '<div>detail</div>',
            }),
        ],
        open: new Set(),
    });
    const html = upgradeCardsHtml(model, {
        rankBy: { options: [{ key: 'score', label: 'Score' }], selected: 'score' },
    });

    test('Details is a real button with aria-expanded and aria-controls pointing at a hidden region', () => {
        expect(html).toMatch(
            /<button type="button" class="mwi-ucard-details"[^>]*aria-expanded="false"[^>]*aria-controls="mwi-ucard-detail-gold-0"/
        );
        expect(html).toMatch(/id="mwi-ucard-detail-gold-0" hidden/);
    });

    test('Verify has an accessible name that says which candidate and what it measures', () => {
        expect(html).toMatch(/data-card-verify="[^"]*" aria-label="Verify: A very long item name[^"]*by Profit\/hr"/);
    });

    test('a name is escaped, never injected', () => {
        expect(html).not.toContain('<b>&</b>');
        expect(html).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    });

    test('nothing is hover-only', () => {
        expect(html).not.toMatch(/\stitle=/);
    });

    test('the stylesheet wraps long names and sizes touch targets only for a coarse pointer', () => {
        expect(UPGRADE_CARD_CSS).toMatch(/\.mwi-ucard-name \{[^}]*overflow-wrap: anywhere/);
        const coarse = UPGRADE_CARD_CSS.slice(UPGRADE_CARD_CSS.indexOf('@media (pointer: coarse)'));
        expect(coarse).toMatch(/\.mwi-ucard-verify/);
        expect(coarse).toMatch(/\.mwi-ucard-details/);
        expect(coarse).toMatch(/min-height: 34px/);
        // The base rules are small; the 34px rule is not applied outside the media query
        const base = UPGRADE_CARD_CSS.slice(0, UPGRADE_CARD_CSS.indexOf('@media (pointer: coarse)'));
        expect(base).not.toMatch(/34px/);
        expect(UPGRADE_CARD_CSS).toMatch(/\.mwi-ucard-foot \{[^}]*flex-wrap: wrap/);
    });
});
