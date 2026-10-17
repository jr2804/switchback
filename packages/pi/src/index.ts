/**
 * Barrel re-export for tests and downstream consumers of the pi adapter. The pi
 * extension entry (`../index.ts`) imports its modules directly to keep its surface
 * small; this barrel exists so a consumer can import the whole pi-side surface
 * from `pi-switchback` without enumerating modules. The host-agnostic half lives
 * in `switchback-core` and is re-exported here so one import still reaches
 * everything.
 */

export * from "switchback-core";
export { buildRoute, ConfigInvalidError } from "./build-route.ts";
export { runDialogue, layerOptionLabel } from "./dialogue.ts";
export { describeJev } from "./dialogue-ui.ts";
export { createModelPicker, buildModelItems, MODEL_PICKER_MAX_VISIBLE } from "./model-picker.ts";
export type { ModelPickerSource, PickerColor, PickerKeybindings, PickerTheme, PickerTui } from "./model-picker.ts";
export type { DialogueContext, DialogueUi } from "./dialogue-ui.ts";
export { createSecretStore, secretsFilePath, powershellDpapi, SecretsError } from "./secrets.ts";
export type { SecretStore, Dpapi } from "./secrets.ts";
