function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`The batch payload is missing a valid "${name}" field.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`The batch payload has an invalid "${name}" field.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`The batch payload is missing a valid "${name}" field.`);
  }
  return value;
}

function optionalTimestamp(value: unknown, name: string): string | null {
  const timestamp = optionalString(value, name);
  if (timestamp === null || timestamp === '') {
    return null;
  }
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new TypeError(`The batch payload has an invalid "${name}" field.`);
  }
  return timestamp;
}

/** Related resource links supplied by the API. */
export class BatchLinks {
  constructor(
    public readonly self: string,
    public readonly zip: string | null = null,
  ) {
    Object.freeze(this);
  }

  static fromArray(value: unknown): BatchLinks {
    const data = record(value, 'The batch payload "links" field');
    const zip = optionalString(data['zip'], 'links.zip');
    return new BatchLinks(requiredString(data['self'], 'links.self'), zip === '' ? null : zip);
  }
}

/** A document row within a generation batch. */
export class BatchItem {
  constructor(
    public readonly rowIndex: number,
    public readonly status: string,
    public readonly downloadUrl: string | null = null,
    public readonly error: string | null = null,
  ) {
    Object.freeze(this);
  }

  static fromArray(value: unknown): BatchItem {
    const data = record(value, 'The batch item');
    return new BatchItem(
      nonnegativeInteger(data['row_index'], 'row_index'),
      requiredString(data['status'], 'status'),
      optionalString(data['download_url'], 'download_url'),
      optionalString(data['error'], 'error'),
    );
  }

  isCompleted(): boolean {
    return this.status === 'completed';
  }

  isFailed(): boolean {
    return this.status === 'failed';
  }
}

/** A document generation batch with status helpers. */
export class Batch {
  public readonly items: readonly BatchItem[];

  constructor(
    public readonly id: string,
    public readonly status: string,
    public readonly setupStatus: string,
    public readonly totalItems: number,
    public readonly processedItems: number,
    public readonly failedItems: number,
    public readonly createdAt: string | null,
    public readonly updatedAt: string | null,
    public readonly links: BatchLinks,
    items: readonly BatchItem[] = [],
    public readonly code: string | null = null,
  ) {
    this.items = Object.freeze([...items]);
    Object.freeze(this);
  }

  static fromApiResponse(value: unknown): Batch {
    const response = record(value, 'The API response');
    const code = optionalString(response['code'], 'code');
    return Batch.fromArray(response['data'], code);
  }

  static fromArray(value: unknown, code: string | null = null): Batch {
    const data = record(value, 'The batch payload');
    const setupStatus = data['setup_status'] === undefined ? '' : data['setup_status'];
    if (typeof setupStatus !== 'string') {
      throw new TypeError('The batch payload has an invalid "setup_status" field.');
    }

    const rawItems = data['items'];
    const items: BatchItem[] = [];
    if (rawItems !== undefined) {
      if (!Array.isArray(rawItems)) {
        throw new TypeError('The batch payload has an invalid "items" field.');
      }
      for (let index = 0; index < rawItems.length; index += 1) {
        try {
          items.push(BatchItem.fromArray(rawItems[index] as unknown));
        } catch (cause) {
          throw new TypeError(`The batch payload has an invalid items[${index}] entry.`, { cause });
        }
      }
    }

    return new Batch(
      requiredString(data['id'], 'id'),
      requiredString(data['status'], 'status'),
      setupStatus,
      nonnegativeInteger(data['total_items'], 'total_items'),
      nonnegativeInteger(data['processed_items'], 'processed_items'),
      nonnegativeInteger(data['failed_items'], 'failed_items'),
      optionalTimestamp(data['created_at'], 'created_at'),
      optionalTimestamp(data['updated_at'], 'updated_at'),
      BatchLinks.fromArray(data['links']),
      items,
      code,
    );
  }

  isCompleted(): boolean {
    return this.status === 'completed';
  }

  isProcessing(): boolean {
    return this.status === 'processing';
  }

  isSetupPending(): boolean {
    return (
      this.code === 'GENERATION_SETUP_PENDING' ||
      this.setupStatus === 'pending' ||
      this.setupStatus === 'setup_pending'
    );
  }

  isSetupFailed(): boolean {
    return (
      this.code === 'GENERATION_SETUP_FAILED' ||
      this.setupStatus === 'failed' ||
      this.setupStatus === 'setup_failed'
    );
  }

  hasFailed(): boolean {
    return this.failedItems > 0;
  }

  isTerminal(): boolean {
    return this.isSetupFailed() || (!this.isSetupPending() && (this.isCompleted() || this.status === 'failed'));
  }
}
