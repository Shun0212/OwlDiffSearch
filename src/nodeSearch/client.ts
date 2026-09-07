import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { EngineOptions, SearchProgress, SearchRequest } from './types';

export class NodeSearchClient {
    private worker?: Worker;
    private nextId = 0;
    private pending?: { id: number; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void };
    private disposed = false;
    onProgress?: (progress: SearchProgress) => void;
    onError?: (message: string) => void;
    onActivity?: (busy: boolean) => void;

    constructor(private readonly options: () => EngineOptions) {}

    get busy() { return this.pending !== undefined; }

    request(operation: 'search' | 'prepare' | 'load', request?: SearchRequest): Promise<Record<string, unknown>> {
        if (this.disposed) { return Promise.reject(new Error('The search engine has been disposed.')); }
        if (this.pending) { return Promise.reject(new Error('A search is already running. Wait for it to finish or cancel it.')); }
        if (!this.worker) {
            const worker = this.worker = new Worker(path.join(__dirname, 'worker.js'), { workerData: this.options() });
            worker.on('message', message => {
                if (this.worker !== worker) { return; }
                if (message.type === 'progress') { this.onProgress?.(message.progress); return; }
                if (message.id !== this.pending?.id) { return; }
                const pending = this.pending!; this.pending = undefined;
                this.onActivity?.(false);
                if (message.type === 'error') { pending.reject(new Error(message.error)); }
                else { pending.resolve(message.result); }
            });
            const failed = (error: Error) => {
                if (this.worker !== worker) { return; }
                this.worker = undefined;
                this.pending?.reject(error); this.pending = undefined;
                this.onActivity?.(false);
                this.onProgress?.({ active: false, phase: '', current: 0, total: 0 });
                this.onError?.(error.message);
            };
            worker.on('error', failed);
            worker.on('exit', code => failed(new Error(`The Node.js search worker exited (${code}). Run the search again to restart it.`)));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.nextId;
            this.pending = { id, resolve, reject };
            this.onActivity?.(true);
            this.worker!.postMessage({ id, operation, request });
        });
    }

    cancel() { this.worker?.postMessage({ operation: 'cancel' }); }

    async stop() {
        const worker = this.worker; this.worker = undefined;
        this.pending?.resolve({ cancelled: true, message: 'Search engine stopped.', results: [] });
        this.pending = undefined;
        this.onActivity?.(false);
        this.onProgress?.({ active: false, phase: '', current: 0, total: 0 });
        if (worker) { await worker.terminate(); }
    }

    dispose() { this.disposed = true; void this.stop(); }
}
