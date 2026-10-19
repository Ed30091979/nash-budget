import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/AppShell";
import { installPlainCopy } from "./plain-text";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Не найден корневой элемент приложения.");
}

// Мягкие переносы в именах плиток — только для глаза: копирование из приложения их снимает.
installPlainCopy(document);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
