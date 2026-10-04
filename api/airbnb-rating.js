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


function ratingRows(r) {
  if (!r) return [];
  return [5,4,3,2,1].map(s => ({ id: 0, ano: 2021, mes: 0, valor: Number(r['nota_'+s] || 0), tipo: 'rating', categoria: String(s) }));
}

async function ensureRatingTable() {
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
}
function setJson(res,status,payload){return res.status(status).json(payload)}
module.exports=async function handler(req,res){
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  if(!sql) return setJson(res,503,{error:"Neon is not configured"});
  try{
    await ensureRatingTable();
    if(req.method==="GET"){
      const rows=await sql`SELECT nota_5,nota_4,nota_3,nota_2,nota_1,updated_at FROM public.airbnb_rating_config WHERE id=1`;
      let row=rows[0]||{nota_5:114,nota_4:3,nota_3:0,nota_2:0,nota_1:0};
      return setJson(res,200,{
        nota_5:Number(row.nota_5),nota_4:Number(row.nota_4),nota_3:Number(row.nota_3),
        nota_2:Number(row.nota_2),nota_1:Number(row.nota_1),
        updated_at:row.updated_at||null
      });
    }
    const user=await authenticateRequest(req);
    if(!user?.id) return setJson(res,401,{error:"Unauthorized"});
    if(req.method==="POST"){
      let body=req.body;
      if(typeof body==="string"){try{body=JSON.parse(body)}catch{body=null}}
      body=body||{};
      const c=body.ratingCounts||{};
      const values=[5,4,3,2,1].map(s=>Number(c[s]));
      if(values.some(v=>!Number.isInteger(v)||v<0)||values.reduce((x,y)=>x+y,0)<=0)
        return setJson(res,400,{error:"Invalid rating counts"});
      const rows=await sql`
        INSERT INTO public.airbnb_rating_config
          (id,nota_5,nota_4,nota_3,nota_2,nota_1,updated_at)
        VALUES (1,${values[0]},${values[1]},${values[2]},${values[3]},${values[4]},now())
        ON CONFLICT (id) DO UPDATE SET
          nota_5=EXCLUDED.nota_5,nota_4=EXCLUDED.nota_4,nota_3=EXCLUDED.nota_3,
          nota_2=EXCLUDED.nota_2,nota_1=EXCLUDED.nota_1,updated_at=now()
        RETURNING nota_5,nota_4,nota_3,nota_2,nota_1,updated_at
      `;
      const row=rows[0];
      return setJson(res,200,{ok:true,nota_5:Number(row.nota_5),nota_4:Number(row.nota_4),nota_3:Number(row.nota_3),nota_2:Number(row.nota_2),nota_1:Number(row.nota_1),updated_at:row.updated_at||null});
    }
    res.setHeader("Allow","GET, POST");
    return setJson(res,405,{error:"Method not allowed"});
  }catch(error){
    console.error("Neon Airbnb rating error:",error);
    return setJson(res,500,{error:error?.message||"Internal server error"});
  }
};