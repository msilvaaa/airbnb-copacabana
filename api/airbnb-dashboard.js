const { neon } = require("@neondatabase/serverless");

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const NEON_AUTH_URL = process.env.NEON_AUTH_BASE_URL || process.env.NEON_AUTH_URL || "https://ep-weathered-smoke-b4g1qnj9.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth";
const NEON_AUTH_JWKS_URL = NEON_AUTH_URL.replace(/\/$/, "") + "/.well-known/jwks";

let jwksPromise;
async function getJwks() {
  if (!jwksPromise) {
    jwksPromise = import("jose").then(({ createRemoteJWKSet }) => createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL)));
  }
  return jwksPromise;
}


async function authenticateRequest(req) {
  // Prioriza a sessão via cookie do Neon Auth. O JWT enviado pelo navegador
  // pode ter um subject com formato diferente do ID UUID usado na tabela.
  const cookie = req.headers.cookie;
  if (cookie) {
    try {
      const response = await fetch(NEON_AUTH_URL.replace(/\/$/, "") + "/get-session", {
        method: "GET",
        headers: { cookie, accept: "application/json" }
      });
      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        const user = data?.user || data?.session?.user;
        if (user?.id) return { id: String(user.id), email: user.email || null };
      }
    } catch (error) {
      console.error("Neon Auth session verification error:", error);
    }
  }

  const bearer = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    try {
      const { jwtVerify } = await import("jose");
      const jwks = await getJwks();
      const { payload } = await jwtVerify(bearer[1], jwks);
      if (payload?.sub) return { id: String(payload.sub), email: payload.email || null };
    } catch (error) {
      console.error("Neon Auth JWT verification error:", error);
    }
  }

  return null;
}

function setJson(res, status, payload) {
  return res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!sql) return setJson(res, 503, { error: "Neon is not configured" });

  const isPublicRead = req.method === "GET" && (req.query?.public === "1" || req.query?.public === "true");

  if (isPublicRead) {
    try {
      const rows = await sql`
        SELECT id, ano, mes, valor, tipo, categoria
        FROM public.airbnb_dashboard
        WHERE user_id = (
          SELECT user_id
          FROM public.airbnb_dashboard
          ORDER BY id DESC
          LIMIT 1
        )
        ORDER BY id ASC
      `;
      return setJson(res, 200, { rows, public: true });
    } catch (error) {
      console.error("Neon public read error:", error);
      return setJson(res, 500, { error: error?.message || "Internal server error" });
    }
  }

  const user = await authenticate(req);
  if (!user?.id) return setJson(res, 401, { error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, ano, mes, valor, tipo, categoria
        FROM public.airbnb_dashboard
        WHERE user_id = ${user.id}::uuid
        ORDER BY id ASC
      `;
      return setJson(res, 200, { rows });
    }

    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    body = body || {};

    if (req.method === "POST") {
      if (body.ratingCounts && typeof body.ratingCounts === "object") {
        const counts = [5, 4, 3, 2, 1].map(s => ({ star: String(s), value: Number(body.ratingCounts[s]) }));
        if (counts.some(r => !Number.isInteger(r.value) || r.value < 0) || counts.reduce((n, r) => n + r.value, 0) <= 0) {
          return setJson(res, 400, { error: "Invalid rating counts" });
        }
        // Substitui a distribuição inteira com INSERTs simples e explícitos.
        // Evita depender de jsonb_to_recordset, que pode gerar 500 em algumas
        // configurações do Postgres/Neon.
        // Não usa um novo valor para a coluna "tipo" que possa estar sujeito
        // a CHECK/ENUM legado. Reaproveita "fixedCategory", já existente no
        // schema, usando uma categoria interna exclusiva para as avaliações.
        await sql`DELETE FROM public.airbnb_dashboard
          WHERE user_id = ${user.id}::uuid
            AND (tipo = 'rating' OR (tipo = 'fixedCategory' AND categoria LIKE '__airbnb_rating_%'))`;
        const rows = [];
        for (const r of counts) {
          const inserted = await sql`INSERT INTO public.airbnb_dashboard (user_id, ano, mes, valor, tipo, categoria)
            VALUES (${user.id}::uuid, 2021, 0, ${r.value}, 'fixedCategory', ${'__airbnb_rating_'+r.star})
            RETURNING id, ano, mes, valor, tipo, categoria`;
          if (inserted[0]) rows.push(inserted[0]);
        }
        if (rows.length !== 5) {
          throw new Error('Neon inseriu apenas '+rows.length+' de 5 notas.');
        }
        return setJson(res, 200, { ok: true, rows });
      }
      const ano = Number(body.ano);
      const mes = Number(body.mes);
      const valor = Number(body.valor);
      const tipo = String(body.tipo || "");
      const categoria = String(body.categoria || "");
      if (!Number.isInteger(ano) || ano < 2021 || !Number.isInteger(mes) || mes < 0 || mes > 11 || !Number.isFinite(valor) || !tipo) {
        return setJson(res, 400, { error: "Invalid row" });
      }
      const rows = await sql`
        WITH deleted AS (
          DELETE FROM public.airbnb_dashboard
          WHERE user_id = ${user.id}::uuid
            AND ano = ${ano}
            AND mes = ${mes}
            AND tipo = ${tipo}
            AND COALESCE(categoria, '') = ${categoria}
        )
        INSERT INTO public.airbnb_dashboard (user_id, ano, mes, valor, tipo, categoria)
        VALUES (${user.id}::uuid, ${ano}, ${mes}, ${valor}, ${tipo}, ${categoria})
        RETURNING id, ano, mes, valor, tipo, categoria
      `;
      return setJson(res, 200, { row: rows[0] || null });
    }

    if (req.method === "PUT") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const normalized = rows
        .map(r => ({
          ano: Number(r.ano),
          mes: Number(r.mes),
          valor: Number(r.valor),
          tipo: String(r.tipo || ""),
          categoria: String(r.categoria || "")
        }))
        .filter(r => Number.isInteger(r.ano) && r.ano >= 2021 && Number.isInteger(r.mes) && r.mes >= 0 && r.mes <= 11 && Number.isFinite(r.valor) && r.tipo);

      await sql`DELETE FROM public.airbnb_dashboard WHERE user_id = ${user.id}::uuid`;

      if (normalized.length) {
        await sql`
          INSERT INTO public.airbnb_dashboard (user_id, ano, mes, valor, tipo, categoria)
          SELECT
            ${user.id}::uuid,
            r.ano,
            r.mes,
            r.valor,
            r.tipo,
            r.categoria
          FROM jsonb_to_recordset(${JSON.stringify(normalized)}::jsonb)
            AS r(ano smallint, mes smallint, valor numeric, tipo text, categoria text)
        `;
      }
      return setJson(res, 200, { ok: true, count: normalized.length });
    }

    if (req.method === "DELETE") {
      if (body.all === true) {
        await sql`DELETE FROM public.airbnb_dashboard WHERE user_id = ${user.id}::uuid`;
        return setJson(res, 200, { ok: true });
      }

      const ano = Number(body.ano);
      const mes = Number(body.mes);
      const tipo = String(body.tipo || "");
      const categoria = String(body.categoria || "");
      if (!Number.isInteger(ano) || !Number.isInteger(mes) || mes < 0 || mes > 11 || !tipo) {
        return setJson(res, 400, { error: "Invalid delete request" });
      }

      await sql`
        DELETE FROM public.airbnb_dashboard
        WHERE user_id = ${user.id}::uuid
          AND ano = ${ano}
          AND mes = ${mes}
          AND tipo = ${tipo}
          AND COALESCE(categoria, '') = ${categoria}
      `;
      return setJson(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");
    return setJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    console.error("Neon Airbnb API error:", error);
    return setJson(res, 500, { error: error?.message || "Internal server error" });
  }
};
