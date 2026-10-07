/**
 * Customer identity: which customer a code and branch mean. One rule for every place a customer is
 * looked up by its code and branch: the order file's check (resolveOrderLines) and its confirm
 * (confirmIntake), the late order, the customer import (also the customer master and the
 * data-to-collect file imported back), the Customers page's create and edit, Bring forward's line
 * keys and the legacy baseline upload. Pure (no imports), so every one of them can use it.
 *
 * A customer is its code and its branch, each with the spaces at both ends cut, whatever the letter
 * case: "c001" is "C001" (exports often change the case, and two rows would split one customer's
 * orders). A blank branch is the main branch (`__MAIN__`, normalizeBranchKey in lib/schemas.ts).
 * Nothing else is folded: every other character is itself, "_" and "%" included.
 *
 * Matched in the program, never with a database pattern. Prisma's `equals` with `mode:
 * 'insensitive'` is an ILIKE on PostgreSQL, which reads "_" as "any one character" and "%" as "any
 * text" (and fails on a trailing "\"): a new customer "C_1" in an order file was matched at confirm to
 * the existing "CX1", and its order went to CX1 and CX1's location, while the check had listed C_1 as
 * a new customer (LOCATION REQUIRED). The branch key "__MAIN__" is a pattern there too. So the
 * company's customers are read (id, code and branch) and compared with customerKey, the same way the
 * check does; product codes had the same fix (lib/product-code.ts).
 */

/** The identity two customers are matched by: "CODE::BRANCH", each trimmed and in upper case. */
export function customerKey(code: string, branchKey: string): string {
  return `${code.trim().toUpperCase()}::${branchKey.trim().toUpperCase()}`;
}

/** The rows of `list` that this code and branch key mean (letter case aside), in the list's order. */
export function customerTwinsOf<T extends { code: string; branchKey: string }>(list: readonly T[], code: string, branchKey: string): T[] {
  const key = customerKey(code, branchKey);
  return list.filter((c) => customerKey(c.code, c.branchKey) === key);
}
