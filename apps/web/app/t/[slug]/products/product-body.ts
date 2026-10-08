/**
 * What the Products dialog sends. Create sends the code as typed (the server tidies and checks it,
 * lib/product-code.ts). Edit never sends it: the code cannot be changed in the dialog, and sending
 * it back made every save of a product whose code the rule refuses fail on the code - the weight
 * of "JA1.5L(6)" could not be saved. Kept apart from the dialog so it can be tested.
 */
export interface ProductFormState {
  code: string;
  name: string;
  weightPerCaseKg: string;
  volumePerCaseL: string;
  /** Cases per pallet as typed; empty = not set. */
  casesPerPallet: string;
  active: boolean;
  /**
   * Edit only: "Weight not known" ticked on a product that has a case weight. The weight is then sent
   * as 0 (unknown) with `clearWeight`, which PATCH /api/products/[id] needs before it saves 0 over a
   * known weight (an emptied field is refused, never saved as unknown by accident).
   */
  clearWeight?: boolean;
}

export function productRequestBody(mode: 'create' | 'edit', form: ProductFormState) {
  const fields = {
    name: form.name,
    weightPerCaseKg: Number(form.weightPerCaseKg),
    volumePerCaseL: Number(form.volumePerCaseL),
    // The ERP pallet factor (owner decision 4 Oct 2026): empty = not set (cleared on edit).
    casesPerPallet: form.casesPerPallet.trim() === '' ? null : Number(form.casesPerPallet),
    active: form.active,
  };
  if (mode === 'create') return { code: form.code, ...fields };
  return form.clearWeight ? { ...fields, weightPerCaseKg: 0, clearWeight: true } : fields;
}
