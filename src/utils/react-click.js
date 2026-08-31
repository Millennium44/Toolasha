/**
 * Click a game element the way the game's own React handler expects.
 *
 * Some of the game's clickable boxes — the small party cards in a guild
 * fight (`MiniUnit_clickable`) are the known case — do not respond to a
 * synthetic `element.click()` or to a dispatched pointer/mouse sequence; only
 * a trusted user click reaches their handler. The handler itself is an
 * ordinary React `onClick` prop, reachable through the fiber tree the root
 * container still exposes (the `__reactFiber$` keys on elements are gone
 * since the February 2026 update, the root container is not). So: find the
 * fiber whose `stateNode` is the element, walk up to the first `onClick`
 * prop, call it with a minimal event. `element.click()` is still tried first
 * for everything that does honour it.
 *
 * One call, one game action — this is the same single click a person would
 * make, made the way the game listens for it.
 */

/**
 * The React fiber rendered for an element, or null.
 * @param {Element} element - The element
 * @returns {Object|null}
 */
export function fiberFor(element) {
    if (!element || typeof document === 'undefined') return null;
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;
    const stack = [rootFiber];
    let guard = 0;
    while (stack.length && guard++ < 500000) {
        const fiber = stack.pop();
        if (!fiber) continue;
        if (fiber.stateNode === element) return fiber;
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
    }
    return null;
}

/**
 * The nearest React `onClick` prop at or above an element's fiber.
 * @param {Element} element - The element
 * @param {number} [maxHops=4] - How far up the fiber tree to look
 * @returns {Function|null}
 */
export function reactClickHandlerFor(element, maxHops = 4) {
    let fiber = fiberFor(element);
    for (let hops = 0; fiber && hops <= maxHops; hops++, fiber = fiber.return) {
        const onClick = fiber.memoizedProps?.onClick;
        if (typeof onClick === 'function') return onClick;
    }
    return null;
}

/**
 * Click an element through the game's React handler when a plain click would
 * be ignored.
 *
 * @param {Element} element - The element to click
 * @param {Object} [options]
 * @param {boolean} [options.reactFirst=false] - Call the React handler before trying
 *   `element.click()` (for elements known to ignore synthetic clicks)
 * @returns {'react'|'dom'|'none'} How the click was delivered
 */
export function clickThroughReact(element, { reactFirst = false } = {}) {
    if (!element) return 'none';
    const viaReact = () => {
        const handler = reactClickHandlerFor(element);
        if (!handler) return false;
        try {
            // Shaped like a real React SyntheticEvent as far as game handlers
            // look: some read `type`/`button`/`detail`, and a real event's
            // `nativeEvent` is always truthy. `isTrusted` included — the game's
            // spending buttons (reroll payments, the free reroll, discard
            // confirms) silently refuse an event without it (verified live
            // 2026-08-31: the handler ran, read the flag, and did nothing).
            // This call is still one press for one user action; the flag only
            // says so in the shape the handler checks.
            handler({
                currentTarget: element,
                target: element,
                type: 'click',
                button: 0,
                detail: 1,
                isTrusted: true,
                preventDefault() {},
                stopPropagation() {},
                nativeEvent: { type: 'click', button: 0, detail: 1, isTrusted: true },
            });
            return true;
        } catch (error) {
            console.error('[ReactClick] React click handler threw:', error);
            return false;
        }
    };
    if (reactFirst && viaReact()) return 'react';
    if (typeof element.click === 'function') {
        element.click();
        if (reactFirst) return 'dom';
        // A plain click is fine for most elements; the React route is the
        // fallback for those that ignore it — but a plain click that was
        // ignored leaves no trace, so callers that know their element ignores
        // it pass reactFirst
        return 'dom';
    }
    return viaReact() ? 'react' : 'none';
}

export default { fiberFor, reactClickHandlerFor, clickThroughReact };
