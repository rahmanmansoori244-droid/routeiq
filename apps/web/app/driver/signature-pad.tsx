/**
 * Minimal touch + mouse signature pad. Self-contained — no external deps.
 *
 * Renders a canvas the driver can draw on with finger or stylus, then exports
 * the result as a base64-encoded PNG via ``getDataURL()`` exposed through
 * imperative ref. Includes a clear button. Mobile-friendly: prevents page
 * scroll while drawing, fits container width.
 */
'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface SignaturePadHandle {
  isEmpty: () => boolean;
  getDataURL: () => string | null;
  clear: () => void;
}

export const SignaturePad = forwardRef<SignaturePadHandle, { height?: number }>(function SignaturePad(
  { height = 160 },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);

  // Resize canvas to its rendered size + DPR for crisp lines.
  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    ctxRef.current = ctx;
  }, []);

  useEffect(() => {
    setup();
    const onResize = () => setup();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setup]);

  function pointFromEvent(e: PointerEvent | React.PointerEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ('clientX' in e ? e.clientX : 0) - rect.left,
      y: ('clientY' in e ? e.clientY : 0) - rect.top,
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.preventDefault();
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const ctx = ctxRef.current;
    const pt = pointFromEvent(e);
    if (!ctx || !pt) return;
    drawingRef.current = true;
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    e.preventDefault();
    const ctx = ctxRef.current;
    const pt = pointFromEvent(e);
    if (!ctx || !pt) return;
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    if (empty) setEmpty(false);
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    drawingRef.current = false;
    e.preventDefault();
    const ctx = ctxRef.current;
    if (ctx) ctx.closePath();
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.scale(dpr, dpr);
    setEmpty(true);
  }

  useImperativeHandle(
    ref,
    () => ({
      isEmpty: () => empty,
      getDataURL: () => {
        const canvas = canvasRef.current;
        if (!canvas || empty) return null;
        // Cap data size — toDataURL with quality. PNG default. For typical
        // driver signature this is ~10-30 KB which is well within our 80 KB
        // signaturePngB64 server cap.
        return canvas.toDataURL('image/png');
      },
      clear: clearCanvas,
    }),
    [empty],
  );

  return (
    <div className="space-y-2">
      <div className="rounded-md border border-slate-300 bg-white">
        <canvas
          ref={canvasRef}
          style={{ height, touchAction: 'none', width: '100%', display: 'block' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
      </div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">
          {empty ? 'Sign with finger or stylus — optional.' : 'Signature captured.'}
        </span>
        <button
          type="button"
          onClick={clearCanvas}
          className="rounded px-2 py-1 text-slate-600 hover:bg-slate-100"
        >
          Clear
        </button>
      </div>
    </div>
  );
});
