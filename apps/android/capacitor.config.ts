import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // До первой публикации package name нужно подтвердить и затем не менять.
  appId: "ru.nashbudget.app",
  appName: "Наш бюджет",
  webDir: "../web-pwa/dist",
  android: {
    backgroundColor: "#100904",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false,
    loggingBehavior: "none",
  },
};

export default config;
