/// <reference lib="dom" />
export const ARTIFACT_LIMIT = 64 * 1024 * 1024;
const FORMATS = new Map([
  ['asset.glb', ['export', 'model/gltf-binary']], ['collision.glb', ['export', 'model/gltf-binary']],
  ['asset-lod1.glb', ['export', 'model/gltf-binary']], ['asset.fbx', ['export', 'application/octet-stream']],
  ['asset.blend', ['scene', 'application/octet-stream']],
  ['request.json', ['request', 'application/json']], ['audit.json', ['audit', 'application/json']],
]);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export interface DownloadArtifact { jobId: string; path: string; bytes: number; sha256: string; filename: string; contentType: string }
export function readDownloadArtifacts(value: unknown, jobId: string): DownloadArtifact[] {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(jobId) || !object(value) || value.jobId !== jobId || !object(value.request) || typeof value.request.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value.request.name) || !Array.isArray(value.artifacts) || value.artifacts.length > 64) throw new Error('The export manifest does not match this exact asset job.');
  const results: DownloadArtifact[] = [], seen = new Set<string>();
  for (const row of value.artifacts) {
    if (!object(row) || typeof row.path !== 'string') throw new Error('Invalid manifest artifact.');
    const format = FORMATS.get(row.path); if (!format) continue;
    if (seen.has(row.path) || row.role !== format[0] || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > ARTIFACT_LIMIT || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('Invalid bounded export artifact.');
    seen.add(row.path); results.push({ jobId, path: row.path, bytes: row.bytes, sha256: row.sha256, filename: value.request.name + '-' + row.path, contentType: format[1]! });
  }
  return results;
}
export async function fetchVerifiedArtifact(artifact: DownloadArtifact, token: string, signal: AbortSignal, transport: typeof fetch = fetch): Promise<Blob> {
  const expected = readDownloadArtifacts({ jobId: artifact.jobId, request: { name: 'download' }, artifacts: [{ path: artifact.path, bytes: artifact.bytes, sha256: artifact.sha256, role: FORMATS.get(artifact.path)?.[0] }] }, artifact.jobId)[0];
  if (!expected || expected.contentType !== artifact.contentType || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Open the private workbench link before downloading.');
  const route = '/v1/assets/artifact?jobId=' + encodeURIComponent(artifact.jobId) + '&path=' + encodeURIComponent(artifact.path);
  if (signal.aborted) throw new Error('Download cancelled.');
  const response = await transport(route, { method: 'GET', headers: { Authorization: 'Bearer ' + token }, signal, cache: 'no-store', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Verified artifact download refused (' + response.status + '). Reload the manifest before retrying.'); }
  if (response.headers.get('Content-Type')?.split(';')[0] !== artifact.contentType || response.headers.get('Content-Length') !== String(artifact.bytes) || !response.headers.get('Content-Disposition')?.startsWith('attachment;') || !response.body) { await response.body?.cancel(); throw new Error('Artifact headers do not match the verified manifest.'); }
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = []; let total = 0;
  try {
    for (;;) { if (signal.aborted) throw new Error('Download cancelled.'); const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > artifact.bytes || total > ARTIFACT_LIMIT) throw new Error('Artifact exceeded its manifest byte bound.'); chunks.push(new Uint8Array(value)); }
    if (total !== artifact.bytes || signal.aborted) throw new Error('Artifact delivery was incomplete.');
    const blob = new Blob(chunks, { type: artifact.contentType });
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (digest !== artifact.sha256 || signal.aborted) throw new Error('Artifact checksum verification failed. No file was downloaded.');
    return blob;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; } finally { reader.releaseLock(); }
}

/** No network request until a human clicks an exact manifest-backed export. */
export class ArtifactDownloads {
  private epoch = 0; private controller: AbortController | null = null;
  constructor(private readonly doc: Document, private readonly token: string) {}
  clear(): void { this.epoch++; this.controller?.abort(); this.controller = null; const host = this.doc.getElementById('artifact-files'); if (host) { host.replaceChildren(); host.hidden = true; } this.doc.getElementById('preview-files-tab')?.setAttribute('data-workspace-target', 'asset-heading'); }
  show(manifest: unknown, jobId: string): void {
    this.clear(); const host = this.doc.getElementById('artifact-files'); if (!host) return;
    const artifacts = readDownloadArtifacts(manifest, jobId); if (!artifacts.length) return;
    const epoch = this.epoch, heading = this.doc.createElement('h3'), notice = this.doc.createElement('p');
    heading.textContent = 'Export files'; notice.textContent = 'Choose a file to verify and download. Review it before importing.'; notice.className = 'hint'; notice.setAttribute('role', 'status'); host.append(heading);
    for (const artifact of artifacts) { const button = this.doc.createElement('button'); button.type = 'button'; button.className = 'artifact-file'; button.textContent = artifact.path + '  ' + (artifact.bytes < 1024 * 1024 ? Math.ceil(artifact.bytes / 1024) + ' KB' : (artifact.bytes / 1024 / 1024).toFixed(1) + ' MB'); button.addEventListener('click', () => { void this.download(artifact, epoch, notice, host); }); host.append(button); }
    host.append(notice); host.hidden = false; this.doc.getElementById('preview-files-tab')?.setAttribute('data-workspace-target', 'artifact-files');
  }
  private async download(artifact: DownloadArtifact, epoch: number, notice: HTMLElement, host: HTMLElement): Promise<void> {
    if (epoch !== this.epoch || this.controller) return;
    const controller = new AbortController(); this.controller = controller;
    const timer = setTimeout(() => controller.abort(), 35000);
    for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.disabled = true;
    notice.textContent = 'Verifying ' + artifact.path + '...';
    try {
      const blob = await fetchVerifiedArtifact(artifact, this.token, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), link = this.doc.createElement('a'); link.href = url; link.download = artifact.filename; link.hidden = true; host.append(link);
      try { link.click(); notice.textContent = artifact.path + ': SHA-256 verified; browser download requested.'; } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { if (epoch === this.epoch) notice.textContent = controller.signal.aborted ? 'Download cancelled or timed out. No file was saved.' : error instanceof Error ? error.message : 'Artifact download failed.'; }
    finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; if (epoch === this.epoch) for (const button of host.querySelectorAll<HTMLButtonElement>('button')) button.disabled = false; }
  }
}
