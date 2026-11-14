import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import worker from "../src/index";

const SECRET = "test-secret";
const realFetch = globalThis.fetch;
let env: Env;

beforeAll(async () => {
  const { privateKey } = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString("base64")}\n-----END PRIVATE KEY-----\n`;
  env = {
    APP_ID: "5657291",
    REVIEWER: "dvcrn",
    ALLOWED_REPOS: ["dvcrn/", "digitalvibeshq/", "microfnhq/"],
    GITHUB_WEBHOOK_SECRET: SECRET,
    GITHUB_APP_PRIVATE_KEY: pem,
  } as Env;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function delivery(payload: unknown, secret = SECRET): Promise<Request> {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return new Request("https://worker.test/", {
    method: "POST",
    headers: { "X-GitHub-Event": "pull_request", "X-Hub-Signature-256": `sha256=${Buffer.from(mac).toString("hex")}` },
    body,
  });
}

const opened = (author: string, repo = "dvcrn/example") => ({
  action: "opened",
  installation: { id: 42 },
  repository: { full_name: repo },
  pull_request: { number: 7, user: { login: author }, requested_reviewers: [] },
});

describe("worker", () => {
  test("rejects deliveries signed with the wrong secret", async () => {
    const fetchMock = mock(realFetch);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await worker.fetch(await delivery(opened("someone"), "wrong"), env);

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requests the reviewer on an opened pull request", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith("/access_tokens")
        ? Response.json({ token: "installation-token" }, { status: 201 })
        : Response.json({}, { status: 201 });
    }) as typeof fetch;

    const res = await worker.fetch(await delivery(opened("someone")), env);

    expect(res.status).toBe(201);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/42/access_tokens",
      "https://api.github.com/repos/dvcrn/example/pulls/7/requested_reviewers",
    ]);
    const jwt = (calls[0].init.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    expect(JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).iss).toBe("5657291");
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer installation-token");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({ reviewers: ["dvcrn"] });
  });

  test("returns 502 when GitHub rejects the review request", async () => {
    globalThis.fetch = (async (url: string) =>
      url.endsWith("/access_tokens")
        ? Response.json({ token: "installation-token" }, { status: 201 })
        : Response.json({ message: "Validation Failed" }, { status: 422 })) as typeof fetch;

    const res = await worker.fetch(await delivery(opened("someone")), env);

    expect(res.status).toBe(502);
  });

  test("skips pull requests opened by the reviewer", async () => {
    const fetchMock = mock(realFetch);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await worker.fetch(await delivery(opened("DVCRN")), env);

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("skips pull requests opened by Dependabot", async () => {
    const fetchMock = mock(realFetch);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await worker.fetch(await delivery(opened("dependabot[bot]")), env);

    expect(res.status).toBe(202);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("allows configured repository prefixes case-insensitively and ignores other repos", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      requestedUrls.push(url);
      return url.endsWith("/access_tokens")
        ? Response.json({ token: "installation-token" }, { status: 201 })
        : Response.json({}, { status: 201 });
    }) as typeof fetch;

    for (const repo of ["DigitalVibesHQ/web", "microfnhq/api"]) {
      const res = await worker.fetch(await delivery(opened("someone", repo)), env);
      expect(res.status).toBe(201);
    }
    expect(requestedUrls).toContain("https://api.github.com/repos/DigitalVibesHQ/web/pulls/7/requested_reviewers");
    expect(requestedUrls).toContain("https://api.github.com/repos/microfnhq/api/pulls/7/requested_reviewers");

    requestedUrls.length = 0;
    for (const repo of ["other-org/repo", "dvcrn-fork/repo"]) {
      const res = await worker.fetch(await delivery(opened("someone", repo)), env);
      expect(res.status).toBe(202);
    }
    expect(requestedUrls).toEqual([]);
  });
});
