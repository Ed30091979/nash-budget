/// <reference types="node" />
import { readFileSync } from "node:fs";

/**
 * Исходник оболочки приложения целиком — для проверок, которые читают код, а не разметку.
 *
 * `App.tsx` разобран на модули (`app/AppShell.tsx`, `app/routes.tsx`, `app/budget-store.ts` и
 * экраны, переехавшие в свои папки). Проверки, которые утверждали что-то о «приложении», читают
 * то же самое, что читали в одном файле, — склейку этих модулей в одном порядке. Новый модуль
 * оболочки добавляется сюда, иначе проверки его не увидят.
 *
 * Модуль обслуживает проверки: приложение его не импортирует, в сборку он не попадает.
 */
export const APP_SOURCE_FILES = [
  "app/AppShell.tsx",
  "app/routes.tsx",
  "app/budget-store.ts",
  "features/today/TodayScreen.tsx",
  "features/plan-year/YearScreen.tsx",
  "features/more/MoreScreen.tsx",
  "date-words.ts",
] as const;

export function readAppSource(): string {
  return APP_SOURCE_FILES.map((file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8")).join("\n");
}
