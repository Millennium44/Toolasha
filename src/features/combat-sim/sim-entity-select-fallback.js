/**
 * Toolasha-drawn dropdown for browsers without customizable selects (Firefox).
 * The real <select> stays the source of truth: it keeps its value, options, disabled state and listeners, and
 * is only hidden. A button beside it shows the selected icon and name; a popup listbox lists icon rows.
 */
import config from '../../core/config.js';
import { addStyles } from '../../utils/dom.js';
import { GAME_COLORS } from '../../utils/game-look.js';
import { holdEscapeWhile } from '../../utils/panel-escape.js';
import { simEntityIconHtml } from './sim-entity-label.js';

const HIDE_CLASS = 'toolasha-sim-entity-select-hidden';
const BUTTON_CLASS = 'toolasha-sim-entity-select-button';
const POPUP_CLASS = 'toolasha-sim-entity-select-popup';
const STYLE_ID = 'toolasha-sim-entity-select-fallback-styles';
const TYPEAHEAD_RESET_MS = 700;
const OPEN_WATCH_MS = 400;
const POPUP_MAX_HEIGHT = 360;
const EDGE = 8;

const CSS_TEXT = `
    select.${HIDE_CLASS} { display: none !important; }
    .${BUTTON_CLASS} {
        display: flex; align-items: center; gap: 4px; box-sizing: border-box;
        text-align: left; cursor: pointer; font: inherit; font-size: 12px; min-width: 0;
        background: ${GAME_COLORS.inputBackground}; color: ${GAME_COLORS.text};
        border: 1px solid ${GAME_COLORS.inputBorder}; border-radius: 4px; padding: 3px 6px;
    }
    .${BUTTON_CLASS}[disabled] { cursor: default; opacity: 0.6; }
    .${BUTTON_CLASS} > [data-label] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .${BUTTON_CLASS} > [data-caret] { flex-shrink: 0; font-size: 9px; opacity: 0.7; }
    .${POPUP_CLASS} {
        position: fixed; box-sizing: border-box; overflow: auto; overscroll-behavior: contain;
        background: ${GAME_COLORS.inputBackground}; color: ${GAME_COLORS.text};
        border: 1px solid ${GAME_COLORS.inputBorder}; border-radius: 4px; box-shadow: ${GAME_COLORS.frameGlow};
        font-size: 12px; max-width: calc(100vw - ${EDGE * 2}px);
    }
    .${POPUP_CLASS} [role="option"] {
        display: flex; align-items: center; gap: 4px; padding: 6px 10px; cursor: pointer;
        white-space: normal; overflow-wrap: anywhere;
    }
    .${POPUP_CLASS} [role="option"][data-active] { background: ${GAME_COLORS.raisedMore}; }
    .${POPUP_CLASS} [role="option"][aria-selected="true"]::after { content: '\\2713'; margin-left: auto; padding-left: 8px; }
    .${POPUP_CLASS} [role="option"][aria-disabled="true"] { opacity: 0.5; cursor: default; }
    .${POPUP_CLASS} [data-sim-entity-icon] { flex-shrink: 0; }
`;

const enhanced = new WeakMap();
let uid = 0;

function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function rowHtml(option) {
    return simEntityIconHtml(option.value) + `<span>${escapeText(option.textContent)}</span>`;
}

function isHidden(option) {
    return Boolean(option.hidden || option.closest('optgroup')?.hidden);
}

function isDisabled(option) {
    return Boolean(option.disabled || option.closest('optgroup')?.disabled);
}

function findDescriptor(object, name) {
    for (let proto = object; proto; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor) return descriptor;
    }
    return null;
}

/**
 * Give a select the fallback dropdown (idempotent). Call again after repopulating; it also follows later changes.
 * @param {HTMLSelectElement} select - Existing single-select control
 */
export function enhanceSimEntitySelect(select) {
    if (enhanced.has(select)) {
        enhanced.get(select).refresh();
        return;
    }
    addStyles(CSS_TEXT, STYLE_ID);

    const id = `toolasha-sim-dd-${++uid}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.style.cssText = select.style.cssText;
    button.style.display = '';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${id}-list`);
    const labelEl = document.createElement('span');
    labelEl.setAttribute('data-label', '');
    const caret = document.createElement('span');
    caret.setAttribute('data-caret', '');
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▼';
    button.append(labelEl, caret);
    select.classList.add(HIDE_CLASS);
    select.after(button);

    let popup = null;
    let items = []; // [{option, el}]
    let activeIndex = -1;
    let typed = '';
    let typedTimer = null;
    let watchTimer = null;
    let releaseEscape = null;
    let destroyed = false;
    const observers = [];
    const shadowed = [];

    const selectedOption = () => select.options[select.selectedIndex] || null;

    const syncButton = () => {
        if (destroyed) return;
        const option = selectedOption();
        labelEl.innerHTML = option ? rowHtml(option) : '';
        button.disabled = select.disabled;
        button.style.display = select.style.display === 'none' ? 'none' : '';
        button.title = select.title || '';
        if (select.disabled && popup) close();
    };

    const setActive = (index, scroll = true) => {
        if (activeIndex >= 0) items[activeIndex]?.el.removeAttribute('data-active');
        activeIndex = index;
        const item = items[index];
        if (!item) {
            button.removeAttribute('aria-activedescendant');
            return;
        }
        item.el.setAttribute('data-active', '');
        button.setAttribute('aria-activedescendant', item.el.id);
        if (scroll) item.el.scrollIntoView?.({ block: 'nearest' });
    };

    const enabledIndexes = () => items.map((it, i) => (isDisabled(it.option) ? -1 : i)).filter((i) => i >= 0);

    const move = (delta) => {
        const enabled = enabledIndexes();
        if (!enabled.length) return;
        const at = enabled.indexOf(activeIndex);
        if (at === -1) setActive(delta > 0 ? enabled[0] : enabled[enabled.length - 1]);
        else setActive(enabled[Math.max(0, Math.min(enabled.length - 1, at + delta))]);
    };

    const place = () => {
        if (!popup) return;
        const rect = button.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        const vh = window.innerHeight || document.documentElement.clientHeight;
        popup.style.minWidth = `${rect.width}px`;
        popup.style.maxHeight = `${POPUP_MAX_HEIGHT}px`;
        const below = vh - rect.bottom - EDGE;
        const above = rect.top - EDGE;
        const natural = Math.min(popup.scrollHeight || POPUP_MAX_HEIGHT, POPUP_MAX_HEIGHT);
        const openUp = natural > below && above > below;
        const room = Math.max(60, openUp ? above : below);
        popup.style.maxHeight = `${Math.min(POPUP_MAX_HEIGHT, room)}px`;
        const height = Math.min(natural, room);
        popup.style.top = `${openUp ? Math.max(EDGE, rect.top - height - 2) : rect.bottom + 2}px`;
        const width = popup.offsetWidth || rect.width;
        popup.style.left = `${Math.max(EDGE, Math.min(rect.left, vw - width - EDGE))}px`;
    };

    const onDocPointerDown = (event) => {
        if (popup?.contains(event.target) || button.contains(event.target)) return;
        close();
    };
    const onDismiss = (event) => {
        if (event?.type === 'scroll' && popup?.contains(event.target)) return;
        close();
    };

    function close() {
        if (!popup) return;
        document.removeEventListener('pointerdown', onDocPointerDown, true);
        document.removeEventListener('scroll', onDismiss, true);
        window.removeEventListener('resize', onDismiss);
        window.removeEventListener('blur', onDismiss);
        clearInterval(watchTimer);
        watchTimer = null;
        releaseEscape?.();
        releaseEscape = null;
        popup.remove();
        popup = null;
        items = [];
        activeIndex = -1;
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-activedescendant');
    }

    function commit(index) {
        const item = items[index];
        if (!item || isDisabled(item.option)) return;
        const changed = select.selectedIndex !== item.option.index;
        select.selectedIndex = item.option.index;
        close();
        syncButton();
        if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
        button.focus?.();
    }

    function open() {
        if (popup || destroyed || select.disabled || !select.isConnected) return;
        syncButton();
        popup = document.createElement('div');
        popup.className = POPUP_CLASS;
        popup.id = `${id}-list`;
        popup.setAttribute('role', 'listbox');
        popup.style.zIndex = String(config.Z_FLOATING_PANEL + 100);
        const selected = selectedOption();
        items = [];
        [...select.options].forEach((option, i) => {
            if (isHidden(option)) return;
            const el = document.createElement('div');
            el.id = `${id}-opt-${i}`;
            el.setAttribute('role', 'option');
            el.setAttribute('aria-selected', String(option === selected));
            if (isDisabled(option)) el.setAttribute('aria-disabled', 'true');
            el.innerHTML = rowHtml(option);
            el.addEventListener('mousedown', (event) => event.preventDefault());
            el.addEventListener('click', () => commit(items.findIndex((it) => it.el === el)));
            el.addEventListener('mousemove', () => {
                const at = items.findIndex((it) => it.el === el);
                if (at !== activeIndex && !isDisabled(option)) setActive(at, false);
            });
            popup.appendChild(el);
            items.push({ option, el });
        });
        document.body.appendChild(popup);
        button.setAttribute('aria-expanded', 'true');
        const start = items.findIndex((it) => it.option === selected && !isDisabled(it.option));
        setActive(start >= 0 ? start : (enabledIndexes()[0] ?? -1));
        place();
        document.addEventListener('pointerdown', onDocPointerDown, true);
        document.addEventListener('scroll', onDismiss, true);
        window.addEventListener('resize', onDismiss);
        window.addEventListener('blur', onDismiss);
        releaseEscape = holdEscapeWhile(() => Boolean(popup));
        // The panel can close while the list is up; a list for a control that left the page goes with it.
        watchTimer = setInterval(() => {
            if (!select.isConnected) destroy();
            else if (button.getClientRects().length === 0) close();
        }, OPEN_WATCH_MS);
    }

    function typeahead(char) {
        clearTimeout(typedTimer);
        typed += char.toLowerCase();
        typedTimer = setTimeout(() => {
            typed = '';
            typedTimer = null;
        }, TYPEAHEAD_RESET_MS);
        const enabled = enabledIndexes();
        if (!enabled.length) return;
        const label = (i) => (items[i]?.option.textContent || '').trim().toLowerCase();
        const repeated = typed.length > 1 && [...typed].every((c) => c === typed[0]);
        const needle = repeated ? typed[0] : typed;
        const at = enabled.indexOf(activeIndex);
        // A single (or repeated) letter moves on to the next match; a longer prefix may keep the current row.
        const skip = needle.length === 1 && at !== -1 ? 1 : 0;
        const start = at === -1 ? 0 : at + skip - (skip ? 0 : 0);
        const order = [...enabled.slice(start), ...enabled.slice(0, start)];
        const hit = order.find((i) => label(i).startsWith(needle));
        if (hit !== undefined) setActive(hit);
    }

    const onKeyDown = (event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const key = event.key;
        if (!popup) {
            if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(key)) {
                event.preventDefault();
                open();
            } else if (key.length === 1) {
                event.preventDefault();
                open();
                typeahead(key);
            }
            return;
        }
        switch (key) {
            case 'ArrowDown':
                event.preventDefault();
                move(1);
                break;
            case 'ArrowUp':
                event.preventDefault();
                move(-1);
                break;
            case 'Home':
                event.preventDefault();
                setActive(enabledIndexes()[0] ?? -1);
                break;
            case 'End':
                event.preventDefault();
                setActive(enabledIndexes().at(-1) ?? -1);
                break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                commit(activeIndex);
                break;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                close();
                break;
            case 'Tab':
                close();
                break;
            default:
                if (key.length === 1) {
                    event.preventDefault();
                    typeahead(key);
                }
        }
    };
    const onClick = () => (popup ? close() : open());
    const onSelectChange = () => syncButton();

    function destroy() {
        if (destroyed) return;
        close();
        destroyed = true;
        clearTimeout(typedTimer);
        observers.forEach((observer) => observer.disconnect());
        button.removeEventListener('keydown', onKeyDown);
        button.removeEventListener('click', onClick);
        select.removeEventListener('change', onSelectChange);
        shadowed.forEach((name) => delete select[name]);
        button.remove();
        select.classList.remove(HIDE_CLASS);
        enhanced.delete(select);
    }

    function refresh() {
        if (destroyed) return;
        syncButton();
        // The options changed under an open list: close it rather than show a stale one.
        close();
    }

    // Callers set select.value / selectedIndex directly, which fires no event: keep the button in step.
    for (const name of ['value', 'selectedIndex']) {
        const original = findDescriptor(select, name);
        if (!original?.set) continue;
        Object.defineProperty(select, name, {
            configurable: true,
            get() {
                return original.get.call(this);
            },
            set(next) {
                original.set.call(this, next);
                syncButton();
            },
        });
        shadowed.push(name);
    }

    button.addEventListener('keydown', onKeyDown);
    button.addEventListener('click', onClick);
    select.addEventListener('change', onSelectChange);
    const selectObserver = new MutationObserver(() => {
        if (select.isConnected) refresh();
    });
    selectObserver.observe(select, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'hidden', 'style', 'title', 'label'],
        characterData: true,
    });
    observers.push(selectObserver);
    // Removing the select from its parent does not mutate the select itself.
    if (select.parentNode) {
        const parentObserver = new MutationObserver(() => {
            if (!select.isConnected || select.parentNode === null) destroy();
        });
        parentObserver.observe(select.parentNode, { childList: true });
        observers.push(parentObserver);
    }

    enhanced.set(select, { refresh, destroy });
    const labels = [...(select.labels || [])].map((l) => l.id).filter(Boolean);
    if (labels.length) button.setAttribute('aria-labelledby', labels.join(' '));
    syncButton();
}

/**
 * Remove the fallback dropdown from a select (idempotent).
 * @param {HTMLSelectElement} select - Previously enhanced select
 */
export function releaseSimEntitySelect(select) {
    enhanced.get(select)?.destroy();
}
