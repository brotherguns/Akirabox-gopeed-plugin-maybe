gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj  = new URL(pageUrl);
  const baseUrl = urlObj.origin;

  // URL shape: https://akirabox.to/{fileId}/file
  const pathParts = urlObj.pathname.split("/").filter(Boolean);
  const fileId = pathParts[0];
  if (!fileId) throw new Error("Could not extract file ID from: " + pageUrl);

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ── 1. GET /file page — CAPTURE cookies from Set-Cookie headers ──────────
  const pageResp = await fetch(pageUrl, {
    headers: {
      "User-Agent":      UA,
      "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  let html = await pageResp.text();

  // Gopeed's XHR module exposes headers via .headers.get()
  // Collect all Set-Cookie values from the page load to replay them
  let sessionCookies = "";
  try {
    // Try to grab the raw Set-Cookie header (may be semicolon-joined in some runtimes)
    const raw = pageResp.headers.get("set-cookie") || "";
    // Parse each cookie's name=value portion (strip flags like Path, Expires, etc.)
    sessionCookies = raw
      .split(/,(?=[^;]+=[^;])/)   // split on commas that start a new cookie
      .map(c => c.trim().split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  } catch (_) {}

  // The site JS always sets this cookie right before calling /file/generate
  const rqfCookie = "rqf=" + fileId;
  const cookieHeader = [rqfCookie, sessionCookies].filter(Boolean).join("; ");

  // If server redirected away and we lost downloadConfig, try /downloads
  if (!html.includes("downloadConfig")) {
    const r2 = await fetch(baseUrl + "/downloads", {
      headers: {
        "User-Agent": UA,
        "Referer":    pageUrl,
        "Cookie":     cookieHeader,
      },
      redirect: "follow",
    });
    html = await r2.text();
  }

  // ── 2. Extract CSRF token ────────────────────────────────────────────────
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  if (!csrfMatch) throw new Error("AkiraBox: could not find CSRF token on page");
  const csrfToken = csrfMatch[1];

  // ── 3. Extract filename from HTML ────────────────────────────────────────
  let fileName = "";

  // Try the JS variable first: const fileName = "something.pkg"
  const fnJs = html.match(/const\s+fileName\s*=\s*"([^"]+)"/);
  if (fnJs) fileName = fnJs[1];

  // Try og:title: "SuperPSX.com - A.Way.Out - Akira Box"
  if (!fileName) {
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle) fileName = ogTitle[1].replace(/\s*[-|]\s*Akira\s*Box\s*$/i, "").trim();
  }

  // Try <title> tag
  if (!fileName) {
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleTag) fileName = titleTag[1].replace(/\s*[-|]\s*Akira\s*Box\s*$/i, "").trim();
  }

  // Fallback to fileId
  if (!fileName) fileName = fileId;

  // ── 4. POST to /{fileId}/file/generate ───────────────────────────────────
  // Discovered by deobfuscating app_v5a4.js:
  //   $.ajax({ url: config.url+'/'+downloadConfig.id+'/file/generate',
  //            type: 'POST',
  //            headers: { 'X-CSRF-TOKEN': token } })
  //   Response: { error: null, download_link: "https://cdn.../..." }
  const generateUrl = baseUrl + "/" + fileId + "/file/generate";

  const genResp = await fetch(generateUrl, {
    method: "POST",
    headers: {
      "User-Agent":       UA,
      "Accept":           "application/json, text/javascript, */*; q=0.01",
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
  let genJson;
  try {
    genJson = JSON.parse(genText);
  } catch (_) {
    throw new Error(
      "AkiraBox: /file/generate returned non-JSON (status " + genResp.status + "):\n" +
      genText.slice(0, 400)
    );
  }

  if (genJson.error && !isEmpty(genJson.error)) {
    throw new Error("AkiraBox server error: " + JSON.stringify(genJson.error));
  }

  const downloadUrl = genJson.download_link || genJson.url || genJson.link;
  if (!downloadUrl || !downloadUrl.startsWith("http")) {
    throw new Error(
      "AkiraBox: no download_link in response:\n" + JSON.stringify(genJson).slice(0, 400)
    );
  }

  // ── 5. Try to get real filename from Content-Disposition header ──────────
  // Do a HEAD request on the CDN URL to see if it provides a better filename
  try {
    const headResp = await fetch(downloadUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": UA,
        "Referer":    baseUrl + "/",
        "Cookie":     cookieHeader,
      },
      redirect: "follow",
    });
    const cd = headResp.headers.get("content-disposition") || "";
    // content-disposition: attachment; filename="SuperPSX.com - A.Way.Out-CUSA08004.pkg"
    const cdMatch = cd.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i);
    if (cdMatch) {
      const cdName = decodeURIComponent(cdMatch[1].replace(/"/g, "").trim());
      if (cdName && cdName !== "file") fileName = cdName;
    }
  } catch (_) {
    // HEAD failed — keep the filename we already have
  }

  // ── 6. Return result to Gopeed ───────────────────────────────────────────
  ctx.res = {
    name: fileName,
    files: [{
      name: fileName,
      req: {
        url: downloadUrl,
        headers: {
          "User-Agent": UA,
          "Referer":    baseUrl + "/",
          "Cookie":     cookieHeader,
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
