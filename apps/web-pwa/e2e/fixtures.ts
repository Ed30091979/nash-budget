import { expect, test as base, type BrowserContext, type Page } from "@playwright/test";

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

export const test = base.extend<{ nativeDialogs: string[] }>({
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
