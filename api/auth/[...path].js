const NEON_AUTH_URL = process.env.NEON_AUTH_BASE_URL || process.env.NEON_AUTH_URL || "https://ep-weathered-smoke-b4g1qnj9.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth";

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
  return value.replace(/;\s*Domain=[^;]+/ig, "");
}

function cookiePairs(setCookies) {
  return setCookies.map(v => String(v).split(';')[0]).filter(Boolean);
}

function encodeCookieBundle(pairs) {
  return Buffer.from(JSON.stringify(pairs), 'utf8').toString('base64url');
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

    const rawSetCookies = getSetCookies(upstream.headers);
    const setCookies = rawSetCookies.map(rewriteSetCookie);
    if (setCookies.length) res.setHeader("Set-Cookie", setCookies);

    const pathName = String(path || "");
    if (setCookies.length && pathName !== "sign-out") {
      const bundle = encodeCookieBundle(cookiePairs(setCookies));
      res.appendHeader
        ? res.appendHeader("Set-Cookie", "airbnb_neon_auth_bundle="+bundle+"; Path=/; HttpOnly; Secure; SameSite=Lax")
        : res.setHeader("Set-Cookie", [...setCookies, "airbnb_neon_auth_bundle="+bundle+"; Path=/; HttpOnly; Secure; SameSite=Lax"]);
    }
    if (pathName === "sign-out") {
      const clearBundle = "airbnb_neon_auth_bundle=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
      if (setCookies.length) {
        res.appendHeader
          ? res.appendHeader("Set-Cookie", clearBundle)
          : res.setHeader("Set-Cookie", [...setCookies, clearBundle]);
      } else {
        res.setHeader("Set-Cookie", clearBundle);
      }
    }

    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    const text = await upstream.text();
    return res.status(upstream.status).send(text);
  } catch (error) {
    console.error("Neon Auth proxy error:", error);
    return res.status(502).json({ error: "Auth service unavailable" });
  }
};
