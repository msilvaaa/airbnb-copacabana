const { neon } = require("@neondatabase/serverless");

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;
const SUPABASE_URL = process.env.SUPABASE_URL || "https://yayfspvqwuefbtiyttnr.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_iOxhPw26ASUO9WaNcc7HfA_dR1XjyKp";

async function authenticate(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const response = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: "Bearer " + match[1]
    }
  });
  if (!response.ok) return null;
  return response.json();
}

function setJson(res, status, payload) {
  return res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!sql) return setJson(res, 503, { error: "Neon is not configured" });

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
