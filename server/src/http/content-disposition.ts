// Build an RFC 6266-compliant Content-Disposition header value.
//
// Node's `res.setHeader` throws `ERR_INVALID_CHAR` for any code point outside
// ISO-8859-1 (e.g. the U+202F narrow no-break space macOS puts before AM/PM in
// screenshot filenames, or any CJK character). A raw `filename="<name>"` with
// such a byte crashes the response with a 500. RFC 6266 handles this with two
// parameters: an ASCII-only `filename=` fallback plus a percent-encoded
// `filename*=UTF-8''` for clients that understand it.

const DISPOSITION_TYPES = new Set(["inline", "attachment"]);

// Percent-encode per RFC 5987 (attr-char): keep unreserved + a small safe set.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value)
    // encodeURIComponent leaves these RFC 3986 sub-delims un-encoded, but they
    // are not attr-chars, so encode them too.
    .replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// ASCII fallback: strip anything outside printable ASCII, drop quotes and path
// separators that would break the quoted-string or leak a path.
function asciiFallback(filename: string, fallbackName: string): string {
  const cleaned = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\/\r\n]/g, "_")
    .trim();
  return cleaned || fallbackName;
}

export function contentDispositionHeader(
  disposition: string,
  filename: string | null | undefined,
  fallbackName = "attachment",
): string {
  const type = DISPOSITION_TYPES.has(disposition) ? disposition : "attachment";
  const name = (filename ?? "").trim() || fallbackName;
  const ascii = asciiFallback(name, fallbackName);
  // Always emit filename* so unicode names survive on modern clients; the ASCII
  // filename= is the mandatory fallback. Order matters: RFC 6266 says the last
  // recognized parameter wins, so filename* comes last.
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
