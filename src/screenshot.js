// Pictures of genjiball.us's pages, taken by Cloudflare's browser (Browser Run): the BROWSER binding
// in wrangler.toml, whose "screenshot" quick action opens the page, waits for it and answers a PNG.
// No API token: the binding is the Worker's own. Free plan: 10 browser minutes a day and one quick
// action every 10 seconds, plenty for a picture per finished tourney.

/** Wide enough for the desktop layout (the site's phone tab bar starts at 640px), doubled for sharp text. */
const VIEWPORT = { width: 760, height: 900, deviceScaleFactor: 2 };

const PICTURE_CSS = ".top { display: none } main { flex: none; padding: 1.5rem 1.25rem 1.25rem }";

/** The tourney page: its `main` (title, facts, every lobby's standings), once the lobbies have loaded. */
export async function tourneyScreenshot(env, url) {
  if (typeof env.BROWSER?.quickAction !== "function") return null;
  const res = await env.BROWSER.quickAction("screenshot", {
    url,
    viewport: VIEWPORT,
    gotoOptions: { waitUntil: "networkidle0", timeout: 30_000 },
    // site.js takes aria-busy off #lobbies once it has drawn them.
    waitForSelector: { selector: "#lobbies:not([aria-busy])", timeout: 15_000 },
    selector: "main",
    // Just the tourney: no header (its nav's underline would show at the top) and no space for the
    // footer under it.
    addStyleTag: [{ content: PICTURE_CSS }],
  });
  if (!res?.ok) throw new Error(`screenshot of ${url}: ${res?.status ?? "no answer"}`);
  return new Uint8Array(await res.arrayBuffer());
}
