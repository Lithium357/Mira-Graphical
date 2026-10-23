// SPDX-License-Identifier: GPL-3.0-only
import React, { useRef } from 'react';

/** A keyboard and pointer operated divider. The owner bounds the resulting size. */
export function PaneDivider({
  axis,
  label,
  value,
  min,
  max,
  onChange,
}: {
  axis: 'horizontal' | 'vertical';
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ pointer: number; position: number; value: number } | undefined>(undefined);
  const resize = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  return (
    <div
      className={`pane-divider ${axis}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          pointer: e.pointerId,
          position: axis === 'vertical' ? e.clientX : e.clientY,
          value,
        };
      }}
      onPointerMove={(e) => {
        const start = drag.current;
        if (start?.pointer === e.pointerId)
          resize(start.value + start.position - (axis === 'vertical' ? e.clientX : e.clientY));
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointer === e.pointerId) {
          drag.current = undefined;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onLostPointerCapture={() => {
        drag.current = undefined;
      }}
      onKeyDown={(e) => {
        const decrease = axis === 'vertical' ? 'ArrowRight' : 'ArrowDown';
        const increase = axis === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
        if ([decrease, increase, 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          resize(
            e.key === 'Home'
              ? min
              : e.key === 'End'
                ? max
                : value + (e.key === increase ? 16 : -16),
          );
        }
      }}
    />
  );
}
