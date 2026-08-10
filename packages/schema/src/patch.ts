import { z } from 'zod';
import { ChunkIdSchema, EntityIdSchema, PatchIdSchema, TransformSchema } from './primitives.js';
import { AuthoringEntitySchema, PrototypeSchema } from './authoring.js';
import { ProvenanceRecordSchema } from './provenance.js';
import { RegionSpecSchema } from './design.js';

export const VisualStatePatchSchema = z.object({
  visible: z.boolean().optional(),
  materialVariant: z.string().optional(),
  animationClip: z.string().optional(),
  animationTime: z.number().nonnegative().optional(),
  damage: z.number().min(0).max(1).optional(),
  teamColor: z.string().optional(),
}).catchall(z.unknown());
export type VisualStatePatch = z.infer<typeof VisualStatePatchSchema>;

export const WorldPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set-transform'), entityId: EntityIdSchema, transform: TransformSchema }),
  z.object({ op: z.literal('set-visual-state'), entityId: EntityIdSchema, state: VisualStatePatchSchema }),
  z.object({ op: z.literal('add-entity'), entity: AuthoringEntitySchema }),
  z.object({ op: z.literal('remove-entity'), entityId: EntityIdSchema }),
  z.object({ op: z.literal('replace-prototype'), prototype: PrototypeSchema, provenance: ProvenanceRecordSchema, sourceProvenance: z.array(ProvenanceRecordSchema).default([]), lodProvenance: z.array(ProvenanceRecordSchema).default([]) }),
  z.object({ op: z.literal('set-environment'), values: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('add-terrain-edit'), center: z.tuple([z.number(), z.number()]), radius: z.number().positive(), delta: z.number() }),
  z.object({ op: z.literal('set-region-density'), regionId: z.string().min(1), density: z.number().min(0).max(1) }),
  z.object({ op: z.literal('replace-region'), region: RegionSpecSchema }),
  z.object({ op: z.literal('invalidate-chunk'), chunkId: ChunkIdSchema }),
]);

export const WorldPatchSchema = z.object({
  id: PatchIdSchema,
  worldId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  author: z.string().min(1),
  operations: z.array(WorldPatchOperationSchema).min(1),
});
export type WorldPatchOperation = z.infer<typeof WorldPatchOperationSchema>;
export type WorldPatch = z.infer<typeof WorldPatchSchema>;

export class PatchConflictError extends Error {
  constructor(public readonly expectedRevision: number, public readonly actualRevision: number) {
    super(`Patch expected revision ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = 'PatchConflictError';
  }
}
