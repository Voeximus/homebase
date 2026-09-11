import { describe, it, expect } from "vitest";
import {
  canonicalGtin,
  digitsOnly,
  expandUpcE,
  gtinCheckDigit,
  gtinVariants,
  isValidGtin,
} from "../src/lib/gtin";

// The number under a barcode is printed four different ways for the same
// product, and a food database is keyed on exactly one of them. Getting this
// wrong is not a rounding error — it is the difference between "scanned, logged"
// and "not in the food database" about a product that is sitting right there.
//
// Every code below is a real published GTIN or a worked example from the GS1
// spec, so the arithmetic is checkable against something outside this file.

describe("the check digit — a free gate against a misread", () => {
  it("computes the published check digit for a UPC-A", () => {
    // 03600029145 → 2 (the GS1 worked example)
    expect(gtinCheckDigit("03600029145")).toBe(2);
    expect(isValidGtin("036000291452")).toBe(true);
  });

  it("computes it for an EAN-13", () => {
    expect(gtinCheckDigit("400638133393")).toBe(1);
    expect(isValidGtin("4006381333931")).toBe(true);
  });

  it("is not fooled by the padding", () => {
    // The weights alternate from the RIGHT, so a 12-digit body and a 13-digit
    // body have opposite parity. Pad on the wrong side and the algorithm is
    // silently correct for EAN-13 and silently wrong for UPC-A — which is the
    // half of the world this household actually shops in.
    expect(isValidGtin("0036000291452")).toBe(true); // same number as EAN-13
    expect(isValidGtin("049000028911")).toBe(true); // Coca-Cola 12oz
    expect(isValidGtin("0049000028911")).toBe(true);
  });

  it("rejects a transposed digit", () => {
    // The most likely typing mistake, and the exact thing mod-10 is for.
    expect(isValidGtin("036000291452")).toBe(true);
    expect(isValidGtin("036000219452")).toBe(false);
  });

  it("rejects anything that is not a GTIN length", () => {
    expect(isValidGtin("12345")).toBe(false);
    expect(isValidGtin("0123456789012345")).toBe(false);
  });

  it("ignores the spaces a person types off a label", () => {
    expect(digitsOnly("0 36000 29145 2")).toBe("036000291452");
  });
});

describe("UPC-E — the squashed barcode on a can", () => {
  // UPC-E is a COMPRESSION of a UPC-A, not a different number: the zero runs are
  // squeezed out and the last data digit records how to put them back. No
  // database stores the compressed form, so without this every soda can and
  // travel-size product is unlookupable.
  //
  // Each case below is checked two ways that do not share an assumption: the
  // expansion rule produces a 12-digit number, and that number's OWN mod-10
  // check digit independently comes out equal to the UPC-E's. The compression
  // spec and the checksum spec agreeing is what makes these right rather than
  // merely self-consistent with the code under test.
  const expands = (e: string, a: string) => {
    expect(expandUpcE(e)).toBe(a);
    expect(isValidGtin(a)).toBe(true);
    expect(a[11]).toBe(e[7]); // the check digit survives the compression
  };

  it("expands the last-digit 0-2 form", () => {
    expands("04252614", "042100005264");
  });

  it("expands the last-digit 3 form", () => {
    expands("04567834", "045600000784");
  });

  it("expands the last-digit 4 form", () => {
    expands("04567840", "045670000080");
  });

  it("expands the last-digit 5-9 form", () => {
    expands("01234565", "012345000065");
  });

  it("leaves a non-compressible number system alone", () => {
    // Only number systems 0 and 1 compress. Anything else is not a UPC-E and
    // must not be expanded into a plausible-looking wrong product.
    expect(expandUpcE("52345670")).toBeNull();
  });
});

// Where the variant list actually earns its place. It was BUILT on the theory
// that a UPC-A label misses an EAN-13 catalog — and probing Open Food Facts
// killed that theory: it normalizes the code server-side, and across a
// 61-product sample the variant walk rescued zero lookups there. What survives
// is the three cases with no server to normalize anything: a UPC-E off the
// camera, USDA's exact gtinUpc match, and matching a food already saved locally.
describe("the variant list", () => {
  it("asks for a US barcode under both of its forms", () => {
    // Cheap insurance rather than the headline: a catalog that does NOT
    // normalize (and the app's own saved-food list, which is a string compare)
    // needs both forms offered.
    const v = gtinVariants("049000028911");
    expect(v).toContain("049000028911");
    expect(v).toContain("0049000028911");
  });

  it("works in the other direction too", () => {
    const v = gtinVariants("0049000028911");
    expect(v).toContain("049000028911");
  });

  it("expands a UPC-E before deriving anything from it", () => {
    const v = gtinVariants("01234565");
    expect(v).toContain("012345000065"); // the UPC-A it stands for
    expect(v).toContain("0012345000065"); // and that as EAN-13
  });

  it("reduces a case code to the item inside it", () => {
    // GTIN-14 is a carton of the product. The trailing digits are the item.
    expect(gtinVariants("00049000028911")).toContain("049000028911");
  });

  it("never repeats a form", () => {
    const v = gtinVariants("049000028911");
    expect(new Set(v).size).toBe(v.length);
  });

  it("is empty for a non-number", () => {
    expect(gtinVariants("abc")).toEqual([]);
  });
});

describe("one product, one row", () => {
  it("stores every printed form under the same canonical number", () => {
    // Scanned off a UPC-A label today and a UPC-E label tomorrow, a product has
    // to land on ONE saved food — or the library fills with duplicates that each
    // know half the history.
    expect(canonicalGtin("049000028911")).toBe("0049000028911");
    expect(canonicalGtin("0049000028911")).toBe("0049000028911");
    expect(canonicalGtin("00049000028911")).toBe("0049000028911");
  });

  it("canonicalizes a UPC-E to the same row as its UPC-A", () => {
    expect(canonicalGtin("01234565")).toBe(canonicalGtin("012345000065"));
  });
});
