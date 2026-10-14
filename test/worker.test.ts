import { describe, expect, it } from "vitest";
import { createApp, INSTALLER_URL, UNAVAILABLE, type Deps, type Env } from "../src/app.ts";

const SCRIPT = "#!/usr/bin/env bash\necho hamsters\n";

/** A Cache that keeps responses in a map, ignoring expiry. */
function memoryCache(): Deps["cache"] & { keys(): string[] } {
  const store = new Map<string, Response>();
  return {
    async match(key) {
      return store.get(String(key))?.clone();
    },
    async put(key, res) {
      store.set(String(key), res.clone());
    },
    keys: () => [...store.keys()],
  };
}

function setup(github: () => Response | Promise<Response>) {
  const cache = memoryCache();
  const asked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    asked.push(String(input));
    return github();
  };
  const app = createApp(() => ({ fetch: fetcher, cache }));
  const env: Env = {
    ASSETS: {
      fetch: async (input: RequestInfo | URL) =>
        new Response(`asset ${new URL(input instanceof Request ? input.url : input).pathname}`),
      connect: () => {
        throw new Error("unused");
      },
    },
  };
  const get = (path: string) => app.request(`https://nibblets.dev${path}`, {}, env);
  return { app, env, cache, asked, get };
}

describe("the nibblets.dev worker", () => {
  it("serves the installer from the repository", async () => {
    const { get, asked } = setup(() => new Response(SCRIPT));
    const res = await get("/install.sh");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SCRIPT);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(asked).toEqual([INSTALLER_URL]);
  });

  it("keeps a fresh copy, so GitHub isn't asked every time", async () => {
    const { get, asked } = setup(() => new Response(SCRIPT));
    await get("/install.sh");
    const again = await get("/install.sh");
    expect(await again.text()).toBe(SCRIPT);
    expect(again.headers.get("x-nibblets-installer")).toBe("cached");
    expect(asked).toHaveLength(1);
  });

  it("falls back to the last good copy when GitHub fails", async () => {
    const lastGoodKey = "https://nibblets.dev/__cache/install.sh?last-good";
    // While GitHub was up, a copy was kept; now only that copy is left.
    const before = setup(() => new Response(SCRIPT));
    await before.get("/install.sh");
    const lastGood = await before.cache.match(lastGoodKey);
    if (!lastGood) throw new Error("no last good copy was kept");
    const down = setup(() => new Response("oops", { status: 502 }));
    await down.cache.put(lastGoodKey, lastGood);
    const res = await down.get("/install.sh");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SCRIPT);
    expect(res.headers.get("x-nibblets-installer")).toBe("stale");
  });

  it("gives a script that explains, rather than nothing, when there's no copy at all", async () => {
    const { get } = setup(() => new Response("Not Found", { status: 404 }));
    const res = await get("/install.sh");
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(UNAVAILABLE);
  });

  it("won't serve a page that isn't a script", async () => {
    const { get } = setup(() => new Response("<html>rate limited</html>"));
    expect((await get("/install.sh")).status).toBe(503);
  });

  it("sends www to the bare domain", async () => {
    const { app, env } = setup(() => new Response(SCRIPT));
    const res = await app.request("https://www.nibblets.dev/install.sh?x=1", {}, env);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://nibblets.dev/install.sh?x=1");
  });

  it("hands everything else to the static site", async () => {
    const { get } = setup(() => new Response(SCRIPT));
    expect(await (await get("/")).text()).toBe("asset /");
    expect(await (await get("/favicon.svg")).text()).toBe("asset /favicon.svg");
  });
});
