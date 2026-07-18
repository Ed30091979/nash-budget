import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // До первой публикации package name нужно подтвердить и затем не менять.
  appId: "ru.familybudget.app",
  appName: "Наш бюджет",
  webDir: "../web-pwa/dist",
  android: {
    backgroundColor: "#f5f7fa",
  },
};

export default config;
