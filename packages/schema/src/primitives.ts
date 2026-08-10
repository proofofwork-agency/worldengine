import { z } from 'zod';

export const WORLD_FORMAT_VERSION = '1.1.0' as const;
export const LEGACY_WORLD_FORMAT_VERSIONS = ['1.0.0'] as const;

export function migrateWorldFormatDocument(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const document = input as Record<string, unknown>;
  const knownFormat = ['WorldDesignSpec', 'AuthoringWorld', 'VisualWorldBundle', 'RuntimeChunk'].includes(String(document['format']));
  if (!knownFormat || !LEGACY_WORLD_FORMAT_VERSIONS.includes(document['version'] as '1.0.0')) return input;
  return { ...document, version: WORLD_FORMAT_VERSION };
}

export const EntityIdSchema = z.string().min(1).max(160).brand<'EntityId'>();
export const PrototypeIdSchema = z.string().min(1).max(160).brand<'PrototypeId'>();
export const ChunkIdSchema = z.string().regex(/^-?\d+:-?\d+$/).brand<'ChunkId'>();
export const RegionIdSchema = z.string().min(1).max(160).brand<'RegionId'>();
export const PatchIdSchema = z.string().min(1).max(160).brand<'PatchId'>();

export type EntityId = z.infer<typeof EntityIdSchema>;
export type PrototypeId = z.infer<typeof PrototypeIdSchema>;
export type ChunkId = z.infer<typeof ChunkIdSchema>;
export type RegionId = z.infer<typeof RegionIdSchema>;
export type PatchId = z.infer<typeof PatchIdSchema>;

export const Vec2Schema = z.tuple([z.number(), z.number()]);
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const QuaternionSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const Mat4Schema = z.tuple([
  z.number(), z.number(), z.number(), z.number(),
  z.number(), z.number(), z.number(), z.number(),
  z.number(), z.number(), z.number(), z.number(),
  z.number(), z.number(), z.number(), z.number(),
]);

export type Vec2 = z.infer<typeof Vec2Schema>;
export type Vec3 = z.infer<typeof Vec3Schema>;
export type Quaternion = z.infer<typeof QuaternionSchema>;
export type Mat4 = z.infer<typeof Mat4Schema>;

export const TransformSchema = z.object({
  position: Vec3Schema.default([0, 0, 0]),
  rotation: QuaternionSchema.default([0, 0, 0, 1]),
  scale: Vec3Schema.default([1, 1, 1]),
});
export type Transform = z.infer<typeof TransformSchema>;

export const Bounds2Schema = z.object({
  min: Vec2Schema,
  max: Vec2Schema,
}).superRefine(({ min, max }, context) => {
  if (min[0] >= max[0] || min[1] >= max[1]) {
    context.addIssue({ code: 'custom', message: 'Bounds min must be below max on both axes' });
  }
});
export type Bounds2 = z.infer<typeof Bounds2Schema>;

export const ChunkCoordinateSchema = z.object({
  x: z.number().int(),
  z: z.number().int(),
});
export type ChunkCoordinate = z.infer<typeof ChunkCoordinateSchema>;

export function chunkId(x: number, z: number): ChunkId {
  return ChunkIdSchema.parse(`${x}:${z}`);
}

export function parseChunkId(id: ChunkId): ChunkCoordinate {
  const [x, zValue] = id.split(':').map(Number);
  return ChunkCoordinateSchema.parse({ x, z: zValue });
}
