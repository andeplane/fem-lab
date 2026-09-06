import { validateScript } from '@femlab/registry/script-validation';
import declarations from '../../registry/src/generated/script-declarations-browser.json';
self.onmessage = (event: MessageEvent<string>) => self.postMessage(validateScript(event.data, declarations));
