/**
 * Give an injected toolbar its own flow row when the content panel is narrow.
 * The native panel, its tabs, and its scroll container are never restyled.
 * Wide layouts retain their original parent and inline geometry.
 *
 * @param {HTMLElement} element - Toolasha-owned toolbar, already mounted
 * @param {Object} options - Narrow placement and measured content area
 * @param {HTMLElement} options.host - Parent of the narrow flow row
 * @param {Node|null} [options.before] - Insert before this sibling
 * @param {HTMLElement} [options.measure] - Content panel whose width decides
 * @param {number} [options.breakpoint] - Maximum narrow content width
 * @param {Function} [options.onChange] - Called with the narrow state
 * @returns {Function} Disconnect observers and restore the wide placement
 */
export function dockWhenNarrow(
    element,
    { host, before = null, measure = host, breakpoint = 640, onChange = () => {} }
) {
    if (!host || !measure || !element.parentNode) return () => {};
    const home = document.createComment('Toolasha toolbar position');
    element.before(home);
    const properties = [
        'position',
        'top',
        'right',
        'bottom',
        'left',
        'width',
        'maxWidth',
        'minWidth',
        'margin',
        'zIndex',
    ];
    let original = null;
    let narrow = false;
    let stopped = false;

    const restore = () => {
        if (!original) return;
        for (const property of properties) element.style[property] = original[property];
        original = null;
        delete element.dataset.toolashaDocked;
        if (element.isConnected && home.parentNode) home.after(element);
        onChange(false);
    };
    const update = () => {
        if (stopped || !element.isConnected || !host.isConnected) return;
        const width = measure.getBoundingClientRect().width;
        // Hidden panels and not-yet-laid-out nodes must not erase saved geometry.
        if (!(width > 0)) return;
        const next = width <= breakpoint;
        if (next === narrow) return;
        narrow = next;
        if (!narrow) {
            restore();
            return;
        }
        original = Object.fromEntries(properties.map((property) => [property, element.style[property]]));
        element.dataset.toolashaDocked = 'true';
        Object.assign(element.style, {
            position: 'relative',
            zIndex: 'auto',
            top: 'auto',
            right: 'auto',
            bottom: 'auto',
            left: 'auto',
            width: '100%',
            maxWidth: '100%',
            minWidth: '0',
            margin: '6px 0',
        });
        host.insertBefore(element, before?.parentNode === host ? before : null);
        onChange(true);
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(measure);
    window.addEventListener('resize', update);
    update();
    return () => {
        stopped = true;
        observer?.disconnect();
        window.removeEventListener('resize', update);
        restore();
        home.remove();
    };
}

/**
 * Keep a horizontal scroller's right edge on screen. On a phone the game's middle panel keeps a
 * 315px minimum width beside the icon sidebar, so on a ~412px screen it overhangs the viewport and
 * the page itself cannot pan; a tab strip as wide as the panel then scrolls short of its last tab.
 * Capping the scroller at the visible edge moves the overhang into its own scroll range.
 * @param {HTMLElement} scroller - The element with overflow-x: auto
 * @param {boolean} on - Cap it (narrow) or clear the cap (wide, released)
 */
export function capToViewport(scroller, on) {
    if (!scroller?.style) return;
    // Measure uncapped, so a screen that grew (rotation) releases an old cap
    scroller.style.removeProperty('max-width');
    if (!on) return;
    const viewportWidth = window.visualViewport?.width || window.innerWidth || 0;
    const rect = scroller.getBoundingClientRect();
    const visible = Math.floor(viewportWidth - rect.left);
    if (visible > 0 && rect.right > viewportWidth) {
        scroller.style.setProperty('max-width', `${visible}px`, 'important');
    }
}
