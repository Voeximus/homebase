// GTIN — the number under a barcode, and the reason a scan "isn't in the
// database" when it plainly is.
//
// There is one product number, printed four different ways:
//
//     UPC-E     8 digits   the squashed barcode on a can of soda
//     UPC-A    12 digits   the standard US retail barcode
//     EAN-13   13 digits   the same number with a country prefix (US = 0)
//     GTIN-14  14 digits   a case/pack of the same product
//
// A US grocery item scans as UPC-A "049000028911". Open Food Facts files that
// same product under EAN-13 "0049000028911". Ask for the 12-digit form and you
// get a clean 404 — and the app says "not in the food database" about a product
// that is sitting right there. Every lookup has to ask for all of the forms.
//
// The check digit matters for the opposite reason: a camera reading a curved or
// creased label WILL sometimes hand back a plausible-looking wrong number, and a
// wrong number silently looks up a different food. GS1 builds a mod-10 checksum
// into every GTIN precisely so a misread can be caught for free.

/** Digits only. Barcodes are numeric; anything else is scanner noise. */
export const digitsOnly = (s: string): string => s.replace(/\D/g, "");

/**
 * The GS1 mod-10 check digit for a GTIN body (the code WITHOUT its last digit).
 *
 * Right-aligned weights alternate 3,1 starting from the rightmost body digit —
 * which is why the body is left-padded to 13 first. Padding is not cosmetic: it
 * fixes the parity, and getting it wrong makes the algorithm silently correct
 * for 13-digit codes and silently wrong for 12-digit ones.
 */
export function gtinCheckDigit(body: string): number {
  const padded = body.padStart(13, "0");
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    // padded[12] is the rightmost body digit → weight 3, then alternating.
    const weight = (12 - i) % 2 === 0 ? 3 : 1;
    sum += Number(padded[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** Does this code's own check digit agree with its contents? */
export function isValidGtin(code: string): boolean {
  const d = digitsOnly(code);
  if (![8, 12, 13, 14].includes(d.length)) return false;
  return gtinCheckDigit(d.slice(0, -1)) === Number(d[d.length - 1]);
}

/**
 * Expand a UPC-E (8 digits) to the UPC-A (12 digits) it stands for.
 *
 * UPC-E is a COMPRESSION, not a different number: the zero-runs in the
 * manufacturer/product codes are squeezed out, and the last data digit records
 * how to put them back. No database stores the compressed form, so a soda can or
 * a travel-size anything is unlookupable until this runs.
 */
export function expandUpcE(code: string): string | null {
  const d = digitsOnly(code);
  if (d.length !== 8) return null;
  const ns = d[0];
  if (ns !== "0" && ns !== "1") return null; // only number systems 0/1 compress
  const [x1, x2, x3, x4, x5, x6] = d.slice(1, 7);
  const check = d[7];
  let body: string;
  switch (x6) {
    case "0":
    case "1":
    case "2":
      body = `${ns}${x1}${x2}${x6}0000${x3}${x4}${x5}`;
      break;
    case "3":
      body = `${ns}${x1}${x2}${x3}00000${x4}${x5}`;
      break;
    case "4":
      body = `${ns}${x1}${x2}${x3}${x4}00000${x5}`;
      break;
    default: // 5–9
      body = `${ns}${x1}${x2}${x3}${x4}${x5}0000${x6}`;
      break;
  }
  return body + check;
}

/**
 * Every form of this product number worth asking a database about, best first.
 *
 * MEASURED, because the obvious story about this turned out to be wrong. The
 * expectation was that a barcode printed as UPC-A would miss a catalog keyed on
 * EAN-13 — same number, different string, clean 404. Probing Open Food Facts
 * directly says otherwise: 049000028911, 0049000028911 and 00049000028911 all
 * resolve to the same product, because OFF normalizes the code server-side. On a
 * 61-product sample the variant walk rescued exactly ZERO lookups there.
 *
 * It is kept because three places genuinely do need it, and all three are string
 * comparisons with no server to normalize them:
 *
 *   · UPC-E. A scanner reading the squashed barcode on a can hands back 8
 *     digits, and no catalog keys on the compressed form.
 *   · USDA FoodData Central, which is SEARCHED by number and then verified by
 *     exact match on the `gtinUpc` it returns.
 *   · The saved-food library in the app, which matches stored string to scanned
 *     string and would otherwise re-download a food it already has.
 */
export function gtinVariants(code: string): string[] {
  const d = digitsOnly(code);
  if (!d) return [];
  const out: string[] = [];
  const add = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };

  add(d);
  // UPC-E is a compressed UPC-A — expand before anything else, because every
  // other form below is derived from the 12-digit number.
  const expanded = d.length === 8 ? expandUpcE(d) : null;
  if (expanded) add(expanded);

  const base = expanded ?? d;
  // A GTIN-14 is a case of the item; its trailing 13 digits are the item itself.
  if (base.length === 14) add(base.slice(1).replace(/^0+(?=\d{12})/, ""));
  // UPC-A ⇄ EAN-13: the same number with or without the US country prefix.
  if (base.length === 12) add(`0${base}`);
  if (base.length === 13 && base.startsWith("0")) add(base.slice(1));
  // Some catalogs zero-pad to 14 regardless.
  if (base.length === 12) add(`00${base}`);
  if (base.length === 13) add(`0${base}`);

  return out;
}

/**
 * The canonical form to STORE a scanned product under.
 *
 * Always the 13-digit EAN form, so the same physical product scanned off a
 * UPC-A label today and a UPC-E label tomorrow lands on one row instead of two.
 */
export function canonicalGtin(code: string): string {
  const d = digitsOnly(code);
  const expanded = d.length === 8 ? expandUpcE(d) : null;
  const base = expanded ?? d;
  if (base.length === 12) return `0${base}`;
  if (base.length === 14 && base.startsWith("0")) return base.slice(1);
  return base;
}
