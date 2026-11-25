import { extract } from '../../okf/src/extract.ts';
import { patchFrontmatterActorEvent } from '../../okf/src/frontmatter-patch.ts';
import { fail, escape, formCsrf } from '../vendor/mikaki/oidc.ts';
import { contentDraft, decodeOfficeBase64, OFFICE_EXT, type ContentChange } from '../../ssg-worker/src/draft-input.ts';
import type { ContentWorkspace } from '../../ssg-worker/src/content-workspace.ts';
import { icon } from './ui.ts';
import type { Site } from './store.ts';

type OfficeEnv = SoraneAdminEnv & { IBIS_OFFICE_ORIGIN?: string };

const TOKEN_TTL_SECONDS = 300;
const BASE64_CHUNK = 0x8000;

export function ibisOfficeOrigin(env: SoraneAdminEnv): string | null {
  const raw = (env as OfficeEnv).IBIS_OFFICE_ORIGIN;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== raw || url.username || url.password) return null;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function officeSigningKey(env: SoraneAdminEnv): Promise<CryptoKey> {
  const secret = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sorane-office-blob:${env.RP_PRIVATE_JWK}`));
  return await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid_token');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function createOfficeBlobToken(
  env: SoraneAdminEnv,
  claims: { siteId: string; proposalId: string; path: string },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ ...claims, exp: nowSeconds + TOKEN_TTL_SECONDS })));
  const key = await officeSigningKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return `${payload}.${toBase64Url(sig)}`;
}

export async function verifyOfficeBlobToken(
  env: SoraneAdminEnv,
  token: string,
  expectedSiteId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ siteId: string; proposalId: string; path: string }> {
  const parts = token.split('.');
  if (parts.length !== 2) fail(403, 'invalid_office_token');
  let sigBytes: Uint8Array;
  let parsed: unknown;
  try {
    sigBytes = fromBase64Url(parts[1]);
    const key = await officeSigningKey(env);
    const ok = await crypto.subtle.verify('HMAC', key, sigBytes as BufferSource, new TextEncoder().encode(parts[0]));
    if (!ok) fail(403, 'invalid_office_token');
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
  } catch (error) {
    if (error instanceof Error && error.name === 'HttpError') throw error;
    fail(403, 'invalid_office_token');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(403, 'invalid_office_token');
  const obj = parsed as Record<string, unknown>;
  if (
    obj.siteId !== expectedSiteId ||
    typeof obj.proposalId !== 'string' ||
    typeof obj.path !== 'string' ||
    typeof obj.exp !== 'number' ||
    obj.exp <= nowSeconds
  ) {
    fail(403, 'invalid_office_token');
  }
  return { siteId: obj.siteId, proposalId: obj.proposalId, path: obj.path };
}

export async function fetchOfficeFile(env: SoraneAdminEnv, siteId: string, proposalId: string, path: string): Promise<Response> {
  if (!env.CONTENT_SOURCE) fail(503, 'source_unavailable');
  const response = await env.CONTENT_SOURCE.fetch(
    `https://content.internal/?${new URLSearchParams({ site: siteId, proposal: proposalId, file: path })}`,
  );
  if (response.status === 404) fail(404, 'article_not_found');
  if (!response.ok) fail(503, 'source_unavailable');
  return response;
}

function decodeMarkdownBase64(base64: string): string {
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('invalid_editor_content');
  }
  const bin = atob(base64);
  if (bin.length > 65536) throw new Error('invalid_editor_content');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('invalid_editor_content');
  return text;
}

export async function officeDraft(source: ContentWorkspace, value: Record<string, unknown>, opts?: { actor?: string }) {
  const isMd = typeof value.path === 'string' && value.path.endsWith('.md');
  const isOffice = typeof value.path === 'string' && OFFICE_EXT.test(value.path);
  if (
    typeof value.path !== 'string' ||
    (!isOffice && !isMd) ||
    typeof value.base64 !== 'string' ||
    typeof value.operationId !== 'string'
  ) {
    fail(400, 'invalid_editor_content');
  }
  const name = value.path.slice(value.path.lastIndexOf('/') + 1);
  if (isMd) {
    const existing = source.articles.find((file) => file.path === value.path);
    if (!existing) fail(404, 'article_not_found');
    let text: string;
    try {
      text = decodeMarkdownBase64(value.base64);
    } catch {
      fail(400, 'invalid_editor_content');
    }
    if (opts?.actor) {
      const parts = extract(text);
      if (parts.frontmatter !== null) {
        const patched = patchFrontmatterActorEvent(parts.frontmatter, 'generated', {
          by: opts.actor,
          at: new Date().toISOString(),
        });
        if (patched !== null) {
          text = `---\n${patched.trimEnd()}\n---\n${parts.body}`;
        }
      }
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const changes = new Map<string, ContentChange>(source.changes.map((change) => [change.path, change]));
    if (digest === existing.before) changes.delete(value.path);
    else changes.set(value.path, { path: value.path, before: existing.before, text });
    if (!changes.size) fail(400, 'no_content_changes');
    try {
      return {
        draft: contentDraft({ schema: 1, repository: source.repositoryId, changes: [...changes.values()] }),
        message: `${name}を更新`,
      };
    } catch {
      fail(400, 'invalid_editor_content');
    }
  }
  const existing = source.officeFiles?.find((file) => file.path === value.path);
  if (!existing) fail(404, 'article_not_found');
  let decoded: Uint8Array;
  try {
    decoded = decodeOfficeBase64(value.base64);
  } catch {
    fail(400, 'invalid_editor_content');
  }
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', decoded as BufferSource))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const changes = new Map<string, ContentChange>(source.changes.map((change) => [change.path, change]));
  if (digest === existing.before) changes.delete(value.path);
  else changes.set(value.path, { path: value.path, before: existing.before, text: null, base64: value.base64 });
  if (!changes.size) fail(400, 'no_content_changes');
  try {
    return {
      draft: contentDraft({ schema: 1, repository: source.repositoryId, changes: [...changes.values()] }),
      message: `${name}を更新`,
    };
  } catch {
    fail(400, 'invalid_editor_content');
  }
}

export function officeEditorPage(
  site: Site,
  source: ContentWorkspace,
  path: string,
  ibisOrigin: string,
  blobUrl: string,
  token: string,
  operationId: string,
): string {
  const isMd = path.endsWith('.md');
  const file = isMd
    ? source.articles.find((entry) => entry.path === path)
    : source.officeFiles?.find((entry) => entry.path === path);
  if (!file) fail(404, 'article_not_found');
  const route = `/sites/${site.id}`;
  const fileName = file.path.slice(file.path.lastIndexOf('/') + 1);
  const iframeSrc = `${ibisOrigin}/editor.html?${new URLSearchParams({
    download: '1',
    close: '1',
    origin: new URL(blobUrl).origin,
    open: blobUrl,
  })}`;
  return `<a class="back-link" href="${route}">${icon('arrow')}記事・文書一覧に戻る</a>
<div class="heading-row"><div><h1>${escape(fileName)}</h1><p>ibisOffice で編集し、右上の保存（ダウンロード）ボタンから変更案に保存できます。</p></div><span class="pill neutral">${isMd ? 'Markdown' : 'Office'}</span></div>
<div class="steps"><span><b>1</b>文書を編集</span><i></i><span><b>2</b>プレビューで確認</span><i></i><span><b>3</b>公開する</span></div>
<div class="office-shell" data-office-editor data-ibis-origin="${escape(ibisOrigin)}" data-action="/api/sites/${site.id}/office" data-review="${route}?view=review" data-back="${route}" data-operation-id="${escape(operationId)}" data-revision="${site.revision}" data-proposal-id="${escape(source.proposalId)}" data-path="${escape(file.path)}">
  ${formCsrf(token)}
  <p class="status-message" data-office-status role="status" aria-live="polite"></p>
  <iframe class="office-frame" title="${escape(fileName)} — ibisOffice" src="${escape(iframeSrc)}" allow="clipboard-read; clipboard-write"></iframe>
</div>`;
}
