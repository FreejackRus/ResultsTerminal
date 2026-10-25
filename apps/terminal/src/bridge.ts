import { invoke } from '@tauri-apps/api/core';
import type { Config } from '@rt/contracts';
const native = '__TAURI_INTERNALS__' in window;
let browserToken = '';
export const isNative = native;
export const errorMessages: Record<string, string> = {
  UNAUTHORIZED: 'Данные не подтверждены. Проверьте ввод или обратитесь к сотруднику.',
  SESSION_EXPIRED: 'Срок сеанса истёк. Начните поиск заново.',
  MIS_UNAVAILABLE: 'Не удалось связаться с медицинской системой. Попробуйте позже.',
  UNSUPPORTED_METHOD: 'Этот способ получения результатов сейчас недоступен.',
  RATE_LIMITED: 'Слишком много попыток. Подождите минуту.',
  INVALID_MIS_RESPONSE: 'Медицинская система вернула некорректный ответ.',
  NOT_FOUND: 'Документ недоступен.',
  PRINTER: 'Не удалось подтвердить печать. Проверьте лоток и обратитесь к сотруднику.',
};
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (native) {
    const r = await invoke<{ status: number; body: string }>('api_request', {
      path,
      method,
      body: body ?? null,
    });
    if (r.status >= 400) throw new Error(JSON.parse(r.body).error?.code ?? 'NETWORK');
    return (r.body ? JSON.parse(r.body) : undefined) as T;
  }
  if (!import.meta.env.DEV) throw new Error('NATIVE_REQUIRED');
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${browserToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const e = await response.json();
    throw new Error(e.error?.code ?? 'NETWORK');
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function enroll(url: string, code: string) {
  if (native) return invoke('enroll', { url, code });
  if (!import.meta.env.DEV) throw Error('NATIVE_REQUIRED');
  const r = await fetch('/api/v1/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!r.ok) throw Error('UNAUTHORIZED');
  browserToken = (await r.json()).token;
}
export async function pdfBytes(session: string, id: string): Promise<number[]> {
  const path = `/api/v1/sessions/${encodeURIComponent(session)}/results/${encodeURIComponent(id)}/pdf`;
  if (native) return invoke('get_pdf', { path });
  if (!import.meta.env.DEV) throw Error('NATIVE_REQUIRED');
  const r = await fetch(path, { headers: { authorization: `Bearer ${browserToken}` } });
  if (!r.ok) throw Error('NOT_FOUND');
  return Array.from(new Uint8Array(await r.arrayBuffer()));
}
export async function submitPrint(sessionId: string, resultId: string, jobId: string) {
  if (!native) throw Error('NATIVE_REQUIRED');
  await invoke('print_document', { sessionId, resultId, jobId });
}
export async function applyConfig(config: Config) {
  if (native) await invoke('apply_config', { config });
}
export async function localReady() {
  return native ? invoke<boolean>('is_enrolled') : !!browserToken;
}

export async function deviceHealth() {
  return native ? invoke('get_health') : undefined;
}
