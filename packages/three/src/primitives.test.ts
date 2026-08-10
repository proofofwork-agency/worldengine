import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createReferenceDesignSpec } from '@worldengine/terrain';
import { createPrimitiveVisual } from './primitives.js';

const additionalThemeAssets = [
  'acacia', 'cactus', 'dry-shrub', 'sandstone-boulder', 'tent', 'well', 'date-palm', 'caravan-cart', 'archway',
  'spruce', 'dead-tree', 'ice-boulder', 'cabin', 'sled', 'frozen-reed', 'snow-shrub', 'fir',
  'obsidian-boulder', 'basalt-column', 'ash-shrub', 'charred-pine', 'sulfur-vent',
];

describe('procedural PBR conformance assets', () => {
  it('provides detailed grounded geometry for every reference and themed asset class', () => {
    const canonical = createReferenceDesignSpec().assetRequirements.map((requirement) => requirement.class);
    for (const assetClass of new Set([...canonical, ...additionalThemeAssets])) {
      const visual = createPrimitiveVisual(`primitive://${assetClass}`);
      const positions = visual.geometry.getAttribute('position');
      expect(positions?.count, assetClass).toBeGreaterThan(50);
      expect(visual.geometry.boundingBox?.min.y, assetClass).toBeCloseTo(0, 5);
      expect(visual.geometry.getAttribute('color'), assetClass).toBeTruthy();
      const material = (Array.isArray(visual.material) ? visual.material[0] : visual.material) as THREE.MeshStandardMaterial;
      expect(material.map, assetClass).toBeTruthy();
      expect(material.roughnessMap, assetClass).toBeTruthy();
      expect(material.normalMap, assetClass).toBeTruthy();
      expect(visual.ownedTextures, assetClass).toHaveLength(3);
      visual.geometry.dispose();
      visual.ownedTextures?.forEach((texture) => texture.dispose());
      (Array.isArray(visual.material) ? visual.material : [visual.material]).forEach((material) => material.dispose());
    }
  });
});
