const ORIGIN = 'https://omni.variational.io';
const MAX_RESPONSE_BYTES = 2_000_000;

export type VariationalSession = {
  current: () => { token: string | null; revision: number; status?: 'missing' | 'expired' | 'ready' | 'rejected' | 'unavailable' };
  report: (revision: number, status: 'ready' | 'rejected' | 'unavailable') => void;
};

export function variationalTokenExpiry(token: unknown): number {
  try {
    if (typeof token !== 'string' || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')));
    if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= 0 || claims.exp >= 253402300799) throw Error();
    return claims.exp * 1000;
  } catch { throw Error('Var token 格式无效，请仅粘贴 vr-token 的值。'); }
}

type VariationalPath = '/me' | '/quotes/indicative'
  | '/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future'
  | '/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future';
const READ_PATHS: readonly string[] = ['/me', '/quotes/indicative',
  '/funding/v2?underlying=BZ&instrument_type=perpetual_rwa_future',
  '/funding/v2?underlying=CL&instrument_type=perpetual_rwa_future'];

/** Credentials only reach these fixed, read-only Variational endpoints. */
export async function requestVariational(path: VariationalPath, token: string, { fetcher = fetch, body }: { fetcher?: typeof fetch; body?: unknown } = {}): Promise<unknown> {
  // Keep the runtime allowlist as well as the TypeScript constraint.
  if (!READ_PATHS.includes(path)) throw Error('不支持的 Variational 数据接口。');
  variationalTokenExpiry(token);
  const post = path === '/quotes/indicative';
  try {
    const response = await fetcher(`${ORIGIN}/api${path}`, {
      method: post ? 'POST' : 'GET',
      headers: { Accept: 'application/json', Cookie: `vr-token=${token}`, 'User-Agent': 'Mozilla/5.0', ...(post ? { 'Content-Type': 'application/json' } : {}) },
      ...(post ? { body: JSON.stringify(body) } : {}),
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(Error('Variational 数据请求失败。'), { rejected: response.status === 401 || response.status === 403 });
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error();
    const decoder = new TextDecoder();
    let text = '', size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw Error();
        text += decoder.decode(chunk.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } catch (error) {
    const rejected = Boolean(error && typeof error === 'object' && 'rejected' in error && error.rejected === true);
    throw Object.assign(Error(rejected ? 'Var token 已失效或被拒绝，请更新。' : 'Variational 暂不可用，请稍后重试。'), { rejected });
  }
}
