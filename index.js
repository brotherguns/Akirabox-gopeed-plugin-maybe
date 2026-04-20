gopeed.events.onResolve(async (ctx) => {
  const pageUrl = ctx.req.url;
  const urlObj = new URL(pageUrl);
  const baseUrl = urlObj.origin;

  // Extract file ID from URL: https://akirabox.to/LK0G14ejz917/file
  const fileId = urlObj.pathname.split("/").filter(Boolean)[0];
  if (!fileId) throw new Error("Could not extract file ID from: " + pageUrl);

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Step 1: Load /file page — this sets the server-side session
  const step1 = await fetch(pageUrl, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    redirect: "follow",
  });
  let html = await step1.text();

  // Step 2: If redirected to /downloads without our data, fetch it explicitly
  if (!html.includes("downloadConfig")) {
    const step2 = await fetch(baseUrl + "/downloads", {
      headers: { "User-Agent": UA, "Referer": pageUrl },
      redirect: "follow",
    });
    html = await step2.text();
  }

  // Step 3: Extract CSRF token
  const csrfMatch = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i);
  const csrfToken = csrfMatch ? csrfMatch[1] : "";

  // Step 4: Extract filename
  let fileName = fileId;
  const fnMatch = html.match(/const\s+fileName\s*=\s*"([^"]+)"/);
  if (fnMatch) fileName = fnMatch[1];

  // Step 5: POST to the download endpoint
  // The URL pattern /{id}/file/report tells us the base path — download is /{id}/download
  const endpoints = [
    baseUrl + "/" + fileId + "/download",
    baseUrl + "/api/download",
    baseUrl + "/download",
  ];

  const postHeaders = {
    "User-Agent": UA,
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept": "application/json, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-CSRF-TOKEN": csrfToken,
    "Referer": baseUrl + "/downloads",
    "Origin": baseUrl,
  };

  const body = "_token=" + encodeURIComponent(csrfToken) + "&id=" + encodeURIComponent(fileId);

  let downloadUrl = "";
  let lastErr = "";

  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: postHeaders,
        body,
        redirect: "manual", // catch 302 → that IS the CDN URL
      });

      // A redirect response means the Location header IS the direct file URL
      if (resp.status >= 300 && resp.status < 400) {
        downloadUrl = resp.headers.get("location") || "";
        if (downloadUrl) break;
      }

      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}

      if (json) {
        const link = json.url || json.download_url || json.link
          || (json.data && (json.data.url || json.data));
        if (typeof link === "string" && link.startsWith("http")) {
          downloadUrl = link;
          break;
        }
        lastErr = JSON.stringify(json).slice(0, 300);
      } else if (text.trim().startsWith("http")) {
        downloadUrl = text.trim();
        break;
      } else {
        lastErr = text.slice(0, 300);
      }
    } catch (e) {
      lastErr = e.message;
    }
  }

  if (!downloadUrl) {
    throw new Error("AkiraBox: no download URL for [" + fileId + "]. Last response: " + lastErr);
  }

  ctx.res = {
    name: fileName,
    files: [{
      name: fileName,
      req: {
        url: downloadUrl,
        headers: {
          "Referer": baseUrl + "/",
          "User-Agent": UA,
        },
      },
    }],
  };
});
