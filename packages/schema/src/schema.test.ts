import { describe, expect, it } from 'vitest';
import { AuthoringWorldSchema, EntityIdSchema, PatchIdSchema, VisualWorldBundleSchema, WorldDesignSpecSchema, jsonSchemas } from './index.js';

describe('canonical schemas', () => {
  it('exposes JSON Schema for all canonical formats', () => {
    expect(jsonSchemas.worldDesignSpec).toMatchObject({ type: 'object' });
    expect(jsonSchemas.authoringWorld).toMatchObject({ type: 'object' });
    expect(jsonSchemas.visualWorldBundle).toMatchObject({ type: 'object' });
  });

  it('rejects malformed bounds and chunk identifiers', () => {
    expect(() => WorldDesignSpecSchema.parse({ format: 'WorldDesignSpec', version: '1.0.0', bounds: { min: [5, 5], max: [0, 0] } })).toThrow();
    expect(() => VisualWorldBundleSchema.parse({ format: 'VisualWorldBundle', version: '1.0.0', chunks: [{ id: 'bad' }] })).toThrow();
  });

  it('preserves branded stable IDs through patch operations', () => {
    expect(EntityIdSchema.parse('settlement:windmill:001')).toBe('settlement:windmill:001');
    expect(PatchIdSchema.parse('editor-patch-0001')).toBe('editor-patch-0001');
  });

  it('requires complete provenance in authoring worlds', () => {
    expect(() => AuthoringWorldSchema.parse({ format: 'AuthoringWorld', version: '1.0.0', provenance: [] })).toThrow();
  });
});
