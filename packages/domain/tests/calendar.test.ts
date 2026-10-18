import { describe, expect, it } from "vitest";

import { addDays, dateFromDayIndex, dayIndex, daysInMonth, monthFromIndex, monthIndex } from "../src/index.js";

/** Every date from `first` to `last` inclusive, walked month by month without any day arithmetic. */
function* calendarDays(firstYear: number, lastYear: number): Generator<string> {
  for (let index = monthIndex(`${firstYear}-01`); index <= monthIndex(`${lastYear}-12`); index += 1) {
    const month = monthFromIndex(index);
    for (let day = 1; day <= daysInMonth(month); day += 1) yield `${month}-${String(day).padStart(2, "0")}`;
  }
}

describe("day arithmetic", () => {
  it("counts days from 1970-01-01, both ways", () => {
    expect(dayIndex("1970-01-01")).toBe(0);
    expect(dayIndex("1970-01-02")).toBe(1);
    expect(dayIndex("1969-12-31")).toBe(-1);
    expect(dayIndex("2000-03-01")).toBe(11_017);
    expect(dateFromDayIndex(0)).toBe("1970-01-01");
    expect(dateFromDayIndex(11_017)).toBe("2000-03-01");
  });

  it("walks every day of the window the journal accepts, 1900 to 2199, one step at a time", () => {
    let previous: number | null = null;
    for (const date of calendarDays(1900, 2199)) {
      const index = dayIndex(date);
      if (previous !== null) expect(index).toBe(previous + 1);
      expect(dateFromDayIndex(index)).toBe(date);
      previous = index;
    }
    expect(dayIndex("2199-12-31") - dayIndex("1900-01-01") + 1).toBe(109_573);
  });

  it("follows the Gregorian leap rule, 1900 and 2100 included", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01");
    expect(addDays("2000-02-28", 1)).toBe("2000-02-29");
    expect(addDays("1900-02-28", 1)).toBe("1900-03-01");
    expect(addDays("2100-02-28", 1)).toBe("2100-03-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-08-04", 14)).toBe("2026-08-18");
    expect(addDays("2026-08-04", 0)).toBe("2026-08-04");
    expect(addDays("2028-02-29", 365)).toBe("2029-02-28");
  });

  it("names both ends of the four-digit calendar and refuses to step past them", () => {
    expect(dateFromDayIndex(dayIndex("0000-01-01"))).toBe("0000-01-01");
    expect(dateFromDayIndex(dayIndex("9999-12-31"))).toBe("9999-12-31");
    expect(() => addDays("9999-12-31", 1)).toThrow(/supported calendar range/);
    expect(() => addDays("0000-01-01", -1)).toThrow(/supported calendar range/);
  });

  it("refuses an impossible date and a fractional offset", () => {
    expect(() => dayIndex("2027-02-29")).toThrow(/valid calendar date/);
    expect(() => dayIndex("2026-04-31")).toThrow(/valid calendar date/);
    expect(() => dayIndex("2026-13-01")).toThrow(/valid calendar month/);
    expect(() => dayIndex("2026-8-1")).toThrow(/YYYY-MM-DD/);
    expect(() => addDays("2026-08-01", 0.5)).toThrow(/integer number of days/);
    expect(() => dateFromDayIndex(Number.NaN)).toThrow(/supported calendar range/);
  });
});
