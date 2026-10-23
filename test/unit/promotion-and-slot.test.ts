import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromCents } from "../../src/domain/money.ts";
import { bestOffer, kindOf, lineCost, type Promotion, parseMechanic } from "../../src/domain/promotion.ts";
import { parseSlotLabel } from "../../src/domain/slot.ts";

const promo = (text: string): Promotion => {
  const mechanic = parseMechanic(text);
  return { kind: kindOf(mechanic), label: "x", validUntil: null, details: [text], regularPrice: null, mechanic };
};

describe("parseMechanic: real Super U and Leclerc texts", () => {
  const cases = [
    ["-80% de remise immédiate sur le 2ème produit acheté.", { type: "nth_percent_off", nth: 2, percent: 80 }],
    ["Le 2ème article à -40% (le moins cher des 2), profitez-en !", { type: "nth_percent_off", nth: 2, percent: 40 }],
    ["Le 2ème est à -60% (le moins cher des 2), profitez-en !", { type: "nth_percent_off", nth: 2, percent: 60 }],
    ["Le 3ème est offert (le moins cher des 3), profitez-en !", { type: "nth_percent_off", nth: 3, percent: 100 }],
    ["20% versés sur votre Carte U pour l'achat de ce produit.", { type: "loyalty_percent", percent: 20 }],
    [
      "20% versés sur votre Carte U pour l'achat de ce produit. Soit 0,27€ versés sur votre Carte U.",
      { type: "loyalty_amount", amount: 27 },
    ],
    [
      "Recevez 34% en Ticket E.Leclerc. Offre réservée aux porteurs de la Carte E.Leclerc.",
      { type: "loyalty_percent", percent: 34 },
    ],
    ["Avantage immédiat de 30%", { type: "percent_off", percent: 30 }],
    ["-34% de remise immédiate. Soit 2,97€ d'économie.", { type: "percent_off", percent: 34 }],
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
    assert.equal(kindOf({ type: "percent_off", percent: 10 }), "immediate");
    assert.equal(kindOf({ type: "nth_percent_off", nth: 2, percent: 50 }), "multibuy");
    assert.equal(kindOf({ type: "loyalty_amount", amount: fromCents(10) }), "loyalty");
  });
});

describe("actual cost of a line", () => {
  const price = fromCents(677);

  it("without promotion: price × quantity", () => {
    assert.deepEqual(lineCost(price, [], 2), { paid: 1354, loyalty: 0, net: 1354 });
  });

  it("3rd free: one free unit per group of 3", () => {
    const lot = [promo("Le 3ème est offert")];
    assert.deepEqual(lineCost(price, lot, 2), { paid: 1354, loyalty: 0, net: 1354 });
    assert.deepEqual(lineCost(price, lot, 3), { paid: 1354, loyalty: 0, net: 1354 });
    assert.deepEqual(lineCost(price, lot, 6), { paid: 2708, loyalty: 0, net: 2708 });
  });

  it("loyalty credit: as a percentage of the paid amount or as an amount per unit", () => {
    assert.deepEqual(lineCost(fromCents(195), [promo("Recevez 34% en Ticket E.Leclerc")], 1), {
      paid: 195,
      loyalty: 66,
      net: 129,
    });
    assert.deepEqual(lineCost(fromCents(134), [promo("Soit 0,27€ versés sur votre Carte U.")], 2), {
      paid: 268,
      loyalty: 54,
      net: 214,
    });
  });

  it("immediate discount: already in the price, nothing more", () => {
    assert.deepEqual(lineCost(fromCents(348), [promo("Avantage immédiat de 30%")], 1).net, 348);
  });

  it("best offer: quantity that triggers the bundle and net unit cost", () => {
    assert.deepEqual(bestOffer(price, [promo("Le 3ème est offert")]), { quantity: 3, netUnitPrice: 451 });
    assert.deepEqual(bestOffer(fromCents(270), [promo("Le 2ème est à -60%")]), { quantity: 2, netUnitPrice: 189 });
    assert.deepEqual(bestOffer(price, []), { quantity: 1, netUnitPrice: 677 });
  });
});

describe("parseSlotLabel", () => {
  const ref = new Date(2026, 9, 24); // samedi 24 octobre 2026

  it("Leclerc and Super U formats", () => {
    assert.deepEqual(parseSlotLabel("Lundi 26 octobre à 07h00", ref), {
      label: "Lundi 26 octobre à 07h00",
      start: "2026-10-26T07:00",
      end: null,
    });
    assert.equal(parseSlotLabel("Lundi 26 octobre 07h00", ref).start, "2026-10-26T07:00");
    assert.deepEqual(parseSlotLabel("Dim. 25/10 de 08h30 à 09h00", ref), {
      label: "Dim. 25/10 de 08h30 à 09h00",
      start: "2026-10-25T08:30",
      end: "2026-10-25T09:00",
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
      label: "Choisir un créneau",
      start: null,
      end: null,
    });
    assert.equal(parseSlotLabel("Lundi 26 octobre à 25h00", ref).start, null);
    assert.equal(parseSlotLabel("32/13 à 10h", ref).start, null);
  });
});
