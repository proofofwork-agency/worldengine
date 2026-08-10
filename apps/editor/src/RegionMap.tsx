import type { RegionId, WorldDesignSpec } from '@worldengine/schema';

const colors = ['#668d7a', '#769d88', '#3f6c54', '#9a9e6c', '#65777b', '#8b705e', '#6d668f'];

export function RegionMap({ design, selected, onSelect }: { design: WorldDesignSpec; selected: RegionId; onSelect(id: RegionId): void }) {
  const width = design.bounds.max[0] - design.bounds.min[0];
  const height = design.bounds.max[1] - design.bounds.min[1];
  const point = ([x, z]: [number, number]): string => `${((x - design.bounds.min[0]) / width) * 240},${160 - ((z - design.bounds.min[1]) / height) * 160}`;
  return (
    <svg className="region-map" viewBox="0 0 240 160" role="img" aria-label="World region map">
      <defs>
        <linearGradient id="map-sea" x1="0" x2="1"><stop stopColor="#253b42"/><stop offset="1" stopColor="#314a4e"/></linearGradient>
        <filter id="map-shadow"><feDropShadow dx="0" dy="2" stdDeviation="2" floodOpacity=".25"/></filter>
      </defs>
      <rect width="240" height="160" rx="8" fill="url(#map-sea)" />
      {design.regions.map((region, index) => (
        <polygon key={region.id} points={region.polygon.map(point).join(' ')} fill={colors[index % colors.length]} opacity={selected === region.id ? 1 : 0.76}
          stroke={selected === region.id ? '#e5d6a4' : '#b7c4b0'} strokeWidth={selected === region.id ? 2.5 : 0.7} filter="url(#map-shadow)"
          onClick={() => onSelect(region.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(region.id); }} tabIndex={0} aria-label={region.name} />
      ))}
      {design.features.map((feature) => <polyline key={feature.id} points={feature.points.map(point).join(' ')} fill="none" stroke={feature.kind === 'river' ? '#82b6c1' : feature.kind === 'road' ? '#d5c18b' : '#a4c8d1'} strokeWidth={Math.max(1.2, Math.min(4, feature.width / 12))} opacity=".9" />)}
      <g fill="#e8dbaa" stroke="#3c443b" strokeWidth="1">{design.landmarks.map((landmark) => { const [cx, cy] = point([landmark.position[0], landmark.position[2]]).split(','); return <circle key={landmark.id} cx={cx} cy={cy} r="3"/>; })}</g>
    </svg>
  );
}
