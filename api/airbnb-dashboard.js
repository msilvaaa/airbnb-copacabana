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

async function ensureDashboardTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS public.airbnb_dashboard (
      id bigserial PRIMARY KEY,
      user_id uuid NOT NULL,
      ano integer NOT NULL,
      mes integer NOT NULL,
      valor numeric NOT NULL,
      tipo text NOT NULL,
      categoria text NOT NULL DEFAULT ''
    )
  `;
}

async function ensureRatingTable() {
  // Faz a migração de forma idempotente: se a tabela ainda não estiver
  // no banco conectado pela Vercel, cria a estrutura necessária.
  await sql`
    CREATE TABLE IF NOT EXISTS public.airbnb_rating_config (
      id integer PRIMARY KEY,
      nota_5 integer NOT NULL DEFAULT 0,
      nota_4 integer NOT NULL DEFAULT 0,
      nota_3 integer NOT NULL DEFAULT 0,
      nota_2 integer NOT NULL DEFAULT 0,
      nota_1 integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`
    INSERT INTO public.airbnb_rating_config
      (id, nota_5, nota_4, nota_3, nota_2, nota_1)
    VALUES (1, 114, 3, 0, 0, 0)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS public.airbnb_editor_state (
      user_id uuid PRIMARY KEY,
      state jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}
function ratingRows(r) {
  if (!r) return [];
  return [5,4,3,2,1].map(s => ({ id: 0, ano: 2021, mes: 0, valor: Number(r['nota_'+s] || 0), tipo: 'rating', categoria: String(s) }));
}
async function readRatingRows() {
  const rows = await sql`SELECT nota_5, nota_4, nota_3, nota_2, nota_1 FROM public.airbnb_rating_config WHERE id = 1`;
  return ratingRows(rows[0]);
}
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!sql) return setJson(res, 503, { error: "Neon is not configured" });

  try {
    await ensureDashboardTable();
    await ensureRatingTable();
  } catch (error) {
    console.error("Neon schema initialization error:", error);
    return setJson(res, 500, { error: error?.message || "Neon schema initialization failed" });
  }

  const isPublicRead = req.method === "GET" && (req.query?.public === "1" || req.query?.public === "true");

  if (isPublicRead) {
    try {
      const [rows, ratings] = await Promise.all([
        sql`SELECT DISTINCT ON (ano, mes, tipo, COALESCE(categoria, ''))
          id, ano, mes, valor, tipo, categoria
          FROM public.airbnb_dashboard
          ORDER BY ano ASC, mes ASC, tipo ASC, COALESCE(categoria, '') ASC, id DESC`,
        readRatingRows()
      ]);
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
        SELECT DISTINCT ON (ano, mes, tipo, COALESCE(categoria, ''))
          id, ano, mes, valor, tipo, categoria
        FROM public.airbnb_dashboard
        WHERE user_id = ${user.id}::uuid
        ORDER BY ano ASC, mes ASC, tipo ASC, COALESCE(categoria, '') ASC, id DESC
      `;
      const ratings = await readRatingRows();
      let editorState = null;
      const stateRows = await sql`SELECT state FROM public.airbnb_editor_state WHERE user_id = ${user.id}::uuid`;
      if (stateRows[0]?.state) editorState = stateRows[0].state;
      return setJson(res, 200, { rows: rows.concat(ratings), editorState });
    }
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    body = body || {};

    if (req.method === "POST") {
      if (body.editorState && typeof body.editorState === "object") {
        const state=body.editorState;
        await sql`
          INSERT INTO public.airbnb_editor_state (user_id, state, updated_at)
          VALUES (${user.id}::uuid, ${JSON.stringify(state)}::jsonb, now())
          ON CONFLICT (user_id) DO UPDATE SET
            state = EXCLUDED.state,
            updated_at = now()
        `;
        // Editor state is a standalone operation. Do not fall through to
        // the generic row validator when there is no dashboard row payload.
        if (body.ratingCounts === undefined && body.ano === undefined && body.valor === undefined) {
          return setJson(res, 200, { ok: true, editorState: state });
        }
      }
      if (body.ratingCounts && typeof body.ratingCounts === "object") {
        const counts = {};
        [5,4,3,2,1].forEach(s => { counts[s] = Number(body.ratingCounts[s]); });
        const values = [5,4,3,2,1].map(s => counts[s]);
        if (values.some(v => !Number.isInteger(v) || v < 0) || values.reduce((a,b)=>a+b,0) <= 0) {
          return setJson(res, 400, { error: "Invalid rating counts" });
        }
        await ensureRatingTable();
        // Upsert atômico: a própria operação grava e devolve os valores
        // efetivamente persistidos na mesma conexão com o Neon.
        const current = await sql`
          INSERT INTO public.airbnb_rating_config
            (id, nota_5, nota_4, nota_3, nota_2, nota_1, updated_at)
          VALUES (1, ${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${values[4]}, now())
          ON CONFLICT (id) DO UPDATE SET
            nota_5 = EXCLUDED.nota_5,
            nota_4 = EXCLUDED.nota_4,
            nota_3 = EXCLUDED.nota_3,
            nota_2 = EXCLUDED.nota_2,
            nota_1 = EXCLUDED.nota_1,
            updated_at = now()
          RETURNING nota_5, nota_4, nota_3, nota_2, nota_1
        `;
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
      if (tipo === 'fixedCategory') {
        // Salva somente a categoria. O total de custos fixos é calculado no
        // cliente preservando todos os demais componentes do mês.
        await sql`
          DELETE FROM public.airbnb_dashboard
          WHERE user_id = ${user.id}::uuid
            AND ano = ${ano}
            AND mes = ${mes}
            AND tipo = 'fixedCategory'
            AND COALESCE(categoria, '') = ${categoria}
        \`;
        const categoryRows = await sql`
          INSERT INTO public.airbnb_dashboard (user_id, ano, mes, valor, tipo, categoria)
          VALUES (${user.id}::uuid, ${ano}, ${mes}, ${valor}, 'fixedCategory', ${categoria})
          RETURNING id, ano, mes, valor, tipo, categoria
        \`;
        return setJson(res, 200, { row: categoryRows[0] || null });
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
