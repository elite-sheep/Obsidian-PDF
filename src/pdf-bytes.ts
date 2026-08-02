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
 * they are hashed to stamp/verify the sidecar's document identity. So pdf.js
 * always gets its own copy.
 *
 * Symptoms when this rule is violated:
 *   - "Cannot perform Construct on a detached ArrayBuffer" from the vault's
 *     writeBinary (Buffer.from on a detached buffer), and
 *   - worse, a detached buffer reports byteLength 0, so SHA-256 of it silently
 *     returns the empty-input digest e3b0c442… — which would make every
 *     document look identical to every other. DocumentBinder.prepare() rejects
 *     empty input so this can never be reached quietly.
 */

/** Bytes to hand to pdf.js, leaving the caller's ArrayBuffer intact. */
export function copyForPdfJs(data: ArrayBuffer): Uint8Array {
  return new Uint8Array(data.slice(0));
}

/** Content identity of a PDF. Lives here because it must see intact bytes. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
