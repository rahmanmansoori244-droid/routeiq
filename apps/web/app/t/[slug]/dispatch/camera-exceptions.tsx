'use client';

import { CameraOff } from 'lucide-react';
import { cameraAlertText, cameraExceptionText, cameraHeadline, type CameraException, type CameraLinkAlert } from '@/lib/delivery/camera-exceptions';

/**
 * "Camera not working" (owner decision 2, 5 Oct 2026): the results saved without a photo, every one
 * listed (truck, trip, stop, customer, driver, time), and the driver links that used it 3 times or
 * more that day in red. On the day screen's Deliveries card and on the plan screen. Nothing when
 * there is none.
 */
export function CameraExceptions({ list, alerts, testId = 'camera-exceptions' }: { list: readonly CameraException[]; alerts: readonly CameraLinkAlert[]; testId?: string }) {
  const headline = cameraHeadline(list.length);
  if (!headline) return null;
  return (
    <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs" data-testid={testId}>
      <p className="flex items-center gap-1 font-medium text-amber-900">
        <CameraOff className="h-4 w-4" aria-hidden /> {headline}
      </p>
      {alerts.map((a) => (
        <p key={`${a.date}-${a.truckId}`} className="font-medium text-red-700" data-testid={`camera-alert-${a.truckCode}`}>
          {cameraAlertText(a)}
        </p>
      ))}
      <ul className="ml-4 list-disc space-y-0.5 text-amber-900">
        {list.map((e) => (
          <li key={`${e.loadId}-${e.sequence}`}>{cameraExceptionText(e)}</li>
        ))}
      </ul>
      <p className="text-muted-foreground">Check each one today: ask the driver, and call the customer when in doubt. The operations manager reviews them every week.</p>
    </div>
  );
}
