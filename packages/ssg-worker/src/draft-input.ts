import { MAX_FILE_BYTES, safePath } from './source-limits.ts';
export type ContentChange = {path:string; before:string|null; text:string|null; base64?:string};
export type ContentDraft = {schema:1; repository:string; changes:ContentChange[]};
export const MAX_DRAFT_REQUEST = 196608;
export const MAX_OFFICE_DRAFT_REQUEST = 524288;
const SHA256 = /^[0-9a-f]{64}$/;
export const OFFICE_EXT = /\.(docx|xlsx|pptx)$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const bytes = (text:string) => new TextEncoder().encode(text);
const object = (value:unknown): value is Record<string,unknown> => !!value && typeof value==='object' && !Array.isArray(value);
function exact(value:Record<string,unknown>, keys:string[]) {
  if (Object.keys(value).length!==keys.length || Object.keys(value).some(key=>!keys.includes(key))) throw new Error('invalid_content_draft');
}
export function decodeOfficeBase64(base64:string): Uint8Array {
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) throw new Error('invalid_content_draft');
  let raw: string;
  try { raw = atob(base64); } catch { throw new Error('invalid_content_draft'); }
  if (raw.length < 4 || raw.length > MAX_FILE_BYTES) throw new Error('invalid_content_draft');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  if (out[0] !== 0x50 || out[1] !== 0x4b || out[2] !== 0x03 || out[3] !== 0x04) throw new Error('invalid_content_draft');
  return out;
}

/** Closed data format, shared by admission and the builder. No authority claims. */
export function contentDraft(value:unknown): ContentDraft {
  if (!object(value)) throw new Error('invalid_content_draft');
  exact(value,['schema','repository','changes']);
  if (value.schema!==1 || typeof value.repository!=='string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.repository) ||
    !Array.isArray(value.changes) || !value.changes.length || value.changes.length>16) throw new Error('invalid_content_draft');
  let size=0;
  const paths=new Set<string>();
  const changes=value.changes.map((change):ContentChange=>{
    if (!object(change)) throw new Error('invalid_content_draft');
    if (typeof change.path!=='string' || !safePath(change.path) || paths.has(change.path) ||
      !(change.before===null || typeof change.before==='string' && SHA256.test(change.before)))
      throw new Error('invalid_content_draft');
    const isMd = change.path.endsWith('.md'), isOffice = OFFICE_EXT.test(change.path);
    if (!isMd && !isOffice) throw new Error('invalid_content_draft');
    paths.add(change.path);
    if (isMd) {
      exact(change,['path','before','text']);
      if (!(change.text===null || typeof change.text==='string') || change.before===null && change.text===null)
        throw new Error('invalid_content_draft');
      if (change.text!==null) {
        const encoded=bytes(change.text);
        // Reject NUL and unpaired surrogates instead of silently replacing input.
        if (change.text.includes('\0') || new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(encoded)!==change.text || encoded.length>65536)
          throw new Error('invalid_content_draft');
        size+=encoded.length;
      }
      if (size>524288) throw new Error('invalid_content_draft');
      return {path:change.path,before:change.before,text:change.text};
    }
    if (change.base64 !== undefined) {
      exact(change,['path','before','text','base64']);
      if (change.text !== null || typeof change.base64 !== 'string') throw new Error('invalid_content_draft');
      const decoded = decodeOfficeBase64(change.base64);
      size += decoded.length;
      if (size>524288) throw new Error('invalid_content_draft');
      return {path:change.path,before:change.before,text:null,base64:change.base64};
    }
    exact(change,['path','before','text']);
    if (change.text !== null || change.before === null) throw new Error('invalid_content_draft');
    return {path:change.path,before:change.before,text:null};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {schema:1,repository:value.repository,changes};
}
export async function draftDigest(draft:ContentDraft): Promise<string> {
  const hash=await crypto.subtle.digest('SHA-256',bytes(JSON.stringify(draft)));
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
