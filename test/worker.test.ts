import { describe, expect, it } from "vitest";
import { createApp, INSTALLER_URL, ranged, UNAVAILABLE, type Deps, type Env } from "../src/app.ts";

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

  describe("range requests, so the song can be seeked", () => {
    const song = () =>
      new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), {
        headers: { "content-type": "audio/mpeg" },
      });
    const ask = (range?: string) =>
      new Request("https://nibblets.dev/nibblets-of-kernow.mp3", {
        headers: range ? { range } : {},
      });

    it("sends the bytes asked for", async () => {
      const res = await ranged(ask("bytes=2-5"), song());
      expect(res.status).toBe(206);
      expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
      expect(res.headers.get("content-length")).toBe("4");
      expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4, 5]);
    });

    it("sends the rest, or the last few, when that's what's asked", async () => {
      const rest = await ranged(ask("bytes=7-"), song());
      expect([...new Uint8Array(await rest.arrayBuffer())]).toEqual([7, 8, 9]);
      const last = await ranged(ask("bytes=-2"), song());
      expect(last.headers.get("content-range")).toBe("bytes 8-9/10");
      expect([...new Uint8Array(await last.arrayBuffer())]).toEqual([8, 9]);
    });

    it("says what it can't send", async () => {
      const res = await ranged(ask("bytes=20-"), song());
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe("bytes */10");
    });

    it("sends the whole song, saying it takes ranges, when none is asked", async () => {
      const res = await ranged(ask(), song());
      expect(res.status).toBe(200);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect((await res.arrayBuffer()).byteLength).toBe(10);
    });

    it("leaves pages alone", async () => {
      const page = new Response("<h1>hi</h1>", { headers: { "content-type": "text/html" } });
      const res = await ranged(ask("bytes=0-1"), page);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<h1>hi</h1>");
    });
  });
});
