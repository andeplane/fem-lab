import type {Plugin} from 'vite';
export interface DocsSite {base:string;files:Map<string,string>;pages:Map<string,unknown>;searchEntries:unknown[];referenceCount:number;exampleCount:number}
export function docsPlugin(base:string):Plugin;
export function buildDocsSite(options?:{base?:string}):Promise<DocsSite>;
export function normalizeBase(base:string):string;
export function headingSlug(value:string):string;
export const NAVIGATION:{title:string;pages:string[]}[];
