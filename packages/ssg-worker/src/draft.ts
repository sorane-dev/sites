import { MAX_FILES, MAX_FILE_BYTES, MAX_SOURCE_BYTES, sha256, type Source } from './artifacts.ts';
import { decodeOfficeBase64, OFFICE_EXT, type ContentDraft } from './draft-input.ts';
const bytes=(text:string)=>new TextEncoder().encode(text);
/** Apply replacements only within the base configuration's content or static Office directories. */
export function applyDraft(source:Source, draft:ContentDraft, contentDir:string, staticDir='static'): Source {
  if (draft.repository!==source.repositoryId) throw new Error('repository_identity_mismatch');
  const files=new Map(source.files.map(file=>[file.path,file.bytes]));
  for (const change of draft.changes) {
    const inContent=change.path.startsWith(contentDir+'/');
    const inStatic=OFFICE_EXT.test(change.path) && change.path.startsWith(staticDir+'/');
    if (!inContent && !inStatic) throw new Error('draft_path_not_content');
    const current=files.get(change.path);
    if ((current===undefined?null:sha256(current))!==change.before) throw new Error('draft_base_mismatch');
    if (change.base64!==undefined) files.set(change.path,decodeOfficeBase64(change.base64));
    else if (change.text===null) files.delete(change.path);
    else files.set(change.path,bytes(change.text));
  }
  let total=0;
  for (const [path,data] of files) {
    total+=data.length;
    if (data.length>MAX_FILE_BYTES || total>MAX_SOURCE_BYTES || files.size>MAX_FILES ||
      [...files.keys()].some(other=>other!==path && other.startsWith(path+'/'))) throw new Error('source_size_limit');
  }
  return {...source,files:[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,data])=>({path,bytes:data}))};
}
