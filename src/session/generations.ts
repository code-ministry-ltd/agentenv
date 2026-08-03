import { withLock } from '../lock.js';
import type { Paths } from '../paths.js';
import { readState, writeState } from '../state.js';
import {
  attachGenerationLease,
  beginGenerationSweep,
  cancelGenerationReservation,
  closeGeneration,
  completeGenerationSweep,
  createViewGeneration,
  publishGeneration,
  releaseGenerationLease,
  reserveGeneration,
  type GenerationInventoryEntry,
  type ProcessIdentity,
  type ViewGeneration,
} from '../view-generation.js';

export interface BeginGenerationRequest {
  id: string;
  envs: readonly string[];
  adapterId: string;
  session: string;
  viewRoot: string;
  createdAt: number;
}

export interface PublishGenerationRequest {
  fingerprint: string;
  inventory: GenerationInventoryEntry[];
  publishedAt: number;
}

async function updateGeneration(
  paths: Paths,
  id: string,
  update: (generation: ViewGeneration) => ViewGeneration,
): Promise<ViewGeneration> {
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    const index = manifest.generations.findIndex((generation) => generation.id === id);
    if (index === -1) throw new Error(`unknown generation '${id}'`);
    const next = update(manifest.generations[index]!);
    manifest.generations[index] = next;
    await writeState(paths, manifest);
    return next;
  });
}

/** Persist build intent before any generation bytes are published. */
export async function beginSessionGeneration(
  paths: Paths,
  req: BeginGenerationRequest,
): Promise<ViewGeneration> {
  return withLock(paths, async () => {
    const manifest = await readState(paths);
    if (manifest.generations.some((generation) => generation.id === req.id)) {
      throw new Error(`duplicate generation '${req.id}'`);
    }
    const generation = createViewGeneration(req.id, req.envs, {
      adapterId: req.adapterId,
      session: req.session,
      viewRoot: req.viewRoot,
      createdAt: req.createdAt,
    });
    manifest.generations.push(generation);
    await writeState(paths, manifest);
    return generation;
  });
}

/** Record the complete published inventory before the generation can be reserved. */
export function publishSessionGeneration(
  paths: Paths,
  id: string,
  req: PublishGenerationRequest,
): Promise<ViewGeneration> {
  return updateGeneration(paths, id, (generation) =>
    publishGeneration({
      ...generation,
      fingerprint: req.fingerprint,
      inventory: req.inventory.map((entry) => ({ ...entry })),
      publishedAt: req.publishedAt,
    }),
  );
}

export function reserveSessionGeneration(
  paths: Paths,
  id: string,
  reservationId: string,
): Promise<ViewGeneration> {
  return updateGeneration(paths, id, (generation) =>
    reserveGeneration(generation, reservationId),
  );
}

export function attachSessionGenerationLease(
  paths: Paths,
  id: string,
  reservationId: string,
  identity: ProcessIdentity,
): Promise<ViewGeneration> {
  return updateGeneration(paths, id, (generation) =>
    attachGenerationLease(generation, reservationId, identity),
  );
}

/**
 * Close and sweep a generation after its child process group is gone. A caller
 * may arrive with either a reservation (spawn never attached) or a lease.
 */
export function sweepSessionGeneration(
  paths: Paths,
  id: string,
  reservationId: string | null,
  now: number,
): Promise<ViewGeneration> {
  return updateGeneration(paths, id, (current) => {
    let generation = current;
    if (reservationId && generation.leases.some((lease) => lease.reservationId === reservationId)) {
      generation = releaseGenerationLease(generation, reservationId);
    } else if (reservationId && generation.reservations.includes(reservationId)) {
      generation = cancelGenerationReservation(generation, reservationId);
    }
    if (generation.phase === 'published') {
      generation = { ...closeGeneration(generation), closedAt: now };
    }
    if (generation.phase !== 'closing') return generation;
    return {
      ...completeGenerationSweep(beginGenerationSweep(generation)),
      sweptAt: now,
    };
  });
}

/** Preserve uncertain bytes and lifecycle references for explicit resolution. */
export function quarantineSessionGeneration(
  paths: Paths,
  id: string,
  failure: string,
): Promise<ViewGeneration> {
  return updateGeneration(paths, id, (generation) => ({
    ...generation,
    phase: 'quarantined',
    failure,
  }));
}
