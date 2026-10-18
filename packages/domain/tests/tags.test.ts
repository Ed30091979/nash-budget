import { describe, expect, it } from "vitest";
import { G002, toDomainBudgetState } from "@family-budget/test-fixtures";

import {
  archiveTag,
  calculateAnnualPlan,
  calculateBudget,
  calculateMemberExpenses,
  COLLECTION_LIMITS,
  createTag,
  deleteTag,
  findTagByName,
  makeSeedBudget,
  normalizeTagIds,
  SEED_IDS,
  TagValidationError,
  type BudgetState,
  type TagId,
} from "../src/index.js";

const HOLIDAY = "8a000000-0000-4000-8000-0000000000a1";
const HOME = "8a000000-0000-4000-8000-0000000000a2";

function sequentialIds(...ids: TagId[]): () => TagId {
  let next = 0;
  return () => ids[next++] ?? `tag-${next}`;
}

/** The seed with two tags, and the food expense carrying both. */
function taggedSeed(): BudgetState {
  const seed = makeSeedBudget();
  return {
    ...seed,
    tags: [
      { id: HOLIDAY, name: "Отпуск", active: true },
      { id: HOME, name: "Дом", active: true },
    ],
    transactions: seed.transactions.map((transaction) =>
      transaction.id === SEED_IDS.transactions.food ? { ...transaction, tagIds: [HOME, HOLIDAY] } : transaction),
  };
}

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof TagValidationError) return error.code;
    throw error;
  }
}

describe("createTag", () => {
  it("creates an active tag and leaves every figure alone", () => {
    const seed = makeSeedBudget();
    const { state, tag } = createTag(seed, "  Отпуск ", sequentialIds(HOLIDAY));

    expect(tag).toEqual({ id: HOLIDAY, name: "Отпуск", active: true });
    expect(state.tags).toEqual([tag]);
    expect(state.transactions).toBe(seed.transactions);
    expect(calculateBudget(state)).toEqual(calculateBudget(seed));
  });

  it("refuses an empty name, an overlong one, hidden characters and mixed alphabets", () => {
    const seed = makeSeedBudget();
    expect(code(() => createTag(seed, "   "))).toBe("name_required");
    expect(code(() => createTag(seed, "я".repeat(41)))).toBe("name_too_long");
    expect(code(() => createTag(seed, "От\u200bпуск"))).toBe("name_forbidden_characters");
    expect(code(() => createTag(seed, "Отпуск в Paris"))).toBe("name_mixed_scripts");
    expect(createTag(seed, "я".repeat(40)).tag.name).toHaveLength(40);
  });

  it("refuses a duplicate of an active tag whatever the case, and lets an archived namesake be", () => {
    const state = taggedSeed();
    expect(code(() => createTag(state, "отпуск"))).toBe("duplicate_name");
    expect(() => createTag(state, "ОТПУСК")).toThrow(/уже существует/);

    const archived = archiveTag(state, HOLIDAY);
    expect(findTagByName(archived, "отпуск")?.id).toBe(HOLIDAY);
    const { tag } = createTag(archived, "Отпуск", sequentialIds("8a000000-0000-4000-8000-0000000000a3"));
    expect(tag.active).toBe(true);
  });

  it("refuses a name nobody can read: no letter or digit, a leading mark, a braille blank", () => {
    // Security review L1: the input rule of a name, on top of the text rule of every label.
    const seed = makeSeedBudget();
    for (const name of ["!!!", "…", "—", "\u0301Дом", "Дом\u2800", "\u2800", "\ufffc", "Дом\ufffc"]) {
      expect(code(() => createTag(seed, name, sequentialIds(HOLIDAY))), JSON.stringify(name)).toBe("name_unreadable");
    }
    expect(() => createTag(seed, "!!!", sequentialIds(HOLIDAY))).toThrow(/нужны буквы или цифры/);
    for (const name of ["2027", "Дом", "Отпуск 2027", "Дом!"]) {
      expect(createTag(seed, name, sequentialIds(HOLIDAY)).tag.name, name).toBe(name);
    }
  });

  it("refuses the tag past the limit a backup holds a document to, archived tags counted", () => {
    const seed = makeSeedBudget();
    const full: BudgetState = {
      ...seed,
      tags: Array.from({ length: COLLECTION_LIMITS.tags }, (_, index) => ({
        id: `8a000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Метка ${index}`,
        active: index % 2 === 0,
      })),
    };
    expect(code(() => createTag(full, "Отпуск", sequentialIds(HOLIDAY)))).toBe("limit_reached");
    expect(() => createTag(full, "Отпуск", sequentialIds(HOLIDAY))).toThrow(/Меток уже 500/);
    const roomForOne: BudgetState = { ...full, tags: full.tags!.slice(1) };
    expect(createTag(roomForOne, "Отпуск", sequentialIds(HOLIDAY)).state.tags).toHaveLength(COLLECTION_LIMITS.tags);
  });

  it("refuses an identifier that is empty or already taken anywhere in the document", () => {
    const state = taggedSeed();
    expect(code(() => createTag(state, "Ремонт", () => " "))).toBe("id_required");
    expect(code(() => createTag(state, "Ремонт", () => HOME))).toBe("duplicate_id");
    // A transaction's identifier is taken too: a backup refuses a file where two kinds share one.
    expect(code(() => createTag(state, "Ремонт", () => SEED_IDS.transactions.food))).toBe("duplicate_id");
  });
});

describe("archiveTag", () => {
  it("keeps the tag on every operation that carries it", () => {
    const state = taggedSeed();
    const archived = archiveTag(state, HOLIDAY);

    expect(archived.tags?.find((tag) => tag.id === HOLIDAY)?.active).toBe(false);
    expect(archived.transactions).toBe(state.transactions);
    expect(() => calculateBudget(archived)).not.toThrow();
    expect(archiveTag(archived, HOLIDAY)).toBe(archived);
    expect(code(() => archiveTag(state, "8a000000-0000-4000-8000-0000000000ff"))).toBe("unknown_tag");
  });
});

describe("deleteTag", () => {
  // Security review L3 (orchestrator decision): deleting a tag that operations carry used to take it
  // off every one of them, which through the journal is one whole-entity update per operation and
  // can silently undo a concurrent edit of that operation elsewhere. Such a tag is archived instead.
  it("refuses a tag an operation carries and points to the archive, moving nothing", () => {
    const state = taggedSeed();
    expect(code(() => deleteTag(state, HOLIDAY))).toBe("tag_in_use");
    expect(() => deleteTag(state, HOME)).toThrow(/Её можно убрать в архив/);
    // An archived tag is still on its operations, so it is still in use.
    expect(code(() => deleteTag(archiveTag(state, HOLIDAY), HOLIDAY))).toBe("tag_in_use");
  });

  it("refuses a tag a recurring rule writes onto its occurrences", () => {
    const seed = makeSeedBudget();
    const state: BudgetState = {
      ...seed,
      tags: [{ id: HOME, name: "Дом", active: true }],
      recurringRules: [{
        id: "8b000000-0000-4000-8000-000000000001",
        template: { kind: "expense", amountMinor: 150_000, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food, tagIds: [HOME] },
        frequency: "weekly",
        interval: 2,
        startDate: "2026-08-04",
        active: true,
      }],
    };
    expect(code(() => deleteTag(state, HOME))).toBe("tag_in_use");
    expect(() => deleteTag(state, HOME)).toThrow(/стоит в регулярной операции/);
  });

  it("deletes a tag no operation carries, and touches nothing else", () => {
    const state = taggedSeed();
    const { state: withSpare, tag } = createTag(state, "Ремонт", sequentialIds("8a000000-0000-4000-8000-0000000000a3"));
    const deleted = deleteTag(withSpare, tag.id);

    expect(deleted.tags).toEqual(state.tags);
    expect(deleted.transactions).toBe(withSpare.transactions);
    expect(() => calculateBudget(deleted)).not.toThrow();
  });

  it("moves no figure of any budget, plan or split", () => {
    const seed = makeSeedBudget();
    const unused: BudgetState = { ...seed, tags: taggedSeed().tags! };
    const deleted = deleteTag(deleteTag(unused, HOLIDAY), HOME);
    expect(deleted.tags).toEqual([]);
    expect(calculateBudget(deleted)).toEqual(calculateBudget(unused));
    expect(calculateAnnualPlan(deleted, "2026-07", 12)).toEqual(calculateAnnualPlan(unused, "2026-07", 12));
    expect(calculateMemberExpenses(deleted)).toEqual(calculateMemberExpenses(unused));
  });

  it("refuses a tag the state does not hold", () => {
    expect(code(() => deleteTag(makeSeedBudget(), HOLIDAY))).toBe("unknown_tag");
  });
});

describe("normalizeTagIds", () => {
  it("drops repeats and sorts, so one set of tags is one value however it was picked", () => {
    expect(normalizeTagIds([HOME, HOLIDAY, HOME])).toEqual([HOLIDAY, HOME]);
    expect(normalizeTagIds([HOLIDAY, HOME])).toEqual(normalizeTagIds([HOME, HOLIDAY]));
  });

  it("has no empty list: no tags is no field", () => {
    expect(normalizeTagIds([])).toBeUndefined();
  });
});

describe("tags on canonical G-002", () => {
  it("leave the July reserve, the free amount and the split by participant where they were", () => {
    const g002 = toDomainBudgetState(G002) as BudgetState;
    const { state: withTag, tag } = createTag(g002, "Дача", sequentialIds(HOLIDAY));
    const tagged: BudgetState = {
      ...withTag,
      transactions: withTag.transactions.map((transaction) => ({ ...transaction, tagIds: [tag.id] })),
    };

    expect(calculateAnnualPlan(tagged, G002.startMonth, 12).currentMonth).toMatchObject({
      annualReserveMinor: 1_980_900,
      spendableAfterPlanMinor: 4_419_100,
    });
    expect(calculateBudget(tagged)).toEqual(calculateBudget(g002));
    expect(calculateMemberExpenses(tagged)).toEqual(calculateMemberExpenses(g002));
  });
});
