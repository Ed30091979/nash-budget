import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { defaultE2EToday, installE2EClock } from "./clock";

/**
 * Ни одного системного окна: `confirm`, `alert`, `prompt` и «Покинуть страницу?» прогон считает
 * ошибкой (третье ревью). Приложение говорит своими экранами; системное окно в прогоне — это
 * вопрос, который человек увидел бы там, где ему нечего спрашивать, — например «Несохранённый
 * черновик будет удалён» сразу после записанной покупки. Окно закрывается отказом, чтобы прогон не
 * висел, и тест падает с его текстом.
 */
export function watchDialogs(context: BrowserContext, seen: string[]): void {
  const watch = (page: Page): void => {
    page.on("dialog", (dialog) => {
      seen.push(`${dialog.type()}: ${dialog.message()}`);
      void dialog.dismiss().catch(() => undefined);
    });
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
}

export const test = base.extend<{ nativeDialogs: string[]; today: string }>({
  /** День прогона (`e2e/clock.ts`): канонический или `E2E_TODAY`; тест просит свой `test.use({ today })`. */
  today: [defaultE2EToday(), { option: true }],
  /** Часы каждой страницы теста стоят на утре этого дня, а не на настоящих часах машины. */
  context: async ({ context, today }, use) => {
    await installE2EClock(context, today);
    await use(context);
  },
  nativeDialogs: [
    async ({ context }, use) => {
      const seen: string[] = [];
      watchDialogs(context, seen);
      await use(seen);
      expect(seen, "системное окно появилось в прогоне").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
