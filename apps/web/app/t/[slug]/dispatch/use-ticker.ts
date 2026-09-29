'use client';

import { useEffect, useState } from 'react';

/**
 * The time now, updated every `ms` while `active`: the progress line of a running search ("6 min so
 * far") ticks on the screen between the (slower) reloads of a long THOROUGH search.
 */
export function useTicker(active: boolean, ms = 5_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
