import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ProviderRequestGuard, type ProviderAdapter, type ProviderInvocation } from './provider.js';
import type { GeneratedImageOutput } from './http-adapters.js';
import { assertValidGlb } from './asset-validation.js';

export const SegmentationInputSchema = z.object({
  image: z.string().min(1),
  box: z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), width: z.number().positive(), height: z.number().positive() }),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SegmentationInput = z.infer<typeof SegmentationInputSchema>;

export const BlenderRefinementOperationSchema = z.enum([
  'validate-mesh',
  'fix-normals',
  'normalize-origin',
  'normalize-materials',
  'fix-ground-contact',
  'export-glb',
  'render-turntable',
  'render-passes',
]);
export type BlenderRefinementOperation = z.infer<typeof BlenderRefinementOperationSchema>;

export const BlenderRefinementRequestSchema = z.object({
  operations: z.array(BlenderRefinementOperationSchema).min(1),
  targetHeightMeters: z.number().positive().optional(),
  renderResolution: z.number().int().min(128).max(2048).default(512),
});
export type BlenderRefinementRequest = z.infer<typeof BlenderRefinementRequestSchema>;

export interface BlenderRefinementResult {
  glb: Uint8Array;
  renders: Array<{ kind: 'blender-rgb' | 'blender-depth' | 'blender-normal' | 'blender-instance'; bytes: Uint8Array }>;
  diagnostics: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
  workerVersion: string;
}

export interface ProcessResult { code: number; stdout: string; stderr: string }
export type ProcessRunner = (command: string, args: readonly string[], signal?: AbortSignal) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = (command, args, signal) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk)); child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.once('error', reject);
  child.once('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
});

function dataUrlBytes(source: string): { bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' } {
  const match = source.match(/^data:(image\/(?:png|jpeg));base64,([a-z\d+/=]+)$/i);
  if (!match) throw new Error('Local worker input must be a PNG or JPEG data URL');
  const contentType = match[1]!.toLowerCase() as 'image/png' | 'image/jpeg';
  const bytes = new Uint8Array(Buffer.from(match[2]!, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > 50 * 1024 * 1024) throw new Error('Local worker image is empty or exceeds 50 MB');
  return { bytes, contentType };
}

export class LocalSam2SegmentationAdapter implements ProviderAdapter<SegmentationInput, GeneratedImageOutput> {
  readonly provider = 'sam2-local';
  private readonly guard = new ProviderRequestGuard();

  constructor(
    readonly modelId: string,
    readonly revision: string,
    private readonly pythonExecutable: string,
    private readonly workerScript: string,
    private readonly checkpointPath: string,
    private readonly modelConfig: string,
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async checkCapabilities() { return { structuredOutput: false, imageInput: true, segmentation: true }; }
  async estimate(): Promise<number> { return 0; }
  async invoke(request: ProviderInvocation<SegmentationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    return this.guard.invokeOnce(request.idempotencyKey, () => this.invokeRequest(request, signal));
  }

  private async invokeRequest(request: ProviderInvocation<SegmentationInput, GeneratedImageOutput>, signal?: AbortSignal): Promise<GeneratedImageOutput> {
    const input = SegmentationInputSchema.parse(request.input);
    const image = dataUrlBytes(input.image);
    const directory = await mkdtemp(join(tmpdir(), 'worldengine-sam2-'));
    try {
      const inputPath = join(directory, image.contentType === 'image/jpeg' ? 'input.jpg' : 'input.png');
      const outputPath = join(directory, 'mask.png');
      const jobPath = join(directory, 'job.json');
      await writeFile(inputPath, image.bytes);
      await writeFile(jobPath, JSON.stringify({ schemaVersion: '1.0.0', operation: 'segment-box', inputPath, outputPath, checkpointPath: this.checkpointPath, modelConfig: this.modelConfig, box: input.box, imageSize: [input.width, input.height] }));
      const result = await this.runner(this.pythonExecutable, [this.workerScript, '--job', jobPath], signal);
      if (result.code !== 0) throw new Error(`SAM2 worker failed: ${result.stderr || result.stdout}`);
      const mask = new Uint8Array(await readFile(outputPath));
      return { images: [{ base64: Buffer.from(mask).toString('base64') }] };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export class BlenderWorkerClient {
  constructor(
    private readonly blenderExecutable: string,
    private readonly workerScript: string,
    private readonly runner: ProcessRunner = runProcess,
  ) {}

  async checkCapabilities(signal?: AbortSignal): Promise<{ available: boolean; version?: string; issue?: string }> {
    try {
      const result = await this.runner(this.blenderExecutable, ['--version'], signal);
      const version = result.stdout.split('\n')[0]?.trim();
      return result.code === 0 && /^Blender 5\.1(?:\.|\s|$)/.test(version ?? '') ? { available: true, ...(version ? { version } : {}) } : { available: false, ...(version ? { version } : {}), issue: 'Studio requires Blender 5.1.x' };
    } catch (error) {
      return { available: false, issue: (error as Error).message };
    }
  }

  async refine(glb: Uint8Array, requestInput: BlenderRefinementRequest, signal?: AbortSignal): Promise<BlenderRefinementResult> {
    assertValidGlb(glb);
    const request = BlenderRefinementRequestSchema.parse(requestInput);
    const directory = await mkdtemp(join(tmpdir(), 'worldengine-blender-'));
    try {
      const inputPath = join(directory, 'input.glb'); const outputPath = join(directory, 'refined.glb'); const resultPath = join(directory, 'result.json'); const jobPath = join(directory, 'job.json');
      await writeFile(inputPath, glb);
      await writeFile(jobPath, JSON.stringify({ schemaVersion: '1.0.0', inputPath, outputPath, resultPath, renderDirectory: directory, ...request }));
      const result = await this.runner(this.blenderExecutable, ['--background', '--factory-startup', '--python', this.workerScript, '--', '--job', jobPath], signal);
      if (result.code !== 0) throw new Error(`Blender worker failed: ${result.stderr || result.stdout}`);
      const manifest = z.object({ workerVersion: z.string(), renders: z.array(z.object({ kind: z.enum(['blender-rgb', 'blender-depth', 'blender-normal', 'blender-instance']), path: z.string() })).default([]), diagnostics: z.array(z.object({ severity: z.enum(['info', 'warning', 'error']), code: z.string(), message: z.string() })).default([]) }).parse(JSON.parse(await readFile(resultPath, 'utf8')));
      const refined = new Uint8Array(await readFile(outputPath)); assertValidGlb(refined);
      const renders = await Promise.all(manifest.renders.map(async (render) => ({ kind: render.kind, bytes: new Uint8Array(await readFile(render.path)) })));
      return { glb: refined, renders, diagnostics: manifest.diagnostics, workerVersion: manifest.workerVersion };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export interface StudioWorkerRegistry {
  blender?: BlenderWorkerClient;
}
