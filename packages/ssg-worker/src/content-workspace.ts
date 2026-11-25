import type { ContentChange } from './draft-input.ts';

/** Private service response. The browser never chooses a repository or commit. */
export interface ContentWorkspace {
  proposalId: string;
  createdAt: number;
  commit: string;
  repositoryId: string;
  contentDir: string;
  staticDir: string;
  changes: ContentChange[];
  articles: {path:string;before:string|null;text:string}[];
  officeFiles: {path:string;before:string|null;size:number}[];
}
