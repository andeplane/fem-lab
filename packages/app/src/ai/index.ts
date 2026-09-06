// The whole assistant behind one import. Mount it in the shell with one line:
//
//   {s.panels['assistant'] ? <AssistantPanel registry={registry} store={store} /> : null}
//
// and, if the app wants `chat.send` / `chat.insertMention` / `chat.clear` to work from a script or
// the command palette, point `HostContext.chat` at `chatBridge`.
export { AssistantPanel, chatBridge, type AssistantPanelProps } from './AssistantPanel';
export { runTurn, undoTurn, type AgentEvent, type ToolCall, type TurnOptions, type TurnResult } from './agent';
export { anthropicProvider, ANTHROPIC_DEFAULT, ANTHROPIC_MODELS, toMessageParams, type AnthropicLike } from './anthropic';
export {
  apiReference,
  browserImages,
  buildSystem,
  buildTurn,
  downscaleImage,
  fitTo,
  objectIndex,
  parseVerification,
  projectBlock,
  resolveMention,
  screenshotBlock,
  skillsIndex,
  IMAGE_TYPES,
  MAX_BYTES,
  MAX_EDGE,
  type BuiltTurn,
  type ImageEnv,
  type ImageType,
  type IndexEntry,
  type ProjectContext,
  type SystemContext,
  type TurnInput,
  type VerifyRow,
  type VerifyStatus,
} from './context';
export { defaultProvider, maskKey, resolveKey, storedModel, storeKey, DEFAULT_MODEL, KEY_SLOT, MODEL_SLOT, MODELS, PROVIDER_IDS, type KeyInfo, type KeySource } from './keys';
export { openaiProvider, OPENAI_DEFAULT, OPENAI_MODELS, toResponseInput, type OpenAILike } from './openai';
export {
  forgetHandle,
  kindOf,
  pickFolder,
  projectSkills,
  ProjectFolder,
  recallHandle,
  rememberHandle,
  watchAgents,
  AGENTS_FILES,
  type DirHandle,
  type FileHandle,
  type FileKind,
  type PickerWindow,
  type ProjectFile,
} from './project';
export { costOf, textOf, NO_USAGE, PRICES, type Block, type ChatEvent, type ChatRequest, type ImageBlock, type Message, type Provider, type ProviderId, type Usage } from './provider';
export { BUILTIN_SKILLS } from './skills';
