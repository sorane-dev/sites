import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { type RequestInit as MFRequestInit } from "miniflare";
import { bundleWorker, engineId } from "../packages/ssg-worker/scripts/bundle.ts";
import { fixture, ORIGIN } from "./helpers/admin-fixture.ts";

const IBIS_ORIGIN = "https://ibis.sorane.dev";
const PUBLIC = "https://public.sorane.example";
const sha = (kind: string, data: Buffer) => createHash("sha1").update(`${kind} ${data.length}\0`).update(data).digest("hex");
const makeZip = (marker: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker, "utf8")]);

type Entry = { name: string; mode: string; hash: string; type: string };
type Repo = { tree: string; trees: Record<string, Entry[]>; blobs: Record<string, string> };
function repository(files: Record<string, string | Buffer>): Repo {
  const blobs: Repo["blobs"] = {}, trees: Repo["trees"] = {};
  function tree(prefix: string): string {
    const names = [...new Set(Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split("/")[0]))];
    const entries = names.map((name): Entry => {
      const path = prefix + name;
      if (files[path] === undefined) return { name, mode: "40000", type: "tree", hash: tree(path + "/") };
      const data = typeof files[path] === "string" ? Buffer.from(files[path]) : files[path];
      const hash = sha("blob", data);
      blobs[hash] = data.toString("base64");
      return { name, mode: "100644", hash, type: "blob" };
    }).sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.type === "tree" ? "/" : "\0")), Buffer.from(b.name + (b.type === "tree" ? "/" : "\0"))));
    const bytes = Buffer.concat(entries.map((e) => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.hash, "hex")])));
    const hash = sha("tree", bytes);
    trees[hash] = entries;
    return hash;
  }
  return { tree: tree(""), trees, blobs };
}

test("admin-worker embeds ibisOffice editor, serves signed CORS blob, and builds updated Office draft", async (t) => {
  const initialDocx = makeZip("initial-docx-v1");
  const updatedDocx = makeZip("edited-in-ibis-office-v2");
  const repo = repository({
    "sorane.yaml": "site:\n  title: Office Test\n",
    "content/index.md": "---\ntype: index\ntitle: Office Site\nprofile: sorane-okf/0.1\n---\n\nWelcome.\n",
    "static/report.docx": initialDocx,
  });
  const commit = sha("commit", Buffer.from(repo.tree));
  const engine = engineId(), worker = await bundleWorker(), publicCode = await build({
    entryPoints: [new URL("../packages/public-worker/src/worker.ts", import.meta.url).pathname],
    bundle: true, format: "esm", target: "es2023", write: false, platform: "node",
  });
  const sourceScript = `import {WorkerEntrypoint,RpcTarget} from 'cloudflare:workers';
    const commit=${JSON.stringify(commit)}, repo=${JSON.stringify(repo)};
    class Repo extends RpcTarget {
      info(){return {name:'alpha',id:'repo-office-id'};}
      readCommit(hash){return hash===commit?{hash,treeHash:repo.tree,committedAt:100}:null;}
      readTree(hash){return repo.trees[hash]??null;}
      readBlob(hash){const b=repo.blobs[hash];return b?new Blob([Uint8Array.from(atob(b),ch=>ch.charCodeAt(0))]):null;}
    }
    export default class Source extends WorkerEntrypoint {get(name){if(name!=='alpha')throw Error('unknown repo');return new Repo();}}
  `;
  const f = await fixture(t, {
    engine, bucket: "builds", sourceService: { name: "ssg", entrypoint: "ContentSource" },
    bindings: { IBIS_OFFICE_ORIGIN: IBIS_ORIGIN },
    workers: [
      { name: "source", modules: true, script: sourceScript, compatibilityDate: "2026-10-08", compatibilityFlags: ["nodejs_compat"] },
      {
        name: "ssg", modules: true, script: worker.outputFiles[0].text, compatibilityDate: "2026-10-08",
        compatibilityFlags: ["nodejs_compat", "disallow_importable_env"],
        bindings: { ARTIFACTS_NAMESPACE: "test-namespace", PUBLIC_ORIGIN: PUBLIC, BUILD_QUEUE_NAME: "test-builds", ARTIFACTS_PUSH_SOURCES: "[]" },
        d1Databases: { DB: "pipeline-db" }, r2Buckets: { BUILDS: "builds" }, queueConsumers: { "test-builds": { maxBatchTimeout: 0 } },
        serviceBindings: { ARTIFACTS: "source" },
      },
      {
        name: "public", routes: [PUBLIC + "/*"], modules: true, script: publicCode.outputFiles[0].text, compatibilityDate: "2026-10-08",
        compatibilityFlags: ["nodejs_compat", "disallow_importable_env"], bindings: { PUBLIC_ORIGIN: PUBLIC },
        d1Databases: { DB: "pipeline-db" }, r2Buckets: { BUILDS: "builds" },
      },
    ],
  });
  await f.seedSite("alpha", { owner: "owner", viewer: "viewer" });
  const owner = await f.login("owner"), viewer = await f.login("viewer");
  const revision = async () => ((await (await owner.get("/api/sites/alpha")).json()) as { site: { revision: number } }).site.revision;
  const completed = async (id: string) => {
    for (let i = 0; i < 80; i++) {
      const row = await f.db.prepare("SELECT status,candidate_digest,error FROM build_job WHERE proposal_id=?").bind(id).first<{ status: string; candidate_digest: string | null; error: string | null }>();
      if (row && (row.status === "ready" || row.status === "failed")) return row;
      await delay(25);
    }
    throw new Error("build timeout");
  };

  const initialId = randomUUID();
  assert.equal((await owner.post("/api/sites/alpha/proposals", { operationId: initialId, revision: await revision(), commit, message: "Initial" })).status, 201);
  assert.equal((await completed(initialId)).status, "ready");

  // 1. Site list shows Office file and edit link for authorized roles
  const listHtml = await (await owner.get("/sites/alpha")).text();
  assert.match(listHtml, /static\/report\.docx/);
  assert.match(listHtml, /ibisOffice で編集/);

  // 2. Office editor page sets frame-src CSP and embeds ibisOffice iframe with signed open= URL
  const officePageRes = await owner.get(`/sites/alpha/office?${new URLSearchParams({ proposal: initialId, path: "static/report.docx" })}`);
  assert.equal(officePageRes.status, 200);
  assert.match(officePageRes.headers.get("Content-Security-Policy") ?? "", new RegExp(`frame-src ${IBIS_ORIGIN}`));
  const officeHtml = await officePageRes.text();
  const srcMatch = /<iframe[^>]+src="([^"]+)"/.exec(officeHtml);
  assert.ok(srcMatch, "iframe src must be present");
  const iframeUrl = new URL(srcMatch[1].replaceAll("&amp;", "&"));
  assert.equal(iframeUrl.origin, IBIS_ORIGIN);
  assert.equal(iframeUrl.pathname, "/editor.html");
  assert.equal(iframeUrl.searchParams.get("download"), "1");
  assert.equal(iframeUrl.searchParams.get("close"), "1");
  assert.equal(iframeUrl.searchParams.get("origin"), ORIGIN);
  const blobUrl = new URL(iframeUrl.searchParams.get("open")!);

  // 3. Viewer cannot access Office editor
  assert.equal((await viewer.get(`/sites/alpha/office?${new URLSearchParams({ proposal: initialId, path: "static/report.docx" })}`)).status, 403);

  // 4. Signed blob URL works without session cookie and sets CORS header for ibisOrigin
  const blobRes = await f.mf.dispatchFetch(blobUrl.toString());
  assert.equal(blobRes.status, 200);
  assert.equal(blobRes.headers.get("Access-Control-Allow-Origin"), IBIS_ORIGIN);
  assert.deepEqual(Buffer.from(await blobRes.arrayBuffer()), initialDocx);

  // Tampered token is rejected
  const badBlobUrl = new URL(blobUrl.toString());
  badBlobUrl.searchParams.set("token", blobUrl.searchParams.get("token") + "x");
  assert.equal((await f.mf.dispatchFetch(badBlobUrl.toString())).status, 403);

  // 5. Rejects invalid base64 (non-ZIP), no-op save, and unauthorized role
  const saveBase = { operationId: randomUUID(), revision: await revision(), proposalId: initialId, path: "static/report.docx" };
  assert.equal((await viewer.post("/api/sites/alpha/office", { ...saveBase, base64: updatedDocx.toString("base64") })).status, 403);
  assert.equal((await owner.post("/api/sites/alpha/office", { ...saveBase, base64: Buffer.from("not-a-zip").toString("base64") })).status, 400);
  assert.equal((await owner.post("/api/sites/alpha/office", { ...saveBase, base64: initialDocx.toString("base64") })).status, 400);

  // 6. Valid Office draft save builds candidate and publishes updated bytes
  const saveRes = await owner.post("/api/sites/alpha/office", { ...saveBase, base64: updatedDocx.toString("base64") });
  assert.equal(saveRes.status, 201, await saveRes.clone().text());
  const built = await completed(saveBase.operationId);
  assert.equal(built.status, "ready", JSON.stringify(built));

  const approveRes = await owner.post(`/api/sites/alpha/proposals/${saveBase.operationId}/approve`, {
    operationId: randomUUID(), revision: await revision(), commit, candidate: built.candidate_digest,
  });
  assert.equal(approveRes.status, 201);

  const publicWorker = await f.mf.getWorker("public");
  const pubRes = await publicWorker.fetch(new URL("/alpha/static/report.docx", PUBLIC).toString() as unknown as Parameters<typeof publicWorker.fetch>[0] & string, {} as MFRequestInit);
  assert.equal(pubRes.status, 200);
  assert.deepEqual(Buffer.from(await pubRes.arrayBuffer()), updatedDocx);

  // 7. Markdown manuscripts can also be opened and saved via ibisOffice with OKF v0.3 generated actor
  const mdPageRes = await owner.get(`/sites/alpha/office?${new URLSearchParams({ proposal: initialId, path: "content/index.md" })}`);
  assert.equal(mdPageRes.status, 200);
  const mdHtml = await mdPageRes.text();
  assert.match(mdHtml, /<span class="pill neutral">Markdown<\/span>/);
  const mdSrcMatch = /<iframe[^>]+src="([^"]+)"/.exec(mdHtml);
  assert.ok(mdSrcMatch);
  const mdBlobUrl = new URL(new URL(mdSrcMatch[1].replaceAll("&amp;", "&")).searchParams.get("open")!);
  const mdBlobRes = await f.mf.dispatchFetch(mdBlobUrl.toString());
  assert.equal(mdBlobRes.status, 200);
  assert.match(mdBlobRes.headers.get("Content-Type") ?? "", /text\/markdown/);
  assert.match(await mdBlobRes.text(), /Welcome\./);

  const updatedMd = "---\ntype: index\ntitle: Office Site Updated\nprofile: sorane-okf/0.3\nx-ibis-format: document\n---\n\nEdited in ibisOffice.\n";
  const mdSaveId = randomUUID();
  const mdSaveRes = await owner.post("/api/sites/alpha/office", {
    operationId: mdSaveId,
    revision: await revision(),
    proposalId: initialId,
    path: "content/index.md",
    base64: Buffer.from(updatedMd, "utf8").toString("base64"),
  });
  assert.equal(mdSaveRes.status, 201, await mdSaveRes.clone().text());
  const mdDraftRes = await owner.get(`/api/sites/alpha/proposals/${mdSaveId}/draft`);
  const mdDraftJson = (await mdDraftRes.json()) as { changes: Array<{ path: string; text: string | null }> };
  const savedMd = mdDraftJson.changes.find((c) => c.path === "content/index.md")?.text ?? "";
  assert.match(savedMd, /x-ibis-format: document/);
  assert.match(savedMd, /generated: \{ by: human:owner, at:/);
});
