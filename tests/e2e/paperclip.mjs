// A Paperclip board session for the e2e tests: sign-up or sign-in, then JSON API calls.
export const PAPERCLIP = process.env.PAPERCLIP_PUBLIC_URL ?? 'http://localhost:3100';
export const DEMO = `http://localhost:${process.env.DEMO_PORT ?? 8090}`;

export async function session({ email, name, password = 'e2e-password-123456' }) {
  let cookie = '';
  async function api(method, path, body) {
    const res = await fetch(`${PAPERCLIP}${path}`, {
      method,
      headers: { 'content-type': 'application/json', origin: PAPERCLIP, ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = [...new Map([...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].map((c) => [c.split('=')[0], c])).values()].join('; ');
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  }
  // Sign-in first, sign-up for a new user; the auth routes are rate-limited, so 429 waits and retries.
  for (let attempt = 0; attempt < 12; attempt++) {
    let res = await api('POST', '/api/auth/sign-in/email', { email, password });
    if (res.status === 401 || res.body?.code === 'INVALID_EMAIL_OR_PASSWORD') res = await api('POST', '/api/auth/sign-up/email', { name, email, password });
    if (res.status < 300) return { api };
    if (res.status !== 429) throw new Error(`cannot sign in ${email}: ${JSON.stringify(res.body)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`cannot sign in ${email}: rate-limited`);
}

/** Fails with the response when the status is not 2xx; returns the body. */
export const ok = (res) => {
  if (res.status >= 300) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 500)}`);
  return res.body;
};
