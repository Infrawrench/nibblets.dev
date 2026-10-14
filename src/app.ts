import { Hono } from "hono";
import { describe, download, latestRelease } from "./releases.ts";

export interface Env {
  ASSETS: Fetcher;
  /** Optional: a GitHub token, for while the repository is private. */
  GITHUB_TOKEN?: string;
}

/** Where the installer lives. It picks the release to install by itself. */
export const INSTALLER_URL =
  "https://raw.githubusercontent.com/Infrawrench/nibblets/main/install.sh";

/** How long a copy is served before asking GitHub again. */
const FRESH_SECONDS = 300;
/** How long the last good copy is kept, for when GitHub can't be reached. */
const LAST_GOOD_SECONDS = 7 * 24 * 60 * 60;

const FRESH_KEY = "https://nibblets.dev/__cache/install.sh";
const LAST_GOOD_KEY = "https://nibblets.dev/__cache/install.sh?last-good";

/** What `curl … | bash` runs when there's no installer to give. */
export const UNAVAILABLE = `#!/bin/sh
echo "Couldn't fetch the Nibblets installer just now. Please try again in a minute," >&2
echo "or get it from https://github.com/Infrawrench/nibblets" >&2
exit 1
`;

export interface Deps {
  fetch: typeof fetch;
  cache: Pick<Cache, "match" | "put">;
}

function script(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": `public, max-age=${status === 200 ? FRESH_SECONDS : 0}`,
      ...extra,
    },
  });
}

/**
 * The installer, from the repository's main branch: a fresh copy for five
 * minutes, then GitHub again. If GitHub fails, the last good copy (kept a
 * week); if there's none, a script that says so rather than doing nothing.
 */
export async function installer(env: Env, deps: Deps): Promise<Response> {
  const fresh = await deps.cache.match(FRESH_KEY);
  if (fresh) return script(await fresh.text(), 200, { "x-nibblets-installer": "cached" });

  try {
    const res = await deps.fetch(INSTALLER_URL, {
      headers: {
        "user-agent": "nibblets.dev",
        ...(env.GITHUB_TOKEN ? { authorization: `token ${env.GITHUB_TOKEN}` } : {}),
      },
    });
    const body = res.ok ? await res.text() : "";
    if (!res.ok || !body.startsWith("#!")) throw new Error(`GitHub said ${res.status}`);
    await Promise.all([
      deps.cache.put(FRESH_KEY, script(body, 200, { "cache-control": `max-age=${FRESH_SECONDS}` })),
      deps.cache.put(
        LAST_GOOD_KEY,
        script(body, 200, { "cache-control": `max-age=${LAST_GOOD_SECONDS}` }),
      ),
    ]);
    return script(body, 200, { "x-nibblets-installer": "fresh" });
  } catch {
    const lastGood = await deps.cache.match(LAST_GOOD_KEY);
    if (lastGood) return script(await lastGood.text(), 200, { "x-nibblets-installer": "stale" });
    return script(UNAVAILABLE, 503);
  }
}

export function createApp(deps: () => Deps | Promise<Deps>) {
  const app = new Hono<{ Bindings: Env }>();

  // One address: www goes to the bare domain.
  app.use(async (c, next) => {
    const url = new URL(c.req.url);
    if (url.hostname === "www.nibblets.dev") {
      url.hostname = "nibblets.dev";
      return c.redirect(url.toString(), 301);
    }
    await next();
  });

  app.get("/install.sh", async (c) => installer(c.env, await deps()));

  // Releases, laid out like infrawrench.com's: the latest as JSON, and files by tag.
  app.get("/api/latest", async (c) => {
    const release = await latestRelease(await deps()).catch(() => null);
    if (!release) return c.json({ error: "There's no release yet" }, 404);
    return c.json(describe(release), 200, { "cache-control": "public, max-age=300" });
  });
  app.get("/api/download/:tag/:file", async (c) =>
    download(c.req.param("tag"), c.req.param("file"), await deps()),
  );

  // Everything else is the static site.
  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}
