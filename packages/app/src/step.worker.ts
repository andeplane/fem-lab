// Loaded only when geometry.importStep has validated its input and requested conversion.
// This Worker can be terminated even while the synchronous OCCT call is running.
import type { StepWorkerRequest } from './step-import';
interface Converter { ReadStepFile(bytes: Uint8Array, options: { linearUnit: 'meter'; linearDeflectionType: 'absolute_value'; linearDeflection: number; angularDeflection: number }): unknown }
type Factory = (options: { locateFile(path: string): string }) => Promise<Converter>;
declare const self: DedicatedWorkerGlobalScope;
self.onmessage = async (event: MessageEvent<StepWorkerRequest>) => {
  try {
    const { assets, bytes, linearDeflection, angularDeflection } = event.data;
    const module = await import(/* @vite-ignore */ `${assets}occt-import-js.js`) as { default: Factory };
    const converter = await module.default({ locateFile: path => new URL(path, assets).href });
    self.postMessage(converter.ReadStepFile(bytes, { linearUnit: 'meter', linearDeflectionType: 'absolute_value', linearDeflection, angularDeflection }));
  } catch (error) {
    self.postMessage({ success: false, error: { code: 'CONVERTER_FAILED', cause: String(error), where: 'step.converter' } });
  }
};
