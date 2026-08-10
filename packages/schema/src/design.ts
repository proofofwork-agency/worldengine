import { z } from 'zod';
import { Bounds2Schema, Mat4Schema, RegionIdSchema, Vec2Schema, Vec3Schema, WORLD_FORMAT_VERSION } from './primitives.js';

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

export const CalibratedRegionalCameraSchema = z.object({
  id: z.string().min(1),
  regionId: RegionIdSchema,
  position: Vec3Schema,
  target: Vec3Schema,
  up: Vec3Schema.default([0, 1, 0]),
  verticalFovDegrees: z.number().positive().max(179),
  aspect: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  intrinsics: z.object({ fx: z.number().positive(), fy: z.number().positive(), cx: z.number(), cy: z.number() }),
  worldToCamera: Mat4Schema,
});
export type CalibratedRegionalCamera = z.infer<typeof CalibratedRegionalCameraSchema>;

export const TerrainLandformOperatorSchema = z.object({
  kind: z.enum(['ridge', 'peak', 'dune', 'terrace', 'erosion', 'riverbed', 'plateau']),
  strength: z.number().min(-2).max(2).default(0.5),
  scaleMeters: z.number().positive().default(600),
  octaves: z.number().int().min(1).max(8).default(4),
  offset: Vec2Schema.default([0, 0]),
  terraceSteps: z.number().int().min(2).max(64).optional(),
});
export type TerrainLandformOperator = z.infer<typeof TerrainLandformOperatorSchema>;

export const TerrainMaterialSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  biome: z.string().min(1),
  baseColorUri: z.string().min(1),
  normalUri: z.string().min(1),
  roughnessUri: z.string().min(1),
  macroVariationUri: z.string().min(1),
  metersPerTile: z.number().positive().default(4),
});
export type TerrainMaterialSet = z.infer<typeof TerrainMaterialSetSchema>;

export const TerrainScatterRecipeSchema = z.object({
  id: z.string().min(1),
  regionId: RegionIdSchema,
  prototypeClasses: z.array(z.string().min(1)).min(1),
  densityPerSquareKm: z.number().nonnegative(),
  slopeDegrees: z.object({ min: z.number().min(0).max(90).default(0), max: z.number().min(0).max(90).default(45) }),
  waterDistanceMeters: z.object({ min: z.number().nonnegative().default(0), max: z.number().nonnegative().default(10_000) }),
  roadDistanceMeters: z.object({ min: z.number().nonnegative().default(0), max: z.number().nonnegative().default(10_000) }),
  scaleRange: z.tuple([z.number().positive(), z.number().positive()]).default([0.8, 1.2]),
  yawJitterDegrees: z.number().min(0).max(180).default(180),
}).superRefine((recipe, context) => {
  if (recipe.slopeDegrees.min > recipe.slopeDegrees.max) context.addIssue({ code: 'custom', path: ['slopeDegrees'], message: 'Slope minimum must not exceed maximum' });
  if (recipe.waterDistanceMeters.min > recipe.waterDistanceMeters.max) context.addIssue({ code: 'custom', path: ['waterDistanceMeters'], message: 'Water-distance minimum must not exceed maximum' });
  if (recipe.roadDistanceMeters.min > recipe.roadDistanceMeters.max) context.addIssue({ code: 'custom', path: ['roadDistanceMeters'], message: 'Road-distance minimum must not exceed maximum' });
  if (recipe.scaleRange[0] > recipe.scaleRange[1]) context.addIssue({ code: 'custom', path: ['scaleRange'], message: 'Scale minimum must not exceed maximum' });
});
export type TerrainScatterRecipe = z.infer<typeof TerrainScatterRecipeSchema>;

export const TerrainPlanSchema = z.object({
  schemaVersion: z.literal('1.0.0').default('1.0.0'),
  maskBlendMeters: z.number().positive().default(180),
  regions: z.array(z.object({
    regionId: RegionIdSchema,
    operators: z.array(TerrainLandformOperatorSchema).min(1),
    materialSetIds: z.array(z.string().min(1)).min(1),
  })).default([]),
  materialSets: z.array(TerrainMaterialSetSchema).default([]),
  scatterRecipes: z.array(TerrainScatterRecipeSchema).default([]),
  featureIds: z.array(z.string().min(1)).default([]),
  referenceCameras: z.array(CalibratedRegionalCameraSchema).default([]),
});
export type TerrainPlan = z.infer<typeof TerrainPlanSchema>;

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
  terrainPlan: TerrainPlanSchema.default({ schemaVersion: '1.0.0', maskBlendMeters: 180, regions: [], materialSets: [], scatterRecipes: [], featureIds: [], referenceCameras: [] }),
});

export type WorldDesignSpec = z.infer<typeof WorldDesignSpecSchema>;
