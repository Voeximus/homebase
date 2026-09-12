// Character-level helpers shared by the parser stages. Nothing here knows about
// nutrition; it only answers "what kind of character is this" and "how far apart
// are these two strings".

/**
 * Fold one UTF-16 unit to its compatibility form (full-width "１２％" → "12%",
 * "（" → "("), but ONLY when the fold is a single character. Keeping the length
 * 1:1 is what lets every later stage slice the ORIGINAL text with the same
 * offsets it matched on the folded text — which is how ReadValue.raw stays the
 * exact printed source (rule 1) even on Chinese labels set in full-width digits.
 */
export function foldChar(c: string): string {
  const code = c.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdfff) return c;
  const n = c.normalize("NFKC");
  return n.length === 1 ? n : c;
}

export function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

export function isLatin(c: string | undefined): boolean {
  return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}

export function isUpper(c: string | undefined): boolean {
  return c !== undefined && c >= "A" && c <= "Z";
}

export function isLower(c: string | undefined): boolean {
  return c !== undefined && c >= "a" && c <= "z";
}

export function isCjk(c: string | undefined): boolean {
  if (c === undefined) return false;
  const code = c.charCodeAt(0);
  return (code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff);
}

export function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/** Plain edit distance. Inputs are label words (a few dozen characters at most), so the O(mn) table is fine. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
