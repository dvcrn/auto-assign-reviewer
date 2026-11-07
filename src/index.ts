// Requests a review from REVIEWER on newly opened pull requests, acting as a GitHub App installation.

// Only the payload fields this worker reads; GitHub sends many more.
interface PullRequestEvent {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  pull_request?: {
    number?: number;
    user?: { login?: string } | null;
    requested_reviewers?: { login?: string }[];
  };
}

const GITHUB_API = "https://api.github.com";
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
  "User-Agent": "auto-assign-reviewer",
  "X-GitHub-Api-Version": "2022-11-28",
};

const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    const body = await request.text();
    const signature = request.headers.get("X-Hub-Signature-256");
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      return new Response("Invalid signature", { status: 401 });
    }

    const eventName = request.headers.get("X-GitHub-Event");
    if (eventName === "ping") return new Response("pong");
    if (eventName !== "pull_request") return new Response(`Ignored event ${eventName}`, { status: 202 });

    let event: PullRequestEvent;
    try {
      event = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (event.action !== "opened") return new Response(`Ignored action ${event.action}`, { status: 202 });

    const installationId = event.installation?.id;
    const repo = event.repository?.full_name;
    const pr = event.pull_request;
    if (!installationId || !repo || !pr?.number) {
      return new Response("Missing installation, repository or pull request", { status: 400 });
    }

    const reviewer = env.REVIEWER.toLowerCase();
    // GitHub rejects a review request for the pull request's own author with 422.
    if (pr.user?.login?.toLowerCase() === reviewer) {
      return new Response("Author is the reviewer", { status: 202 });
    }
    if (pr.requested_reviewers?.some((r) => r.login?.toLowerCase() === reviewer)) {
      return new Response("Review already requested", { status: 202 });
    }

    try {
      const token = await installationToken(env, installationId);
      const res = await fetch(`${GITHUB_API}/repos/${repo}/pulls/${pr.number}/requested_reviewers`, {
        method: "POST",
        headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ reviewers: [env.REVIEWER] }),
      });
      if (!res.ok) throw new Error(`Review request failed: ${res.status} ${await res.text()}`);
    } catch (err) {
      console.error(`${repo}#${pr.number}: ${err instanceof Error ? err.message : err}`);
      return new Response("GitHub request failed", { status: 502 });
    }

    console.log(`Requested review from ${env.REVIEWER} on ${repo}#${pr.number}`);
    return new Response(`Requested review from ${env.REVIEWER}`, { status: 201 });
  },
} satisfies ExportedHandler<Env>;

export async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!hex) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify("HMAC", key, hexToBytes(hex), encoder.encode(body));
}

async function installationToken(env: Env, installationId: number): Promise<string> {
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${await appJwt(env)}` },
    body: JSON.stringify({ permissions: { pull_requests: "write" } }),
  });
  if (!res.ok) throw new Error(`Installation token request failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

async function appJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // Backdated a minute for clock drift; GitHub caps the lifetime at 10 minutes.
  const claims = { iat: now - 60, exp: now + 540, iss: env.APP_ID };
  const unsigned = `${base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(env.GITHUB_APP_PRIVATE_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

// Expects PKCS#8 ("BEGIN PRIVATE KEY"); convert GitHub's PKCS#1 download with `openssl pkcs8 -topk8 -nocrypt`.
function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const base64 = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----|\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
