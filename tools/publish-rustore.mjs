#!/usr/bin/env node
/**
 * Публикация «Наш бюджет» в RuStore через Public API.
 *
 *   node tools/publish-rustore.mjs                 # черновик + карточка + медиа + APK
 *   node tools/publish-rustore.mjs --submit        # … и отправить на модерацию
 *
 * Ключ API: ~/.upword/rustore-api.env (RUSTORE_KEY_ID, RUSTORE_PRIVATE_KEY_PATH).
 * Приложение com.edfurman.nashbudget должно быть создано в RuStore Console,
 * а ключ API — иметь к нему доступ.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "com.edfurman.nashbudget";
const API = "https://public-api.rustore.ru/public/v1";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "outputs/release-1.0.0/store-assets");
const APK = path.join(ROOT, "outputs/release-1.0.0/nash-budget-1.0.0.apk");
const SUBMIT = process.argv.includes("--submit");

const SHORT_DESCRIPTION = "Семейный бюджет офлайн: план на год, лимиты месяца и резерв к крупным платежам.";
const WHATS_NEW = "Первый релиз: планирование на 12–24 месяца, лимиты месяца, резерв к крупным платежам, офлайн-работа и резервные копии.";
const MODER_INFO = "Приложение полностью офлайн, без регистрации и сбора данных. Все данные хранятся локально на устройстве.";
const FULL_DESCRIPTION = `«Наш бюджет» — спокойный планировщик семейных денег, который работает полностью на вашем устройстве. Без регистрации, без интернета, без рекламы и аналитики.

ЧТО УМЕЕТ:
— План на 12–24 месяца: доходы, ежемесячные, сезонные и крупные ежегодные платежи;
— Резерв к срокам: приложение подсказывает, сколько откладывать каждый месяц, чтобы страховка или обучение не стали сюрпризом;
— Лимиты повседневных расходов и сигналы «почти лимит» / «перелимит»;
— Быстрая запись операций: доходы, расходы, возвраты, переводы, накопления;
— Дашборд план/факт, ближайшие платежи, поиск по истории;
— Резервная копия в JSON и экспорт таблицы в CSV — вы сами выбираете, куда сохранить файл.

ПРИВАТНОСТЬ:
Все данные хранятся только на устройстве. Приложение не запрашивает разрешений, не собирает и не передаёт персональные данные, не содержит рекламы и трекеров. Экспорт создаётся только по вашей команде в выбранную вами папку.

Политика конфиденциальности: https://ed30091979.github.io/nash-budget/privacy.html`;

function fail(step, payload) {
  console.error(`✗ ${step}:`, typeof payload === "string" ? payload : JSON.stringify(payload));
  process.exit(1);
}

// --- авторизация ---
const env = Object.fromEntries(
  fs.readFileSync(path.join(os.homedir(), ".upword/rustore-api.env"), "utf-8")
    .split("\n").filter((l) => l.includes("=")).map((l) => l.split("=", 2)),
);
let pem = fs.readFileSync(env.RUSTORE_PRIVATE_KEY_PATH, "utf-8").trim();
if (!pem.includes("BEGIN")) {
  pem = `-----BEGIN PRIVATE KEY-----\n${pem.replace(/(.{64})/g, "$1\n").trim()}\n-----END PRIVATE KEY-----`;
}
const timestamp = new Date().toISOString();
const signature = crypto.sign("RSA-SHA512", Buffer.from(env.RUSTORE_KEY_ID + timestamp), pem).toString("base64");
const authResp = await fetch("https://public-api.rustore.ru/public/auth/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ keyId: env.RUSTORE_KEY_ID, timestamp, signature }),
});
const auth = await authResp.json();
if (auth.code !== "OK") fail("Авторизация", auth);
const headers = { "Public-Token": auth.body.jwe };
console.log("✓ Авторизация в RuStore API");

// --- черновик версии с карточкой ---
const draftBody = {
  appName: "Наш бюджет",
  appType: "MAIN",
  ageLegal: "0+",
  shortDescription: SHORT_DESCRIPTION.slice(0, 80),
  fullDescription: FULL_DESCRIPTION.slice(0, 4000),
  whatsNew: WHATS_NEW.slice(0, 5000),
  moderInfo: MODER_INFO.slice(0, 180),
  publishType: "INSTANTLY",
};

let versionId;
const draftResp = await fetch(`${API}/application/${PACKAGE}/version`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify(draftBody),
});
const draft = await draftResp.json();
if (draft.code === "OK") {
  versionId = draft.body;
  console.log(`✓ Черновик версии создан: ${versionId}`);
} else {
  const match = String(draft.message ?? "").match(/\d{4,}/);
  if (!match) fail("Создание черновика", draft);
  versionId = match[0];
  console.log(`▸ Использую существующий черновик: ${versionId}`);
}

async function uploadFile(step, url, filePath) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const resp = await fetch(url, { method: "POST", headers, body: form });
  const json = await resp.json();
  if (json.code !== "OK") {
    console.warn(`▸ ${step}: ${JSON.stringify(json).slice(0, 300)}`);
    return false;
  }
  console.log(`✓ ${step}`);
  return true;
}

// --- иконка и скриншоты ---
await uploadFile("Иконка 512", `${API}/application/${PACKAGE}/version/${versionId}/image/icon`, path.join(ASSETS, "icon-512.png"));
const shots = ["01-today.png", "02-year.png", "03-operations.png", "04-more.png", "05-onboarding.png"];
for (let i = 0; i < shots.length; i += 1) {
  await uploadFile(
    `Скриншот ${i + 1}/${shots.length}`,
    `${API}/application/${PACKAGE}/version/${versionId}/image/screenshot/PORTRAIT/${i}`,
    path.join(ASSETS, shots[i]),
  );
}

// --- APK ---
if (!fs.existsSync(APK)) fail("APK", `нет файла ${APK}`);
const ok = await uploadFile(
  `APK (${(fs.statSync(APK).size / 1e6).toFixed(1)} MB)`,
  `${API}/application/${PACKAGE}/version/${versionId}/apk?servicesType=Unknown&isMainApk=true`,
  APK,
);
if (!ok) fail("Загрузка APK", "см. выше");

// --- на модерацию ---
if (SUBMIT) {
  const commitResp = await fetch(`${API}/application/${PACKAGE}/version/${versionId}/commit?priorityUpdate=0`, {
    method: "POST",
    headers,
  });
  const commit = await commitResp.json();
  if (commit.code !== "OK") fail("Отправка на модерацию", commit);
  console.log("✓ Версия отправлена на модерацию RuStore");
} else {
  console.log("▸ Черновик готов. Отправка на модерацию: node tools/publish-rustore.mjs --submit");
}
