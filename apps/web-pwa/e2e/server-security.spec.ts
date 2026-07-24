import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";

interface RawResponse {
  readonly body: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly status: number | undefined;
}

function getRawPath(baseURL: string, path: string): Promise<RawResponse> {
  const target = new URL(baseURL);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        method: "GET",
        path,
        port: target.port,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            body,
            headers: response.headers,
            status: response.statusCode,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("the isolated server rejects malformed percent encoding without crashing", async ({
  baseURL,
  request,
}) => {
  if (!baseURL) throw new Error("Playwright baseURL is required.");

  const malformed = await getRawPath(baseURL, "/%");

  expect(malformed.status).toBe(400);
  expect(malformed.body).toBe("Invalid path encoding.");
  expect(malformed.headers["content-security-policy"]).toContain(
    "frame-ancestors 'none'",
  );
  expect(malformed.headers["x-frame-options"]).toBe("DENY");

  const health = await request.get(`${baseURL}/__e2e__/health`);
  expect(health.ok()).toBe(true);
  const healthBody = (await health.json()) as {
    activeBuild: "A" | "B";
    buildId: string;
    ready: boolean;
  };
  expect(healthBody.ready).toBe(true);
  expect(healthBody.buildId).toBe(
    healthBody.activeBuild === "A" ? "phase8-e2e-a" : "phase8-e2e-b",
  );
});
