export type NanDemoModel =
  | "deepseek-v4-flash"
  | "mimo-v2.5"
  | "qwen3.6"
  | "gemma4";

export type NanDemoCatalogEntry = Readonly<
  | { label: string; kind: "capped"; cap: number; unit: "tokens/month" | "requests/month" }
  | { label: string; kind: "uncapped" }
>;

export const DEFAULT_NAN_DEMO_MODEL: NanDemoModel = "deepseek-v4-flash";

export const NAN_DEMO_CATALOG: Readonly<Record<NanDemoModel, NanDemoCatalogEntry>> = Object.freeze({
  "deepseek-v4-flash": Object.freeze({ label: "DeepSeek V4 Flash", kind: "capped", cap: 500_000_000, unit: "tokens/month" }),
  "mimo-v2.5": Object.freeze({ label: "MiMo V2.5", kind: "capped", cap: 500_000_000, unit: "tokens/month" }),
  "qwen3.6": Object.freeze({ label: "Qwen 3.6", kind: "uncapped" }),
  "gemma4": Object.freeze({ label: "Gemma 4", kind: "uncapped" }),
});

const NAN_DEMO_MODELS = Object.freeze(Object.keys(NAN_DEMO_CATALOG) as NanDemoModel[]);

export function getNanDemoModel(model: unknown): { model: NanDemoModel; entry: NanDemoCatalogEntry } | undefined {
  if (typeof model !== "string" || !Object.hasOwn(NAN_DEMO_CATALOG, model)) return undefined;
  const selected = model as NanDemoModel;
  return { model: selected, entry: NAN_DEMO_CATALOG[selected] };
}

export function cycleNanDemoModel(currentModel: unknown, ticks: number): NanDemoModel {
  const current = getNanDemoModel(currentModel)?.model ?? DEFAULT_NAN_DEMO_MODEL;
  const currentIndex = NAN_DEMO_MODELS.indexOf(current);
  const nextIndex = (currentIndex + Math.trunc(ticks)) % NAN_DEMO_MODELS.length;
  return NAN_DEMO_MODELS[(nextIndex + NAN_DEMO_MODELS.length) % NAN_DEMO_MODELS.length];
}
