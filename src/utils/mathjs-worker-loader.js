/**
 * Worker-side loader for math.js, shared by the enhancement and networth worker
 * managers so the two cannot drift on which build they pull or how they load it.
 *
 * The workers need math.js for the Markov matrix maths, and pull it from cdnjs.
 * That build ends with a source-map directive pointing at math.js.map, and a
 * worker running it tries to fetch that map every load — the map is not served
 * here, so the browser logs a "Source map error … in the worker" on every spawn.
 * The directive is only a debugging aid, so this fetches the source, drops it,
 * and runs the rest from a same-origin blob. If anything on that path fails it
 * falls back to importing the CDN URL directly: the source-map noise returns,
 * but the maths still works.
 *
 * Exported as a string because a blob worker cannot import a module — it is
 * spliced into each worker's inline source at build time.
 */

/** The math.js build both workers load */
export const MATHJS_CDN_URL = 'https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.2/math.js';

/**
 * Worker-side JS that defines `math`, stripped of its source-map comment.
 *
 * Interpolate into a worker's inline source in place of a bare
 * `importScripts(<mathjs>)`.
 */
export const MATHJS_WORKER_IMPORT = `
// Load math.js, dropping its trailing source-map directive so this worker does
// not try to fetch math.js.map (unserved here) and log a source-map error. The
// marker is built by concatenation so the literal never appears contiguously in
// the bundle, where tooling could mistake it for a real directive.
(function () {
    var url = '${MATHJS_CDN_URL}';
    try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send();
        if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
            var marker = '//' + '# sourceMappingURL=';
            var at = xhr.responseText.indexOf(marker);
            var src = at === -1 ? xhr.responseText : xhr.responseText.slice(0, at);
            var blob = new Blob([src], { type: 'application/javascript' });
            importScripts(URL.createObjectURL(blob));
            return;
        }
    } catch (err) {
        // Fall through to the direct import below
    }
    importScripts(url);
})();
`;
