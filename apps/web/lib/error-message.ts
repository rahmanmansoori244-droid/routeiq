/**
 * Human message from an API error envelope `{ data: null, error }`. `error` is a string for
 * simple failures and an object for structured ones ({ error | message, code, ... } or a zod
 * flatten() with fieldErrors / formErrors), which must not collapse into a generic toast.
 */
export function errorMessage(body: unknown, fallback: string): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === 'string' && err) return err;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message) return e.message;
    if (typeof e.error === 'string' && e.error) return e.error;
    const fields = e.fieldErrors as Record<string, string[] | undefined> | undefined;
    const fieldText = fields ? Object.values(fields).flat().filter(Boolean).join(' ') : '';
    if (fieldText) return fieldText;
    if (Array.isArray(e.formErrors) && e.formErrors.length) return (e.formErrors as string[]).join(' ');
  }
  return fallback;
}
