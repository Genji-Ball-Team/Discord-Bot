// Pictures of genjiball.us's pages, taken by Cloudflare's browser (Browser Run): the BROWSER binding
// in wrangler.toml, whose "screenshot" quick action opens the page, waits for it and answers a PNG.
// No API token: the binding is the Worker's own. Free plan: 10 browser minutes a day and one quick
// action every 10 seconds, plenty for a picture per finished tourney.

/**
 * 720 wide: a wide picture shows bigger in Discord, which fits it in a box, and the standings table
 * keeps its columns. Doubled for sharp text: about 1440 pixels wide.
 */
const VIEWPORT = { width: 720, height: 900, deviceScaleFactor: 2 };

/** Thin margins, so the tourney fills the picture. */
const PICTURE_CSS = ".top, .tabbar { display: none } main { flex: none; padding: 1rem }";

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
    // Just the tourney: no header (its nav's underline would show at the top), no tab bar over it and
    // no space for the footer under it.
    addStyleTag: [{ content: PICTURE_CSS }],
  });
  if (!res?.ok) throw new Error(`screenshot of ${url}: ${res?.status ?? "no answer"}`);
  return new Uint8Array(await res.arrayBuffer());
}
