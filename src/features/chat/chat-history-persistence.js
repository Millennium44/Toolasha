/**
 * Chat History Persistence
 *
 * The history buffer that `chat-history-extender.js` keeps above live chat is
 * lost on every reload, because it is built from `cloneNode(true)` of nodes the
 * game has already thrown away. This module writes that markup to IndexedDB and
 * puts it back on the next load.
 *
 * ## When a message is recorded
 *
 * On render, not only on eviction. This used to record a message only when the
 * game pushed it out of the live list, on the theory that everything still in
 * the live list would come back from the server on the next load. It does not
 * always: a server restart (a game update, say) comes back with an empty or
 * short channel history, and a reload takes the page's copy with it. Every
 * message that was still on screen at that moment was lost — on a quiet
 * channel like Party, that can be every message since the page was opened.
 * So a message is recorded as soon as it is rendered, again (deduplicated —
 * see {@link messageIdentity}) when it is evicted, and a restore leaves out
 * whatever the game is already showing live.
 *
 * What cannot be saved is what this page never rendered: a message that
 * arrived while its tab was not the open one and was pushed out of the game's
 * own list before that tab was next opened, or anything sent while the page
 * was closed or disconnected.
 *
 * ## Why the markup, and why the links have to be rebuilt
 *
 * A live message is made clickable by reading its React fiber props at clone
 * time — `props.onClick`, `props.goToMarketplaceHandler` — and keeping the
 * *function references* in a map. Functions do not serialize, so nothing that
 * comes back off disk can carry the game's own callbacks. Restored item links
 * are therefore re-wired to this script's own navigation
 * (`navigateToMarketplace`), resolved from the icon sprite the markup already
 * carries, and a link whose item cannot be resolved is left inert: it loses
 * `.mwi-interactive` too, because a pointer cursor over a dead link is worse
 * than a plain one.
 *
 * Player names this script itself decorated travel with the message: the name
 * attribute and the class that styles it are both kept, so the delegated
 * listener in `chat-profile-link.js` works on a restored message without
 * waiting for anything to re-decorate it. This used to claim that decorator
 * would re-link them wherever they appeared; it does not, because it skips any
 * node that already carries its class — which a restored one does.
 *
 * The *sender* name of an ordinary chat line is the game's own element
 * (`ChatMessage_name ChatMessage_clickable`), carries no attribute of ours, and
 * is clickable only through a React handler — so it dies with the session
 * exactly like an item link does, and is re-wired here the same way. The name
 * is read back out of the `CharacterName_name` text the markup already carries
 * rather than from anything saved, which is what lets messages stored long
 * before this existed come back clickable with no migration. A sender whose
 * name cannot be read or does not look like a player name loses
 * `ChatMessage_clickable` as well, for the same reason an unresolvable item
 * link loses `.mwi-interactive`: on a restored node that class is a promise
 * nothing can keep.
 *
 * ## Why it never leaves the device
 *
 * Every tab is persisted, whispers and private messages included — a deliberate
 * choice, made knowing this puts private conversations on disk. Disk is the
 * whole of it: the cross-device sync uploads to a GitHub gist, and a whisper
 * reaching a gist would be a real privacy failure. The key is prefixed
 * `toolasha_local_`, which `features/sync/sync-payload.js` strips from the
 * settings store on the upload path (`redactSettingsStore`) and again on the
 * import path (`applyPayload`), and which `utils/full-backup.js` strips from
 * every manual backup file as well.
 *
 * The `settings` store is used rather than a store of this feature's own,
 * because a new object store means a `dbVersion` bump and this database's
 * version is held in lockstep with the upstream script that shares it — see
 * `core/storage.js`. A store-level exclusion would also have been needed then,
 * since `buildPayloadJSON('everything')` walks every store `listStores()`
 * reports; keeping the record in `settings` puts it under the key-prefix
 * exclusion that already exists and is already applied on both paths.
 *
 * ## Which record a tab lives in
 *
 * Three kinds of record, all under {@link CHAT_HISTORY_KEY_BASE}:
 *
 * - `_public` — the public channels ({@link tabScope}), one record for every
 *   character this browser profile plays, since they all see the same lines;
 * - `_guild_<guildId>` — Guild chat, one record per guild, so characters in the
 *   same guild share it and a character in another guild never reads it;
 * - `_<characterId>` — everything else: Party, whispers, Local, Mod, and any tab
 *   whose label cannot be told apart from a whisper partner's name.
 *
 * A shared record has several writers — one per open game tab — so it is never
 * overwritten: every write is a read-merge-write in one IndexedDB readwrite
 * transaction (`storage.update`), which IndexedDB serialises across every
 * connection on the origin. A deletion is kept in the record as a tombstone
 * (`deleted`), because a merge would otherwise put the line straight back from
 * whichever tab still holds it. Each deletion and undelete carries the time its
 * event arrived, and the record keeps the newest per id (`decidedAt`), so a game
 * tab that missed a later event cannot override it with an older one; a session
 * stops sending a decision once a write has landed it. The per-character record
 * keeps its one writer and is still written whole.
 *
 * The first load after this existed moves a character's copies of shared tabs
 * out of its own record — see {@link ChatHistoryPersistence#load}. Its Guild tab
 * names no guild, so it moves only once a guild's record shares a line with it;
 * until then the character's own record holds it (`guildLegacy`), shown to that
 * character alone.
 *
 * ## Caps
 *
 * Markup for a dozen tabs at 150 messages each is not small, so three caps hold
 * the write down and every one of them trims oldest-first. The per-tab cap
 * counts lines older than the live backlog the game still shows (reported by
 * the extender, kept in the record's `live` map). See
 * {@link MAX_MESSAGE_CHARS}, {@link MAX_MESSAGES_PER_TAB} and
 * {@link MAX_TOTAL_CHARS}. The total applies per record, so a profile holds at
 * most one budget for the public channels, one per guild and one per character.
 *
 * ## Message identity and deletion
 *
 * A September 2026 patch (test server only as of this writing) lets a player
 * delete their own Trade/Recruit messages, on top of the moderator deletion
 * that already existed. Deletion arrives as `chat_message_updated`, carrying
 * `{ id, chan, isDeleted, deleteReason }` for the message it targets — no
 * text, no sender, nothing else. Removing the right stored message therefore
 * means keying by that `id`, which nothing here used before this patch: a
 * stored entry was, and still is, just an HTML string.
 *
 * Rather than change that shape (a new field would mean a `RECORD_VERSION`
 * bump and a migration for every existing record), the id rides *inside* the
 * markup: `chat-history-extender.js` stamps a live message's DOM node with
 * `data-mwi-msg-id` the moment it can correlate that node to the
 * `chat_message_received` websocket event that produced it, and
 * `serializeMessage` neither adds nor strips that attribute, so it survives
 * into storage as part of the HTML like any other attribute the game itself
 * wrote. {@link extractStoredMessageId} pulls it back out with a regex — a
 * full parse of every message in a tab on every deletion is more work than a
 * deletion (which can arrive in a burst, e.g. a moderator clearing a channel)
 * should cost.
 *
 * That correlation is only possible for a tab keyed `tab2:ch:<channel>` — an
 * aggregate channel like Trade or Global, where the websocket's `chan` field
 * names the same channel the open tab shows. A `tab2:name:<label>` tab
 * (whispers, or any tab the strip does not expose a channel for) has no such
 * 1:1 mapping — several whisper conversations can share one `chan` value — so
 * chat-history-extender does not attempt it there, and a message recorded
 * from one carries no id. So does every message recorded by a build before
 * this patch. {@link purgeMessageById} simply cannot find either kind: they
 * stay on disk until the ordinary caps age them out, same as before this
 * existed. That is a quiet miss, not a crash — deletion here is a courtesy on
 * top of a local cache, not a guarantee.
 *
 * An undelete (`chat_message_updated` with `isDeleted: false`) restores
 * nothing. The deleted message's markup is gone the moment it is purged;
 * there is nothing left to put back, and re-adding a message this script
 * never re-receives over the socket is not something an undelete event alone
 * can do.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { characterKey } from '../../utils/character-key.js';
import { captureOwner, noteTeardown, stillOurs } from '../../utils/init-ownership.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { openPlayerProfile, VALID_PLAYER_NAME_RE } from '../../utils/profile-command.js';
import { RANK_BADGE_ATTR, RANK_BADGE_SELECTOR } from '../../utils/rank-badge-data.js';

/**
 * Unscoped storage key. The `toolasha_local_` prefix is the load-bearing part:
 * it is what keeps this record out of a sync payload and out of a backup file.
 * Changing it without changing `LOCAL_ONLY_KEY_PREFIXES` in
 * `features/sync/sync-payload.js` would publish whispers to a gist.
 */
export const CHAT_HISTORY_KEY_BASE = 'toolasha_local_chatHistory';

/** The store the record lives in — deliberately not a new one; see the header. */
export const CHAT_HISTORY_STORE = 'settings';

/** Record shape version, so a future change can drop what it cannot read. */
const RECORD_VERSION = 1;

/**
 * Longest single message kept, in characters of serialized HTML.
 *
 * A chat line is a few hundred characters; anything past this is markup that
 * has grown a shape we did not expect, and storing it would let one message eat
 * the whole budget. Such a message is dropped rather than truncated — half a
 * message's HTML restores as broken markup, which is worse than its absence.
 */
export const MAX_MESSAGE_CHARS = 8 * 1024;

/**
 * Hard ceiling on messages kept per tab that are older than the game's live
 * backlog, whatever the user's max-history is. The lines the game is still
 * showing live are kept on top of this; see {@link MAX_LIVE_ALLOWANCE}.
 */
export const MAX_MESSAGES_PER_TAB = 150;

/**
 * Most live lines a tab's cap makes room for, and what a tab whose live count
 * is not known (never mounted this session, record from an older build) is
 * given. Together with {@link MAX_MESSAGES_PER_TAB} it is the absolute ceiling
 * a tab's record can reach: 150 older lines plus 200 live ones.
 */
export const MAX_LIVE_ALLOWANCE = 200;

/**
 * Ceiling on the whole record, in characters of serialized HTML summed across
 * every tab. It is a bound, not a target, and the trim that enforces it takes
 * from the largest tab first so one busy channel cannot starve the quiet ones.
 * Measured 2026-10-01: a guild line with chat icons and a rank badge is ~1k
 * characters, so 256k filled at ~400 lines across five tabs and capped history
 * well before the per-tab limit; 1M leaves room for ~1,000. The record is local
 * only (never synced or backed up).
 */
export const MAX_TOTAL_CHARS = 1024 * 1024;

/** How long writes are coalesced before one hits storage. */
const WRITE_DEBOUNCE_MS = 5000;

/** Attributes stripped on the way in — stale handles into a dead session. */
/**
 * Handles that mean nothing in the next session and have to come off.
 *
 * `data-mwi-profile-name` is deliberately NOT among them, though it used to be.
 * It is a player's name — stable text, not a handle into this session's caches —
 * and `chat-profile-link.js` writes it beside the `mwi-chat-profile-name` class
 * that carries the styling. Stripping one and keeping the other left restored
 * messages looking exactly like links, cursor and all, whose click handler read
 * an empty name and returned; and the decorator skips any node already carrying
 * the class, so nothing ever put it back. The pair has to travel together.
 */
const STALE_ATTRIBUTES = [
    'data-mwi-uid',
    'data-mwi-hydrated',
    'data-mwi-profile-link',
    'data-mwi-key-names-linked',
    // A session-local flag (chat-history-extender's `_tagMessageId` /
    // `_handleMessageUpdated`): a message carrying it is never handed to
    // `record()` in the first place, so this only fires for a message this
    // build did not mean to skip — belt and braces, not the primary gate.
    'data-mwi-skip-store',
];

/**
 * Serialize one live/cloned chat message node for storage.
 *
 * The node is copied first: the handles that only mean something in this
 * session are removed from the copy, never from the node the buffer is
 * rendering. `data-processed` is deliberately *kept* — it is
 * `dungeon-tracker-chat-annotations.js`'s "already counted" marker, and a
 * restored key-counts line that still carries it is one that annotator skips.
 *
 * @param {Element} node - A `ChatMessage_chatMessage` element
 * @returns {string|null} HTML text, or null when the node is unusable or over
 *   {@link MAX_MESSAGE_CHARS}
 */
export function serializeMessage(node) {
    if (!node || node.nodeType !== 1) return null;

    let copy;
    try {
        copy = node.cloneNode(true);
    } catch {
        return null;
    }

    const all = [copy, ...copy.querySelectorAll('*')];
    for (const el of all) {
        for (const attribute of STALE_ATTRIBUTES) el.removeAttribute(attribute);
        el.classList?.remove('mwi-interactive');
    }
    // Annotations this script drew are rebuilt from stored runs on the next
    // pass; keeping them would double them up.
    copy.querySelectorAll('.dungeon-timer-annotation, .dungeon-timer-average').forEach((span) => span.remove());
    // A rank badge is a decoration of this session: its rank goes stale, and its digits would make the
    // same line badged and unbadged two different messages to {@link messageIdentity}.
    copy.querySelectorAll(RANK_BADGE_SELECTOR).forEach((badge) => badge.remove());

    const html = copy.outerHTML;
    if (typeof html !== 'string' || !html || html.length > MAX_MESSAGE_CHARS) return null;
    return html;
}

/**
 * Elements removed from restored markup outright.
 *
 * The first five execute or load; `base` and `meta` rewrite how every URL
 * around them resolves; and the SMIL trio (`animate`, `animateTransform`,
 * `set`) is the one that gets missed — they run *after* a sanitizer has been
 * over the tree and put back the attribute it just took, so
 * `<svg><a><animate attributeName="href" to="javascript:…"/></a></svg>`
 * survives an attribute-only pass. Chat markup animates nothing, so there is
 * nothing to lose by removing them.
 */
const UNSAFE_ELEMENT_SELECTOR =
    'script, iframe, object, embed, link, style, base, meta, animate, animateTransform, set';

/**
 * Attributes naming something the browser fetches or navigates to.
 *
 * `xlink:href` is here because that is how the game's item icons reference the
 * sprite sheet, so it is the one attribute in restored markup that reliably
 * carries a URL; the values kept are the fragment references those icons use
 * (`#itemName`), which no scheme test can match.
 */
const URL_ATTRIBUTES = ['href', 'xlink:href', 'src', 'action', 'formaction', 'ping', 'srcdoc'];

/** Schemes that run code when the URL is followed, tested after {@link normalizeURL}. */
const SCRIPTABLE_SCHEME = /^(?:javascript|vbscript):/i;

/**
 * A URL attribute's value reduced to what the browser will actually resolve.
 *
 * Leading whitespace and C0 control characters are ignored by the URL parser
 * and stripped from anywhere inside the scheme, so a tab-split `javascript:`
 * and a newline-padded one both navigate — and both walk past a naive
 * `startsWith('javascript:')`.
 *
 * @param {string} value - Raw attribute value
 * @returns {string} The value with whitespace and control characters removed
 */
function normalizeURL(value) {
    return String(value || '').replace(/[\x00-\x20]/g, '');
}

/**
 * Strip everything scriptable from one restored element, in place.
 *
 * Attribute-only sanitizing is not enough on its own — see
 * {@link UNSAFE_ELEMENT_SELECTOR} — so the elements go first and the
 * attributes second, over what is left.
 *
 * @param {Element} el - Parsed message element, still inside its template
 */
function sanitizeRestoredMarkup(el) {
    el.querySelectorAll(UNSAFE_ELEMENT_SELECTOR).forEach((bad) => bad.remove());

    for (const node of [el, ...el.querySelectorAll('*')]) {
        for (const attribute of [...(node.attributes || [])]) {
            const name = attribute.name;
            if (/^on/i.test(name)) {
                node.removeAttribute(name);
                continue;
            }
            const lower = name.toLowerCase();
            if (lower === 'srcdoc') {
                // A whole document's worth of markup that no pass over *this*
                // tree can reach, because it is parsed in the frame instead.
                node.removeAttribute(name);
                continue;
            }
            if (URL_ATTRIBUTES.includes(lower) && SCRIPTABLE_SCHEME.test(normalizeURL(attribute.value))) {
                node.removeAttribute(name);
                continue;
            }
            // An inline `url()` is a request to a third party the moment the
            // node is laid out — a read receipt on restored scrollback, fired
            // without a click. Colors and spacing are why chat markup carries
            // `style` at all, so only the ones with a fetch in them go.
            if (lower === 'style' && /url\s*\(/i.test(attribute.value || '')) node.removeAttribute(name);
        }
    }
}

/**
 * Parse stored HTML back into an element, with the parts that could execute
 * removed.
 *
 * The markup came from the game's own React render, so it should hold nothing
 * scriptable — but it has been round-tripped through storage since, and
 * `innerHTML` re-parses whatever is handed to it. `<script>` inserted this way
 * does not run; an `onerror` on an `<img>` does. Both go, along with the
 * element and URL forms an `on*` sweep alone would walk straight past — see
 * {@link sanitizeRestoredMarkup}.
 *
 * @param {string} html - Stored message markup
 * @returns {Element|null} The message element, or null when it does not parse
 */
export function parseStoredMessage(html) {
    if (typeof html !== 'string' || !html) return null;

    let template;
    try {
        template = document.createElement('template');
        template.innerHTML = html;
    } catch {
        return null;
    }

    const el = template.content.firstElementChild;
    if (!el) return null;

    sanitizeRestoredMarkup(el);
    // Records written before the serializer dropped badges still carry one, with whatever rank it had then
    // (and shown even with badges switched off). The badge module redraws a current one if it has one.
    el.querySelectorAll(RANK_BADGE_SELECTOR).forEach((badge) => badge.remove());

    // Mark it as scrollback from a previous session. The dungeon tracker scans
    // every `ChatMessage_chatMessage` in the document, buffer included, and
    // banks runs from pairs of "Key counts" lines — so without this a restored
    // key count pairs with this session's first live one and invents a run
    // spanning the reload. `data-processed` is preserved by the serializer for
    // lines already counted, but a reset clears that marker from the whole
    // document; this one is a property of where the node came from, so it
    // survives.
    //
    // Every node the tracker's own query would match is marked, not just the
    // root: it queries `[class*="ChatMessage_chatMessage"]` over the whole
    // document, which finds a nested one too, and a nested one carrying no mark
    // is a restored line the tracker reads as live.
    el.dataset.mwiRestored = '1';
    for (const nested of el.querySelectorAll('[class*="ChatMessage_chatMessage"]')) {
        nested.dataset.mwiRestored = '1';
    }

    return el;
}

/**
 * The item an icon element draws, read off its sprite reference.
 *
 * Same handle the rest of the codebase uses (`utils/marketplace-autofill.js`,
 * `features/alchemy/alchemy-success-stamp.js`): item icons carry the sprite id
 * on `xlink:href`, and only some also carry a plain `href`.
 *
 * Exported for chat-history-extender.js's id correlator, which reads the same
 * sprite reference off a rendered item link to compare against a queued
 * `chat_message_received`'s `linksMetadata.itemHrid` — see that module's
 * `linkIdentitiesFromDom`.
 *
 * @param {Element} container - An `Item_itemContainer` element
 * @returns {string|null} Item HRID, or null when no item sprite is drawn
 */
export function itemHridFrom(container) {
    const use = container.querySelector('svg use[href], svg use[xlink\\:href]');
    const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
    const slug = href.match(/#(.+)$/)?.[1];
    return slug ? `/items/${slug}` : null;
}

/**
 * The game's sender-name element on a chat line — the one it makes clickable.
 * Exported for chat-history-extender.js's id correlator, which needs the same
 * exact sender-name extraction {@link senderNameFrom} does to match a live
 * node's content against a queued `chat_message_received` — see that
 * module's "Message identity and deletion" section.
 */
export const SENDER_SELECTOR = '[class*="ChatMessage_name"]';

/** The name itself, inside the sender element; a rank badge or icon sits beside it. */
const CHARACTER_NAME_SELECTOR = '[class*="CharacterName_name"]';

/**
 * The class prefix behind the sender's pointer cursor. A CSS module, so the
 * live class is `ChatMessage_clickable__<hash>` and only the prefix is stable.
 */
const CLICKABLE_CLASS_PREFIX = 'ChatMessage_clickable';

/**
 * The player name a restored sender element shows.
 *
 * Read from the markup, never from a stored attribute: `CharacterName_name`'s
 * text is the name and nothing strips it, so this works on records written
 * before any of this code existed. `data-name` is preferred where the game
 * wrote one (it does on some surfaces) because it is the name without whatever
 * decoration sits around the text.
 *
 * @param {Element} sender - A `ChatMessage_name` element
 * @returns {string} The name, or '' when the markup does not yield one
 */
export function senderNameFrom(sender) {
    const inner = sender.querySelector(CHARACTER_NAME_SELECTOR) || sender;
    const raw = inner.getAttribute?.('data-name') || inner.textContent || '';
    // The fallback path can pick up the separator the game draws after the name.
    return raw.trim().replace(/:$/, '').trim();
}

/**
 * Re-wire the sender name of a restored message to this script's own profile open.
 *
 * The live element's clickability is a React handler, which no serialization can
 * carry — so a restored sender is a name styled as a link with nothing behind it.
 * Marking is an attribute rather than a listener, so a node re-processed (or
 * cloned into another buffer) cannot accumulate handlers.
 *
 * @param {Element} el - A restored message element
 * @returns {number} How many sender names were made clickable
 */
function rewireRestoredSender(el) {
    let senders;
    try {
        senders = el.querySelectorAll(SENDER_SELECTOR);
    } catch {
        return 0;
    }

    let wired = 0;
    for (const sender of senders) {
        try {
            const name = senderNameFrom(sender);
            if (name && VALID_PLAYER_NAME_RE.test(name)) {
                sender.dataset.mwiRestoredSender = name;
                wired += 1;
                continue;
            }
            // Nothing can honour the click, so nothing may advertise one.
            delete sender.dataset.mwiRestoredSender;
            for (const cls of [...sender.classList]) {
                if (cls.startsWith(CLICKABLE_CLASS_PREFIX)) sender.classList.remove(cls);
            }
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not re-wire a sender name:', error);
        }
    }
    return wired;
}

/**
 * Re-wire the clickable parts of a restored message.
 *
 * Fails soft by design: a game update will eventually change this markup, and
 * when it does the only correct outcome is a message that still reads as text.
 * So every step is best-effort, nothing throws out of here, and an item link
 * that cannot be resolved — unknown sprite, sprite naming an item this build's
 * game data does not know — is left without `.mwi-interactive` rather than
 * given a cursor it cannot honour.
 *
 * @param {Element} el - A restored message element, not yet in the document
 * @returns {number} How many links were made clickable, sender name included
 */
export function rewireRestoredMessage(el) {
    if (!el) return 0;

    let wired = rewireRestoredSender(el);
    let containers;
    try {
        containers = el.querySelectorAll('[class*="Item_itemContainer"]');
    } catch {
        return wired;
    }

    for (const container of containers) {
        try {
            const hrid = itemHridFrom(container);
            // `getItemDetails` is the same validation `utils/item-navigation.js`
            // does before handing an HRID to the game: an unknown one crashes
            // the game's own renderer, so an unresolvable link stays inert.
            if (!hrid || !dataManager.getItemDetails?.(hrid)) continue;

            const level = parseInt(
                container.querySelector('[class*="Item_enhancementLevel"]')?.textContent?.replace(/\D/g, ''),
                10
            );
            const enhancementLevel = Number.isFinite(level) ? level : 0;

            // The clickable target is the element the player sees, which is the
            // container itself; the handler is this script's own navigation,
            // not the game callback the live node had.
            container.dataset.mwiRestoredItem = hrid;
            container.dataset.mwiRestoredEnh = String(enhancementLevel);
            container.classList.add('mwi-interactive');
            wired += 1;
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not re-wire an item link:', error);
        }
    }

    return wired;
}

/**
 * Handle a click inside a restored message. Attached once per buffer by
 * `chat-history-extender.js`; a click on anything not re-wired does nothing.
 *
 * The sender name goes through `openPlayerProfile` — the same helper the
 * delegated listener in `chat-profile-link.js` calls, so the click behaviour is
 * shared rather than duplicated. What is deliberately *not* reused is that
 * module's `markAsProfileLink`: it recolors the name to this script's link
 * blue (restored lines would stop matching live ones) and it is gated on
 * `chat_profileLink`, which turns off decorating names the game left plain.
 * Putting back a sender the game itself made clickable is not that feature, so
 * it is not that feature's setting to switch off; the history buffer's own
 * setting already gates all of this.
 *
 * @param {Event} event
 */
export function handleRestoredClick(event) {
    const sender = event.target?.closest?.('[data-mwi-restored-sender]');
    if (sender) {
        openPlayerProfile(sender.dataset.mwiRestoredSender, { logPrefix: 'ChatHistoryPersistence' });
        return;
    }

    const target = event.target?.closest?.('[data-mwi-restored-item]');
    if (!target) return;

    const hrid = target.dataset.mwiRestoredItem;
    const enhancementLevel = parseInt(target.dataset.mwiRestoredEnh, 10) || 0;
    try {
        navigateToMarketplace(hrid, enhancementLevel);
    } catch (error) {
        console.error('[ChatHistoryPersistence] Marketplace navigation failed:', error);
    }
}

/**
 * Prefix every key this module will accept, and the marker of the key format.
 *
 * The generation number is load-bearing rather than decorative. Two earlier
 * formats named a *slot* instead of a tab: `idx:<n>` named a position in the
 * tab strip, and `tab:<label>` claimed to name the tab but was resolved by
 * index alignment against a strip that renders one container for *every* tab —
 * so in practice every tab's history went under the first button's name. A
 * record under either is an unattributable mixture of whichever tabs the player
 * used, whispers included, and nothing on disk says which message came from
 * where. They cannot be migrated; see {@link dropForeignKeys}.
 *
 * Bumping the prefix rather than reusing `tab:` is what makes that drop safe:
 * a key written by an older build can never be mistaken for one written by this
 * one, so no record can mix content across the change.
 */
export const TAB_KEY_PREFIX = 'tab2:';

/**
 * Copy a stored `{tabKey: [html]}` map without keys this build cannot have
 * written.
 *
 * The only survivors are {@link TAB_KEY_PREFIX} keys, which are produced by one
 * function (`chatTabKey` in `chat-history-extender.js`) and name the tab that
 * was open when the message was recorded. Everything else is a slot-named
 * record from an older format: restoring one puts whatever it holds into
 * whichever tab happens to be open, which is a whisper in Global. A tab whose
 * history is missing is recoverable; a private conversation in a public tab's
 * scrollback is not.
 *
 * This is deliberately a format test and not a one-shot migration flag. It is
 * idempotent, needs nothing remembered on disk, and can only ever discard keys
 * that no current writer produces — so there is no later run of it that can eat
 * good data. The drop reaches storage on the next flush, because the working
 * record is what this returns.
 *
 * @param {Record<string, Array<string>>} tabs - Not mutated
 * @returns {Record<string, Array<string>>} A fresh map holding only current-format keys
 */
export function dropForeignKeys(tabs) {
    return Object.fromEntries(Object.entries(tabs || {}).filter(([key]) => String(key).startsWith(TAB_KEY_PREFIX)));
}

/**
 * Pull a stored message's `data-mwi-msg-id` back out of its serialized HTML,
 * without parsing it — see the "Message identity and deletion" section above
 * for why the id lives inside the markup instead of a field of its own.
 *
 * @param {string} html - One stored message, as {@link serializeMessage} produced it
 * @returns {string|null} The id, or null when the message carries none
 */
export function extractStoredMessageId(html) {
    if (typeof html !== 'string') return null;
    const match = html.match(/\sdata-mwi-msg-id="([^"]*)"/);
    return match ? match[1] : null;
}

/**
 * What makes two stored messages the same message: their visible text, with
 * the markup and whitespace runs taken out.
 *
 * A message is now recorded more than once over its life — when it is
 * rendered (see `chat-history-extender.js`'s `_recordLive`), again when the
 * game evicts it, and again whenever the game re-renders a tab's backlog. The
 * markup differs between those sightings (an id stamped on one and not the
 * other, a dungeon-tracker marker, a decorated player name), but the text a
 * player reads — timestamp, sender and message — does not. Two genuinely
 * different messages with the same text to the second from the same sender
 * collapse into one; that is the price, and it is a small one next to showing
 * every message twice.
 *
 * Always computed from {@link serializeMessage} output, never from a live
 * node's `textContent`, so entity escaping is the same on both sides of any
 * comparison.
 *
 * @param {string} html - One message, as {@link serializeMessage} produced it
 * @returns {string|null} The identity, or null when the markup carries no text
 */
export function messageIdentity(html) {
    if (typeof html !== 'string' || !html) return null;
    // `record()` compares a new message against every one a tab holds, and a
    // tab switch records a whole backlog at once; the same strings come round
    // again and again, so they are only stripped once.
    const cached = identityMemo.get(html);
    if (cached !== undefined) return cached;
    const text = html
        .replace(RANK_BADGE_MARKUP_RE, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (identityMemo.size >= IDENTITY_MEMO_MAX) identityMemo.clear();
    identityMemo.set(html, text || null);
    return text || null;
}

/**
 * A rank badge as stored by builds that serialized it: a span holding an icon and the rank, no nested span.
 * Stripped before {@link messageIdentity} reads the text, so those records still match the same line unbadged.
 */
const RANK_BADGE_MARKUP_RE = new RegExp(String.raw`<span\b[^>]*\s${RANK_BADGE_ATTR}\b[^>]*>[\s\S]*?<\/span>`, 'g');

/** Bound on {@link messageIdentity}'s memo: a little over one full tab set's worth of messages. */
const IDENTITY_MEMO_MAX = 4000;

/** @type {Map<string, string|null>} */
const identityMemo = new Map();

/**
 * A live-line count made safe to add to the cap.
 * @param {*} count
 * @returns {number} 0..{@link MAX_LIVE_ALLOWANCE}; the allowance itself when not a number
 */
function clampLive(count) {
    if (typeof count !== 'number' || !Number.isFinite(count)) return MAX_LIVE_ALLOWANCE;
    return Math.max(0, Math.min(Math.floor(count), MAX_LIVE_ALLOWANCE));
}

/**
 * The live counts a stored record carries.
 * @param {*} record - Whatever the read returned
 * @returns {Record<string, number>}
 */
function liveFromRecord(record) {
    const stored = record && record.v === RECORD_VERSION && record.live;
    if (!stored || typeof stored !== 'object') return {};
    const live = {};
    for (const [key, count] of Object.entries(stored)) {
        if (typeof count === 'number' && Number.isFinite(count)) live[key] = clampLive(count);
    }
    return live;
}

/**
 * Apply the three caps to a `{tabKey: [html]}` map, oldest-first, in place.
 *
 * Per-tab count first (cheap, and the cap the user's setting talks about), then
 * the total: the total's victim is always the oldest message of whichever tab
 * is currently largest, so a chatty channel is trimmed before a quiet one loses
 * anything.
 *
 * The per-tab cap counts lines *older than the game's live backlog*: a tab's
 * list may hold `perTab` such lines plus the lines the game is still showing
 * live, because those are recorded as they render and would otherwise eat the
 * cap — with the game keeping L lines live, only `perTab - L` older ones would
 * survive a reload. `liveCounts` says how many each tab has live; a tab absent
 * from it gets {@link MAX_LIVE_ALLOWANCE}, so a tab that is not mounted never
 * loses history it cannot account for. Omit `liveCounts` for a plain cap.
 *
 * @param {Record<string, Array<string>>} tabs - Mutated
 * @param {number} perTab - Message cap per tab, not counting live lines
 * @param {Record<string, number>|null} [liveCounts] - Live lines per tab key
 * @returns {Record<string, Array<string>>} The same object
 */
export function applyCaps(tabs, perTab = MAX_MESSAGES_PER_TAB, liveCounts = null) {
    const base = Math.max(1, Math.min(perTab || MAX_MESSAGES_PER_TAB, MAX_MESSAGES_PER_TAB));

    let total = 0;
    for (const key of Object.keys(tabs)) {
        let list = tabs[key];
        if (!Array.isArray(list)) {
            delete tabs[key];
            continue;
        }
        // Everything this module writes is a non-empty string, but a record
        // read back off disk is whatever is on disk — and one entry that is not
        // a string makes `html.length` throw out of here, which is the eviction
        // handler on the recording path and an unhandled rejection on the load
        // path. A corrupt record costs its own contents, nothing else.
        if (list.some((html) => typeof html !== 'string')) {
            list = list.filter((html) => typeof html === 'string');
            tabs[key] = list;
        }
        const limit = liveCounts ? base + clampLive(liveCounts[key]) : base;
        if (list.length > limit) list.splice(0, list.length - limit);
        if (!list.length) {
            delete tabs[key];
            continue;
        }
        total += list.reduce((sum, html) => sum + html.length, 0);
    }

    // Guard the loop as well as the budget: an empty map cannot get smaller, and
    // a run of zero-length entries must not spin.
    let guard = 0;
    while (total > MAX_TOTAL_CHARS && guard++ < 100000) {
        let biggestKey = null;
        let biggestSize = -1;
        for (const [key, list] of Object.entries(tabs)) {
            if (!list.length) continue;
            const size = list.reduce((sum, html) => sum + html.length, 0);
            if (size > biggestSize) {
                biggestSize = size;
                biggestKey = key;
            }
        }
        if (!biggestKey) break;
        total -= tabs[biggestKey].shift().length;
        if (!tabs[biggestKey].length) delete tabs[biggestKey];
    }

    return tabs;
}

/**
 * Put one message into a tab's list: update it in place when the list already
 * holds it (see {@link messageIdentity}), append it otherwise.
 *
 * The copy carrying the game's id is kept over one that lacks it: the id is
 * what a later deletion finds it by.
 *
 * @param {Array<string>} list - Mutated
 * @param {string} html - As produced by {@link serializeMessage}
 * @returns {'same'|'updated'|'appended'} What happened to the list
 */
function mergeMessage(list, html) {
    const identity = messageIdentity(html);
    if (identity) {
        for (let i = list.length - 1; i >= 0; i -= 1) {
            if (messageIdentity(list[i]) !== identity) continue;
            if (list[i] === html) return 'same';
            if (extractStoredMessageId(list[i]) && !extractStoredMessageId(html)) return 'same';
            list[i] = html;
            return 'updated';
        }
    }
    list.push(html);
    return 'appended';
}

/**
 * Merge one tab's list into another without losing either's order.
 *
 * Every line of `incoming` the base already holds is an anchor. A line the base
 * lacks goes just before the next anchor after it — so an old line another tab
 * has since trimmed goes back to the front, where the cap takes it again, and a
 * line between two shared ones stays between them — or, with no anchor after
 * it, at the end: after whatever another tab wrote meanwhile, which is the
 * order the writes landed in. With no anchor at all the lists are disjoint, and
 * `incomingNewer` decides which goes first. Duplicates fold as
 * {@link mergeMessage} folds them.
 *
 * @param {Array<string>} base - Not mutated
 * @param {Array<string>} incoming - Not mutated
 * @param {boolean} [incomingNewer=true] - Order for two lists that share no line
 * @returns {Array<string>} A fresh list
 */
export function mergeLists(base, incoming, incomingNewer = true) {
    const out = [];
    const index = new Map();
    for (const html of base || []) {
        if (typeof html !== 'string') continue;
        const identity = messageIdentity(html);
        if (identity && index.has(identity)) continue;
        if (identity) index.set(identity, out.length);
        out.push(html);
    }

    const before = new Map();
    const added = new Set();
    let waiting = [];
    let anchored = false;
    for (const html of incoming || []) {
        if (typeof html !== 'string' || !html) continue;
        const identity = messageIdentity(html);
        const at = identity ? index.get(identity) : undefined;
        if (at !== undefined) {
            anchored = true;
            if (waiting.length) {
                before.set(at, [...(before.get(at) || []), ...waiting]);
                waiting = [];
            }
            const held = out[at];
            if (held !== html && !(extractStoredMessageId(held) && !extractStoredMessageId(html))) out[at] = html;
            continue;
        }
        if (identity) {
            if (added.has(identity)) continue;
            added.add(identity);
        }
        waiting.push(html);
    }

    const merged = [];
    if (!anchored && !incomingNewer) merged.push(...waiting);
    out.forEach((html, i) => {
        if (before.has(i)) merged.push(...before.get(i));
        merged.push(html);
    });
    if (anchored || incomingNewer) merged.push(...waiting);
    return merged;
}

/** Message ids a shared record remembers as deleted, newest last. */
const MAX_TOMBSTONES = 500;

/** The last time {@link decisionTime} handed out. */
let lastDecisionTime = 0;

/**
 * The time a moderation event arrived, for ordering it against others.
 *
 * Wall-clock milliseconds, so game tabs on one machine compare, but never
 * repeated within one page: a deletion and its undelete arriving in the same
 * millisecond still read in the order they came.
 * @returns {number}
 */
function decisionTime() {
    lastDecisionTime = Math.max(Date.now(), lastDecisionTime + 1);
    return lastDecisionTime;
}

/**
 * Whether one moderation decision supersedes another for the same id: the later
 * one, and at the same instant the deletion.
 * @param {{deleted: boolean, at: number}} a
 * @param {{deleted: boolean, at: number}} b
 * @returns {boolean}
 */
function newerDecision(a, b) {
    return a.at > b.at || (a.at === b.at && a.deleted && !b.deleted);
}

/**
 * The deletion tombstones a stored record carries.
 * @param {*} record
 * @returns {Array<string>}
 */
function tombstonesFrom(record) {
    const stored = record && record.v === RECORD_VERSION && Array.isArray(record.deleted) ? record.deleted : [];
    return stored.filter((id) => typeof id === 'string' && id);
}

/**
 * Two tombstone lists as one, oldest dropped past {@link MAX_TOMBSTONES}.
 * @param {Array<string>} a
 * @param {Array<string>} b
 * @returns {Array<string>}
 */
function unionTombstones(a, b) {
    const seen = new Set();
    const out = [];
    for (const id of [...(a || []), ...(b || [])]) {
        if (typeof id !== 'string' || !id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out.slice(-MAX_TOMBSTONES);
}

/**
 * When each id's newest moderation decision was taken, as a stored record holds it.
 * @param {*} record
 * @returns {Record<string, number>}
 */
function decidedAtFrom(record) {
    const stored =
        record && record.v === RECORD_VERSION && record.decidedAt && typeof record.decidedAt === 'object'
            ? record.decidedAt
            : {};
    const out = {};
    for (const [id, at] of Object.entries(stored)) {
        if (id && typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
}

/**
 * Apply moderation decisions to a record's tombstones, the newest decision per id winning.
 *
 * Every decision carries the time the game tab saw its event, and the record
 * keeps the time of the newest one it applied per id (`decidedAt`). A decision
 * older than that is ignored: a game tab that missed a later undelete cannot
 * put back an old deletion, and one that missed a later deletion cannot undo it
 * with an old undelete. At the same instant a deletion wins. A tombstone stored
 * with no time (a record written before the times were kept) counts as time 0.
 *
 * Undeletes keep their time too, up to {@link MAX_TOMBSTONES} of the newest, so
 * an old deletion still loses to them once their tombstone is gone.
 *
 * @param {Array<string>} storedDeleted - The record's tombstones, oldest first
 * @param {Record<string, number>} storedAt - The record's `decidedAt`
 * @param {Array<{id: string, deleted: boolean, at: number}>} [decisions]
 * @returns {{deleted: Array<string>, decidedAt: Record<string, number>}}
 */
export function applyDecisions(storedDeleted, storedAt, decisions) {
    const decidedAt = { ...storedAt };
    const deleted = new Set(storedDeleted);
    const ordered = (decisions || [])
        .filter((d) => d && typeof d.id === 'string' && d.id && typeof d.at === 'number' && Number.isFinite(d.at))
        .sort((a, b) => a.at - b.at || Number(a.deleted) - Number(b.deleted));
    for (const decision of ordered) {
        const prior = decidedAt[decision.id] ?? (deleted.has(decision.id) ? 0 : -Infinity);
        if (decision.at < prior || (decision.at === prior && !decision.deleted)) continue;
        decidedAt[decision.id] = decision.at;
        // Re-added at the end: the newest tombstone is the last the cap drops.
        deleted.delete(decision.id);
        if (decision.deleted) deleted.add(decision.id);
    }
    const kept = [...deleted].slice(-MAX_TOMBSTONES);
    const undone = Object.entries(decidedAt)
        .filter(([id]) => !deleted.has(id))
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TOMBSTONES);
    const out = {};
    for (const id of kept) if (decidedAt[id] !== undefined) out[id] = decidedAt[id];
    for (const [id, at] of undone) out[id] = at;
    return { deleted: kept, decidedAt: out };
}

/**
 * Remove every message a tombstone names, in place.
 * @param {Record<string, Array<string>>} tabs - Mutated
 * @param {Set<string>} deleted
 */
function dropDeleted(tabs, deleted) {
    if (!deleted.size) return;
    for (const [key, list] of Object.entries(tabs)) {
        const kept = list.filter((html) => !deleted.has(extractStoredMessageId(html)));
        if (kept.length) tabs[key] = kept;
        else delete tabs[key];
    }
}

/**
 * A shared record with one writer's lines merged in: what `storage.update`
 * writes, computed from what the transaction read.
 *
 * Live counts take the larger of the stored and the incoming figure. Several
 * game tabs show the same channel, and the game keeps about the same backlog in
 * each; the larger one never trims history a tab still needs, and the figure is
 * bounded by {@link MAX_LIVE_ALLOWANCE} whatever it says.
 *
 * `at` remembers, per tab, the newest time a writer merged into it. It is only
 * consulted for two lists that share no line (see {@link mergeLists}): a
 * character's record from last week merged in after this week's lines goes
 * first, not last.
 *
 * Deletions and undeletes arrive as `decisions`, each with the time its event
 * was seen; see {@link applyDecisions} for how a stale one is kept from
 * overriding a newer one.
 *
 * @param {*} stored - The record as read, or undefined
 * @param {{tabs: Record<string, Array<string>>, live?: Record<string, number>,
 *   decisions?: Array<{id: string, deleted: boolean, at: number}>, at: number}} incoming
 * @param {number} perTab - Message cap per tab
 * @returns {{v: number, savedAt: number, tabs: Record<string, Array<string>>, live: Record<string, number>,
 *   deleted: Array<string>, decidedAt: Record<string, number>, at: Record<string, number>}}
 */
export function mergeSharedRecord(stored, incoming, perTab = MAX_MESSAGES_PER_TAB) {
    const live = liveFromRecord(stored);
    for (const [key, count] of Object.entries(incoming.live || {})) {
        if (typeof count === 'number' && Number.isFinite(count)) live[key] = Math.max(live[key] ?? 0, clampLive(count));
    }
    const tabs = tabsFromRecord(stored, perTab, live);

    const storedAt =
        stored && stored.v === RECORD_VERSION && stored.at && typeof stored.at === 'object' ? stored.at : {};
    const at = {};
    for (const [key, value] of Object.entries(storedAt)) {
        if (typeof value === 'number' && Number.isFinite(value)) at[key] = value;
    }
    const incomingAt = Number(incoming.at) || 0;
    for (const [key, list] of Object.entries(incoming.tabs || {})) {
        if (!String(key).startsWith(TAB_KEY_PREFIX) || !Array.isArray(list)) continue;
        tabs[key] = mergeLists(tabs[key] || [], list, incomingAt >= (at[key] ?? 0));
        at[key] = Math.max(at[key] ?? 0, incomingAt);
        if (!tabs[key].length) delete tabs[key];
    }

    // An undelete takes its id back out: the line may be recorded again.
    const { deleted, decidedAt } = applyDecisions(
        unionTombstones(tombstonesFrom(stored), []),
        decidedAtFrom(stored),
        incoming.decisions
    );
    dropDeleted(tabs, new Set(deleted));
    applyCaps(tabs, perTab, live);

    const keptAt = {};
    for (const key of Object.keys(tabs)) if (at[key] !== undefined) keptAt[key] = at[key];
    return {
        v: RECORD_VERSION,
        savedAt: Date.now(),
        tabs,
        live: liveForRecord(live, tabs),
        deleted,
        decidedAt,
        at: keptAt,
    };
}

/**
 * Read-merge-write a shared record in one transaction.
 *
 * The call into storage is made before this function's first `await`, so a
 * page-close listener that calls it still opens its transaction in time. A
 * storage without `update` (a test double) gets a read and a write instead —
 * not atomic across tabs, and nothing the real storage does.
 *
 * @param {string} key
 * @param {(current: *) => *} mutate - Synchronous; the value to write
 * @returns {Promise<{written: boolean, value: *}|null>} What is stored, or null when nothing could be
 */
async function updateRecord(key, mutate) {
    if (typeof storage.update === 'function') {
        try {
            return await storage.update(key, mutate, CHAT_HISTORY_STORE);
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not update a shared chat history record:', error);
            return null;
        }
    }
    const read = await readStoredRecord(key);
    if (!read.ok) return null;
    try {
        const value = mutate(read.record ?? undefined);
        if (value === undefined) return { written: false, value: read.record };
        return (await storage.set(key, value, CHAT_HISTORY_STORE, true)) === true ? { written: true, value } : null;
    } catch (error) {
        console.error('[ChatHistoryPersistence] Could not update a shared chat history record:', error);
        return null;
    }
}

/** The account-wide record of the public channels. */
export const PUBLIC_RECORD_KEY = `${CHAT_HISTORY_KEY_BASE}_public`;

/**
 * The record of one guild's chat.
 * @param {string|number} guildId
 * @returns {string}
 */
export function guildRecordKey(guildId) {
    return `${CHAT_HISTORY_KEY_BASE}_guild_${guildId}`;
}

/** The game's guild channel. */
const GUILD_CHANNEL = '/chat_channel_types/guild';

/**
 * Channels every character sees the same lines in. Party, Whisper, Local and Mod
 * are not here: Party and Whisper are the character's own, and Local and Mod are
 * not known well enough to share — kept per character until they are.
 */
const PUBLIC_CHANNELS = new Set(
    [
        'global',
        'general',
        'trade',
        'beginner',
        'recruit',
        'help',
        'ironcow',
        'chinese',
        'russian',
        'korean',
        'japanese',
        'portuguese',
        'spanish',
        'french',
        'german',
    ].map((name) => `/chat_channel_types/${name}`)
);

/**
 * Which kind of record a tab's history belongs in.
 *
 * Only a `tab2:ch:` key is shared: its channel was named by the tab's
 * `data-mention-channel`, which `chatTabKey` trusts only when no other tab in
 * the strip carries the same one. A `tab2:name:` key is just the button's text,
 * which a whisper with a player called `Help`, `Trade` or `Guild` reads the same
 * as the channel, so it stays with the character: sharing it would put a
 * private conversation in every character's tab, or every guildmate's. The
 * cost is that a public room named only by its text (the language rooms, Help,
 * and every tab while the mention tracker is off) is kept per character, as all
 * history was before the shared records.
 *
 * @param {string} tabKey - From `chatTabKey`
 * @returns {'public'|'guild'|'character'}
 */
export function tabScope(tabKey) {
    const key = String(tabKey || '');
    const channelPrefix = `${TAB_KEY_PREFIX}ch:`;
    if (!key.startsWith(channelPrefix)) return 'character';
    const channel = key.slice(channelPrefix.length);
    if (channel === GUILD_CHANNEL) return 'guild';
    return PUBLIC_CHANNELS.has(channel) ? 'public' : 'character';
}

/**
 * The logged-in character's guild id, or null when it is not known.
 *
 * Read from `init_character_data` as the data manager holds it: the character's
 * own `guildCharacterMap` row (the same `guildID` the guild XP tracker keys its
 * records by), then `guild.id`. A `characterData` belonging to someone else —
 * it is replaced after `character_switched` fires — answers null rather than
 * the departing character's guild.
 *
 * @returns {string|null}
 */
export function currentGuildId() {
    try {
        const characterId = dataManager.getCurrentCharacterId?.();
        const data = dataManager.characterData;
        if (!characterId || !data) return null;
        const owner = data.character?.id;
        if (owner != null && String(owner) !== String(characterId)) return null;
        const guildId = data.guildCharacterMap?.[characterId]?.guildID ?? data.guild?.id ?? null;
        return guildId == null || guildId === '' ? null : String(guildId);
    } catch {
        return null;
    }
}

/**
 * Where each record a session reads and writes lives. Fixed when the session's
 * read starts, so a write after a character switch still names the character
 * it was recorded for.
 * @typedef {{charKey: string, guildKey: string|null}} RecordContext
 */

/**
 * The record a tab's history is written to.
 * @param {string} tabKey
 * @param {RecordContext} context
 * @returns {string}
 */
export function recordKeyFor(tabKey, context) {
    const scope = tabScope(tabKey);
    if (scope === 'public') return PUBLIC_RECORD_KEY;
    if (scope === 'guild' && context.guildKey) return context.guildKey;
    return context.charKey;
}

/**
 * Split a `{tabKey: [html]}` map by the record each tab is written to.
 * @param {Record<string, Array<string>>} tabs - Lists are shared, not copied
 * @param {RecordContext} context
 * @returns {Record<string, Record<string, Array<string>>>}
 */
function groupByRecord(tabs, context) {
    const groups = {};
    for (const [tabKey, list] of Object.entries(tabs || {})) {
        const key = recordKeyFor(tabKey, context);
        if (!groups[key]) groups[key] = {};
        groups[key][tabKey] = list;
    }
    return groups;
}

/**
 * The guild-tab lines a character's own record holds back because nothing shows
 * which guild they came from; see {@link ChatHistoryPersistence#load}.
 * @param {*} record - The character's record as read
 * @param {number} perTab - Message cap per tab
 * @returns {Record<string, Array<string>>}
 */
function guildLegacyFrom(record, perTab) {
    if (!record || record.v !== RECORD_VERSION || !record.guildLegacy || typeof record.guildLegacy !== 'object') {
        return {};
    }
    const held = {};
    for (const [tabKey, list] of Object.entries(
        tabsFromRecord({ v: RECORD_VERSION, tabs: record.guildLegacy }, perTab, {})
    )) {
        if (tabScope(tabKey) === 'guild' && list.length) held[tabKey] = list;
    }
    return held;
}

/**
 * Whether a character's held guild lines are provably from a guild's chat: one
 * of them is also in that guild's shared record, which only that guild's members
 * write. A line's identity is its sender, time and text, and a player is in one
 * guild at a time, so two guilds never share one.
 * @param {Record<string, Array<string>>} held
 * @param {*} guildRecord - The guild's shared record as read
 * @returns {boolean}
 */
function sharesGuildLine(held, guildRecord) {
    const known = new Set();
    const tabs = guildRecord && guildRecord.v === RECORD_VERSION && guildRecord.tabs ? guildRecord.tabs : {};
    for (const list of Object.values(tabs)) {
        if (!Array.isArray(list)) continue;
        for (const html of list) {
            const identity = messageIdentity(html);
            if (identity) known.add(identity);
        }
    }
    if (!known.size) return false;
    return Object.values(held).some((list) => list.some((html) => known.has(messageIdentity(html))));
}

/**
 * Wait for a promise to settle, whichever way, without letting it throw here.
 * @param {Promise<*>|null} promise
 * @returns {Promise<void>}
 */
async function settleQuietly(promise) {
    if (!promise) return;
    try {
        await promise;
    } catch {
        // Its own caller reports it; a reader only needs it to have finished.
    }
}

/**
 * Read the stored record, telling "nothing stored" apart from "could not read".
 *
 * `storage.get` answers a failed request, an aborted transaction and a missing
 * connection with its default, which is exactly what "nothing stored" looks
 * like — and a writer that takes one for the other replaces the history with
 * whatever it holds. `storage.tryGet` answers those with `null`; so does a
 * read that throws here.
 *
 * @param {string} key - The character's record key
 * @returns {Promise<{ok: boolean, record: *}>} `ok` false when the read cannot be trusted
 */
async function readStoredRecord(key) {
    try {
        const read = await storage.tryGet(key, CHAT_HISTORY_STORE);
        if (!read) return { ok: false, record: null };
        return { ok: true, record: read.found ? read.value : null };
    } catch (error) {
        console.error('[ChatHistoryPersistence] Could not read stored chat history:', error);
        return { ok: false, record: null };
    }
}

/**
 * The tabs of a stored record this build can use, or an empty map.
 * @param {*} record - Whatever the read returned
 * @param {number} perTab - Message cap per tab
 * @param {Record<string, number>} live - Live lines per tab key
 * @returns {Record<string, Array<string>>}
 */
function tabsFromRecord(record, perTab, live) {
    // A record from a version we do not understand is discarded rather than
    // half-read; the cost is one session's history.
    const stored = record && record.v === RECORD_VERSION && record.tabs ? record.tabs : {};
    const tabs = dropForeignKeys(stored);
    // Builds before rank badges were left out of the identity stored one line
    // up to once per badge state it was seen in. Folded here, those copies stop
    // rendering twice and stop holding the cap against older history.
    for (const [key, list] of Object.entries(tabs)) {
        if (!Array.isArray(list)) continue;
        const unique = [];
        for (const html of list) {
            if (typeof html === 'string') mergeMessage(unique, html);
        }
        tabs[key] = unique;
    }
    return applyCaps(tabs, perTab, live);
}

/**
 * The live counts to write beside a record: only for tabs it holds.
 * @param {Record<string, number>} live
 * @param {Record<string, Array<string>>} tabs
 * @returns {Record<string, number>}
 */
function liveForRecord(live, tabs) {
    const out = {};
    for (const key of Object.keys(tabs)) {
        if (typeof live[key] === 'number') out[key] = live[key];
    }
    return out;
}

/**
 * The records of preserved chat — the character's own and the shared ones — and
 * the reads and writes over them.
 *
 * ## The working record is not the record until the first read has merged
 *
 * Messages are recorded as soon as they render, which is before the read of
 * what is already on disk comes back — the backlog a pane shows when its
 * handler attaches is recorded synchronously, and the read never is. Until
 * `load()` has folded that read in, {@link ChatHistoryPersistence#tabs} holds
 * only this session's lines, and writing it would replace the character's
 * whole record — every older message and every other tab — with them. So
 * nothing writes `tabs` as the record until `loaded` is set:
 *
 * - the coalescing timer does nothing, and `load()` schedules the write once it
 *   has merged;
 * - an explicit flush (disable, character switch, page hide, socket close)
 *   reads the record itself, merges a copy of what this session recorded into
 *   it, and writes that — see {@link ChatHistoryPersistence#_mergeIntoStored};
 * - a read that fails, is unreadable (`storage.tryGet` answering null) or never
 *   returns means nothing is written at all. What
 *   this session recorded stays in memory, where a later successful read
 *   still merges it; it is lost only if the page ends first, and the record on
 *   disk is untouched either way.
 */
class ChatHistoryPersistence {
    constructor() {
        /** @type {Record<string, Array<string>>|null} Working record, null until loaded or first recorded */
        this.tabs = null;
        /** @type {Record<string, Array<string>>|null} What the last read found on disk; what a restore renders */
        this.snapshot = null;
        this.enabled = false;
        this.writeTimer = null;
        this.loadPromise = null;
        /** @type {Set<() => void>} Called once per successful read; see {@link ChatHistoryPersistence#onLoaded} */
        this.loadListeners = new Set();
        /** Whether `tabs` has had the stored record merged into it; see the class doc. */
        this.loaded = false;
        /** Whether `tabs` holds something no write has been issued for yet. */
        this.dirty = false;
        /**
         * The last session's final write, while it is still landing. Survives
         * `reset()` on purpose: it is the next session's reads that wait on it.
         * @type {Promise<boolean>|null}
         */
        this.finalFlush = null;
        /**
         * How many lines each tab last showed live: the cap's allowance. Written
         * beside the record (`live`) so a tab that is not mounted next session
         * keeps what it had. Reported by the extender through
         * {@link ChatHistoryPersistence#setLiveCount}.
         * @type {Record<string, number>}
         */
        this.liveCounts = {};
        this.getMaxHistory = () => MAX_MESSAGES_PER_TAB;
        /** @type {RecordContext|null} Which records this session reads and writes; set when its read starts */
        this.context = null;
        /** @type {Set<string>} Tabs recorded into or purged since their record was last written */
        this.dirtyTabs = new Set();
        /**
         * Deletions and undeletes this session saw for the shared records that no
         * write has landed yet, per tab: the newest decision per id, with the time
         * its event arrived. See {@link applyDecisions}.
         * @type {Map<string, Map<string, {deleted: boolean, at: number}>>}
         */
        this.decisions = new Map();
        /**
         * A character's copies of shared tabs whose move into the shared record
         * failed: written back into its own record so nothing is lost before the
         * next load tries again.
         * @type {Record<string, Array<string>>|null}
         */
        this.heldLegacy = null;
        /**
         * Guild-tab lines from before the shared records, which name no guild:
         * kept in the character's own record (`guildLegacy`) and shown only to
         * that character, until a guild's record proves they are its lines.
         * Never in `tabs`, so no write puts them in a guild's record.
         * @type {Record<string, Array<string>>|null}
         */
        this.guildLegacy = null;
        /**
         * A guild left mid-session: its lines and decisions, per record key, until
         * a write lands them there. See {@link ChatHistoryPersistence#noteGuildRoster}.
         * @type {Map<string, {tabs: Record<string, Array<string>>, live: Record<string, number>,
         *   decisions: Array<{id: string, deleted: boolean, at: number}>}>}
         */
        this.heldGuildWrites = new Map();
        /** @type {string|null} The guild the socket last named for this character, over `characterData`'s */
        this.guildOverride = null;
        /** @type {Record<string, number>} Live allowances the shared records hold, as last read or written */
        this.sharedLive = {};
    }

    /**
     * Where this session's records are, as of now.
     * @returns {RecordContext}
     */
    _contextNow() {
        const guildId = this.guildOverride ?? currentGuildId();
        return {
            charKey: characterKey(CHAT_HISTORY_KEY_BASE),
            guildKey: guildId ? guildRecordKey(guildId) : null,
        };
    }

    /**
     * Apply the caps to the working record one record's tabs at a time: the
     * total is a per-record budget, and the working record holds several.
     */
    _capMemory() {
        if (!this.tabs) return;
        const context = this.context || this._contextNow();
        const perTab = this.getMaxHistory();
        // A shared tab's record keeps the larger allowance of the game tabs showing
        // it; the working record keeps the same, or a tab switch would restore
        // fewer lines than are stored.
        const live = { ...this.liveCounts };
        for (const [tabKey, count] of Object.entries(this.sharedLive)) {
            live[tabKey] = Math.max(live[tabKey] ?? 0, count);
        }
        for (const group of Object.values(groupByRecord(this.tabs, context))) {
            const keys = Object.keys(group);
            applyCaps(group, perTab, live);
            for (const key of keys) {
                if (group[key]) this.tabs[key] = group[key];
                else delete this.tabs[key];
            }
        }
    }

    /**
     * Learn the character's guild from a `guild_characters_updated` roster.
     *
     * `characterData` is the login's copy and does not follow a guild change, so
     * the socket's word is kept over it. Only the character's own row counts — a
     * roster delta about another member says nothing about this one. A change
     * while a session is running writes the old guild's lines under the old
     * guild first, then drops them from the working record: the next guild's
     * record must not receive them.
     *
     * @param {Record<string, {guildID?: string|number}>|null|undefined} guildCharacterMap
     */
    noteGuildRoster(guildCharacterMap) {
        if (!this.enabled || !guildCharacterMap || typeof guildCharacterMap !== 'object') return;
        const characterId = dataManager.getCurrentCharacterId?.();
        const guildId = characterId ? guildCharacterMap[characterId]?.guildID : null;
        if (guildId == null || guildId === '') return;
        this.guildOverride = String(guildId);

        const context = this.context;
        const guildKey = guildRecordKey(this.guildOverride);
        if (!context || context.guildKey === guildKey) return;

        // The old guild's lines and moderation decisions, taken before the context
        // moves and held until a write lands them in the old guild's record: the
        // working record drops them below, and a write that failed then would
        // have nothing left to retry with.
        if (this.tabs && context.guildKey) {
            const tabs = {};
            const live = {};
            for (const [tabKey, list] of Object.entries(this.tabs)) {
                if (tabScope(tabKey) !== 'guild') continue;
                tabs[tabKey] = [...list];
                if (typeof this.liveCounts[tabKey] === 'number') live[tabKey] = this.liveCounts[tabKey];
            }
            const decisions = this._decisionsFor(context.guildKey, context);
            if (Object.keys(tabs).length || decisions.length) {
                this._holdGuildWrite(context.guildKey, { tabs, live, decisions });
                this._writeHeldGuild(context.guildKey).catch(() => {});
            }
        } else if (this.tabs) {
            // With no guild, a guild tab was the character's own (old lines no
            // guild is known for): held as such, not dropped and not handed to
            // the guild just joined.
            for (const [tabKey, list] of Object.entries(this.tabs)) {
                if (tabScope(tabKey) !== 'guild' || !list.length) continue;
                this.guildLegacy = this.guildLegacy || {};
                this.guildLegacy[tabKey] = mergeLists(this.guildLegacy[tabKey] || [], list, true);
                this.dirty = true;
            }
        }
        for (const tabKey of Object.keys(this.tabs || {})) {
            if (tabScope(tabKey) !== 'guild') continue;
            delete this.tabs[tabKey];
            if (this.snapshot) delete this.snapshot[tabKey];
            delete this.liveCounts[tabKey];
            this.dirtyTabs.delete(tabKey);
            this.decisions.delete(tabKey);
        }
        this.context = { ...context, guildKey };
    }

    /**
     * Tell the cap how many lines a tab's game pane is showing live.
     *
     * Called by the extender once per mutation batch and at restore. Takes
     * effect at the next cap; it neither dirties the record nor schedules a
     * write — the figure rides along with the next write that happens anyway.
     *
     * @param {string} tabKey
     * @param {number} count - Live message nodes in that tab's pane
     */
    setLiveCount(tabKey, count) {
        if (!this.enabled || !tabKey || !tabKey.startsWith(TAB_KEY_PREFIX)) return;
        this.liveCounts[tabKey] = clampLive(count);
    }

    /**
     * The allowance the cap currently holds for a tab, or null when none is known.
     *
     * Read by the extender at restore: before the game's backlog has rendered,
     * the saved allowance is the number of stored lines that will turn out to
     * overlap it.
     *
     * @param {string} tabKey
     * @returns {number|null}
     */
    liveCountFor(tabKey) {
        const own = this.liveCounts[tabKey];
        const shared = this.sharedLive[tabKey];
        // A shared tab is capped with the larger of the two (see `_capMemory`), so that is its allowance.
        if (typeof shared === 'number') return typeof own === 'number' ? Math.max(own, shared) : shared;
        return typeof own === 'number' ? own : null;
    }

    /**
     * Turn persistence on for a session.
     * @param {() => number} getMaxHistory - Reads the user's per-tab cap
     */
    enable(getMaxHistory) {
        this.enabled = true;
        if (typeof getMaxHistory === 'function') this.getMaxHistory = getMaxHistory;
    }

    /**
     * Be told when a read of the record succeeds.
     *
     * Fired from the owning session's read only — not for a failed read, and
     * not for a stale tail after a teardown. It exists because a read can
     * succeed for a caller (a deletion's purge) that has nothing to do with
     * the tabs a failed read left empty.
     *
     * @param {() => void} fn
     * @returns {() => void} Unsubscribe
     */
    onLoaded(fn) {
        this.loadListeners.add(fn);
        return () => this.loadListeners.delete(fn);
    }

    /**
     * Read the record, and answer with what was on disk.
     *
     * The answer is a *snapshot*, fixed at the read, and is what tells a
     * caller the read succeeded. A restore renders the working record instead
     * ({@link ChatHistoryPersistence#messagesFor}), which also holds what was
     * recorded since; it leaves out what its tab is showing live or already
     * holds in its buffer, so a message evicted during the read is not
     * rendered a second time above the buffer's clone of it.
     *
     * Never awaited on the path that makes chat usable: callers fire it and
     * fill their buffer when it lands.
     *
     * Reads three records — the character's, the public one and its guild's —
     * and answers with their tabs as one map. The first time a character's own
     * record still holds public or guild tabs (every record written before the
     * shared records existed), they are merged into the shared records first.
     * That is idempotent, so it needs no lock against another game tab doing
     * the same; the character's next write leaves them out and sets
     * `sharedMigrated`, after which there is nothing left to move.
     *
     * @returns {Promise<Record<string, Array<string>>>} What was stored, oldest first per tab
     */
    async load() {
        if (!this.enabled) return {};
        if (this.loadPromise) return this.loadPromise;

        // Whose read this is, fixed before it starts. `reset()` — the teardown
        // `chat-history-extender.disable()` runs on a character switch — nulls
        // `tabs`, `snapshot` and `loadPromise`, but it cannot cancel a read
        // already in flight with IndexedDB. Resumed afterwards, the tail below
        // put the DEPARTING character's messages back into `this.tabs`, and
        // `enable()` on the arriving character's re-initialise does not clear
        // them: their own load then folded the leftover in as "recorded while
        // the read was in flight", and the first eviction wrote the pair under
        // `characterKey()`, which by then names them. One character's chat,
        // whispers included, rendered in another's tabs and written over their
        // record for good.
        const ticket = captureOwner(this);
        // Taken now, synchronously: the keys are this character's and this
        // guild's now, and the flush to wait for is the one that was in flight
        // when this began.
        const context = this._contextNow();
        this.context = context;
        const keys = [context.charKey, PUBLIC_RECORD_KEY];
        if (context.guildKey) keys.push(context.guildKey);
        const prior = this.finalFlush;
        const loading = (async () => {
            await settleQuietly(prior);
            const reads = await Promise.all(keys.map((key) => readStoredRecord(key)));
            // Before the first thing this tail touches. The generation is what
            // catches the switch: `disable()` runs on `character_switching`,
            // which fires before `getCurrentCharacterId()` moves, so an id
            // comparison alone would still read as this character's.
            if (!stillOurs(ticket)) return {};
            // A failed read is not an empty record. Treating it as one made
            // the next write replace whatever is on disk with this session's
            // lines; left unloaded, every write goes through a fresh read.
            if (reads.some((read) => !read.ok)) {
                // Not cached: a tab mounted or a deletion purged after storage
                // recovers has to read again, or history stays unrestored and
                // the purge never reaches disk for the rest of the session. A
                // purge that arrives during the outage finds nothing loaded
                // and is not remembered; only later ones reach disk.
                // Only this read's own promise is dropped — a newer load
                // already in `loadPromise` belongs to someone else.
                if (this.loadPromise === loading) this.loadPromise = null;
                return {};
            }
            const records = Object.fromEntries(keys.map((key, i) => [key, reads[i].record]));
            const perTab = this.getMaxHistory();

            // The move into the shared records. A character's own record held
            // every tab before they existed; the shared tabs in it are merged
            // into their shared record (a merge, so two game tabs doing this at
            // once, or one doing it twice, lose and duplicate nothing) and left
            // out of the working record, so the next write of the character's
            // record drops them. One that could not be merged stays held and is
            // written back where it was.
            const own = records[context.charKey];
            const legacy = groupByRecord(tabsFromRecord(own, perTab, liveFromRecord(own)), context);
            delete legacy[context.charKey];
            this.heldLegacy = null;

            // Guild tabs in a character's record carry no guild id, and the
            // character may have changed guilds since they were written: grouped
            // under today's guild they would land in a guild that never saw them.
            // They are held in the character's own record instead, and move only
            // once that guild's record shares a line with them.
            let guildHeld = guildLegacyFrom(own, perTab);
            const heldBefore = Object.keys(guildHeld).length;
            let heldChanged = false;
            if (context.guildKey && legacy[context.guildKey]) {
                for (const [tabKey, list] of Object.entries(legacy[context.guildKey])) {
                    guildHeld[tabKey] = mergeLists(guildHeld[tabKey] || [], list, true);
                }
                delete legacy[context.guildKey];
                heldChanged = true;
            }
            if (context.guildKey && Object.keys(guildHeld).length) {
                if (sharesGuildLine(guildHeld, records[context.guildKey])) {
                    legacy[context.guildKey] = guildHeld;
                    guildHeld = {};
                    heldChanged = heldChanged || heldBefore > 0;
                }
            }
            this.guildLegacy = Object.keys(guildHeld).length ? guildHeld : null;
            if (heldChanged) this.dirty = true;

            const moving = Object.entries(legacy);
            if (moving.length) {
                const ownLive = liveFromRecord(own);
                const savedAt = Number(own?.savedAt) || 0;
                const moved = await Promise.all(
                    moving.map(([key, tabs]) =>
                        updateRecord(key, (stored) =>
                            mergeSharedRecord(stored, { tabs, live: liveForRecord(ownLive, tabs), at: savedAt }, perTab)
                        )
                    )
                );
                if (!stillOurs(ticket)) return {};
                moving.forEach(([key, tabs], i) => {
                    if (moved[i]) records[key] = moved[i].value;
                    else this.heldLegacy = { ...(this.heldLegacy || {}), ...tabs };
                });
                // The character's own record still holds the moved copies until it is written.
                this.dirty = true;
            }

            // What this session has reported wins over what was stored.
            const storedLive = {};
            for (const key of keys) Object.assign(storedLive, liveFromRecord(records[key]));
            this.liveCounts = { ...storedLive, ...this.liveCounts };
            this.sharedLive = {};
            for (const key of keys) {
                if (key !== context.charKey) Object.assign(this.sharedLive, liveFromRecord(records[key]));
            }
            // A guild change during the read moved the context on; the old
            // guild's record is no longer this session's to show.
            const current = this.context || context;
            const loaded = {};
            for (const key of keys) {
                for (const [tabKey, list] of Object.entries(tabsFromRecord(records[key], perTab, this.liveCounts))) {
                    if (recordKeyFor(tabKey, current) === key) loaded[tabKey] = list;
                }
            }
            // Taken before the merge below, which writes into `loaded` itself —
            // a snapshot taken after it held what was recorded during the read,
            // and a restore rendered those a second time.
            this.snapshot = Object.fromEntries(Object.entries(loaded).map(([key, list]) => [key, [...list]]));
            for (const [tabKey, list] of Object.entries(this.guildLegacy || {})) {
                this.snapshot[tabKey] = mergeLists(list, this.snapshot[tabKey] || [], true);
            }

            // Anything recorded while the read was in flight belongs after what
            // was on disk, not instead of it.
            const pending = this.tabs;
            this.tabs = loaded;
            this.loaded = true;
            if (pending) {
                for (const [key, list] of Object.entries(pending)) {
                    // Through the dedupe, not a blind append: a message
                    // recorded live during the read may already be on disk from
                    // the last session, which also recorded it live.
                    if (!this.tabs[key]) this.tabs[key] = [];
                    for (const html of list) mergeMessage(this.tabs[key], html);
                    if (!this.tabs[key].length) delete this.tabs[key];
                }
                this._capMemory();
            }
            // The timer stood down while the read was open; this is the write
            // it was holding back.
            if (this.dirty) this._scheduleWrite();

            for (const fn of [...this.loadListeners]) {
                try {
                    fn();
                } catch (error) {
                    console.error('[ChatHistoryPersistence] Load listener failed:', error);
                }
            }
            return this.snapshot;
        })();
        this.loadPromise = loading;

        return this.loadPromise;
    }

    /**
     * A tab's messages in the working record, once the first read has merged.
     *
     * What a restore after a tab switch renders. The snapshot `load()` answers
     * with is fixed at the first read, so it lacks every line this session
     * evicted since — and a switch empties the buffer that was showing them.
     *
     * @param {string} tabKey
     * @returns {Array<string>|null} A copy, oldest first; null before the first read has merged
     */
    messagesFor(tabKey) {
        if (!this.loaded || !this.tabs) return null;
        const held = this.guildLegacy?.[tabKey];
        // Older than anything the guild's record holds; shown ahead of it, never written into it.
        if (held) return mergeLists(held, this.tabs[tabKey] || [], true);
        return [...(this.tabs[tabKey] || [])];
    }

    /**
     * Append one message to a tab's record and schedule a write.
     * @param {string} tabKey - Stable-ish identity of the chat tab
     * @param {string} html - As produced by {@link serializeMessage}
     */
    record(tabKey, html) {
        if (!this.enabled || !tabKey || !html) return;
        // Belt and braces beside `chatTabKey`: only a key in the current
        // format names a tab rather than a slot, and nothing else may enter the
        // record — a key this build would not write is one a restore has to
        // throw away again.
        if (!tabKey.startsWith(TAB_KEY_PREFIX)) return;
        if (!this.tabs) this.tabs = {};
        if (!this.tabs[tabKey]) this.tabs[tabKey] = [];

        // The same message is offered more than once — on render, again on
        // eviction, again whenever the game re-renders a tab's backlog — so a
        // message already held is updated in place rather than appended.
        const outcome = mergeMessage(this.tabs[tabKey], html);
        if (outcome === 'same') return;
        if (outcome === 'appended') this._capMemory();
        this.dirtyTabs.add(tabKey);
        this.dirty = true;
        this._scheduleWrite();
    }

    /**
     * Write now if a write is waiting, and otherwise do nothing.
     *
     * For the moments the page or the socket is going away: the coalescing
     * timer in {@link _scheduleWrite} would otherwise take the last few
     * seconds of chat down with the page. `immediate` because a page being
     * hidden or unloaded is exactly when storage's own debounce cannot be
     * relied on to get another turn.
     *
     * @returns {Promise<boolean>} Whether a write was attempted and accepted
     */
    flushPending() {
        if (!this.dirty) return Promise.resolve(false);
        return this.flush(true);
    }

    /**
     * The last write of a session that is ending, remembered so the next
     * session's reads wait for it — see {@link ChatHistoryPersistence#finalFlush}.
     *
     * Called before `reset()`: whatever the write needs is taken synchronously
     * inside {@link flush}, so the reset on the caller's next line cannot reach
     * it. A write that is already waiting on an earlier final flush (a merge
     * whose read waits behind it) is chained, not raced.
     *
     * @returns {Promise<boolean>} Whether the final write was accepted
     */
    flushForTeardown() {
        const write = this.enabled && this.tabs ? this.flush(true) : Promise.resolve(false);
        const tracked = (async () => {
            try {
                return await write;
            } catch {
                return false;
            } finally {
                if (this.finalFlush === tracked) this.finalFlush = null;
            }
        })();
        this.finalFlush = tracked;
        return tracked;
    }

    /**
     * Coalesce the burst of evictions a busy channel produces into one write.
     * Stands down until the first read has merged — `load()` reschedules.
     */
    _scheduleWrite() {
        if (this.writeTimer) return;
        this.writeTimer = setTimeout(() => {
            this.writeTimer = null;
            if (this.loaded) this.flush();
        }, WRITE_DEBOUNCE_MS);
    }

    /**
     * Write the record now.
     * @param {boolean} [immediate=false] - Skip storage's own write debounce
     * @returns {Promise<boolean>} Whether the write was attempted and accepted
     */
    async flush(immediate = false) {
        if (!this.enabled || !this.tabs) return false;
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }

        // A recorder that keeps writing into a full quota just fails on every
        // flush; chat history is the most disposable thing in the database, so
        // it stands down first.
        if (storage.isQuotaExceeded?.()) return false;

        if (!this.loaded) return this._mergeIntoStored(immediate);

        // Everything up to the writes is synchronous: the page-close listener
        // and a guild change both rely on the writes being issued, against this
        // context, before this returns.
        const context = this.context;
        this._capMemory();
        const groups = groupByRecord(this.tabs, context);
        const sharedKeys = new Set();
        for (const tabKey of this.dirtyTabs) {
            const key = recordKeyFor(tabKey, context);
            if (key !== context.charKey) sharedKeys.add(key);
        }
        // Cleared before the await so a line recorded while the write is in
        // flight marks the record dirty again; restored if the write fails.
        const dirtyTabs = this.dirtyTabs;
        this.dirtyTabs = new Set();
        this.dirty = false;
        const ticket = captureOwner(this);

        // The character's own record has one writer and is written whole, as it
        // always was — and on every flush, because the first one after a load
        // that moved shared tabs out is what removes them from it.
        const ownTabs = { ...(this.heldLegacy || {}), ...(groups[context.charKey] || {}) };
        const writes = [this._writeOwn(context.charKey, ownTabs, immediate)];
        for (const key of sharedKeys) {
            if (groups[key] || this._decisionsFor(key, context).length) {
                writes.push(this._writeShared(key, groups[key] || {}, context, ticket));
            }
        }
        for (const key of this.heldGuildWrites.keys()) writes.push(this._writeHeldGuild(key));

        const accepted = (await Promise.all(writes)).every(Boolean);
        if (!accepted && stillOurs(ticket)) {
            this.dirty = true;
            for (const tabKey of dirtyTabs) this.dirtyTabs.add(tabKey);
        }
        return accepted;
    }

    /**
     * Write the character's own record whole.
     * @param {string} key
     * @param {Record<string, Array<string>>} tabs
     * @param {boolean} immediate - Skip storage's own write debounce
     * @returns {Promise<boolean>} Whether the write was accepted
     */
    async _writeOwn(key, tabs, immediate) {
        try {
            // `set` reports a refused write by resolving false, not by throwing.
            return (
                (await storage.set(
                    key,
                    {
                        v: RECORD_VERSION,
                        savedAt: Date.now(),
                        tabs,
                        live: liveForRecord(this.liveCounts, tabs),
                        // Marks the move into the shared records as done; see `load()`.
                        sharedMigrated: !this.heldLegacy,
                        ...(this.guildLegacy ? { guildLegacy: this.guildLegacy } : {}),
                    },
                    CHAT_HISTORY_STORE,
                    immediate
                )) === true
            );
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not write chat history:', error);
            return false;
        }
    }

    /**
     * Keep a left guild's lines for its record until a write lands them, folded
     * into whatever is already held for it.
     * @param {string} key - The old guild's record key
     * @param {{tabs: Record<string, Array<string>>, live: Record<string, number>,
     *   decisions: Array<{id: string, deleted: boolean, at: number}>}} snapshot
     */
    _holdGuildWrite(key, snapshot) {
        const held = this.heldGuildWrites.get(key);
        if (!held) {
            this.heldGuildWrites.set(key, snapshot);
            return;
        }
        const tabs = { ...held.tabs };
        for (const [tabKey, list] of Object.entries(snapshot.tabs)) {
            tabs[tabKey] = mergeLists(tabs[tabKey] || [], list, true);
        }
        const live = { ...held.live };
        for (const [tabKey, count] of Object.entries(snapshot.live)) {
            live[tabKey] = Math.max(live[tabKey] ?? 0, count);
        }
        this.heldGuildWrites.set(key, { tabs, live, decisions: [...held.decisions, ...snapshot.decisions] });
    }

    /**
     * Write what is held for a left guild into its record; forgotten once landed,
     * and kept, with a write scheduled, when it is not.
     * @param {string} key - The old guild's record key
     * @returns {Promise<boolean>} Whether it landed (true when nothing was held)
     */
    async _writeHeldGuild(key) {
        const held = this.heldGuildWrites.get(key);
        if (!held) return true;
        const perTab = this.getMaxHistory();
        const ticket = captureOwner(this);
        const incoming = { tabs: held.tabs, live: held.live, decisions: held.decisions, at: Date.now() };
        const result = await updateRecord(key, (stored) => mergeSharedRecord(stored, incoming, perTab));
        if (result) {
            // Something held since this was sent is newer, and waits for its own write.
            if (this.heldGuildWrites.get(key) === held) this.heldGuildWrites.delete(key);
            return true;
        }
        if (stillOurs(ticket)) {
            this.dirty = true;
            this._scheduleWrite();
        }
        return false;
    }

    /**
     * The moderation decisions no write has landed yet for the tabs that live in
     * one record, the newest per id.
     * @param {string} key - Record key
     * @param {RecordContext} context
     * @returns {Array<{tabKey: string, id: string, deleted: boolean, at: number}>}
     */
    _decisionsFor(key, context) {
        const byId = new Map();
        for (const [tabKey, ids] of this.decisions) {
            if (recordKeyFor(tabKey, context) !== key) continue;
            for (const [id, decision] of ids) {
                const held = byId.get(id);
                if (!held || newerDecision(decision, held)) byId.set(id, { tabKey, id, ...decision });
            }
        }
        return [...byId.values()];
    }

    /**
     * Remember a deletion or an undelete for a shared tab, unless a newer one for
     * the same id is already held.
     * @param {string} tabKey
     * @param {string} id
     * @param {boolean} deleted
     * @param {number} at - When its event arrived
     */
    _noteDecision(tabKey, id, deleted, at) {
        const ids = this.decisions.get(tabKey) || new Map();
        const held = ids.get(id);
        if (held && !newerDecision({ deleted, at }, held)) return;
        ids.delete(id);
        ids.set(id, { deleted, at });
        // Bounded like the record's own tombstones; the oldest go first.
        while (ids.size > MAX_TOMBSTONES) ids.delete(ids.keys().next().value);
        this.decisions.set(tabKey, ids);
    }

    /**
     * Forget the decisions a write landed, so later writes stop resending them.
     * One replaced since it was sent is newer than what landed, and stays.
     * @param {Array<{tabKey: string, id: string, deleted: boolean, at: number}>} sent
     */
    _acknowledge(sent) {
        for (const { tabKey, id, deleted, at } of sent) {
            const ids = this.decisions.get(tabKey);
            const held = ids?.get(id);
            if (!held || held.deleted !== deleted || held.at !== at) continue;
            ids.delete(id);
            if (!ids.size) this.decisions.delete(tabKey);
        }
    }

    /**
     * Read-merge-write one shared record, then take what the other game tabs
     * had written into the working record, so a restore shows it and the next
     * merge carries less.
     *
     * The transaction is opened before this function's first `await`.
     *
     * @param {string} key - Record key
     * @param {Record<string, Array<string>>} tabs - This session's lines for that record
     * @param {RecordContext} context
     * @param {*} ticket - The owning session, from `captureOwner`
     * @returns {Promise<boolean>} Whether the write was accepted
     */
    async _writeShared(key, tabs, context, ticket) {
        const decisions = this._decisionsFor(key, context);
        const incoming = {
            tabs: Object.fromEntries(Object.entries(tabs).map(([tabKey, list]) => [tabKey, [...list]])),
            live: liveForRecord(this.liveCounts, tabs),
            decisions,
            at: Date.now(),
        };
        const perTab = this.getMaxHistory();
        const result = await updateRecord(key, (stored) => mergeSharedRecord(stored, incoming, perTab));
        if (!result) return false;
        // On the record now, with their times; resent later, they would only race a newer decision.
        if (stillOurs(ticket)) this._acknowledge(decisions);
        // A switch or a guild change since the write was issued: the working
        // record is no longer the one these lines belong to.
        if (stillOurs(ticket) && this.context === context && this.tabs) this._adopt(key, result.value, context);
        return true;
    }

    /**
     * Fold a shared record as written back into the working record.
     * @param {string} key - Record key
     * @param {*} written - The record `storage.update` wrote
     * @param {RecordContext} context
     */
    _adopt(key, written, context) {
        Object.assign(this.sharedLive, liveFromRecord(written));
        const stored = written && written.tabs && typeof written.tabs === 'object' ? written.tabs : {};
        const deleted = new Set(tombstonesFrom(written));
        const tabKeys = new Set([...Object.keys(stored), ...Object.keys(this.tabs)]);
        for (const tabKey of tabKeys) {
            if (recordKeyFor(tabKey, context) !== key) continue;
            const merged = mergeLists(stored[tabKey] || [], this.tabs[tabKey] || [], true).filter(
                (html) => !deleted.has(extractStoredMessageId(html))
            );
            if (merged.length) this.tabs[tabKey] = merged;
            else delete this.tabs[tabKey];
        }
        this._capMemory();
    }

    /**
     * A flush that arrives before the first read has merged: read the record
     * now, merge a copy of what this session recorded into it, and write that.
     *
     * Everything this needs is taken before the first await — the key, the
     * lines, the cap — because the caller is usually `disable()`, which resets
     * this instance on the very next line and, on a character switch, is
     * followed by the id `characterKey()` reads moving on. A read that fails
     * or never comes back writes nothing: the record on disk is never
     * replaced by one that was not read first.
     *
     * @param {boolean} immediate - Skip storage's own write debounce
     * @returns {Promise<boolean>} Whether the write was attempted and accepted
     */
    async _mergeIntoStored(immediate) {
        const context = this.context || this._contextNow();
        const key = context.charKey;
        const perTab = this.getMaxHistory();
        const sessionLive = { ...this.liveCounts };
        const groups = groupByRecord(this.tabs, context);
        const pending = Object.entries(groups[key] || {}).map(([tabKey, list]) => [tabKey, [...list]]);
        // An earlier session's final write, captured before this one's own
        // flush is tracked — waiting on itself would never finish.
        const prior = this.finalFlush;
        // `dirty` is deliberately left set on this path whatever happens: the
        // working record is still unmerged, and the load that merges it is
        // what schedules the write that clears it.
        this.dirty = true;

        // Shared records are a merge whichever path writes them, so they need no
        // read of their own first; issued now, before the first await, which is
        // also what lets the page-close flush land them. An earlier session's
        // final write to the same record opened its transaction earlier, and
        // IndexedDB commits them in that order.
        const shared = [];
        for (const [recordKey, tabs] of Object.entries(groups)) {
            if (recordKey === key) continue;
            const incoming = {
                tabs: Object.fromEntries(Object.entries(tabs).map(([tabKey, list]) => [tabKey, [...list]])),
                live: liveForRecord(sessionLive, tabs),
                decisions: this._decisionsFor(recordKey, context),
                at: Date.now(),
            };
            shared.push(updateRecord(recordKey, (stored) => mergeSharedRecord(stored, incoming, perTab)));
        }
        for (const heldKey of this.heldGuildWrites.keys()) shared.push(this._writeHeldGuild(heldKey));
        const own = this._mergeOwnIntoStored(key, pending, perTab, sessionLive, prior, immediate);
        const results = await Promise.all([own, ...shared]);
        return results.every(Boolean);
    }

    /**
     * The character's own half of {@link ChatHistoryPersistence#_mergeIntoStored}.
     * @param {string} key - The character's record key
     * @param {Array<[string, Array<string>]>} pending - Its tabs' lines, copied
     * @param {number} perTab - Message cap per tab
     * @param {Record<string, number>} sessionLive - Live counts this session reported
     * @param {Promise<boolean>|null} prior - An earlier session's final write
     * @param {boolean} immediate - Skip storage's own write debounce
     * @returns {Promise<boolean>} Whether the write was attempted and accepted
     */
    async _mergeOwnIntoStored(key, pending, perTab, sessionLive, prior, immediate) {
        await settleQuietly(prior);
        const read = await readStoredRecord(key);
        if (!read.ok) {
            console.error('[ChatHistoryPersistence] Could not read chat history to merge into; not writing.');
            return false;
        }

        const live = { ...liveFromRecord(read.record), ...sessionLive };
        const tabs = tabsFromRecord(read.record, perTab, live);
        for (const [tabKey, list] of pending) {
            if (!tabs[tabKey]) tabs[tabKey] = [];
            for (const html of list) mergeMessage(tabs[tabKey], html);
            if (!tabs[tabKey].length) delete tabs[tabKey];
        }
        applyCaps(tabs, perTab, live);

        try {
            return (
                (await storage.set(
                    key,
                    {
                        v: RECORD_VERSION,
                        savedAt: Date.now(),
                        tabs,
                        live: liveForRecord(live, tabs),
                        // Not this path's to drop: only a load decides where held guild lines go.
                        ...(read.record?.guildLegacy ? { guildLegacy: read.record.guildLegacy } : {}),
                    },
                    CHAT_HISTORY_STORE,
                    immediate
                )) === true
            );
        } catch (error) {
            console.error('[ChatHistoryPersistence] Could not write chat history:', error);
            return false;
        }
    }

    /**
     * Remove one message from a tab's stored record by the game's own id, and
     * schedule the write. The caller (chat-history-extender's
     * `chat_message_updated` handler) is the only one that knows a tab key
     * from a bare channel hrid — see {@link tabKeyForChannel} there.
     *
     * Only a message recorded with an id can be found this way — see the
     * "Message identity and deletion" section at the top of this file for
     * which ones that is. Everything else is a silent no-op: there is no
     * corruption to report, just nothing here that names the message.
     *
     * @param {string} tabKey - `tab2:ch:<channel>`
     * @param {string|number} id - The game's message id
     * @returns {Promise<boolean>} Whether a stored message was found and removed
     */
    async purgeMessageById(tabKey, id) {
        if (!this.enabled || !tabKey || id == null) return false;
        // When the event arrived, taken before the read below: an undelete that
        // lands during that read is newer than this deletion, and must stay so.
        const at = decisionTime();
        // Always load, not just await a read someone else already started.
        // A deletion can arrive before any chat container has ever called
        // `restore()` — the game is still mounting its chat UI, say — in
        // which case `loadPromise` is null and `this.tabs` is too: the old
        // guard here returned straight away, leaving whatever was on disk
        // from an earlier session untouched. The deletion tombstone
        // (chat-history-extender.js's `DeletedMessageIds`) can paper over
        // that for the 60 seconds it lasts, by keeping a late `restore()`
        // from re-inserting the message — but the record on disk itself was
        // never touched, and a session that starts more than 60 seconds
        // after this runs would restore it anyway. `load()` is safe to call
        // unconditionally: it no-ops if disabled, and returns the in-flight
        // promise if a read is already running, the same race `load()`'s own
        // "pending" merge exists to survive, just from the other direction.
        await this.load();
        if (!this.tabs) return false;

        const key = String(id);
        // A shared record can hold the line though this tab never saw it — another
        // game tab recorded it — and a merge would put back whatever was only
        // filtered here, so the deletion is written down as a tombstone too.
        const shared = tabScope(tabKey) !== 'character';
        if (shared) {
            this._noteDecision(tabKey, key, true, at);
            this.dirtyTabs.add(tabKey);
            this.dirty = true;
            this._scheduleWrite();
        }
        const held = this.guildLegacy?.[tabKey];
        let purgedHeld = false;
        if (held) {
            const kept = held.filter((html) => extractStoredMessageId(html) !== key);
            if (kept.length !== held.length) {
                purgedHeld = true;
                if (kept.length) this.guildLegacy[tabKey] = kept;
                else delete this.guildLegacy[tabKey];
                if (!Object.keys(this.guildLegacy).length) this.guildLegacy = null;
                // Held in the character's own record, which every flush writes.
                this.dirty = true;
                this._scheduleWrite();
            }
        }
        if (!this.tabs[tabKey]) return purgedHeld;

        const before = this.tabs[tabKey].length;
        this.tabs[tabKey] = this.tabs[tabKey].filter((html) => extractStoredMessageId(html) !== key);
        if (this.tabs[tabKey].length === before) return purgedHeld;

        if (!this.tabs[tabKey].length) delete this.tabs[tabKey];
        this.dirtyTabs.add(tabKey);
        this.dirty = true;
        this._scheduleWrite();
        return true;
    }

    /**
     * Take a deletion back: a moderator's undelete. Nothing is restored — the
     * markup is gone — but the tombstone must go, or the line could never be
     * recorded again: every merge of a shared record would filter it out.
     * @param {string} tabKey - `tab2:ch:<channel>`
     * @param {string|number} id - The game's message id
     */
    forgetDeletion(tabKey, id) {
        if (!this.enabled || !tabKey || id == null || tabScope(tabKey) === 'character') return;
        this._noteDecision(tabKey, String(id), false, decisionTime());
        this.dirtyTabs.add(tabKey);
        this.dirty = true;
        this._scheduleWrite();
    }

    /** Drop the session's state. Storage is left alone — a disable is not a wipe. */
    reset() {
        // First, and before the clearing itself: a read still in flight has to
        // be refused even if something below throws part-way.
        noteTeardown(this);
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }
        this.tabs = null;
        this.snapshot = null;
        this.loadPromise = null;
        this.loaded = false;
        this.dirty = false;
        this.liveCounts = {};
        this.enabled = false;
        this.getMaxHistory = () => MAX_MESSAGES_PER_TAB;
        this.context = null;
        this.dirtyTabs = new Set();
        this.decisions = new Map();
        this.heldLegacy = null;
        this.guildLegacy = null;
        this.heldGuildWrites = new Map();
        this.guildOverride = null;
        this.sharedLive = {};
    }
}

const chatHistoryPersistence = new ChatHistoryPersistence();
export default chatHistoryPersistence;
