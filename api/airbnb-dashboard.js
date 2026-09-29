const { neon } = require("@neondatabase/serverless");

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const NEON_AUTH_URL = process.env.NEON_AUTH_BASE_URL || process.env.NEON_AUTH_URL || "https://ep-weathered-smoke-b4g1qnj9.neonauth.c-6.us-east-2.aws.neon.tech/neondb/auth";
const NEON_AUTH_JWKS_URL = NEON_AUTH_URL.replace(/\/$/, "") + "/.well-known/jwks.json";

let jwksPromise;
async function getJwks() {
  if (!jwksPromise) {
    jwksPromise = import("jose").then(({ createRemoteJWKSet }) => createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL)));
  }
  return jwksPromise;
}


function decodeCookieBundle(value) {
  try {
    const json = Buffer.from(String(value), 'base64url').toString('utf8');
    const cookies = JSON.parse(json);
    return Array.isArray(cookies) ? cookies.join('; ') : '';
  } catch { return ''; }
}

async function authenticateRequest(req) {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) {
    try {
      const { jwtVerify } = await import('jose');
      const jwks = await getJwks();
      const { payload } = await jwtVerify(bearer[1], jwks);
      if (payload?.sub) return { id: String(payload.sub), email: payload.email || null };
    } catch (error) {
      console.error('Neon Auth JWT verification error:', error?.message || error);
    }
  }
  return null;
}

function setJson(res, status, payload) {
  return res.status(status).json(payload);
}

async function ensureRatingTable() {
  // A tabela já existe no Neon; não cria objetos durante cada requisição.
  const rows = await sql`SELECT to_regclass('public.airbnb_rating_config') AS table_name`;
  if (!rows[0]?.table_name) throw new Error('Tabela public.airbnb_rating_config não encontrada no banco da Vercel.');
}
function ratingRows(r) {
  if (!r) return [];
  return [5,4,3,2,1].map(s => ({ id: 0, ano: 2021, mes: 0, valor: Number(r['nota_'+s] || 0), tipo: 'rating', categoria: String(s) }));
}
async function readRatingRows() {
  await ensureRatingTable();
  const rows = await sql`SELECT nota_5, nota_4, nota_3, nota_2, nota_1 FROM public.airbnb_rating_config WHERE id = 1`;
  return ratingRows(rows[0]);
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!sql) return setJson(res, 503, { error: "Neon is not configured" });

  const isPublicRead = req.method === "GET" && (req.query?.public === "1" || req.query?.public === "true");

  if (isPublicRead) {
    try {
      const rows = await sql`SELECT id, ano, mes, valor, tipo, categoria FROM public.airbnb_dashboard ORDER BY id ASC`;
      const ratings = await readRatingRows();
      return setJson(res, 200, { rows: rows.concat(ratings), public: true });
    } catch (error) {
      console.error("Neon public read error:", error);
      return setJson(res, 500, { error: error?.message || "Internal server error" });
    }
  }
  const user = await authenticateRequest(req);
  if (!user?.id) return setJson(res, 401, { error: "Unauthorized" });

  try {
    if (req.method === "GET") {
      const rows = await sql`
        SELECT id, ano, mes, valor, tipo, categoria
        FROM public.airbnb_dashboard
        WHERE user_id = ${user.id}::uuid
        ORDER BY id ASC
      `;
      const ratings = await readRatingRows();
      return setJson(res, 200, { rows: rows.concat(ratings) });
    }
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    body = body || {};

    if (req.method === "POST") {
      if (body.ratingCounts && typeof body.ratingCounts === "object") {
        const counts = {};
        [5,4,3,2,1].forEach(s => { counts[s] = Number(body.ratingCounts[s]); });
        const values = [5,4,3,2,1].map(s => counts[s]);
        if (values.some(v => !Number.isInteger(v) || v < 0) || values.reduce((a,b)=>a+b,0) <= 0) {
          return setJson(res, 400, { error: "Invalid rating counts" });
        }
        await ensureRatingTable();
        const exists = await sql`SELECT id FROM public.airbnb_rating_config WHERE id = 1`;
        if (exists.length) {
          await sql`UPDATE public.airbnb_rating_config
            SET nota_5 = \${values[0]}, nota_4 = \${values[1]}, nota_3 = \${values[2]},
                nota_2 = \${values[3]}, nota_1 = \${values[4]}, updated_at = now()
            WHERE id = 1`;
        } else {
          await sql`INSERT INTO public.airbnb_rating_config
            (id, nota_5, nota_4, nota_3, nota_2, nota_1, updated_at)
            VALUES (1, \${values[0]}, \${values[1]}, \${values[2]}, \${values[3]}, \${values[4]}, now())`;
        }
        const current = await sql`SELECT nota_5, nota_4, nota_3, nota_2, nota_1 FROM public.airbnb_rating_config WHERE id = 1`;
        return setJson(res, 200, { ok: true, rows: ratingRows(current[0]) });
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
