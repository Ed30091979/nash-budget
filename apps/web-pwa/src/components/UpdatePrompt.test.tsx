/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UpdatePromptView } from "./UpdatePrompt";

const noOp = vi.fn();

describe("UpdatePromptView", () => {
  it("renders an explicit conservative update prompt with Later", () => {
    const html = renderToStaticMarkup(
      <UpdatePromptView
        offlineReady={false}
        needRefresh
        registrationFailed={false}
        updatePhase="idle"
        updateBlocked={false}
        onUpdate={noOp}
        onLater={noOp}
        onDismissOfflineReady={noOp}
        onDismissRegistrationError={noOp}
      />,
    );

    expect(html).toContain("Обновление начнётся только после вашего подтверждения");
    expect(html).toContain("Обновить сейчас");
    expect(html).toContain("Позже");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain("window.location");
  });

  it("announces and disables actions while a single controlled update is in progress", () => {
    const html = renderToStaticMarkup(
      <UpdatePromptView
        offlineReady={false}
        needRefresh
        registrationFailed={false}
        updatePhase="updating"
        updateBlocked={false}
        onUpdate={noOp}
        onLater={noOp}
        onDismissOfflineReady={noOp}
        onDismissRegistrationError={noOp}
      />,
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Обновляем…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("shows a generic accessible failure and a retry without error details", () => {
    const html = renderToStaticMarkup(
      <UpdatePromptView
        offlineReady={false}
        needRefresh
        registrationFailed={false}
        updatePhase="failed"
        updateBlocked={false}
        onUpdate={noOp}
        onLater={noOp}
        onDismissOfflineReady={noOp}
        onDismissRegistrationError={noOp}
      />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("Не удалось обновить приложение");
    expect(html).toContain("Повторить обновление");
    expect(html).not.toContain("registration");
    expect(html).not.toContain("device");
  });

  it("keeps service-worker registration failures generic and dismissible", () => {
    const html = renderToStaticMarkup(
      <UpdatePromptView
        offlineReady={false}
        needRefresh={false}
        registrationFailed
        updatePhase="idle"
        updateBlocked={false}
        onUpdate={noOp}
        onLater={noOp}
        onDismissOfflineReady={noOp}
        onDismissRegistrationError={noOp}
      />,
    );

    expect(html).toContain("Не удалось включить офлайн-режим");
    expect(html).toContain("Приложение продолжит работать в браузере");
    expect(html).toContain("Понятно");
    expect(html).not.toContain("registration");
    expect(html).not.toContain("serviceWorker");
  });

  it("explains that an unsaved operation blocks reload without hiding the update", () => {
    const html = renderToStaticMarkup(
      <UpdatePromptView
        offlineReady={false}
        needRefresh
        registrationFailed={false}
        updatePhase="idle"
        updateBlocked
        onUpdate={noOp}
        onLater={noOp}
        onDismissOfflineReady={noOp}
        onDismissRegistrationError={noOp}
      />,
    );

    expect(html).toContain("Сначала сохраните изменения или очистите черновик");
    expect(html).toContain("Несохранённый ввод останется в форме");
    expect(html).toContain('id="update-blocked"');
    expect(html).toContain('aria-describedby="update-blocked"');
    expect(html).toContain("Обновить сейчас");
  });

  it("does not log registration or update errors or add an automatic reload path", () => {
    const source = [
      readFileSync(new URL("./UpdatePrompt.tsx", import.meta.url), "utf8"),
      readFileSync(new URL("./update-policy.ts", import.meta.url), "utf8"),
    ].join("\n");

    expect(source).not.toMatch(/console\.(?:log|error|warn)/);
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("location.reload");
    expect(source.match(/updateServiceWorker\(true\)/g)).toHaveLength(1);
  });
});
