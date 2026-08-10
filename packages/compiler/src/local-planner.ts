import { RegionIdSchema, WorldDesignSpecSchema, type CompileRequest, type WorldDesignSpec } from '@worldengine/schema';
import { createReferenceDesignSpec } from '@worldengine/terrain';

interface ThemeProfile {
  title: string;
  match: RegExp;
  names: [string, string, string, string, string];
  biomes: [string, string, string, string, string];
  densities: [number, number, number, number, number];
  elevations: Array<{ min: number; max: number }>;
  assets: string[];
  palette: string[];
}

const themes: ThemeProfile[] = [
  {
    title: 'The Ember Expanse', match: /\b(desert|dune|oasis|arid|sand)\b/i,
    names: ['Western Dunes', 'Salt Basin', 'Acacia Wadi', 'Caravan Plain', 'Sunstone Mesa'],
    biomes: ['dunes', 'salt-flat', 'arid-scrub', 'desert-settlement', 'mesa'], densities: [0.12, 0.08, 0.34, 0.32, 0.14],
    elevations: [{ min: -4, max: 34 }, { min: -12, max: 8 }, { min: 0, max: 48 }, { min: 2, max: 28 }, { min: 40, max: 170 }],
    assets: ['acacia', 'cactus', 'dry-shrub', 'sandstone-boulder', 'ruin-column', 'tent', 'market-stall', 'well', 'watchtower', 'bridge', 'lantern', 'date-palm', 'caravan-cart', 'archway', 'windmill', 'wildflower', 'reed', 'dock', 'boat', 'standing-stone'],
    palette: ['#caa66b', '#8f6542', '#e0c888', '#5e6b52'],
  },
  {
    title: 'The Frostbound Reach', match: /\b(arctic|snow|frozen|ice|tundra|winter)\b/i,
    names: ['Ice Coast', 'Frozen Basin', 'Pine Wilds', 'Sheltered Vale', 'Eastern Peaks'],
    biomes: ['ice-coast', 'frozen-wetland', 'boreal-forest', 'snow-settlement', 'alpine'], densities: [0.18, 0.24, 0.72, 0.38, 0.16],
    elevations: [{ min: -12, max: 26 }, { min: -8, max: 16 }, { min: 6, max: 94 }, { min: 0, max: 38 }, { min: 44, max: 190 }],
    assets: ['spruce', 'pine', 'dead-tree', 'ice-boulder', 'standing-stone', 'ruin-column', 'cabin', 'watchtower', 'bridge', 'lantern', 'sled', 'frozen-reed', 'snow-shrub', 'fir', 'market-stall', 'windmill', 'dock', 'boat', 'archway', 'wildflower'],
    palette: ['#d9e8ea', '#78919a', '#3f5b50', '#b9c7bd'],
  },
  {
    title: 'The Cinder Vale', match: /\b(volcanic|lava|ash|obsidian|magma)\b/i,
    names: ['Black Shore', 'Ash Caldera', 'Charred Grove', 'Cinder Plain', 'Obsidian Ridge'],
    biomes: ['volcanic-coast', 'caldera', 'burnt-forest', 'ashland', 'volcanic-highland'], densities: [0.16, 0.08, 0.46, 0.2, 0.12],
    elevations: [{ min: -18, max: 32 }, { min: -22, max: 18 }, { min: 8, max: 92 }, { min: 0, max: 46 }, { min: 52, max: 210 }],
    assets: ['obsidian-boulder', 'basalt-column', 'dead-tree', 'ash-shrub', 'ruin-wall', 'ruin-column', 'watchtower', 'bridge', 'lantern', 'cottage', 'standing-stone', 'market-stall', 'archway', 'charred-pine', 'sulfur-vent', 'dock', 'boat', 'windmill', 'wildflower', 'fern'],
    palette: ['#201f22', '#5f4038', '#b34c2f', '#85786f'],
  },
  {
    title: 'The Aster Vale', match: /.*/,
    names: ['Western Coast', 'River Wetlands', 'Old Forest', 'Settled Plain', 'Eastern Highlands'],
    biomes: ['coastal', 'wetland', 'temperate-forest', 'grassland', 'highland'], densities: [0.32, 0.7, 0.88, 0.48, 0.25],
    elevations: [{ min: -15, max: 28 }, { min: -8, max: 18 }, { min: 8, max: 90 }, { min: 0, max: 42 }, { min: 35, max: 150 }],
    assets: ['oak', 'pine', 'birch', 'willow', 'boulder', 'standing-stone', 'ruin-column', 'ruin-wall', 'cottage', 'watchtower', 'dock', 'boat', 'reed', 'wildflower', 'fern', 'mushroom', 'market-stall', 'lantern', 'bridge', 'windmill'],
    palette: ['#9bb174', '#496b4b', '#7d8d92', '#c5a870'],
  },
];

function promptMentions(prompt: string, expression: RegExp): boolean { return expression.test(prompt); }

export function planLocalWorldDesign(request: CompileRequest): WorldDesignSpec {
  if (request.designSpec) return WorldDesignSpecSchema.parse(request.designSpec);
  const base = createReferenceDesignSpec(request.seed);
  const theme = themes.find((candidate) => candidate.match.test(request.prompt)) ?? themes[themes.length - 1]!;
  const ids = theme.names.map((name, index) => RegionIdSchema.parse(`region-${index + 1}-${name.toLowerCase().replace(/[^a-z\d]+/g, '-').replace(/(^-|-$)/g, '')}`));
  const adjacency = [[1, 2], [0, 2, 3], [0, 1, 4], [1, 4], [2, 3]];
  const regions = base.regions.map((region, index) => ({
    ...region,
    id: ids[index]!,
    name: theme.names[index]!,
    biome: theme.biomes[index]!,
    density: theme.densities[index]!,
    elevation: theme.elevations[index]!,
    adjacentTo: adjacency[index]!.map((target) => ids[target]!),
    description: `${theme.names[index]} visual region derived from the prompt theme.`,
  }));
  const lower = request.prompt.toLowerCase();
  const weather: WorldDesignSpec['environment']['weather'] = promptMentions(lower, /\brain(y|ing)?\b|\bstorm\b/) ? 'rain'
    : promptMentions(lower, /\bsnow(y|ing)?\b|\bblizzard\b/) ? 'snow'
      : promptMentions(lower, /\bfog(gy)?\b|\bmist(y)?\b/) ? 'fog'
        : promptMentions(lower, /\bcloud(y|s)?\b|\bovercast\b/) ? 'cloudy' : 'clear';
  const timeOfDay = promptMentions(lower, /\bnight\b|\bmidnight\b/) ? 23
    : promptMentions(lower, /\bdawn\b|\bsunrise\b/) ? 6.5
      : promptMentions(lower, /\bdusk\b|\bsunset\b/) ? 19.5
        : promptMentions(lower, /\bnoon\b|\bmidday\b/) ? 12 : 16.5;
  const rendering = promptMentions(lower, /\bunlit\b/) ? 'unlit' : promptMentions(lower, /\bhybrid\b/) ? 'hybrid' : 'pbr';
  const styleDescription = promptMentions(lower, /\bstylized\b|\bcartoon\b|\blow[- ]poly\b/) ? 'Stylized PBR with bold readable silhouettes'
    : promptMentions(lower, /\bphotoreal|\brealistic\b/) ? 'Realistic natural PBR materials and physically grounded lighting'
      : 'Style-neutral natural PBR materials with readable silhouettes';
  const features = base.features.filter((feature) => {
    if (feature.kind === 'river') return promptMentions(lower, /\briver\b|\bstream\b|\bwetland\b|\bwadi\b/);
    if (feature.kind === 'road') return promptMentions(lower, /\broad\b|\bpath\b|\bsettled\b|\bsettlement\b|\bvillage\b|\bcity\b|\bcaravan\b/);
    return promptMentions(lower, /\bcoast\b|\bcoastal\b|\bocean\b|\bshore\b|\bisland\b/);
  });
  const defaultsApplied = [
    '4 km square bounds centered on the origin',
    '256 m signed chunk grid and 257 canonical terrain samples',
    'five-region vector topology because no structured designSpec was supplied',
  ];
  if (!promptMentions(lower, /\bnight\b|\bmidnight\b|\bdawn\b|\bsunrise\b|\bdusk\b|\bsunset\b|\bnoon\b|\bmidday\b/)) defaultsApplied.push('late-afternoon time of day');
  if (!promptMentions(lower, /\brain|\bstorm\b|\bsnow|\bblizzard\b|\bfog|\bmist|\bcloud|\bovercast\b/)) defaultsApplied.push('clear weather');
  return WorldDesignSpecSchema.parse({
    ...base,
    id: `design-${request.seed}-${theme.title.toLowerCase().replace(/[^a-z\d]+/g, '-')}`,
    prompt: request.prompt,
    title: theme.title,
    style: { ...base.style, description: styleDescription, rendering, palette: theme.palette },
    environment: { ...base.environment, timeOfDay, weather },
    regions,
    features,
    landmarks: [],
    assetRequirements: theme.assets.map((assetClass) => ({ class: assetClass, count: 1, sourcePreference: ['library', 'cache', 'generate'], tags: [theme.biomes[0]!] })),
    defaultsApplied,
  });
}
