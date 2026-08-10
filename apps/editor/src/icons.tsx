import type { ReactNode } from 'react';

export function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}

export const icons = {
  select: <><path d="m5 3 14 8-6 2-2 6z"/><path d="m13 13 5 5"/></>,
  move: <><path d="M12 2v20M2 12h20"/><path d="m8 6 4-4 4 4M18 8l4 4-4 4M8 18l4 4 4-4M6 8l-4 4 4 4"/></>,
  rotate: <><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></>,
  scale: <><path d="M4 14v6h6M20 10V4h-6"/><path d="m14 10 6-6M4 20l6-6"/></>,
  terrain: <><path d="m3 18 6-7 4 4 3-3 5 6"/><path d="M3 21h18"/></>,
  region: <><path d="m5 4 6-2 8 4 2 9-6 7-10-3-2-8z"/><path d="m11 2 1 7 9 6M3 11l9-2 3 13"/></>,
  play: <path d="m8 5 11 7-11 7z"/>,
  cube: <><path d="m12 2 9 5-9 5-9-5z"/><path d="m3 7 9 5v10M21 7l-9 5"/></>,
  layers: <><path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></>,
};
