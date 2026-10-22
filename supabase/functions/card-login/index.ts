// EMON OVERRUNS E-PORTAL — sign in with the employee ID card (3.21).
// POST { code, pin }: the code read from the QR on the back of the ID card and the employee's 4-digit PIN.
// The database (public.card_login, service role only) checks the card and the PIN. When both are right this function
// makes a one-time sign-in token for that employee's account and gives back its hash; the portal exchanges it for a
// session (supabase.auth.verifyOtp). Nothing is emailed. Deployed with JWT verification off: the card and PIN are the
// proof, and the portal's publishable key is not a JWT.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "Use POST." });
  let body: { code?: unknown; pin?: unknown };
  try { body = await req.json(); } catch { return reply(400, { error: "Scan the ID card and enter the 4-digit PIN." }); }
  const code = String(body.code ?? "").trim().slice(0, 200);
  const pin = String(body.pin ?? "").trim();
  if (!code || !/^\d{4}$/.test(pin)) return reply(400, { error: "Scan the ID card and enter the 4-digit PIN." });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("card_login", { p_code: code, p_pin: pin });
  if (error) {
    console.error("card_login:", error.message);
    return reply(500, { error: "The ID card could not be checked. Try again." });
  }
  if (!data?.ok) return reply(401, { error: data?.error || "This ID card cannot sign in." });

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email: data.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    console.error("generateLink:", linkError?.message);
    return reply(500, { error: "The portal could not be opened. Try again." });
  }
  return reply(200, { token_hash: tokenHash });
});
