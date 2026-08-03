export type ViewGenerationPhase =
  | 'building'
  | 'published'
  | 'closing'
  | 'sweeping'
  | 'swept'
  | 'quarantined'
  | 'collected';

export interface ProcessIdentity {
  processGroupId: number;
  pid: number;
  processStart: string;
}

export interface GenerationLease extends ProcessIdentity {
  reservationId: string;
}

export interface GenerationInventoryEntry {
  surfaceId: string;
  storeKind: string;
  mechanism: string;
  path: string;
  baseline: string[] | string;
  ownerEnv: string | null;
}

export interface ViewGenerationDetails {
  adapterId: string;
  session: string;
  viewRoot: string;
  createdAt: number;
}

export interface ViewGeneration {
  schemaVersion: 2;
  id: string;
  envs: string[];
  phase: ViewGenerationPhase;
  reservations: string[];
  leases: GenerationLease[];
  adapterId?: string;
  session?: string;
  viewRoot?: string;
  fingerprint?: string;
  inventory?: GenerationInventoryEntry[];
  createdAt?: number;
  publishedAt?: number;
  closedAt?: number;
  sweptAt?: number;
  failure?: string;
}

export function createViewGeneration(
  id: string,
  envs: readonly string[],
  details?: ViewGenerationDetails,
): ViewGeneration {
  return {
    schemaVersion: 2,
    id,
    envs: [...envs],
    phase: 'building',
    reservations: [],
    leases: [],
    ...details,
  };
}

function requirePhase(generation: ViewGeneration, expected: ViewGenerationPhase): void {
  if (generation.phase !== expected) {
    throw new Error(`generation must be ${expected}; it is ${generation.phase}`);
  }
}

export function publishGeneration(generation: ViewGeneration): ViewGeneration {
  requirePhase(generation, 'building');
  return { ...generation, phase: 'published' };
}

export function reserveGeneration(generation: ViewGeneration, reservationId: string): ViewGeneration {
  requirePhase(generation, 'published');
  if (!reservationId || generation.reservations.includes(reservationId)) {
    throw new Error(`invalid or duplicate reservation '${reservationId}'`);
  }
  return { ...generation, reservations: [...generation.reservations, reservationId] };
}

export function cancelGenerationReservation(
  generation: ViewGeneration,
  reservationId: string,
): ViewGeneration {
  if (!generation.reservations.includes(reservationId)) {
    throw new Error(`unknown reservation '${reservationId}'`);
  }
  return {
    ...generation,
    reservations: generation.reservations.filter((id) => id !== reservationId),
  };
}

export function attachGenerationLease(
  generation: ViewGeneration,
  reservationId: string,
  process: ProcessIdentity,
): ViewGeneration {
  if (generation.phase !== 'published' && generation.phase !== 'closing') {
    throw new Error(`cannot attach a lease while generation is ${generation.phase}`);
  }
  if (!generation.reservations.includes(reservationId)) {
    throw new Error(`lease requires reservation '${reservationId}'`);
  }
  return {
    ...generation,
    reservations: generation.reservations.filter((id) => id !== reservationId),
    leases: [...generation.leases, { reservationId, ...process }],
  };
}

export function releaseGenerationLease(
  generation: ViewGeneration,
  reservationId: string,
): ViewGeneration {
  if (!generation.leases.some((lease) => lease.reservationId === reservationId)) {
    throw new Error(`unknown lease '${reservationId}'`);
  }
  return {
    ...generation,
    leases: generation.leases.filter((lease) => lease.reservationId !== reservationId),
  };
}

export function closeGeneration(generation: ViewGeneration): ViewGeneration {
  requirePhase(generation, 'published');
  return { ...generation, phase: 'closing' };
}

export function beginGenerationSweep(generation: ViewGeneration): ViewGeneration {
  requirePhase(generation, 'closing');
  if (generation.reservations.length > 0) throw new Error('generation still has a reservation');
  if (generation.leases.length > 0) throw new Error('generation still has a process-group lease');
  return { ...generation, phase: 'sweeping' };
}

export function completeGenerationSweep(generation: ViewGeneration): ViewGeneration {
  requirePhase(generation, 'sweeping');
  return { ...generation, phase: 'swept' };
}

export function failGenerationSweep(generation: ViewGeneration, failure: string): ViewGeneration {
  requirePhase(generation, 'sweeping');
  return { ...generation, phase: 'quarantined', failure };
}

export function collectGeneration(generation: ViewGeneration): ViewGeneration {
  requirePhase(generation, 'swept');
  if (generation.reservations.length > 0 || generation.leases.length > 0) {
    throw new Error('cannot collect a referenced generation');
  }
  return { ...generation, phase: 'collected' };
}
