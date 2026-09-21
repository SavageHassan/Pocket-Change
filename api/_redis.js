// Tiny Redis-over-HTTP helper (Upstash REST). Files starting with "_" aren't routed by Vercel.
// Works with the env vars the Vercel/Upstash integration adds (KV_REST_API_* or UPSTASH_REDIS_REST_*).

const url = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const configured = () => Boolean(url() && token());

export async function redis(command) {
  const res = await fetch(url(), {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}
