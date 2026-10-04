import { HttpClient } from './http.js';
import { Batches } from './resources/batches.js';
import { Documents } from './resources/documents.js';
import type { TrydokuOptions } from './types/index.js';

/** Official server-side Node.js client for the TRYDOKU v1 API. */
export class Trydoku {
  readonly documents: Documents;
  readonly batches: Batches;

  constructor(options: TrydokuOptions) {
    const http = new HttpClient(options);
    this.documents = new Documents(http);
    this.batches = new Batches(http);
  }
}
