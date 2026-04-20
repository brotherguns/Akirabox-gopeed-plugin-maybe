gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj  = new URL(pageUrl);
  const baseUrl = urlObj.origin;
  const fileId  = urlObj.pathname.split("/").filter(Boolean)[0];

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ── Step 1: Load the /file page ──────────────────────────────────────────
  const pageResp = await fetch(pageUrl, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    redirect: "follow",
  });
  let html = await pageResp.text();

  // Try to grab Set-Cookie from the response
  let capturedCookies = "";
  try {
    const raw = pageResp.headers.get("set-cookie") || "";
    capturedCookies = raw
      .split(/,(?=[^;]+=[^;])/)
      .map(c => c.trim().split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  } catch (_) {}

  if (!html.includes("downloadConfig")) {
    const r2 = await fetch(baseUrl + "/downloads", {
      headers: { "User-Agent": UA, "Referer": pageUrl },
      redirect: "follow",
    });
    html = await r2.text();
  }

  // ── Step 2: Get CSRF token ────────────────────────────────────────────────
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  const csrfToken = csrfMatch ? csrfMatch[1] : "NOT_FOUND";

  // ── Step 3: POST to /file/generate ───────────────────────────────────────
  const generateUrl = baseUrl + "/" + fileId + "/file/generate";
  const cookieHeader = "rqf=" + fileId + (capturedCookies ? "; " + capturedCookies : "");

  const genResp = await fetch(generateUrl, {
    method: "POST",
    headers: {
      "User-Agent":       UA,
      "Accept":           "application/json, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-CSRF-TOKEN":     csrfToken,
      "Content-Type":     "application/x-www-form-urlencoded; charset=UTF-8",
      "Referer":          pageUrl,
      "Origin":           baseUrl,
      "Cookie":           cookieHeader,
    },
    body: "_token=" + encodeURIComponent(csrfToken),
    redirect: "follow",
  });

  const genText = await genResp.text();

  // ── DEBUG: Throw everything as an error so you can see it ─────────────────
  // Read this error in Gopeed's task list.
  // Copy the "download_link" URL shown and paste it here:
  throw new Error(
    "=== DEBUG (remove this throw when done) ===\n" +
    "fileId: " + fileId + "\n" +
    "csrfToken: " + csrfToken.slice(0, 20) + "...\n" +
    "capturedCookies: " + (capturedCookies || "(none — Set-Cookie not accessible)") + "\n" +
    "POST status: " + genResp.status + "\n" +
    "Raw response (first 500 chars):\n" +
    genText.slice(0, 500)
  );
});
