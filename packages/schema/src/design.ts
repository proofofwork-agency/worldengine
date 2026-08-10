import { z } from 'zod';
import { Bounds2Schema, RegionIdSchema, Vec2Schema, Vec3Schema, WORLD_FORMAT_VERSION } from './primitives.js';

export const VisualStyleSchema = z.object({
  description: z.string().min(1),
  rendering: z.enum(['pbr', 'unlit', 'hybrid']).default('pbr'),
  palette: z.array(z.string()).default([]),
  references: z.array(z.string().url()).default([]),
});

export const EnvironmentIntentSchema = z.object({
  timeOfDay: z.number().min(0).max(24).default(12),
  latitude: z.number().min(-90).max(90).default(52),
  weather: z.enum(['clear', 'cloudy', 'rain', 'snow', 'fog']).default('clear'),
  waterLevel: z.number().nullable().default(null),
  fogDensity: z.number().min(0).max(1).default(0.002),
  wind: Vec3Schema.default([1, 0, 0]),
});

export const RegionSpecSchema = z.object({
  id: RegionIdSchema,
  name: z.string().min(1),
  description: z.string().default(''),
  polygon: z.array(Vec2Schema).min(3),
  adjacentTo: z.array(RegionIdSchema).default([]),
  biome: z.string().min(1),
  elevation: z.object({ min: z.number(), max: z.number() }),
  density: z.number().min(0).max(1).default(0.5),
});
export type RegionSpec = z.infer<typeof RegionSpecSchema>;

export const WorldFeatureSpecSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['road', 'river', 'coastline']),
  points: z.array(Vec2Schema).min(2),
  width: z.number().positive(),
  depth: z.number().nonnegative().default(0),
  tags: z.array(z.string()).default([]),
});
export type WorldFeatureSpec = z.infer<typeof WorldFeatureSpecSchema>;

export const AssetRequirementSchema = z.object({
  class: z.string().min(1),
  count: z.number().int().nonnegative(),
  sourcePreference: z.array(z.enum(['library', 'cache', 'generate'])).min(1),
  tags: z.array(z.string()).default([]),
});

export const WorldDesignSpecSchema = z.object({
  format: z.literal('WorldDesignSpec'),
  version: z.literal(WORLD_FORMAT_VERSION),
  id: z.string().min(1),
  seed: z.number().int().nonnegative(),
  prompt: z.string(),
  title: z.string().min(1),
  units: z.literal('meters'),
  coordinateSystem: z.literal('right-handed-y-up'),
  bounds: Bounds2Schema,
  chunkSize: z.number().positive().default(256),
  terrainSamples: z.number().int().min(3).default(257),
  style: VisualStyleSchema,
  environment: EnvironmentIntentSchema,
  regions: z.array(RegionSpecSchema).min(1),
  features: z.array(WorldFeatureSpecSchema).default([]),
  landmarks: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: Vec3Schema,
    description: z.string().default(''),
  })).default([]),
  assetRequirements: z.array(AssetRequirementSchema).default([]),
  constraints: z.array(z.string()).default([]),
  defaultsApplied: z.array(z.string()).default([]),
});

export type WorldDesignSpec = z.infer<typeof WorldDesignSpecSchema>;
