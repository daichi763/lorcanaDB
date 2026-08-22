/**
 * adminAuth.ts — 隠し管理画面の署名セッション（共通実装）
 *
 * なぜ lib に置くか:
 *   管理画面（routes/admin.ts）だけでなく、記憶層の構築API（routes/memory.ts）も
 *   「管理者本人か」を判定する必要がある。以前は memory.ts が
 *   ADMIN_TOKEN ヘッダ or localhost 判定という別系統だったため、
 *   本番（*.pages.dev）では管理画面から記憶層を更新できず 403 になっていた。
 *   認証の実装をここへ一本化し、両方が同じセッションを信頼できるようにする。
 *
 * 方式:
 *   ステートレスな HMAC-SHA256 署名クッキー。
 *   値は `v1.<exp>.<b64url(HMAC(password, "v1."+exp))>`。
 *   鍵は ADMIN_PASSWORD（無ければ ADMIN_TOKEN）。KV等の保存領域を使わずに
 *   失効付きセッションを実現できる。
 */
import type { Bindings } from '../types';

/** セッションの有効期間（秒）。作業単位としては十分で、放置リスクは抑えたい */
export const SESSION_TTL = 60 * 60 * 2;
export const COOKIE_NAME = '__ops_sess';

const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function hmac(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/** タイミング攻撃を避けるため、長さと内容を定数時間で比較する */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function adminPassword(env: Bindings): string | null {
  // ADMIN_PASSWORD が未設定なら ADMIN_TOKEN で代替（記憶層構築と同じ鍵で運用できる）
  const pw = (env as any).ADMIN_PASSWORD || (env as any).ADMIN_TOKEN || '';
  return pw ? String(pw) : null;
}

export async function issueSession(env: Bindings): Promise<string> {
  const pw = adminPassword(env);
  if (!pw) throw new Error('no password configured');
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const payload = `v1.${exp}`;
  return `${payload}.${await hmac(pw, payload)}`;
}

export async function verifySession(env: Bindings, token: string | null): Promise<boolean> {
  const pw = adminPassword(env);
  if (!pw || !token) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmac(pw, `v1.${exp}`);
  return timingSafeEqual(expected, parts[2]);
}

export function readCookie(c: any, name: string): string | null {
  const raw = c.req.header('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * 管理者として通ってよいリクエストか。
 *  1) 有効な __ops_sess クッキー（管理画面からの操作。本番でもこれで通る）
 *  2) x-admin-token ヘッダ == ADMIN_TOKEN（CI やスクリプトからの操作）
 *  3) 上のどちらの鍵も設定されていない場合のみ、localhost に限り許可（ローカル開発）
 */
export async function isAdminRequest(c: any): Promise<boolean> {
  if (await verifySession(c.env, readCookie(c, COOKIE_NAME))) return true;

  const token = (c.env as any).ADMIN_TOKEN;
  if (token) {
    const got = c.req.header('x-admin-token') || '';
    return got.length === String(token).length && timingSafeEqual(got, String(token));
  }

  // ADMIN_TOKEN 未設定時はローカル開発を想定し、localhost からのみ許可。
  // 本番のホストは *.pages.dev なのでここは通らない（= クッキー必須になる）。
  const host = c.req.header('host') || '';
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(host);
}
