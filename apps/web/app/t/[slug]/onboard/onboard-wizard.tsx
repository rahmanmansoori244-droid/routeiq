'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Building2, Check, ChevronRight, Truck, Upload, Warehouse } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPicker } from '@/components/map-picker';

interface Completion {
  depots: number;
  trucks: number;
  customers: number;
}

interface OnboardProps {
  slug: string;
  mapboxToken: string;
  completion: Completion;
}

export function OnboardWizard({ slug, mapboxToken, completion }: OnboardProps) {
  const router = useRouter();
  const initial = completion.depots > 0 ? (completion.trucks > 0 ? 2 : 1) : 0;
  const [step, setStep] = useState(initial);

  const stepDefs = [
    { title: 'Add your first depot', done: completion.depots > 0, icon: Warehouse },
    { title: 'Add a truck', done: completion.trucks > 0, icon: Truck },
    { title: 'Customers (optional)', done: completion.customers > 0, icon: Building2 },
  ];

  function next() {
    if (step < stepDefs.length - 1) setStep(step + 1);
    else {
      router.push(`/t/${slug}`);
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <ol className="flex gap-2 text-sm">
        {stepDefs.map((s, i) => (
          <li
            key={s.title}
            className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 ${
              i === step ? 'border-primary bg-primary/5' : 'border-muted'
            }`}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                s.done ? 'bg-green-600 text-white' : i === step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {s.done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className="font-medium">{s.title}</span>
          </li>
        ))}
      </ol>

      {step === 0 ? <DepotStep mapboxToken={mapboxToken} onSaved={next} /> : null}
      {step === 1 ? <TruckStep slug={slug} onSaved={next} /> : null}
      {step === 2 ? <CustomerStep slug={slug} completion={completion} onDone={next} /> : null}

      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => {
            if (step > 0) setStep(step - 1);
            else router.push(`/t/${slug}`);
          }}
        >
          {step === 0 ? 'Skip onboarding' : 'Back'}
        </Button>
        {step < 2 ? null : (
          <Button onClick={() => router.push(`/t/${slug}`)}>
            Go to dashboard
            <ChevronRight className="ms-1 h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

function DepotStep({ mapboxToken, onSaved }: { mapboxToken: string; onSaved: () => void }) {
  const [form, setForm] = useState<{
    code: string;
    name: string;
    lat: number | null;
    lng: number | null;
    address: string;
  }>({ code: 'MAIN', name: 'Main depot', lat: 23.5859, lng: 58.4059, address: '' });
  const [pending, startSubmit] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.lat === null || form.lng === null) {
      toast.error('Pick a location on the map.');
      return;
    }
    startSubmit(async () => {
      const res = await fetch('/api/depots', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: form.code,
          name: form.name,
          lat: form.lat,
          lng: form.lng,
          address: form.address,
          active: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Depot creation failed.');
        return;
      }
      toast.success('Depot created');
      onSaved();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add your first depot</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ocode">Code</Label>
              <Input id="ocode" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="oname">Name</Label>
              <Input id="oname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </div>
          </div>
          <MapPicker
            lat={form.lat}
            lng={form.lng}
            onChange={(lat, lng) => setForm((f) => ({ ...f, lat, lng }))}
            mapboxToken={mapboxToken}
            height={220}
          />
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save & next'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function TruckStep({ slug, onSaved }: { slug: string; onSaved: () => void }) {
  const [depots, setDepots] = useState<{ id: string; code: string; name: string }[]>([]);
  const [form, setForm] = useState({
    code: 'T-101',
    depotId: '',
    capacityCases: '200',
    capacityWeightKg: '3000',
    capacityVolumeL: '8000',
    fixedCostPerDay: '20',
    costPerKm: '0.15',
  });
  const [pending, startSubmit] = useTransition();

  useEffect(() => {
    fetch('/api/depots')
      .then((r) => r.json())
      .then((b) => {
        const list = b.data ?? [];
        setDepots(list);
        if (list[0]) setForm((f) => ({ ...f, depotId: list[0].id }));
      })
      .catch(() => {});
  }, [slug]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startSubmit(async () => {
      const res = await fetch('/api/trucks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: form.code,
          depotId: form.depotId,
          capacityCases: Number(form.capacityCases),
          capacityWeightKg: Number(form.capacityWeightKg),
          capacityVolumeL: Number(form.capacityVolumeL),
          fixedCostPerDay: Number(form.fixedCostPerDay),
          costPerKm: Number(form.costPerKm),
          active: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Truck creation failed.');
        return;
      }
      toast.success('Truck created');
      onSaved();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Add a truck</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tcode">Code</Label>
              <Input id="tcode" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tdepot">Depot</Label>
              <Select value={form.depotId} onValueChange={(v) => setForm({ ...form, depotId: v })}>
                <SelectTrigger id="tdepot">
                  <SelectValue placeholder="Pick a depot" />
                </SelectTrigger>
                <SelectContent>
                  {depots.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.code} — {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tcap">Cases</Label>
              <Input id="tcap" type="number" min="0" value={form.capacityCases} onChange={(e) => setForm({ ...form, capacityCases: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tkg">Weight (kg)</Label>
              <Input id="tkg" type="number" min="0" step="0.1" value={form.capacityWeightKg} onChange={(e) => setForm({ ...form, capacityWeightKg: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tvol">Volume (L)</Label>
              <Input id="tvol" type="number" min="0" step="0.1" value={form.capacityVolumeL} onChange={(e) => setForm({ ...form, capacityVolumeL: e.target.value })} required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="tfixed">Fixed daily cost</Label>
              <Input id="tfixed" type="number" min="0" step="0.01" value={form.fixedCostPerDay} onChange={(e) => setForm({ ...form, fixedCostPerDay: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tperkm">Per km cost</Label>
              <Input id="tperkm" type="number" min="0" step="0.01" value={form.costPerKm} onChange={(e) => setForm({ ...form, costPerKm: e.target.value })} required />
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={pending || !form.depotId}>
              {pending ? 'Saving…' : 'Save & next'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function CustomerStep({ slug, completion, onDone }: { slug: string; completion: Completion; onDone: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Customers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Upload a CSV of customers (recommended) or add them later. You currently have{' '}
          <strong>{completion.customers}</strong> customers.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Button asChild>
            <Link href={`/t/${slug}/customers/import`}>
              <Upload className="me-2 h-4 w-4" />
              Import CSV
            </Link>
          </Button>
          <Button variant="outline" onClick={onDone}>
            I'll add them later
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
