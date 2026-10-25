import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromCents } from "../../src/domain/money.ts";
import { bestOffer, kindOf, lineCost, type Promotion, parseMechanic } from "../../src/domain/promotion.ts";
import { parseSlotLabel } from "../../src/domain/slot.ts";

const promo = (text: string): Promotion => {
  const mechanic = parseMechanic(text);
  return { details: [text], kind: kindOf(mechanic), label: "x", mechanic, regularPrice: null, validUntil: null };
};

describe("parseMechanic: real Super U and Leclerc texts", () => {
  const cases = [
    ["-80% de remise immédiate sur le 2ème produit acheté.", { nth: 2, percent: 80, type: "nth_percent_off" }],
    ["Le 2ème article à -40% (le moins cher des 2), profitez-en !", { nth: 2, percent: 40, type: "nth_percent_off" }],
    ["Le 2ème est à -60% (le moins cher des 2), profitez-en !", { nth: 2, percent: 60, type: "nth_percent_off" }],
    ["Le 3ème est offert (le moins cher des 3), profitez-en !", { nth: 3, percent: 100, type: "nth_percent_off" }],
    ["20% versés sur votre Carte U pour l'achat de ce produit.", { percent: 20, type: "loyalty_percent" }],
    [
      "20% versés sur votre Carte U pour l'achat de ce produit. Soit 0,27€ versés sur votre Carte U.",
      { amount: 27, type: "loyalty_amount" },
    ],
    [
      "Recevez 34% en Ticket E.Leclerc. Offre réservée aux porteurs de la Carte E.Leclerc.",
      { percent: 34, type: "loyalty_percent" },
    ],
    ["Avantage immédiat de 30%", { percent: 30, type: "percent_off" }],
    ["-34% de remise immédiate. Soit 2,97€ d'économie.", { percent: 34, type: "percent_off" }],
  ] as const;
  for (const [text, expected] of cases) {
    it(text, () => assert.deepEqual(parseMechanic(text), expected));
  }

  it("unknown text or absurd percentage: no mechanic", () => {
    assert.equal(parseMechanic("Le prix affiché tient compte de la remise."), null);
    assert.equal(parseMechanic("-150% sur tout"), null);
    assert.equal(parseMechanic("Le 1er est offert"), null);
  });

  it("category inferred from the mechanic", () => {
    assert.equal(kindOf(null), "immediate");
    assert.equal(kindOf({ percent: 10, type: "percent_off" }), "immediate");
    assert.equal(kindOf({ nth: 2, percent: 50, type: "nth_percent_off" }), "multibuy");
    assert.equal(kindOf({ amount: fromCents(10), type: "loyalty_amount" }), "loyalty");
  });
});

describe("actual cost of a line", () => {
  const price = fromCents(677);

  it("without promotion: price × quantity", () => {
    assert.deepEqual(lineCost(price, [], 2), { loyalty: 0, net: 1354, paid: 1354 });
  });

  it("3rd free: one free unit per group of 3", () => {
    const lot = [promo("Le 3ème est offert")];
    assert.deepEqual(lineCost(price, lot, 2), { loyalty: 0, net: 1354, paid: 1354 });
    assert.deepEqual(lineCost(price, lot, 3), { loyalty: 0, net: 1354, paid: 1354 });
    assert.deepEqual(lineCost(price, lot, 6), { loyalty: 0, net: 2708, paid: 2708 });
  });

  it("loyalty credit: as a percentage of the paid amount or as an amount per unit", () => {
    assert.deepEqual(lineCost(fromCents(195), [promo("Recevez 34% en Ticket E.Leclerc")], 1), {
      loyalty: 66,
      net: 129,
      paid: 195,
    });
    assert.deepEqual(lineCost(fromCents(134), [promo("Soit 0,27€ versés sur votre Carte U.")], 2), {
      loyalty: 54,
      net: 214,
      paid: 268,
    });
  });

  it("immediate discount: already in the price, nothing more", () => {
    assert.deepEqual(lineCost(fromCents(348), [promo("Avantage immédiat de 30%")], 1).net, 348);
  });

  it("best offer: quantity that triggers the bundle and net unit cost", () => {
    assert.deepEqual(bestOffer(price, [promo("Le 3ème est offert")]), { netUnitPrice: 451, quantity: 3 });
    assert.deepEqual(bestOffer(fromCents(270), [promo("Le 2ème est à -60%")]), { netUnitPrice: 189, quantity: 2 });
    assert.deepEqual(bestOffer(price, []), { netUnitPrice: 677, quantity: 1 });
  });
});

describe("parseSlotLabel", () => {
  const ref = new Date(2026, 9, 24); // samedi 24 octobre 2026

  it("Leclerc and Super U formats", () => {
    assert.deepEqual(parseSlotLabel("Lundi 26 octobre à 07h00", ref), {
      end: null,
      label: "Lundi 26 octobre à 07h00",
      start: "2026-10-26T07:00",
    });
    assert.equal(parseSlotLabel("Lundi 26 octobre 07h00", ref).start, "2026-10-26T07:00");
    assert.deepEqual(parseSlotLabel("Dim. 25/10 de 08h30 à 09h00", ref), {
      end: "2026-10-25T09:00",
      label: "Dim. 25/10 de 08h30 à 09h00",
      start: "2026-10-25T08:30",
    });
    assert.equal(parseSlotLabel("Mardi 1er décembre à 9h", ref).start, null, '"1er" is not read');
    assert.equal(parseSlotLabel("mardi 1 décembre à 9h", ref).start, "2026-12-01T09:00");
  });

  it("next year for a date more than a week in the past", () => {
    assert.equal(parseSlotLabel("Samedi 2 janvier à 10h00", ref).start, "2027-01-02T10:00");
    assert.equal(parseSlotLabel("Mardi 20 octobre à 10h00", ref).start, "2026-10-20T10:00");
  });

  it("label without a date, or invalid time", () => {
    assert.deepEqual(parseSlotLabel("Choisir un créneau", ref), {
      end: null,
      label: "Choisir un créneau",
      start: null,
    });
    assert.equal(parseSlotLabel("Lundi 26 octobre à 25h00", ref).start, null);
    assert.equal(parseSlotLabel("32/13 à 10h", ref).start, null);
  });
});
