gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;

  // ── 1. Build base URL (https://akirabox.to) ──────────────────────────────
  const urlObj = new URL(pageUrl);
  const baseUrl = urlObj.origin; // e.g. https://akirabox.to

  // ── 2. Fetch the file page to extract CSRF token, file ID, file name ─────
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    Referer: baseUrl + "/",
  };

  // Attach user-supplied cookie if configured
  const userCookie = gopeed.settings.cookie || "";
  if (userCookie) {
    headers["Cookie"] = userCookie;
  }

  const pageResp = await fetch(pageUrl, { headers });
  if (!pageResp.ok) {
    throw new Error("Failed to load AkiraBox page: HTTP " + pageResp.status);
  }
  const html = await pageResp.text();

  // ── 3. Extract CSRF token ─────────────────────────────────────────────────
  // <meta name="csrf-token" content="...">
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/);
  if (!csrfMatch) {
    throw new Error("Could not find CSRF token on AkiraBox page.");
  }
  const csrfToken = csrfMatch[1];

  // ── 4. Extract downloadConfig to get the file ID ──────────────────────────
  // const downloadConfig = {"id":"LK0G14ejz917", ...}
  const configMatch = html.match(/const\s+downloadConfig\s*=\s*(\{[^}]+\})/);
  if (!configMatch) {
    throw new Error("Could not find downloadConfig on AkiraBox page.");
  }
  let downloadConfig;
  try {
    downloadConfig = JSON.parse(configMatch[1]);
  } catch (e) {
    throw new Error("Failed to parse downloadConfig: " + e.message);
  }
  const fileId = downloadConfig.id;
  if (!fileId) {
    throw new Error("No file ID found in downloadConfig.");
  }

  // ── 5. Extract file name from the page ────────────────────────────────────
  // const fileName = "...";
  let fileName = "";
  const fileNameMatch = html.match(/const\s+fileName\s*=\s*"([^"]+)"/);
  if (fileNameMatch) {
    fileName = fileNameMatch[1];
  }
  // Fallback: grab from <title>
  if (!fileName) {
    const titleMatch = html.match(/<title>([^<]+)\s*-\s*Akira Box<\/title>/i);
    if (titleMatch) {
      fileName = titleMatch[1].trim();
    }
  }
  if (!fileName) {
    fileName = fileId; // last resort
  }

  // ── 6. Grab cookies set by the page (session cookie) ─────────────────────
  // Gopeed's fetch exposes Set-Cookie via headers
  const setCookieHeader = pageResp.headers.get("set-cookie") || "";
  // Build a simple cookie string from Set-Cookie headers
  const sessionCookies = setCookieHeader
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  const cookieHeader = userCookie
    ? userCookie
    : sessionCookies;

  // ── 7. Request the actual download link from the API ──────────────────────
  //
  // AkiraBox (Vironeer FileX) exposes a download endpoint at:
  //   POST {baseUrl}/api/download
  // Body (form-encoded): _token=<csrf>&id=<fileId>
  //
  // The response is JSON: { "url": "https://..." }  on success
  // or { "error": "..." } on failure.
  //
  // We also try the alternate endpoint just in case.
  const endpoints = [
    baseUrl + "/api/download",
    baseUrl + "/download",
    baseUrl + "/" + fileId + "/download",
  ];

  let downloadUrl = null;
  let lastError = "";

  const postHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRF-TOKEN": csrfToken,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/plain, */*",
    Referer: pageUrl,
    Origin: baseUrl,
  };
  if (cookieHeader) {
    postHeaders["Cookie"] = cookieHeader;
  }

  const body = "_token=" + encodeURIComponent(csrfToken) + "&id=" + encodeURIComponent(fileId);

  for (const endpoint of endpoints) {
    try {
      const apiResp = await fetch(endpoint, {
        method: "POST",
        headers: postHeaders,
        body: body,
      });

      const text = await apiResp.text();

      // Try JSON parse first
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {}

      if (json) {
        // Common response shapes:
        // { url: "..." }  /  { download_url: "..." }  /  { link: "..." }
        const link = json.url || json.download_url || json.link || json.data;
        if (link && typeof link === "string" && link.startsWith("http")) {
          downloadUrl = link;
          break;
        }
        if (json.error || json.message) {
          lastError = json.error || json.message;
        }
      } else {
        // Maybe the response body IS the URL directly
        const trimmed = text.trim();
        if (trimmed.startsWith("http")) {
          downloadUrl = trimmed;
          break;
        }
        // Or look for a URL inside the response HTML/text
        const urlInText = trimmed.match(/https?:\/\/[^\s"'<>]+/);
        if (urlInText) {
          downloadUrl = urlInText[0];
          break;
        }
        lastError = "Unexpected response from " + endpoint + ": " + trimmed.slice(0, 120);
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  if (!downloadUrl) {
    throw new Error(
      "AkiraBox extension could not resolve a download URL.\n" +
        "Last error: " + lastError + "\n\n" +
        "Tips:\n" +
        "• Make sure you are pasting the /file page URL (e.g. https://akirabox.to/ABC123/file)\n" +
        "• Try adding your session cookie in the extension settings for premium speed."
    );
  }

  // ── 8. Return the resolved file to Gopeed ────────────────────────────────
  ctx.res = {
    name: fileName,
    files: [
      {
        name: fileName,
        req: {
          url: downloadUrl,
          headers: {
            Referer: pageUrl,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          },
        },
      },
    ],
  };
});
