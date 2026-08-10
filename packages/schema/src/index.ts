import { z } from 'zod';
import { AuthoringWorldSchema } from './authoring.js';
import { RuntimeChunkDocumentSchema, VisualWorldBundleSchema } from './bundle.js';
import { WorldDesignSpecSchema } from './design.js';
import { CompileArtifactCatalogSchema } from './compiler.js';

export * from './authoring.js';
export * from './bundle.js';
export * from './compiler.js';
export * from './design.js';
export * from './generation.js';
export * from './patch.js';
export * from './primitives.js';
export * from './provenance.js';
export * from './quality.js';

export const jsonSchemas = {
  worldDesignSpec: z.toJSONSchema(WorldDesignSpecSchema, { target: 'draft-7' }),
  authoringWorld: z.toJSONSchema(AuthoringWorldSchema, { target: 'draft-7' }),
  visualWorldBundle: z.toJSONSchema(VisualWorldBundleSchema, { target: 'draft-7' }),
  runtimeChunk: z.toJSONSchema(RuntimeChunkDocumentSchema, { target: 'draft-7' }),
  compileArtifactCatalog: z.toJSONSchema(CompileArtifactCatalogSchema, { target: 'draft-7' }),
} as const;
