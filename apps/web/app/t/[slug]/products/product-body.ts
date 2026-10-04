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
  active: boolean;
}

export function productRequestBody(mode: 'create' | 'edit', form: ProductFormState) {
  const fields = {
    name: form.name,
    weightPerCaseKg: Number(form.weightPerCaseKg),
    volumePerCaseL: Number(form.volumePerCaseL),
    active: form.active,
  };
  return mode === 'create' ? { code: form.code, ...fields } : fields;
}
