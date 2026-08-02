/**
 * pdf-bytes.ts — one rule about PDF byte ownership, kept dependency-free so it
 * can be unit-tested without pulling in pdf.js.
 *
 * pdf.js sends `getDocument({ data })` to its worker with the buffer in the
 * postMessage TRANSFER list:
 *
 *   worker.messageHandler.sendWithPromise("GetDocRequest", source,
 *     source.data ? [source.data.buffer] : null);   // pdf.js 3.11 display/api.js
 *
 * so that ArrayBuffer is DETACHED in the main thread as soon as the document
 * starts loading. `new Uint8Array(buffer)` is a VIEW over the same buffer, not a
 * copy, so handing one to pdf.js gives away the caller's bytes.
 *
 * Every annotation path still needs the original bytes AFTER the document opens:
 * the managed bundle hashes them for the document's identity and writes the
 * verified recovery copy. So pdf.js always gets its own copy.
 *
 * Symptoms when this rule is violated:
 *   - "Cannot perform Construct on a detached ArrayBuffer" from the vault's
 *     writeBinary (Buffer.from on a detached buffer), and
 *   - worse, a detached buffer reports byteLength 0, so SHA-256 of it silently
 *     returns the empty-input digest e3b0c442… — which would collapse every
 *     document onto a single bundle id. PdfBundleManager.prepare() rejects
 *     empty input so this can never be reached quietly.
 */

/** Bytes to hand to pdf.js, leaving the caller's ArrayBuffer intact. */
export function copyForPdfJs(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data.slice(0));
}
