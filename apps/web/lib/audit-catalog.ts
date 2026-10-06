/**
 * The one catalog of audit events (review F23): every action and entity an audit row can carry,
 * with a plain label. The writers (lib/audit.ts types `action` with it), the audit API (unknown
 * filters answer 400) and the Audit log page (its filter lists) all read this file, so a new event
 * cannot be written without being findable. `legacy`: no longer written (kept so older rows stay
 * filterable).
 *
 * Pure (no server imports): the page passes it to its client component.
 */

export interface AuditActionInfo {
  label: string;
  legacy?: boolean;
}

/** Load statuses (Prisma LoadStatus): a status change writes LOAD_<status>. */
export const LOAD_STATUS_NAMES = ['PLANNED', 'LOCKED', 'LOADING', 'DISPATCHED', 'COMPLETED'] as const;
export type LoadStatusName = (typeof LOAD_STATUS_NAMES)[number];
type LoadAction = `LOAD_${LoadStatusName}`;

const LOAD_LABEL: Record<LoadStatusName, string> = {
  PLANNED: 'Load back to planned (unlocked)',
  LOCKED: 'Load locked',
  LOADING: 'Load loading',
  DISPATCHED: 'Load dispatched',
  COMPLETED: 'Load completed',
};

const LOAD_ACTIONS = Object.fromEntries(LOAD_STATUS_NAMES.map((s) => [`LOAD_${s}`, { label: LOAD_LABEL[s] }])) as Record<LoadAction, AuditActionInfo>;

export const AUDIT_ACTIONS = {
  CREATE: { label: 'Created' },
  UPDATE: { label: 'Changed' },
  DELETE: { label: 'Deleted' },
  OVERRIDE: { label: 'Override (legacy run unlocked)' },
  DISPATCH: { label: 'Legacy run dispatched' },
  LOGIN: { label: 'Signed in' },
  SIGNUP: { label: 'Company signed up' },
  LOGIN_THROTTLED: { label: 'Sign-in attempts slowed down' },
  PASSWORD_RESET_BY_ADMIN: { label: 'Password reset by an admin' },
  CROSS_TENANT_VIEW: { label: 'Viewed by a platform admin' },
  PLATFORM_ADMIN_GRANTED: { label: 'Platform admin granted' },
  PLATFORM_ADMIN_REVOKED: { label: 'Platform admin revoked' },
  CUSTOMER_LOCATION_SET: { label: 'Customer location set' },
  ORDER_DELIVERY_TIME_SET: { label: 'Delivery time set for one order (urgent / promised)' },
  ORDER_DELIVERY_TIME_CLEARED: { label: 'Delivery time of one order removed' },
  LATE_ORDER_RECORDED: { label: 'Late order recorded' },
  ORDERS_CARRIED_OVER: { label: 'Orders brought forward from earlier days' },
  ORDER_WEIGHTS_RESOLVED: { label: 'Order weights taken from products' },
  // Truck capacity in pallets (owner decision 4 Oct 2026): the product master imported from a file.
  PRODUCTS_IMPORTED: { label: 'Products imported (weights, cases per pallet)' },
  OPTIMIZE_STARTED: { label: 'Optimization started' },
  OPTIMIZE_SUCCEEDED: { label: 'Optimization finished' },
  OPTIMIZE_FAILED: { label: 'Optimization failed' },
  PLAN_RESET: { label: 'Stuck plan reset by a dispatcher' },
  SEARCH_STOPPED: { label: 'Thorough search stopped early (best plan so far used)' },
  SCENARIO_CHOSEN: { label: 'Plan option applied' },
  PLAN_VERSION_CREATED: { label: 'Plan version created (re-plan)' },
  ...LOAD_ACTIONS,
  LOAD_DRIVER_SET: { label: 'Load driver set' },
  // Delivery outcome and the driver page (owner request 4 Oct 2026).
  DRIVER_LINK_ISSUED: { label: 'Driver link (QR) made' },
  DRIVER_LINK_REISSUED: { label: 'Driver link reissued (the old one stopped working)' },
  DRIVER_LINK_REVOKED: { label: 'Driver link stopped' },
  CASUAL_DRIVER_ADDED: { label: 'Daily driver added' },
  DELIVERY_OUTCOME_SET: { label: 'Delivery result recorded or corrected' },
  DELIVERY_PHOTO_ADDED: { label: 'Delivery photo added' },
  STOP_ARRIVAL_MANUAL: { label: 'Arrival at a stop recorded by hand' },
  DRIVER_BACK_AT_DEPOT: { label: 'Driver back at the depot' },
  DELIVERY_CARRY_CONFLICT: { label: 'Result change refused: already brought forward' },
  ORDERS_CARRY_UNDONE: { label: 'Bring forward undone' },
  DELIVERY_PHOTOS_PURGED: { label: 'Old delivery photos removed (retention)' },
  DELIVERY_LOCATIONS_PURGED: { label: 'Old driver positions removed (retention)' },
  CASUAL_DRIVERS_CLEARED: { label: 'Idle daily drivers hidden (clean-up)' },
  // Start fresh (owner request 4 Oct 2026): a company admin removed the test orders, plans and results.
  TEST_DATA_CLEARED: { label: 'Test data removed (Start fresh)' },
  // The hire suggestion (owner request 6 Oct 2026): which trucks to rent when the fleet cannot carry the day.
  HIRE_CHECK_STARTED: { label: 'Hire check started (a what-if with trucks to rent)' },
  HIRE_CHECK_FINISHED: { label: 'Hire check finished (suggestion ready)' },
  HIRE_CHECK_FAILED: { label: 'Hire check failed or stopped' },
  HIRE_SUGGESTION_USED: { label: 'Hire suggestion used ("Use this plan")' },
  HIRED_TRUCKS_ADDED: { label: 'One-day hired trucks added' },
  HIRED_TRUCK_CHANGED: { label: 'One-day hired truck: plate or driver set' },
  ONE_DAY_TRUCKS_RETIRED: { label: 'One-day hired trucks retired after their day' },
  BASELINE_UPLOADED: { label: 'Baseline uploaded (legacy run)' },
  ROUTE_MANUALLY_CHANGED: { label: 'Route changed by hand (legacy run)' },
  SECURITY_CLEANUP: { label: 'Security clean-up (migration)' },
  DEPOT_BACKFILL: { label: 'Depot filled in for orders and order files without one (migration)' },
  LOGOUT: { label: 'Signed out', legacy: true },
  DRIVER_LOGIN: { label: 'Driver app sign-in (retired)', legacy: true },
  DELIVERY_PROOF_CREATED: { label: 'Driver app delivery proof (retired)', legacy: true },
} as const satisfies Record<string, AuditActionInfo>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as [AuditAction, ...AuditAction[]];

/** The audit action of a load status change. */
export function loadStatusAction(status: LoadStatusName): AuditAction {
  return `LOAD_${status}`;
}

/** Entities audit rows name (the model the row is about). `legacy`: nothing writes it any more. */
export const AUDIT_ENTITIES = {
  Tenant: { label: 'Company' },
  TenantConfig: { label: 'Settings' },
  User: { label: 'User' },
  PasswordResetToken: { label: 'Password reset' },
  Depot: { label: 'Depot' },
  Truck: { label: 'Truck' },
  Driver: { label: 'Driver' },
  Region: { label: 'Region' },
  Customer: { label: 'Customer' },
  Product: { label: 'Product' },
  UploadBatch: { label: 'Order file' },
  Order: { label: 'Order' },
  RunPlan: { label: 'Plan version' },
  PlanLoad: { label: 'Load' },
  RouteAssignment: { label: 'Stop (legacy run)' },
  ManualBaseline: { label: 'Baseline (legacy run)' },
  DriverLink: { label: 'Driver link' },
  StopVisit: { label: 'Delivery stop' },
  HireOption: { label: 'Truck to hire (hire option)' },
  HireSuggestion: { label: 'Hire suggestion' },
  RunJob: { label: 'Optimization job', legacy: true },
  DriverShift: { label: 'Driver shift (retired app)', legacy: true },
} as const satisfies Record<string, AuditActionInfo>;

export type AuditEntity = keyof typeof AUDIT_ENTITIES;
export const AUDIT_ENTITY_NAMES = Object.keys(AUDIT_ENTITIES) as [AuditEntity, ...AuditEntity[]];

/** Badge colour of an action on the Audit log page. */
export function auditActionTone(action: string): 'default' | 'success' | 'warning' | 'secondary' | 'destructive' | 'outline' {
  if (action === 'DELETE' || action === 'OPTIMIZE_FAILED' || action === 'LOGIN_THROTTLED' || action === 'TEST_DATA_CLEARED') return 'destructive';
  if (action === 'CREATE' || action === 'OPTIMIZE_SUCCEEDED' || action === 'LOAD_DISPATCHED' || action === 'LOAD_COMPLETED' || action === 'DISPATCH') return 'success';
  if (action === 'OVERRIDE' || action === 'ROUTE_MANUALLY_CHANGED' || action === 'LOAD_PLANNED' || action === 'PLAN_RESET' || action === 'CROSS_TENANT_VIEW' || action.startsWith('PLATFORM_ADMIN')) return 'warning';
  if (action === 'DRIVER_LINK_REVOKED' || action === 'DRIVER_LINK_REISSUED' || action === 'DELIVERY_CARRY_CONFLICT') return 'warning';
  if (action === 'LOGIN' || action === 'SIGNUP' || action === 'LOAD_LOCKED' || action === 'LOAD_LOADING') return 'secondary';
  return 'outline';
}
