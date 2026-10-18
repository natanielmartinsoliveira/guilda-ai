import type { Point } from './layout';
export type CameraMode = 'follow' | 'overview' | 'manual';
export interface Focus {
  x: number;
  y: number;
  zoom: number;
}
export function cameraFocus(
  points: Point[],
  view: { width: number; height: number },
  world: { width: number; height: number },
  opts: { padding?: number; minZoom?: number; maxZoom?: number } = {},
): Focus {
  const minZoom = opts.minZoom ?? Math.min(view.width / world.width, view.height / world.height);
  const maxZoom = Math.max(minZoom, opts.maxZoom ?? 2.5),
    padding = opts.padding ?? 120;
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const x0 = Math.min(...xs),
    x1 = Math.max(...xs),
    y0 = Math.min(...ys),
    y1 = Math.max(...ys);
  const zoom = points.length
    ? Math.max(
        minZoom,
        Math.min(
          maxZoom,
          view.width / (x1 - x0 + 2 * padding),
          view.height / (y1 - y0 + 2 * padding),
        ),
      )
    : minZoom;
  const limit = (value: number, size: number, visible: number) =>
    visible >= size ? size / 2 : Math.max(visible / 2, Math.min(size - visible / 2, value));
  return {
    x: limit(points.length ? (x0 + x1) / 2 : world.width / 2, world.width, view.width / zoom),
    y: limit(points.length ? (y0 + y1) / 2 : world.height / 2, world.height, view.height / zoom),
    zoom,
  };
}
