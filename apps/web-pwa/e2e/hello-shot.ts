import type { Page } from "@playwright/test";

/**
 * Снимок экрана для отчёта — только когда прогон об этом попросил.
 *
 * Без `HELLO_SHOTS_DIR` функция ничего не делает: обычный прогон не пишет файлов вне своего
 * временного каталога. С ним — кладёт `hello-<имя>.png` в названный каталог, чтобы снимок
 * можно было снять с настоящей сборки в том самом состоянии, которое проверка только что
 * подтвердила, а не воспроизводить его руками.
 */
export async function helloShot(page: Page, name: string): Promise<void> {
  const directory = process.env.HELLO_SHOTS_DIR;
  if (!directory) return;
  await page.screenshot({ path: `${directory}/hello-${name}.png` });
}
