// The Worker's entry. Workers treat every named export here as an entry
// point, so the app and its helpers live in app.ts.
import { createApp } from "./app.ts";

export default createApp(async () => ({ fetch, cache: await caches.open("installer") }));
