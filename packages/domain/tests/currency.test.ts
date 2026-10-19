import { describe, expect, it } from "vitest";

import {
  baseCurrencyOf,
  convertMinor,
  currencyExponent,
  DEFAULT_BASE_CURRENCY,
  findRate,
  HOUSEHOLD_ID,
  indexRates,
  isExchangeRateValue,
  isSupportedCurrency,
  makeSeedBudget,
  RATE_PART_MAX,
  SUPPORTED_CURRENCIES,
  type ExchangeRate,
} from "../src/index.js";

/**
 * The table as it was first written. An exponent decides what a stored integer means, so this pin
 * may only ever grow: a code added to the table is added here, and no line here is ever edited.
 */
const ZERO_DIGITS = "BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX VND VUV";
const THREE_DIGITS = "BHD IQD JOD KWD LYD OMR TND";
const TWO_DIGITS = [
  "AED AFN ALL AMD AOA ARS AUD AWG AZN",
  "BAM BBD BDT BGN BMD BND BOB BRL BSD BTN BWP BYN BZD",
  "CAD CDF CHF CNY COP CRC CUP CVE CZK",
  "DKK DOP DZD EGP ERN ETB EUR FJD FKP",
  "GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF",
  "IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT",
  "LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN",
  "NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB",
  "SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL",
  "THB TJS TMT TOP TRY TTD TWD TZS UAH USD UYU UZS VED VES WST YER ZAR ZMW ZWG",
].join(" ");

function pinned(): ReadonlyMap<string, number> {
  const table = new Map<string, number>();
  for (const [codes, exponent] of [[ZERO_DIGITS, 0], [TWO_DIGITS, 2], [THREE_DIGITS, 3]] as const) {
    for (const code of codes.split(" ")) table.set(code, exponent);
  }
  return table;
}

function rate(id: string, date: string, baseMinor: number, overrides: Partial<ExchangeRate> = {}): ExchangeRate {
  return { id, currency: "USD", baseCurrency: "RUB", date, rate: { baseMinor, quoteMinor: 100 }, ...overrides };
}

describe("supported currencies", () => {
  it("never changes the exponent of a code once written, and never drops one", () => {
    for (const [code, exponent] of pinned()) {
      expect(SUPPORTED_CURRENCIES[code], code).toBe(exponent);
      expect(currencyExponent(code), code).toBe(exponent);
    }
    expect(Object.isFrozen(SUPPORTED_CURRENCIES)).toBe(true);
    expect(() => {
      (SUPPORTED_CURRENCIES as Record<string, number>).RUB = 0;
    }).toThrow();
    expect(currencyExponent("RUB")).toBe(2);
  });

  it("holds money only: no X-code and no fund code", () => {
    const funds = ["BOV", "CHE", "CHW", "CLF", "COU", "MXV", "USN", "UYI", "UYW"];
    for (const code of Object.keys(SUPPORTED_CURRENCIES)) {
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(code.startsWith("X"), code).toBe(false);
      expect(funds, code).not.toContain(code);
      expect([0, 2, 3], code).toContain(SUPPORTED_CURRENCIES[code]);
    }
    for (const code of ["XAU", "XDR", "XAF", "XTS", ...funds]) expect(isSupportedCurrency(code), code).toBe(false);
  });

  it("answers only for its own codes", () => {
    expect(isSupportedCurrency("RUB")).toBe(true);
    expect(isSupportedCurrency("USD")).toBe(true);
    for (const value of ["rub", "RUR", "RUBL", "", "toString", "constructor", "__proto__", 643, null, undefined]) {
      expect(isSupportedCurrency(value), String(value)).toBe(false);
    }
    expect(() => currencyExponent("XYZ")).toThrow(/currency XYZ is not supported/);
  });

  it("counts a state without a household in roubles", () => {
    const seed = makeSeedBudget();
    expect(DEFAULT_BASE_CURRENCY).toBe("RUB");
    expect(baseCurrencyOf(seed)).toBe("RUB");
    expect(baseCurrencyOf({ ...seed, household: { id: HOUSEHOLD_ID, baseCurrency: "EUR" } })).toBe("EUR");
  });
});

describe("convertMinor", () => {
  it("rounds half-up to the minor unit, the way the contracts round basis points", () => {
    // G-003: 25,55 $ at 92,50 ₽ is 2 363,375 ₽ — 236 337,5 kopecks, and the half goes up.
    expect(convertMinor(2_555, { baseMinor: 9_250, quoteMinor: 100 })).toBe(236_338);
    // G-003 holdings: 744,45 $ at 92,50 ₽ — 6 886 162,5 kopecks.
    expect(convertMinor(74_445, { baseMinor: 9_250, quoteMinor: 100 })).toBe(6_886_163);
    expect(convertMinor(4_000, { baseMinor: 9_000, quoteMinor: 100 })).toBe(360_000);
    // A quarter goes down, three quarters go up.
    expect(convertMinor(1, { baseMinor: 125, quoteMinor: 100 })).toBe(1);
    expect(convertMinor(1, { baseMinor: 175, quoteMinor: 100 })).toBe(2);
    expect(convertMinor(0, { baseMinor: 9_250, quoteMinor: 100 })).toBe(0);
  });

  it("rounds a negative amount as the positive one and keeps the sign", () => {
    expect(convertMinor(-2_555, { baseMinor: 9_250, quoteMinor: 100 })).toBe(-236_338);
    expect(convertMinor(-1, { baseMinor: 125, quoteMinor: 100 })).toBe(-1);
    expect(Object.is(convertMinor(-1, { baseMinor: 1, quoteMinor: 1_000 }), 0)).toBe(true);
  });

  it("computes exactly where a float product would already have lost digits", () => {
    // 9 007 199 254 735 991 × 3 / 7 is 3 860 228 252 029 710 and 3/7, so it rounds down. In doubles
    // the product has already lost its last digit, and rounding the float quotient goes up instead.
    const amount = 9_007_199_254_735_991;
    expect(Math.round((amount * 3) / 7)).toBe(3_860_228_252_029_711);
    expect(convertMinor(amount, { baseMinor: 3, quoteMinor: 7 })).toBe(3_860_228_252_029_710);
  });

  it("refuses a result outside the safe integer range and a rate it does not store", () => {
    expect(() => convertMinor(Number.MAX_SAFE_INTEGER, { baseMinor: 2, quoteMinor: 1 })).toThrow(/safe integer range/);
    expect(() => convertMinor(1.5, { baseMinor: 1, quoteMinor: 1 })).toThrow(/integer minor-unit amount/);
    for (const bad of [
      { baseMinor: 0, quoteMinor: 100 },
      { baseMinor: 100, quoteMinor: 0 },
      { baseMinor: RATE_PART_MAX + 1, quoteMinor: 100 },
      { baseMinor: 1.5, quoteMinor: 100 },
      { baseMinor: -9_000, quoteMinor: 100 },
    ]) {
      expect(isExchangeRateValue(bad), JSON.stringify(bad)).toBe(false);
      expect(() => convertMinor(100, bad), JSON.stringify(bad)).toThrow(/rate parts must be integers from 1 to 1000000000000/);
    }
    expect(isExchangeRateValue({ baseMinor: RATE_PART_MAX, quoteMinor: 1 })).toBe(true);
    expect(isExchangeRateValue(null)).toBe(false);
    expect(isExchangeRateValue([9_000, 100])).toBe(false);
  });
});

describe("findRate", () => {
  const rates = [
    rate("8e000000-0000-4000-8000-000000000001", "2026-07-31", 9_000),
    rate("8e000000-0000-4000-8000-000000000002", "2026-08-15", 9_250),
    rate("8e000000-0000-4000-8000-000000000003", "2026-08-15", 9_300),
    rate("8e000000-0000-4000-8000-000000000004", "2026-08-20", 9_400, { baseCurrency: "EUR" }),
    rate("8e000000-0000-4000-8000-000000000005", "2026-08-20", 1_000, { currency: "CNY" }),
  ];

  it("takes the latest rate dated on or before the day", () => {
    expect(findRate(rates, "USD", "RUB", "2026-08-10")?.rate.baseMinor).toBe(9_000);
    expect(findRate(rates, "USD", "RUB", "2026-07-31")?.rate.baseMinor).toBe(9_000);
    expect(findRate(rates, "USD", "RUB", "2026-07-30")).toBeUndefined();
  });

  it("breaks a tie on the date by the larger identifier, whatever the order of the list", () => {
    expect(findRate(rates, "USD", "RUB", "2026-08-31")?.id).toBe("8e000000-0000-4000-8000-000000000003");
    expect(findRate([...rates].reverse(), "USD", "RUB", "2026-08-31")?.id).toBe("8e000000-0000-4000-8000-000000000003");
  });

  it("ignores a rate against another base and a rate of another currency", () => {
    expect(findRate(rates, "USD", "EUR", "2026-08-31")?.rate.baseMinor).toBe(9_400);
    expect(findRate(rates, "CNY", "RUB", "2026-08-31")?.rate.baseMinor).toBe(1_000);
    expect(findRate(rates, "EUR", "RUB", "2026-08-31")).toBeUndefined();
  });
});

describe("indexRates", () => {
  it("chooses exactly the rate findRate chooses, for every pair and day", () => {
    // A seeded table with every case findRate decides: several rates a day, two bases, gaps,
    // identifiers out of order and days before the first rate and after the last.
    let seed = 7;
    const next = (bound: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % bound;
    };
    const days = Array.from({ length: 40 }, (_, day) => `2026-08-${String((day % 28) + 1).padStart(2, "0")}`);
    const rates: ExchangeRate[] = Array.from({ length: 400 }, (_, index) => rate(
      // Unique, and in no particular order: a random prefix and the position as the tail.
      `8e000000-0000-4000-8000-${String(next(1_000_000) * 1_000 + index).padStart(12, "0")}`,
      days[next(days.length)]!,
      1 + next(10_000),
      { currency: ["USD", "EUR", "CNY"][next(3)]!, baseCurrency: ["RUB", "KZT"][next(2)]! },
    ));
    const index = indexRates(rates);
    for (const currency of ["USD", "EUR", "CNY", "JPY"]) {
      for (const base of ["RUB", "KZT", "USD"]) {
        for (const day of ["2026-07-31", ...days, "2026-09-01"]) {
          expect(index.find(currency, base, day), `${currency}/${base} ${day}`).toBe(findRate(rates, currency, base, day));
        }
      }
    }
    expect(indexRates([]).find("USD", "RUB", "2026-08-01")).toBeUndefined();
  });

  it("breaks a tie on the date by the larger identifier, whatever the order of the list", () => {
    const tied = [
      rate("8e000000-0000-4000-8000-000000000003", "2026-08-15", 9_300),
      rate("8e000000-0000-4000-8000-000000000002", "2026-08-15", 9_250),
      rate("8e000000-0000-4000-8000-000000000001", "2026-07-31", 9_000),
    ];
    expect(indexRates(tied).find("USD", "RUB", "2026-08-15")?.id).toBe("8e000000-0000-4000-8000-000000000003");
    expect(indexRates([...tied].reverse()).find("USD", "RUB", "2026-08-15")?.id).toBe("8e000000-0000-4000-8000-000000000003");
    expect(indexRates(tied).find("USD", "RUB", "2026-08-14")?.id).toBe("8e000000-0000-4000-8000-000000000001");
  });
});
