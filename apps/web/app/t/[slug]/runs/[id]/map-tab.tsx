'use client';

// MapLibre styles must be loaded as a static side-effect import — dynamic
// `await import('maplibre-gl/dist/maplibre-gl.css')` inside the effect doesn't
// reliably inject the stylesheet under Next.js's RSC payload + bundler split,
// which leaves canvas-container at position:static and tiles never render.
import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Lock, MapPinOff, MoreVertical, Move, Unlock, Eye, EyeOff, Locate } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface MapStop {
  assignmentId: string;
  truckId: string;
  truckCode: string;
  sequence: number;
  lat: number | null;
  lng: number | null;
  customerCode: string;
  customerName: string;
  branchKey: string;
  cases: number;
  arrivalMin: number;
  locked: boolean;
}

export interface MapUnserved {
  orderId: string;
  lat: number | null;
  lng: number | null;
  customerCode: string;
  customerName: string;
  reason: string;
  cases: number;
}

export interface MapTruck {
  id: string;
  code: string;
  capacityCases: number;
  currentLoad: number;
}

interface Props {
  runId: string;
  canEdit: boolean;
  mapboxToken: string;
  depot: { code: string; lat: number; lng: number };
  stops: MapStop[];
  trucks: MapTruck[];
  unserved: MapUnserved[];
}

// 12 visually-distinct colors for truck routes.
const TRUCK_COLORS = [
  '#2563EB', '#DC2626', '#16A34A', '#D97706', '#7C3AED', '#0891B2',
  '#DB2777', '#65A30D', '#475569', '#9333EA', '#0EA5E9', '#EA580C',
];

export function MapTab({ runId, canEdit, mapboxToken, depot, stops, trucks, unserved }: Props) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<unknown>(null);
  const markersRef = useRef<unknown[]>([]);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [showLabels, setShowLabels] = useState<'numbers' | 'names' | 'none'>('numbers');
  const [hiddenTrucks, setHiddenTrucks] = useState<Set<string>>(new Set());
  const [contextStop, setContextStop] = useState<MapStop | null>(null);
  const [confirmUnassign, setConfirmUnassign] = useState<MapStop | null>(null);
  const [moveDialog, setMoveDialog] = useState<MapStop | null>(null);
  const [pending, startTransition] = useTransition();

  const truckColor = useMemo(() => {
    const map = new Map<string, string>();
    trucks.forEach((t, idx) => map.set(t.id, TRUCK_COLORS[idx % TRUCK_COLORS.length]));
    return map;
  }, [trucks]);

  // Initialize map once. Uses MapLibre + OSM tiles by default (no token needed);
  // upgrades to Mapbox vector tiles when NEXT_PUBLIC_MAPBOX_TOKEN is set.
  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const mb = await import('maplibre-gl');
        const { defaultMapStyle } = await import('@/lib/maps');
        if (cancelled || !containerRef.current) return;
        const style = defaultMapStyle(mapboxToken);
        const map = new mb.Map({
          container: containerRef.current,
          style: style as never,
          center: [depot.lng, depot.lat],
          zoom: 10,
        });
        mapRef.current = map;
        map.on('load', () => setMapReady(true));
      } catch (err) {
        setMapError((err as Error).message ?? 'Failed to load map.');
      }
    })();
    return () => {
      cancelled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = mapRef.current as any;
      if (m?.remove) m.remove();
      mapRef.current = null;
    };
  }, [mapboxToken, depot.lat, depot.lng]);

  // Re-render markers + routes whenever data changes.
  useEffect(() => {
    if (!mapReady) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mapRef.current as any;
    if (!map) return;

    // Clear prior markers.
    for (const m of markersRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (m as any).remove?.();
    }
    markersRef.current = [];

    // Remove prior route layers/sources.
    for (const t of trucks) {
      const id = `route-${t.id}`;
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }

    (async () => {
      const mb = await import('maplibre-gl');

      // Depot marker (large + brand color).
      const depotEl = document.createElement('div');
      depotEl.style.cssText =
        'width:28px;height:28px;border-radius:50%;background:#0F172A;color:#fff;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,0.3)';
      depotEl.textContent = 'D';
      const depotMarker = new mb.Marker({ element: depotEl })
        .setLngLat([depot.lng, depot.lat])
        .setPopup(new mb.Popup().setText(`Depot ${depot.code}`))
        .addTo(map);
      markersRef.current.push(depotMarker);

      // Group stops by truck for polylines.
      const groupedByTruck = new Map<string, MapStop[]>();
      for (const s of stops) {
        if (hiddenTrucks.has(s.truckId)) continue;
        if (s.lat === null || s.lng === null) continue;
        const list = groupedByTruck.get(s.truckId) ?? [];
        list.push(s);
        groupedByTruck.set(s.truckId, list);
      }

      // Sort each truck's stops by sequence.
      for (const list of groupedByTruck.values()) {
        list.sort((a, b) => a.sequence - b.sequence);
      }

      // Render polylines per truck (depot → stops → depot).
      for (const [truckId, list] of groupedByTruck) {
        const color = truckColor.get(truckId) ?? '#2563EB';
        const coords: [number, number][] = [[depot.lng, depot.lat]];
        for (const s of list) coords.push([s.lng as number, s.lat as number]);
        coords.push([depot.lng, depot.lat]);
        const sourceId = `route-${truckId}`;
        map.addSource(sourceId, {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: coords },
          },
        });
        map.addLayer({
          id: sourceId,
          type: 'line',
          source: sourceId,
          paint: {
            'line-color': color,
            'line-width': 3,
            'line-opacity': 0.75,
          },
        });

        // Stop markers (numbered circles colored by truck).
        for (const s of list) {
          const el = document.createElement('div');
          const label = showLabels === 'numbers' ? String(s.sequence) : showLabels === 'names' ? s.customerCode.slice(0, 4) : '';
          el.style.cssText = `width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.3);cursor:pointer`;
          if (s.locked) el.style.boxShadow = '0 0 0 2px #fbbf24, 0 1px 3px rgba(0,0,0,0.3)';
          el.textContent = label;
          el.title = `${s.customerCode} ${s.customerName} (truck ${s.truckCode}, seq ${s.sequence}${s.locked ? ', locked' : ''})`;
          if (canEdit) el.onclick = () => setContextStop(s);
          const m = new mb.Marker({ element: el }).setLngLat([s.lng as number, s.lat as number]).addTo(map);
          markersRef.current.push(m);
        }
      }

      // Unserved markers — gray X.
      for (const u of unserved) {
        if (u.lat === null || u.lng === null) continue;
        const el = document.createElement('div');
        el.style.cssText =
          'width:22px;height:22px;border-radius:50%;background:#94A3B8;color:#fff;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;border:2px solid #fff';
        el.textContent = '×';
        el.title = `Unserved: ${u.customerCode} ${u.customerName} — ${u.reason}`;
        const m = new mb.Marker({ element: el }).setLngLat([u.lng, u.lat]).addTo(map);
        markersRef.current.push(m);
      }
    })();
  }, [mapReady, stops, unserved, hiddenTrucks, truckColor, depot, trucks, showLabels, canEdit]);

  function resetZoom() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = mapRef.current as any;
    if (!map) return;
    const allCoords: [number, number][] = [[depot.lng, depot.lat]];
    for (const s of stops) {
      if (s.lat !== null && s.lng !== null) allCoords.push([s.lng, s.lat]);
    }
    if (allCoords.length < 2) return;
    const lats = allCoords.map((c) => c[1]);
    const lngs = allCoords.map((c) => c[0]);
    map.fitBounds(
      [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      { padding: 60, duration: 600 },
    );
  }

  function toggleTruck(truckId: string) {
    setHiddenTrucks((prev) => {
      const next = new Set(prev);
      if (next.has(truckId)) next.delete(truckId);
      else next.add(truckId);
      return next;
    });
  }

  async function applyMove(target: { truckId: string; insertionMode: 'after' | 'end' | 'auto'; insertAfterAssignmentId?: string | null }) {
    if (!moveDialog) return;
    startTransition(async () => {
      const res = await fetch(`/api/runs/${runId}/routes/${moveDialog.assignmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'move', ...target }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Move failed.');
        return;
      }
      toast.success(
        `Moved ${moveDialog.customerCode} to truck ${trucks.find((t) => t.id === target.truckId)?.code ?? target.truckId}.`,
      );
      setMoveDialog(null);
      setContextStop(null);
      router.refresh();
    });
  }

  async function applyLock(lock: boolean) {
    if (!contextStop) return;
    startTransition(async () => {
      const res = await fetch(`/api/runs/${runId}/routes/${contextStop.assignmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: lock ? 'lock' : 'unlock' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Lock failed.');
        return;
      }
      toast.success(lock ? `${contextStop.customerCode} locked.` : `${contextStop.customerCode} unlocked.`);
      setContextStop(null);
      router.refresh();
    });
  }

  async function applyUnassign() {
    if (!confirmUnassign) return;
    startTransition(async () => {
      const res = await fetch(`/api/runs/${runId}/routes/${confirmUnassign.assignmentId}`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Unassign failed.');
        return;
      }
      toast.success(`${confirmUnassign.customerCode} unassigned.`);
      setConfirmUnassign(null);
      setContextStop(null);
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
      {/* Controls */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="text-base">Map controls</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Show on stops</Label>
            <Select value={showLabels} onValueChange={(v) => setShowLabels(v as typeof showLabels)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="numbers">Sequence numbers</SelectItem>
                <SelectItem value="names">Customer codes</SelectItem>
                <SelectItem value="none">Nothing</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Trucks ({trucks.length})</Label>
            <div className="max-h-72 space-y-1 overflow-y-auto pe-1">
              {trucks.map((t) => {
                const color = truckColor.get(t.id) ?? '#2563EB';
                const hidden = hiddenTrucks.has(t.id);
                return (
                  <label key={t.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/40">
                    <Checkbox checked={!hidden} onCheckedChange={() => toggleTruck(t.id)} />
                    <span
                      className="h-3 w-3 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-mono text-xs">{t.code}</span>
                    <span className="ms-auto text-xs text-muted-foreground">
                      {t.currentLoad}/{t.capacityCases}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <Button variant="outline" size="sm" className="w-full" onClick={resetZoom}>
            <Locate className="me-2 h-4 w-4" />
            Fit all stops
          </Button>

          {unserved.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs">
              <Badge variant="warning" className="mb-1">
                <MapPinOff className="me-1 h-3 w-3" />
                {unserved.length} unserved
              </Badge>
              <p className="text-muted-foreground">Gray × markers on the map.</p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Map */}
      <div className="lg:col-span-3">
        <div className="relative h-[640px] overflow-hidden rounded-lg border bg-card">
          {/* h-full + w-full instead of absolute inset-0 because MapLibre's
              `.maplibregl-map { position: relative }` overrides Tailwind's
              absolute positioning, leaving the container at height 0 and tiles
              never painting. Matches the working pattern in live-client.tsx. */}
          <div ref={containerRef} className="h-full w-full" />
          {!mapReady && !mapError ? (
            <div className="absolute inset-0 grid place-items-center bg-muted/40 text-sm text-muted-foreground">
              Loading map…
            </div>
          ) : null}
          {mapError ? (
            <div className="absolute inset-0 grid place-items-center bg-muted/40 p-6 text-center text-sm text-muted-foreground">
              <div>
                <MapPinOff className="mx-auto mb-2 h-6 w-6" />
                <p>{mapError}</p>
                <p className="mt-1 text-xs">Routes are still visible in the Routes tab.</p>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Stop context menu */}
      <Dialog open={!!contextStop} onOpenChange={(o) => !o && setContextStop(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {contextStop?.customerCode}
              {contextStop?.branchKey && contextStop.branchKey !== '__MAIN__' ? ` / ${contextStop.branchKey}` : ''}
            </DialogTitle>
            <DialogDescription>
              {contextStop?.customerName} · {contextStop?.cases} cases · truck {contextStop?.truckCode} seq{' '}
              {contextStop?.sequence}
              {contextStop?.locked ? ' · 🔒 locked' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Button variant="outline" className="w-full justify-start" onClick={() => setMoveDialog(contextStop)} disabled={pending || contextStop?.locked}>
              <Move className="me-2 h-4 w-4" />
              Move to a different truck
            </Button>
            {contextStop?.locked ? (
              <Button variant="outline" className="w-full justify-start" onClick={() => applyLock(false)} disabled={pending}>
                <Unlock className="me-2 h-4 w-4" />
                Unlock from this truck
              </Button>
            ) : (
              <Button variant="outline" className="w-full justify-start" onClick={() => applyLock(true)} disabled={pending}>
                <Lock className="me-2 h-4 w-4" />
                Lock to this truck
              </Button>
            )}
            <Button
              variant="outline"
              className="w-full justify-start text-destructive"
              onClick={() => setConfirmUnassign(contextStop)}
              disabled={pending || contextStop?.locked}
            >
              <MoreVertical className="me-2 h-4 w-4 rotate-90" />
              Unassign (drop from route)
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Move dialog */}
      <MoveDialog
        open={!!moveDialog}
        onOpenChange={(o) => !o && setMoveDialog(null)}
        stop={moveDialog}
        trucks={trucks}
        stops={stops}
        pending={pending}
        onMove={applyMove}
      />

      {/* Unassign confirm */}
      <AlertDialog open={!!confirmUnassign} onOpenChange={(o) => !o && setConfirmUnassign(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unassign {confirmUnassign?.customerCode}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmUnassign?.customerName} will be removed from truck {confirmUnassign?.truckCode}. It will not be
              served by this run unless you re-optimize or move it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                applyUnassign();
              }}
            >
              Unassign
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Label toggle button at top-right of the map area (mobile-friendly fallback) */}
      <span className="hidden">
        <EyeOff /> <Eye />
      </span>
    </div>
  );
}

function MoveDialog({
  open,
  onOpenChange,
  stop,
  trucks,
  stops,
  pending,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stop: MapStop | null;
  trucks: MapTruck[];
  stops: MapStop[];
  pending: boolean;
  onMove: (t: { truckId: string; insertionMode: 'after' | 'end' | 'auto'; insertAfterAssignmentId?: string | null }) => void;
}) {
  const [targetTruckId, setTargetTruckId] = useState<string>('');
  const [insertionMode, setInsertionMode] = useState<'after' | 'end' | 'auto'>('auto');
  const [insertAfter, setInsertAfter] = useState<string>('');

  useEffect(() => {
    if (open && stop) {
      // Default to the most under-utilized other truck.
      const candidates = trucks
        .filter((t) => t.id !== stop.truckId)
        .map((t) => ({ ...t, head: t.capacityCases - t.currentLoad }))
        .sort((a, b) => b.head - a.head);
      setTargetTruckId(candidates[0]?.id ?? trucks[0]?.id ?? '');
      setInsertionMode('auto');
      setInsertAfter('');
    }
  }, [open, stop, trucks]);

  const targetTruck = trucks.find((t) => t.id === targetTruckId);
  const targetStops = useMemo(
    () => stops.filter((s) => s.truckId === targetTruckId).sort((a, b) => a.sequence - b.sequence),
    [stops, targetTruckId],
  );
  const wouldExceed = stop && targetTruck ? targetTruck.currentLoad + stop.cases > targetTruck.capacityCases : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {stop?.customerCode}</DialogTitle>
          <DialogDescription>
            From truck {stop?.truckCode} · {stop?.cases} cases
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="target">Target truck</Label>
            <Select value={targetTruckId} onValueChange={setTargetTruckId}>
              <SelectTrigger id="target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {trucks
                  .filter((t) => t.id !== stop?.truckId)
                  .map((t) => {
                    const head = t.capacityCases - t.currentLoad;
                    const fits = stop ? head >= stop.cases : true;
                    return (
                      <SelectItem key={t.id} value={t.id}>
                        {t.code} — {t.currentLoad}/{t.capacityCases} ({fits ? `${head} free` : 'over capacity'})
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
            {wouldExceed ? (
              <p className="text-xs text-destructive">
                Truck {targetTruck?.code} would carry {(targetTruck?.currentLoad ?? 0) + (stop?.cases ?? 0)} &gt;{' '}
                {targetTruck?.capacityCases} cases.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mode">Where to insert</Label>
            <Select value={insertionMode} onValueChange={(v) => setInsertionMode(v as typeof insertionMode)}>
              <SelectTrigger id="mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto (nearest neighbor)</SelectItem>
                <SelectItem value="end">At the end of the route</SelectItem>
                <SelectItem value="after">After a specific stop</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {insertionMode === 'after' ? (
            <div className="space-y-1.5">
              <Label htmlFor="after">Insert after</Label>
              <Select value={insertAfter} onValueChange={setInsertAfter}>
                <SelectTrigger id="after">
                  <SelectValue placeholder="Pick a stop" />
                </SelectTrigger>
                <SelectContent>
                  {targetStops.map((s) => (
                    <SelectItem key={s.assignmentId} value={s.assignmentId}>
                      #{s.sequence} — {s.customerCode}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !targetTruckId || wouldExceed || (insertionMode === 'after' && !insertAfter)}
            onClick={() =>
              onMove({
                truckId: targetTruckId,
                insertionMode,
                insertAfterAssignmentId: insertionMode === 'after' ? insertAfter : null,
              })
            }
          >
            {pending ? 'Moving…' : 'Move stop'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
