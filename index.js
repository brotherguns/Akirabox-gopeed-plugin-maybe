gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj  = new URL(pageUrl);
  const baseUrl = urlObj.origin;
  const fileId  = urlObj.pathname.split("/").filter(Boolean)[0];

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const pageResp = await fetch(pageUrl, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    redirect: "follow",
  });
  let html = await pageResp.text();

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

  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  const csrfToken = csrfMatch ? csrfMatch[1] : "NOT_FOUND";

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

  const status = genResp.status;
  const genText = await genResp.text();

  let downloadLink = "NOT_FOUND";
  try {
    const j = JSON.parse(genText);
    downloadLink = j.download_link || j.url || j.link || "KEY_MISSING";
  } catch (_) {
    downloadLink = "NOT_JSON:" + genText.slice(0, 80).replace(/\s+/g, " ");
  }

  const cookieStatus = capturedCookies ? "YES" : "NONE";
  const csrfStatus   = csrfToken !== "NOT_FOUND" ? "OK" : "MISSING";

  // Pack everything into the task name so it shows in Gopeed's task list
  const debugName =
    "[S=" + status + "]" +
    "[CSRF=" + csrfStatus + "]" +
    "[CK=" + cookieStatus + "]" +
    "[LINK=" + downloadLink + "]";

  const resolvedUrl = downloadLink.startsWith("http")
    ? downloadLink
    : "https://akirabox.to/debug-failed-no-url";

  ctx.res = {
    name: debugName,
    files: [{
      name: debugName,
      req: {
        url: resolvedUrl,
        headers: {
          "User-Agent": UA,
          "Referer":    baseUrl + "/",
          "Cookie":     cookieHeader,
        },
      },
    }],
  };
});
