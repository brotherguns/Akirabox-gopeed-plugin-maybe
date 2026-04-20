gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj = new URL(pageUrl);
  const baseUrl = urlObj.origin; // https://akirabox.to

  // ── 1. Extract file ID directly from the URL path ─────────────────────────
  // URL shape: https://akirabox.to/LK0G14ejz917/file
  const pathParts = urlObj.pathname.replace(/^\//, "").split("/");
  const fileId = pathParts[0]; // e.g. "LK0G14ejz917"
  
  if (!fileId) {
    throw new Error("Could not extract file ID from URL: " + pageUrl);
  }

  const commonHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  let html = "";

  // ── 2. Hit the /file URL so server sets session cookie ────────────────────
  // We use gopeed.http.get instead of fetch. Go handles the cookies automatically.
  try {
    const step1 = await gopeed.http.get(pageUrl, {
      headers: commonHeaders,
    });
    // Ensure we are working with a string
    html = typeof step1.data === "string" ? step1.data : String(step1.data);
  } catch (e) {
    throw new Error("Failed to load AkiraBox page: " + e.message);
  }

  // ── 3. If redirected without file data, re-fetch ──────────────────────────
  if (!html.includes("downloadConfig") && !html.includes(fileId)) {
    try {
      const step2 = await gopeed.http.get(baseUrl + "/downloads", {
        headers: {
          ...commonHeaders,
          "Referer": pageUrl,
        },
      });
      html = typeof step2.data === "string" ? step2.data : String(step2.data);
    } catch (e) {
      // non-fatal — we still have the fileId, continue
    }
  }

  // ── 4. Extract CSRF token ─────────────────────────────────────────────────
  let csrfToken = "";
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  if (csrfMatch) csrfToken = csrfMatch[1];
  
  if (!csrfToken) {
    const csrfJs = html.match(/"csrf[_-]token"\s*:\s*"([^"]+)"/i);
    if (csrfJs) csrfToken = csrfJs[1];
  }

  // ── 5. Extract file name ──────────────────────────────────────────────────
  let fileName = "";
  const fileNameJs = html.match(/const\s+fileName\s*=\s*"([^"]+)"/);
  if (fileNameJs) fileName = fileNameJs[1];
  
  if (!fileName) {
    const titleMatch = html.match(/<title>([^<]+?)\s*[-|]\s*Akira\s*Box\s*<\/title>/i);
    if (titleMatch) fileName = titleMatch[1].trim();
  }
  
  if (!fileName) {
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle) fileName = ogTitle[1].replace(/\s*-\s*Akira\s*Box\s*$/i, "").trim();
  }
  
  if (!fileName) fileName = fileId;

  // ── 6. POST to download API ───────────────────────────────────────────────
  const apiEndpoints = [
    baseUrl + "/api/download",
    baseUrl + "/download",
    baseUrl + "/" + fileId + "/download",
  ];

  const postBody = "_token=" + encodeURIComponent(csrfToken) + "&id=" + encodeURIComponent(fileId);

  const postHeaders = {
    ...commonHeaders,
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": pageUrl,
    "Origin": baseUrl,
  };
  
  if (csrfToken) postHeaders["X-CSRF-TOKEN"] = csrfToken;

  let downloadUrl = "";
  let lastError = "";

  for (const endpoint of apiEndpoints) {
    try {
      const apiResp = await gopeed.http.post(endpoint, postBody, {
        headers: postHeaders,
      });

      // If POST itself redirected to the actual file URL
      if (apiResp.url && apiResp.url !== endpoint && apiResp.url.includes("?")) {
        downloadUrl = apiResp.url;
        break;
      }

      const text = typeof apiResp.data === "string" ? apiResp.data : String(apiResp.data);
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}

      if (json) {
        const link = json.url || json.download_url || json.link || (json.data && (json.data.url || json.data));
        if (link && typeof link === "string" && link.startsWith("http")) {
          downloadUrl = link;
          break;
        }
        lastError = JSON.stringify(json).slice(0, 200);
      } else {
        const trimmed = text.trim();
        if (trimmed.startsWith("http")) { 
          downloadUrl = trimmed; 
          break; 
        }
        const inBody = trimmed.match(/https?:\/\/[^\s"'<>]+/);
        if (inBody) { 
          downloadUrl = inBody[0]; 
          break; 
        }
        lastError = trimmed.slice(0, 200);
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!downloadUrl) {
    throw new Error(
      "AkiraBox: could not get a download URL for [" + fileId + "].\n" +
      "Response: " + lastError
    );
  }

  // ── 7. Return resolved file to Gopeed ────────────────────────────────────
  ctx.res = {
    name: fileName,
    files: [
      {
        name: fileName,
        req: {
          url: downloadUrl,
          headers: {
            "Referer": baseUrl + "/",
            "User-Agent": commonHeaders["User-Agent"],
          },
        },
      },
    ],
  };
});
