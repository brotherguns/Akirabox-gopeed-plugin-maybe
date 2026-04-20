gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj  = new URL(pageUrl);
  const baseUrl = urlObj.origin;

  // URL shape: https://akirabox.to/{fileId}/file
  const fileId = urlObj.pathname.split("/").filter(Boolean)[0];
  if (!fileId) throw new Error("Could not extract file ID from: " + pageUrl);

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ── 1. GET the /file page — establishes server session ──────────────────
  const pageResp = await fetch(pageUrl, {
    headers: {
      "User-Agent":      UA,
      "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  let html = await pageResp.text();

  // If the response doesn't have downloadConfig, try /downloads directly
  if (!html.includes("downloadConfig")) {
    const r2 = await fetch(baseUrl + "/downloads", {
      headers: { "User-Agent": UA, "Referer": pageUrl },
      redirect: "follow",
    });
    html = await r2.text();
  }

  // ── 2. Extract CSRF token ────────────────────────────────────────────────
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  if (!csrfMatch) throw new Error("AkiraBox: could not find CSRF token on page");
  const csrfToken = csrfMatch[1];

  // ── 3. Extract filename ──────────────────────────────────────────────────
  let fileName = fileId;
  const fnJs = html.match(/const\s+fileName\s*=\s*"([^"]+)"/);
  if (fnJs) {
    fileName = fnJs[1];
  } else {
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle) fileName = ogTitle[1].replace(/\s*-\s*Akira\s*Box\s*$/i, "").trim();
  }

  // ── 4. POST to /file/generate ────────────────────────────────────────────
  // The app JS (app_v5a4.js) does exactly this:
  //   $.ajax({ url: config.url+'/'+downloadConfig.id+'/file/generate',
  //            type: 'POST',
  //            headers: { 'X-CSRF-TOKEN': csrfToken } })
  //   Before the call it sets cookie: rqf={fileId}
  //   Response JSON: { error: null, download_link: "https://cdn.../..." }
  const generateUrl = baseUrl + "/" + fileId + "/file/generate";

  const genResp = await fetch(generateUrl, {
    method: "POST",
    headers: {
      "User-Agent":        UA,
      "Accept":            "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With":  "XMLHttpRequest",
      "X-CSRF-TOKEN":      csrfToken,
      "Content-Type":      "application/x-www-form-urlencoded; charset=UTF-8",
      "Referer":           pageUrl,
      "Origin":            baseUrl,
      // The page JS sets this cookie right before calling /file/generate
      "Cookie":            "rqf=" + fileId,
    },
    body: "_token=" + encodeURIComponent(csrfToken),
    redirect: "follow",
  });

  let genText = await genResp.text();
  let genJson;
  try {
    genJson = JSON.parse(genText);
  } catch (_) {
    throw new Error(
      "AkiraBox: /file/generate returned non-JSON (status " + genResp.status + "):\n" +
      genText.slice(0, 300)
    );
  }

  // Response shape: { error: null, download_link: "https://..." }
  // or on error:    { error: "some message" }
  if (genJson.error && !isEmpty(genJson.error)) {
    throw new Error("AkiraBox server error: " + JSON.stringify(genJson.error));
  }

  const downloadUrl = genJson.download_link || genJson.url || genJson.link;
  if (!downloadUrl || !downloadUrl.startsWith("http")) {
    throw new Error(
      "AkiraBox: no download_link in response:\n" + JSON.stringify(genJson).slice(0, 300)
    );
  }

  // ── 5. Return to Gopeed ──────────────────────────────────────────────────
  ctx.res = {
    name: fileName,
    files: [{
      name: fileName,
      req: {
        url: downloadUrl,
        headers: {
          "User-Agent": UA,
          "Referer":    baseUrl + "/",
        },
      },
    }],
  };
});

// Mirrors jQuery's $.isEmptyObject
function isEmpty(val) {
  if (!val) return true;
  if (typeof val === "object") return Object.keys(val).length === 0;
  return false;
}
