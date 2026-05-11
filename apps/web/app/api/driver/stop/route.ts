/**
 * Mark a stop as delivered (Module C).
 *
 * POST /api/driver/stop — body { assignmentId, notes?, signaturePngB64?, lat?, lng? }
 * Auth via X-Driver-Token header. The assignment must belong to the same
 * tenant + truck as the active shift; we treat any mismatch as 404 to avoid
 * leaking IDs across tenants.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireDriverShift } from '@/lib/driver-auth';
import { audit } from '@/lib/audit';

const bodySchema = z.object({
  assignmentId: z.string().trim().min(1),
  notes: z.string().trim().max(1000).optional(),
  signaturePngB64: z.string().max(80_000).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

export async function POST(req: Request) {
  const token = req.headers.get('x-driver-token') ?? '';
  let ctx;
  try {
    ctx = await requireDriverShift(token);
  } catch {
    return NextResponse.json({ data: null, error: 'Unauthorized.' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ data: null, error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ data: null, error: 'Bad stop payload.' }, { status: 400 });
  }
  const p = parsed.data;

  // Verify the assignment is on this driver's truck + tenant.
  const assignment = await prisma.routeAssignment.findFirst({
    where: { id: p.assignmentId, truckId: ctx.truckId, run: { tenantId: ctx.tenantId } },
    select: { id: true, deliveryProof: { select: { id: true } } },
  });
  if (!assignment) {
    return NextResponse.json({ data: null, error: 'Stop not found on your truck.' }, { status: 404 });
  }
  if (assignment.deliveryProof) {
    return NextResponse.json(
      { data: { assignmentId: assignment.id, alreadyDone: true }, error: null },
      { status: 200 },
    );
  }

  const proof = await prisma.deliveryProof.create({
    data: {
      tenantId: ctx.tenantId,
      shiftId: ctx.shiftId,
      assignmentId: assignment.id,
      notes: p.notes ?? null,
      signaturePngB64: p.signaturePngB64 ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
    },
    select: { id: true, completedAt: true },
  });

  await audit({
    tenantId: ctx.tenantId,
    userId: null,
    action: 'DELIVERY_PROOF_CREATED',
    entity: 'RouteAssignment',
    entityId: assignment.id,
    afterJson: {
      shiftId: ctx.shiftId,
      notesLen: p.notes?.length ?? 0,
      signatureCaptured: !!p.signaturePngB64,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
    },
    ip: req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
  });

  return NextResponse.json(
    {
      data: {
        assignmentId: assignment.id,
        proofId: proof.id,
        completedAt: proof.completedAt.toISOString(),
      },
      error: null,
    },
    { status: 201 },
  );
}
