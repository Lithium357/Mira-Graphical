// SPDX-License-Identifier: GPL-3.0-only
export type Bounds = { x: number; y: number; width: number; height: number };
export type WindowState = Bounds & { maximized: boolean };
export function restoreBounds(saved: unknown, displays: Bounds[]): Partial<WindowState> {
  if (!displays.length || !saved || typeof saved !== 'object') return {};
  const b = saved as WindowState;
  if (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 300 || b.height < 200)
    return {};
  const overlap = (d: Bounds) =>
    Math.max(0, Math.min(b.x + b.width, d.x + d.width) - Math.max(b.x, d.x)) *
    Math.max(0, Math.min(b.y + b.height, d.y + d.height) - Math.max(b.y, d.y));
  const display = [...displays].sort((a, c) => overlap(c) - overlap(a))[0];
  const width = Math.min(Math.max(900, b.width), display.width),
    height = Math.min(Math.max(600, b.height), display.height);
  return {
    x: Math.min(Math.max(b.x, display.x), display.x + display.width - width),
    y: Math.min(Math.max(b.y, display.y), display.y + display.height - height),
    width,
    height,
    maximized: b.maximized === true,
  };
}
