/**
 * Gzip for the sync payload.
 *
 * The payload is JSON with the same key names repeated thousands of times —
 * about the most compressible text there is — and the gist ceiling is a hard
 * 9 MB. Compressing before upload is the difference between "Everything" scope
 * fitting in one gist and the too-large refusal.
 *
 * Order matters with encryption: compress first, then encrypt. Ciphertext is
 * indistinguishable from noise and does not compress; gzip-then-AES keeps the
 * whole gain.
 *
 * `CompressionStream` is feature-detected rather than assumed. Where it is
 * missing the payload simply goes up uncompressed, exactly as it always did —
 * the manifest says which happened, so the reader never guesses.
 */

/** Whether this environment can compress at all */
export function compressionAvailable() {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

/**
 * Gzip a payload.
 * @param {string} text - The payload JSON
 * @returns {Promise<Uint8Array>} Compressed bytes
 */
export async function gzipText(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reverse of {@link gzipText}.
 * @param {Uint8Array} bytes - Compressed bytes
 * @returns {Promise<string>} The payload JSON
 */
export async function gunzipToText(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

export default { compressionAvailable, gzipText, gunzipToText };
