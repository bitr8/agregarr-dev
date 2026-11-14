import type {
  LocalParts,
  NextChangeKind,
  PlanInput,
  PlanResult,
  RotationInterval,
  RotationState,
} from './types';

export function periodKey(
  _interval: RotationInterval,
  _weekday: number | undefined,
  _parts: LocalParts,
  _syncRunId: string | undefined,
  _state: RotationState
): string | null {
  throw new Error('not implemented');
}

export function nextBoundary(
  _interval: RotationInterval,
  _weekday: number | undefined,
  _now: Date,
  _toLocal: (d: Date) => LocalParts,
  _state: RotationState
): { kind: NextChangeKind; notBefore?: Date } {
  throw new Error('not implemented');
}

export function planRotation(_input: PlanInput): PlanResult {
  throw new Error('not implemented');
}

/** Repeated forced planRotation on copies; never mutates the input. */
export function simulate(_input: PlanInput, _steps: number): RotationState[] {
  throw new Error('not implemented');
}

export function emptyState(): RotationState {
  return {
    seq: 0,
    appliedSeq: 0,
    periodKey: null,
    slots: [],
    queue: [],
    shownThisCycle: [],
    cycle: 1,
  };
}
