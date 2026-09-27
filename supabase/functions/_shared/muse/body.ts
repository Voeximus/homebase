// How much of a request either door is willing to read.
//
// WHY A CAP AT ALL. An edge function gets 256 MB of memory. `await req.text()`
// buffers whatever the caller sends, so one 200 MB body from anybody holding a
// key kills the isolate — and takes any request sharing it down too. Nothing
// leaks and nothing persists, which is why this is small; but the write door was
// given a cap for exactly this reason and the read door was not, and a cap only
// one door has is a door nobody remembered to close.
//
// AND WHY THE WRITE DOOR'S CAP WAS NOT ENOUGH ON ITS OWN. It read the body first
// and measured afterwards, so the buffering it existed to prevent had already
// happened — and it measured `text.length`, which counts UTF-16 units, so 16,000
// four-byte characters is 64 KB under a constant named BYTES.
//
// So: the declared size is refused BEFORE anything is read, and the read itself is
// counted in bytes as it arrives, because a chunked request declares no size at
// all. 16 KB for both doors — no tool on either takes an argument longer than a
// couple of hundred characters.

/** The biggest body either door will read. A call is a handful of small fields. */
export const MAX_BODY_BYTES = 16 * 1024;

/** The caller sent more than the cap. Both doors answer it without reading on. */
export class BodyTooLarge extends Error {
  /** What the caller said it was sending, when it said. Null for a chunked body,
   *  where the size is only known once it has been counted. */
  readonly declared: number | null;
  constructor(declared: number | null) {
    super(declared === null ? "body over the cap" : `body declared ${declared} bytes`);
    this.name = "BodyTooLarge";
    this.declared = declared;
  }
}

/**
 * The request body as text, or `BodyTooLarge` — never a partial body.
 *
 * Two guards, in this order:
 *   1. `Content-Length`, when the caller sent one. Refused before a byte is read.
 *   2. The bytes themselves, counted as they arrive, because a chunked request
 *      carries no length and a header is the caller's own claim anyway.
 */
export async function readCappedText(req: Request, cap: number = MAX_BODY_BYTES): Promise<string> {
  const header = req.headers.get("Content-Length");
  if (header !== null) {
    const declared = Number(header);
    if (Number.isFinite(declared) && declared > cap) throw new BodyTooLarge(declared);
    if (declared === 0) return "";
  }

  const stream = req.body;
  // No body at all — a GET, or a POST somebody sent empty.
  if (!stream) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > cap) {
      // Stop reading rather than finish and then complain: the whole point of the
      // cap is that the memory is never taken. Cancelling tells the runtime to
      // drop whatever is still arriving.
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge(null);
    }
    chunks.push(value);
  }

  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
