/**
 * Readers for the game's marketplace order modal (Buy Now, New Buy Listing, and their sell twins).
 *
 * Pure DOM reads, kept out of the market bundle so the UI bundle can check what a modal is about
 * before it presses anything in it. Nothing here clicks, and nothing here imports a module another
 * test file mocks. The Bulk Sell Assistant keeps its own copies of the item and level readers; the
 * rules are the same ones.
 */

/** The selector the game's modal container is found by */
export const MODAL_SELECTOR = '[class*="Modal_modalContainer"]';

/**
 * Whether the game has disabled a button. A press through the React handler does not look at
 * `disabled`, so every press has to.
 * @param {HTMLButtonElement} button - The button
 * @returns {boolean}
 */
export function isButtonDisabled(button) {
    return !!(
        button.disabled ||
        button.hasAttribute?.('disabled') ||
        button.getAttribute?.('aria-disabled') === 'true'
    );
}

/**
 * The item a marketplace modal is about, from its icon.
 * @param {Element} modal - The modal container
 * @returns {string|null} Item hrid, or null when the icon can't be read
 */
export function modalItemHrid(modal) {
    let href = '';
    for (const use of modal.querySelectorAll('svg use')) {
        href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        if (href) break;
    }
    const slug = href.match(/#(.+)$/)?.[1];
    return slug ? `/items/${slug}` : null;
}

/**
 * The enhancement level the modal is set to, or null when it has no such field (an unenhanceable
 * item's modal looks like that).
 * @param {Element} modal - The modal container
 * @returns {number|null}
 */
export function modalEnhancementLevel(modal) {
    const inputs = Array.from(modal.querySelectorAll('input'));
    for (let level = 0; level < 4; level++) {
        for (const input of inputs) {
            let parent = input.parentElement;
            for (let step = 0; step < level && parent; step++) parent = parent.parentElement;
            if (!parent) continue;
            const text = parent.textContent || '';
            if (text.includes('Enhancement Level') && !text.includes('Quantity')) {
                return parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10) || 0;
            }
        }
    }
    return null;
}

/**
 * The quantity input, identified positively: the game's quantity row, a modal with exactly one
 * input, or the input whose container says Quantity and not Enhancement Level. Never a guess.
 * @param {Element} modal - The modal container
 * @returns {HTMLInputElement|null}
 */
export function modalQuantityInput(modal) {
    const rowInput = modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input');
    if (rowInput) return rowInput;
    const inputs = Array.from(modal.querySelectorAll('input'));
    if (inputs.length === 0) return null;
    if (inputs.length === 1) return inputs[0];
    for (let level = 0; level < 4; level++) {
        for (const input of inputs) {
            let parent = input.parentElement;
            for (let step = 0; step < level && parent; step++) parent = parent.parentElement;
            if (!parent) continue;
            const text = parent.textContent || '';
            if (text.includes('Quantity') && !text.includes('Enhancement Level')) return input;
        }
    }
    return null;
}

/**
 * The quantity typed into the modal.
 * @param {Element} modal - The modal container
 * @returns {number|null} Null when the field can't be found or read
 */
export function modalQuantity(modal) {
    const input = modalQuantityInput(modal);
    if (!input) return null;
    const value = parseInt(String(input.value).replace(/[^0-9-]/g, ''), 10);
    return Number.isFinite(value) ? value : null;
}

/**
 * Which kind of buy form a modal is, from its header.
 * @param {Element} modal - The modal container
 * @returns {'instant'|'order'|null} Null when it is not a buy form (a sell form, or anything else)
 */
export function buyFormKind(modal) {
    const header = modal.querySelector('div[class*="MarketplacePanel_header"]')?.textContent || '';
    if (header.includes('Buy Now')) return 'instant';
    if (header.includes('Buy Listing')) return 'order';
    return null;
}

/**
 * What the game's own confirm button in a buy modal says. The game's string table defines the buy
 * strings `buyNow`, `postBuyOrder`, `buyListing` and `postBuyListing`; these are localized, so the
 * `Button_buy` class is tried first and a translated client that matches neither fails closed.
 */
const BUY_CONFIRM_LABELS = [
    'buy now',
    'post buy order',
    'post buy listing',
    'buy listing',
    'buy',
    'post',
    'post listing',
    'list',
    'confirm',
];

/**
 * The game's own confirming button inside a buy modal. Anything the script itself injected (`mwi-`
 * or `toolasha` classes) and the close button are excluded: pressing one of ours would be a
 * purchase nobody asked for.
 * @param {Element} modal - The modal container
 * @returns {HTMLButtonElement|null}
 */
export function findBuyConfirmButton(modal) {
    const candidates = Array.from(modal.querySelectorAll('button')).filter((btn) => {
        const cls = String(btn.className || '');
        return !cls.includes('Modal_closeButton') && !cls.includes('mwi-') && !cls.includes('toolasha');
    });
    return (
        candidates.find((btn) => String(btn.className || '').includes('Button_buy')) ||
        candidates.find((btn) => BUY_CONFIRM_LABELS.includes(btn.textContent.trim().toLowerCase())) ||
        null
    );
}

/**
 * Why an open modal is not the buy form for the given item, or null when it is. The one safety
 * check both the press and the watch use, so they judge a modal the same way.
 * @param {Element|null} modal - The open modal, if any
 * @param {string} itemHrid - The item the step queued
 * @param {string} [name] - Its display name, for the message
 * @returns {string|null}
 */
export function buyModalIdentityProblem(modal, itemHrid, name = '') {
    if (!modal) return 'the buy form is not open';
    if (!buyFormKind(modal)) return 'the open modal is not a buy form';
    const hrid = modalItemHrid(modal);
    if (!hrid) return 'the modal does not say what it is buying';
    if (hrid !== itemHrid) {
        return `the modal is buying ${hrid.split('/').pop().replace(/_/g, ' ')}, not ${name || itemHrid}`;
    }
    const level = modalEnhancementLevel(modal);
    // A consumable has no enhancement field; one that names a level other than +0 is not this step
    if (level !== null && level !== 0) return `the modal is buying +${level}, not +0`;
    return null;
}
