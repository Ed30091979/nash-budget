import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // До первой публикации package name нужно подтвердить и затем не менять.
  appId: "com.edfurman.nashbudget",
  appName: "Наш бюджет",
  webDir: "../web-pwa/dist",
  android: {
    // Фон WebView до первого кадра страницы — ровно `--canvas` из apps/web-pwa/src/styles.css.
    // Тёмный `#100904` остался от оформления 1.0.0 и давал шов «почти чёрное → бумага» между
    // заставкой и приложением. Совпадение с таблицей стилей сверяет scripts/brand-palette.mjs.
    backgroundColor: "#F6F3EE",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    loggingBehavior: "none",
  },
  plugins: {
    // Встроенный плагин SystemBars красит глифы строки состояния и навигационной панели сам и при
    // `DEFAULT` берёт стиль из системной темы: в тёмной теме — светлые глифы, а под ними всё равно
    // холст, потому что тема у приложения одна. `LIGHT` — светлые панели, тёмные глифы, как в теме.
    // Измерено в эмуляторе: без этого в тёмной теме часы на холсте были белыми.
    SystemBars: {
      style: "LIGHT",
    },
  },
};

export default config;
