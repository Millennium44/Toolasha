/** @vitest-environment happy-dom
 *
 * Tests for when the sidebar's Marketplace badge is warranted, and what it says.
 *
 * The rule matters more than it looks: hide too much and uncollected coins sit
 * there silently, hide too little and the badge is back to firing on orders you
 * cannot do anything about.
 *
 * The count is written into the game's own badge rather than drawn over it, so
 * these build a sidebar to write into. A fake DOM is the only way to catch the
 * two things that went wrong there: the selector matching more than one element,
 * and the number landing somewhere that threw the badge's styling away.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ listings: null, styles: new Map() }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { register: () => () => {} } }));
// The badge and the "a listing finished" notification read the same count.
// These tests are about the badge, so the telling half is stubbed out — the
// alternative is a real toast for every listing this file invents.
vi.mock('../notifications/notification-service.js', () => ({ default: { notify: () => ({ fired: true }) } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.listings === null ? null : { myMarketListings: game.listings };
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/dom.js', () => ({
    addStyles: (css, id) => game.styles.set(id, css),
    removeStyles: (id) => game.styles.delete(id),
}));

const {
    isFinishedWithSpoils,
    anyFinished,
    countHolder,
    default: badgeFilter,
} = await import('./marketplace-badge-filter.js');

/**
 * The sidebar, as the game builds it.
 *
 * The Marketplace item carries a second badge-ish element beside its badge,
 * which is the shape the "2 2" bug needed: a selector matching the class name
 * as a prefix matches both, and the count was written into whichever came
 * first. The Tasks item is here because the sidebar has more than one nav item
 * and only one of them is ours.
 */
function buildSidebar() {
    document.body.innerHTML = `
        <div class="NavigationBar_nav__ab12">
            <svg aria-label="navigationBar.tasks"></svg>
            <div id="tasks-badge" class="NavigationBar_badge__3I_xZ">1</div>
        </div>
        <div class="NavigationBar_nav__ab12">
            <svg aria-label="navigationBar.marketplace"></svg>
            <div id="market-count" class="NavigationBar_badgeCount__xy99">3</div>
            <div id="market-badge" class="NavigationBar_badge__3I_xZ">7</div>
        </div>
    `;
}

/** The Marketplace badge the game drew */
const marketBadge = () => document.getElementById('market-badge');

const listing = (over = {}) => ({
    id: 1,
    status: '/market_listing_status/active',
    orderQuantity: 200,
    filledQuantity: 200,
    unclaimedItemCount: 200,
    unclaimedCoinCount: 0,
    ...over,
});

describe('isFinishedWithSpoils', () => {
    test('a fully filled order with something to collect warrants the badge', () => {
        expect(isFinishedWithSpoils(listing())).toBe(true);
    });

    test('a working order does not, however much it has taken', () => {
        // 30 of 200 bought and still buying — collecting the 30 achieves
        // nothing except silencing the badge until the next fill
        expect(isFinishedWithSpoils(listing({ filledQuantity: 30, unclaimedItemCount: 30 }))).toBe(false);
        expect(isFinishedWithSpoils(listing({ filledQuantity: 199, unclaimedItemCount: 199 }))).toBe(false);
    });

    test('a cancelled order is holding a refund and counts as finished', () => {
        const cancelled = listing({
            status: '/market_listing_status/cancelled',
            filledQuantity: 0,
            unclaimedItemCount: 0,
            unclaimedCoinCount: 500_000,
        });
        expect(isFinishedWithSpoils(cancelled)).toBe(true);
    });

    test('nothing to collect means nothing to say', () => {
        expect(isFinishedWithSpoils(listing({ unclaimedItemCount: 0, unclaimedCoinCount: 0 }))).toBe(false);
        expect(
            isFinishedWithSpoils(
                listing({
                    status: '/market_listing_status/cancelled',
                    unclaimedItemCount: 0,
                    unclaimedCoinCount: 0,
                })
            )
        ).toBe(false);
    });

    test('unclaimed coins count as well as items', () => {
        expect(isFinishedWithSpoils(listing({ unclaimedItemCount: 0, unclaimedCoinCount: 12 }))).toBe(true);
    });

    test('an order for nothing is not finished', () => {
        expect(isFinishedWithSpoils(listing({ orderQuantity: 0, filledQuantity: 0 }))).toBe(false);
    });

    test('says no rather than throwing on nonsense', () => {
        expect(isFinishedWithSpoils(null)).toBe(false);
        expect(isFinishedWithSpoils({})).toBe(false);
    });
});

describe('anyFinished', () => {
    test('one finished listing among many working ones is enough', () => {
        const listings = {
            1: listing({ id: 1, filledQuantity: 30, unclaimedItemCount: 30 }),
            2: listing({ id: 2, filledQuantity: 5, unclaimedItemCount: 5 }),
            3: listing({ id: 3 }),
        };
        expect(anyFinished(listings)).toBe(true);
    });

    test('all working means the badge stays down', () => {
        expect(
            anyFinished({
                1: listing({ id: 1, filledQuantity: 30, unclaimedItemCount: 30 }),
                2: listing({ id: 2, filledQuantity: 1, unclaimedItemCount: 1 }),
            })
        ).toBe(false);
    });

    test('an empty book badges nothing', () => {
        expect(anyFinished({})).toBe(false);
        expect(anyFinished(null)).toBe(false);
    });
});

describe('starting up with listings already on the books', () => {
    const css = () => game.styles.get('mwi-marketplace-badge-filter') || '';
    /** Whether the badge is currently being hidden outright */
    const hiding = () => css().includes(') { display: none');

    beforeEach(() => {
        game.styles.clear();
        game.listings = null;
        badgeFilter.disable();
        badgeFilter.lastSeen = null;
        buildSidebar();
    });

    test('a filled order sitting there through a reload still badges', () => {
        // The reported bug. Features are initialized from inside the
        // `character_initialized` handler, so subscribing to that event and
        // waiting is subscribing to something that has already happened — the
        // badge stayed hidden until an unrelated listing happened to change.
        game.listings = [listing()];

        badgeFilter.initialize();

        expect(hiding()).toBe(false);
    });

    test('and a book of working orders is still quietened at start-up', () => {
        game.listings = [listing({ filledQuantity: 30, unclaimedItemCount: 30 })];

        badgeFilter.initialize();

        expect(hiding()).toBe(true);
    });

    test('no character data yet hides, and says nothing it cannot know', () => {
        badgeFilter.initialize();

        expect(hiding()).toBe(true);
    });

    test('a later update is still followed', () => {
        game.listings = [listing({ filledQuantity: 30, unclaimedItemCount: 30 })];
        badgeFilter.initialize();
        expect(hiding()).toBe(true);

        game.listings = [listing()];
        badgeFilter.refresh();

        expect(hiding()).toBe(false);
    });

    test('a listing that leaves the book stops badging for it', () => {
        // Which a privately accumulated copy could not do: the listing would
        // linger at whatever state it was last seen in
        game.listings = [listing()];
        badgeFilter.initialize();
        expect(hiding()).toBe(false);

        game.listings = [];
        badgeFilter.refresh();

        expect(hiding()).toBe(true);
    });
});

describe('what number the badge shows', () => {
    const css = () => game.styles.get('mwi-marketplace-badge-filter') || '';
    const hiding = () => css().includes('display: none');

    beforeEach(() => {
        game.styles.clear();
        game.listings = null;
        badgeFilter.disable();
        badgeFilter.lastSeen = null;
        buildSidebar();
    });

    test('the finished ones, not everything collectable', () => {
        // The game's own badge said 2: a filled sell order and a buy order that
        // had taken 130 of 719. Collecting the 130 does nothing but silence it.
        game.listings = [
            listing({ id: 1, orderQuantity: 2, filledQuantity: 2, unclaimedItemCount: 0, unclaimedCoinCount: 1568000 }),
            listing({ id: 2, orderQuantity: 719, filledQuantity: 130, unclaimedCoinCount: 293020 }),
        ];

        badgeFilter.initialize();

        expect(marketBadge().textContent).toBe('1');
        expect(hiding()).toBe(false);
    });

    test('two finished say two', () => {
        game.listings = [listing({ id: 1 }), listing({ id: 2 })];
        badgeFilter.initialize();

        expect(marketBadge().textContent).toBe('2');
    });

    test('it is the game’s own badge, kept whole', () => {
        // Printing the count in a pseudo-element left a bare digit where a
        // styled badge should be — the point of writing the digits in place is
        // that everything around them is untouched
        game.listings = [listing()];
        const before = marketBadge();
        badgeFilter.initialize();

        expect(marketBadge()).toBe(before);
        expect(marketBadge().className).toBe('NavigationBar_badge__3I_xZ');
        expect(marketBadge().style.display).toBe('');
    });

    test('and nothing else in the sidebar is written into', () => {
        // The badge read "2 2" because `NavigationBar_badge` without the hash
        // separator also matched the element sitting beside it
        game.listings = [listing({ id: 1 }), listing({ id: 2 })];
        badgeFilter.initialize();

        expect(document.getElementById('market-count').textContent).toBe('3');
        expect(document.getElementById('tasks-badge').textContent).toBe('1');
    });

    test('React writing its own count back over ours is undone', () => {
        game.listings = [listing({ id: 1 }), listing({ id: 2 })];
        badgeFilter.initialize();
        expect(marketBadge().textContent).toBe('2');

        marketBadge().textContent = '5';
        badgeFilter._paint();

        expect(marketBadge().textContent).toBe('2');
    });

    test('the text watcher is scoped to the badge, and the badge is looked up once', () => {
        game.listings = [listing({ id: 1 })];
        badgeFilter.initialize();

        expect(badgeFilter.watchedHolder).toBe(marketBadge());
        const spy = vi.spyOn(document, 'querySelector');
        badgeFilter._paint();
        badgeFilter._attach();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();

        // A rebuilt sidebar item is found again
        const old = marketBadge();
        const fresh = old.cloneNode(true);
        old.replaceWith(fresh);
        badgeFilter._attach();
        expect(badgeFilter.badge).toBe(fresh);
        expect(badgeFilter.watchedHolder).toBe(fresh);
    });

    test('none finished hides it outright rather than showing a zero', () => {
        game.listings = [listing({ filledQuantity: 30, unclaimedItemCount: 30 })];
        badgeFilter.initialize();

        expect(hiding()).toBe(true);
        expect(css()).not.toContain('content:');
    });

    test('a sidebar that has not been drawn yet is not an error', () => {
        // The badge is React's, and at start-up it may not exist
        document.body.innerHTML = '';
        game.listings = [listing()];

        expect(() => badgeFilter.initialize()).not.toThrow();
    });
});

describe('where the number goes', () => {
    const badge = (html) => {
        const element = document.createElement('div');
        element.innerHTML = html;
        return element;
    };

    test('the badge itself, when it holds the digits directly', () => {
        const element = badge('2');
        expect(countHolder(element)).toBe(element);
    });

    test('a wrapping span, so its styling is not thrown away with the text', () => {
        const element = badge('<span class="inner">2</span>');
        expect(countHolder(element).className).toBe('inner');
    });

    test('but not past a fork, where "the same box drawn deeper" stops being true', () => {
        const element = badge('<span>2</span><span>!</span>');
        expect(countHolder(element)).toBe(element);
    });
});
