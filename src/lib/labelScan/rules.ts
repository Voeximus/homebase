// OWNER: verifier agent. Placeholder — replace the bodies, keep the signatures.
// The three regulations as data. Sources and exact values: docs/research/label-parity.
import type { FieldKey, Regime } from "./types";

export interface EnergyFactors {
  /** per gram, in the unit asked for */
  prot: number;
  carb: number;
  fat: number;
  /** present where the regulation gives fiber its own factor (EU 2 kcal / 8 kJ, CN 8 kJ) */
  fiber?: number;
}

/** The reference a percentage column is computed against: US DRV, CN NRV, EU RI. undefined = no second copy exists. */
export function referenceValue(_regime: Regime, _field: FieldKey): number | undefined {
  throw new Error("rules.referenceValue: not implemented");
}

/** The range of ACTUAL amounts that a declared value could have been rounded from. */
export function roundingInterval(
  _regime: Regime,
  _field: FieldKey,
  _declared: number,
  _lessThan?: boolean,
): [number, number] {
  throw new Error("rules.roundingInterval: not implemented");
}

/** Whether a declared value can legally be printed at all under this regime's rounding rules. */
export function onGrid(_regime: Regime, _field: FieldKey, _value: number): boolean {
  throw new Error("rules.onGrid: not implemented");
}

/** Every percentage the regulation allows to be printed beside this declared amount. Empty when no reference exists. */
export function allowedRefPct(_regime: Regime, _field: FieldKey, _declared: number): number[] {
  throw new Error("rules.allowedRefPct: not implemented");
}

export function energyFactors(_regime: Regime, _unit: "kcal" | "kj"): EnergyFactors {
  throw new Error("rules.energyFactors: not implemented");
}

/** Fields each regulation requires, in printed order. */
export const MANDATORY: Record<Regime, FieldKey[]> = { us: [], eu: [], cn: [] };
