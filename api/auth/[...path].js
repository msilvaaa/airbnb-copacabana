const NEON_AUTH_URL = process.env.NEON_AUTH_URL || "https://ep-holy-frost-b4fodald.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth";

function normalizePath(value) {
  const parts = Array.isArray(value) ? value : (value ? [value] : []);
  return parts.filter(Boolean).map(String).join("/");
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  return raw ? [raw] : [];
}

function rewriteSetCookie(value) {
  return value
    .replace(/;\s*Domain=[^;]+/ig, "")
    .replace(/;\s*SameSite=None/ig, "; SameSite=Lax");
}

module.exports = async function handler(req, res) {
  const path = normalizePath(req.query?.path);
  if (!path) return res.status(400).json({ error: "Missing auth path" });

  const target = NEON_AUTH_URL.replace(/\/$/, "") + "/" + path;
  const headers = {};
  if (req.headers.cookie) headers.cookie = req.headers.cookie;
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
  if (req.headers.origin) headers.origin = req.headers.origin;
  headers.accept = req.headers.accept || "application/json";

  let body;
  if (!["GET","HEAD"].includes(req.method)) {
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
  }

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body
    });

    const setCookies = getSetCookies(upstream.headers).map(rewriteSetCookie);
    if (setCookies.length) res.setHeader("Set-Cookie", setCookies);

    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    const text = await upstream.text();
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error("Neon Auth proxy error:", error);
    return res.status(502).json({ error: "Auth service unavailable" });
  }
};
