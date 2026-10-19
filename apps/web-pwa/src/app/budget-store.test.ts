/**
 * Сверка показа с документом на диске — `catchUp` координатора записи.
 *
 * Оболочка зовёт её после каждого круга синхронизации (`showStoredBudget` в `useFamily`). Здесь
 * проверяется то, на чём держится «экран не отстаёт»: сверка идёт по ревизии, ждёт свою запись, а
 * не пропадает из-за неё, и показывает только то, что действительно лежит на диске.
 */
import type { BudgetState } from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { prepareBudgetState } from "../backup";
import { makeG000State } from "../features/operations/test-fixture";
import { BudgetWriteRefusal } from "../write-refusal";
import { createAppBudgetSaveCoordinator, type BudgetSaveResult } from "./budget-store";

/** Документ на диске и экран над ним — как в оболочке: показанное состояние и его ревизия. */
function harness() {
  const initial = prepareBudgetState(makeG000State());
  const disk = { value: initial as BudgetState, revision: "r1" };
  const screen = { value: initial, revision: "r1" as string | null, published: 0 };
  let journal: (() => Promise<BudgetSaveResult | null>) | null = null;
  const coordinator = createAppBudgetSaveCoordinator({
    repository: {
      loadVersioned: async () => ({ value: disk.value, revision: disk.revision }),
      saveIfRevision: async (expected, state) => {
        if (expected !== disk.revision) return { status: "conflict", current: { ...disk } };
        disk.value = state;
        disk.revision = `${disk.revision}+`;
        return { status: "saved", value: state, revision: disk.revision };
      },
    },
    getCurrent: () => screen.value,
    getRevision: () => screen.revision,
    setRevision: (revision) => {
      screen.revision = revision;
    },
    publish: (state, revision) => {
      screen.value = state;
      screen.revision = revision;
      screen.published += 1;
    },
    journalWrite: () => (journal === null ? null : () => journal!()),
  });
  const adopt = (state: BudgetState, revision: string) => {
    screen.value = state;
    screen.revision = revision;
    return true;
  };
  return { disk, screen, coordinator, adopt, setJournal: (write: typeof journal) => { journal = write; } };
}

/** Чужая покупка, которую приём записал в документ: новая ревизия на диске, экран о ней не знает. */
function deliver(disk: { value: BudgetState; revision: string }, note: string): void {
  const [first, ...rest] = disk.value.transactions;
  disk.value = { ...disk.value, transactions: [{ ...first!, note }, ...rest] };
  disk.revision = `remote:${note}`;
}

describe("показ догоняет документ на диске", () => {
  it("показывает документ, ревизия которого не та, что на экране", async () => {
    const { disk, screen, coordinator, adopt } = harness();
    deliver(disk, "от Анны");

    await expect(coordinator.catchUp(adopt)).resolves.toBe(true);
    expect(screen.revision).toBe("remote:от Анны");
    expect(screen.value.transactions[0]?.note).toBe("от Анны");
  });

  it("ничего не показывает, когда на экране та же ревизия, что на диске", async () => {
    const { coordinator } = harness();
    let asked = 0;
    await expect(coordinator.catchUp(() => { asked += 1; return true; })).resolves.toBe(false);
    expect(asked).toBe(0);
  });

  it("сверка во время своей записи ждёт её, а не пропадает, — и читает диск после неё", async () => {
    // Прежде показ на время записи просто пропускался, и если запись отказала, а приём тем временем
    // уже лёг на диск, экран оставался без него, пока следующий круг не применит что-то новое.
    const { disk, screen, coordinator, adopt, setJournal } = harness();
    let refuse!: () => void;
    const refused = new Promise<void>((resolve) => {
      refuse = resolve;
    });
    setJournal(async () => {
      await refused;
      throw new BudgetWriteRefusal("held");
    });

    const write = coordinator.apply((state) => ({ ...state }));
    expect(coordinator.locked).toBe(true);
    deliver(disk, "от Анны");
    const caughtUp = coordinator.catchUp(adopt);
    // Пока запись идёт, экран не трогается: её сравнение ревизии — против того, что на нём.
    await Promise.resolve();
    expect(screen.revision).toBe("r1");

    refuse();
    await expect(write).rejects.toBeInstanceOf(BudgetWriteRefusal);
    await expect(caughtUp).resolves.toBe(true);
    expect(screen.revision).toBe("remote:от Анны");
    expect(screen.published).toBe(0);
  });

  it("запись после сверки идёт от показанного документа, а не от прежнего", async () => {
    const { disk, screen, coordinator, adopt } = harness();
    deliver(disk, "от Анны");
    const caughtUp = coordinator.catchUp(adopt);
    const write = coordinator.apply((state) => ({ ...state, members: [] }));

    await expect(caughtUp).resolves.toBe(true);
    await expect(write).resolves.toMatchObject({ members: [] });
    // Сравнение ревизии прошло против того, что показала сверка, и чужая покупка не потерялась.
    expect(disk.value.transactions[0]?.note).toBe("от Анны");
    expect(screen.revision).toBe(disk.revision);
  });

  it("пока своя запись не легла, сверка не читает диск и экран не трогает", async () => {
    // Без очереди сверка прочла бы диск посреди записи и показала бы чужую ревизию поверх своей
    // будущей; проверка — по времени, а не по порядку микрозадач (ревью исправления синхронизации).
    const initial = prepareBudgetState(makeG000State());
    const disk = { value: initial as BudgetState, revision: "r1" };
    const screen = { value: initial, revision: "r1" as string | null };
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = createAppBudgetSaveCoordinator({
      repository: {
        loadVersioned: async () => {
          reads += 1;
          return { value: disk.value, revision: disk.revision };
        },
        saveIfRevision: async (_expected, state) => {
          await gate;
          disk.value = state;
          disk.revision = "r2";
          return { status: "saved", value: state, revision: "r2" };
        },
      },
      getCurrent: () => screen.value,
      getRevision: () => screen.revision,
      setRevision: (revision) => {
        screen.revision = revision;
      },
      publish: (state, revision) => {
        screen.value = state;
        screen.revision = revision;
      },
    });
    const write = coordinator.apply((state) => ({ ...state, members: [] }));
    disk.revision = "remote";
    const caught = coordinator.catchUp((state, revision) => {
      screen.value = state;
      screen.revision = revision;
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(0);
    expect(screen.revision).toBe("r1");
    release();
    await write.catch(() => undefined);
    await caught;
    expect(reads).toBe(1);
    expect(screen.revision).toBe("r2");
  });

  it("документ, который не собирается в показуемый бюджет, не показывается", async () => {
    const { disk, screen, coordinator } = harness();
    disk.value = { broken: true } as unknown as BudgetState;
    disk.revision = "r-broken";
    let asked = 0;

    await expect(coordinator.catchUp(() => { asked += 1; return true; })).resolves.toBe(false);
    expect(asked).toBe(0);
    expect(screen.revision).toBe("r1");
  });

  it("решает тот, кто показывает: отказ показать — это «не показано»", async () => {
    const { disk, screen, coordinator } = harness();
    deliver(disk, "от Анны");

    await expect(coordinator.catchUp(() => false)).resolves.toBe(false);
    expect(screen.revision).toBe("r1");
  });
});
