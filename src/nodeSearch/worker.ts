import { parentPort, workerData } from 'node:worker_threads';
import { SearchEngine } from './engine';
import type { EngineOptions, SearchRequest } from './types';

const port = parentPort!;
const engine = new SearchEngine(workerData as EngineOptions, progress => port.postMessage({ type: 'progress', progress }));
port.on('message', async (message: { id: number; operation: 'search' | 'prepare' | 'load' | 'cancel'; request?: SearchRequest }) => {
    if (message.operation === 'cancel') { engine.cancel(); return; }
    try {
        const result = await engine.run(message.operation, message.request);
        port.postMessage({ type: 'result', id: message.id, result });
    } catch (error) {
        port.postMessage({ type: 'error', id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
});
