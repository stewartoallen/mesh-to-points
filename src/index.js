// stl-to-mesh: STL to Point Mesh converter using WebGPU
// Main ESM entry point

/**
 * Main class for STL to mesh conversion using WebGPU
 * Manages WebGPU worker lifecycle and provides async API for conversions
 */
export class STLToMesh {
    constructor() {
        this.worker = null;
        this.isInitialized = false;
        this.messageHandlers = new Map();
        this.messageId = 0;
    }

    /**
     * Initialize WebGPU worker
     * Must be called before any processing operations
     * @returns {Promise<boolean>} Success status
     */
    async init() {
        if (this.isInitialized) {
            return true;
        }

        return new Promise((resolve, reject) => {
            try {
                // Create worker from the webgpu-worker.js file
                const workerPath = new URL('./web/webgpu-worker.js', import.meta.url);
                this.worker = new Worker(workerPath, { type: 'module' });

                // Set up message handler
                this.worker.onmessage = (e) => this._handleMessage(e);
                this.worker.onerror = (error) => {
                    console.error('[STLToMesh] Worker error:', error);
                    reject(error);
                };

                // Send init message
                const handler = (success) => {
                    this.isInitialized = success;
                    if (success) {
                        resolve(true);
                    } else {
                        reject(new Error('Failed to initialize WebGPU'));
                    }
                };

                this._sendMessage('init', null, 'webgpu-ready', handler);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Convert STL buffer to point mesh
     * @param {ArrayBuffer} stlBuffer - Binary STL data
     * @param {number} stepSize - Grid resolution (e.g., 0.05)
     * @param {number} filterMode - 0 for max Z, 1 for min Z
     * @param {object} boundsOverride - Optional bounding box {min: {x, y, z}, max: {x, y, z}}
     * @returns {Promise<{positions: Float32Array, pointCount: number, bounds: object}>}
     */
    async rasterizeSTL(stlBuffer, stepSize, filterMode = 0, boundsOverride = null) {
        if (!this.isInitialized) {
            throw new Error('STLToMesh not initialized. Call init() first.');
        }

        // Parse STL to triangles
        const triangles = this._parseSTL(stlBuffer);

        return new Promise((resolve, reject) => {
            const handler = (data) => {
                resolve(data);
            };

            this._sendMessage(
                'rasterize',
                { triangles, stepSize, filterMode, isForTool: false, boundsOverride },
                'rasterize-complete',
                handler
            );
        });
    }

    /**
     * Generate toolpath from terrain and tool meshes
     * @param {Float32Array} terrainPositions - Terrain point cloud positions
     * @param {Float32Array} toolPositions - Tool point cloud positions
     * @param {number} xStep - X-axis step size
     * @param {number} yStep - Y-axis step size
     * @param {number} zFloor - Z floor value
     * @param {number} gridStep - Grid resolution
     * @returns {Promise<{pathData: Float32Array, numScanlines: number, pointsPerLine: number, generationTime: number}>}
     */
    async generateToolpath(terrainPositions, toolPositions, xStep, yStep, zFloor, gridStep) {
        if (!this.isInitialized) {
            throw new Error('STLToMesh not initialized. Call init() first.');
        }

        return new Promise((resolve, reject) => {
            const handler = (data) => {
                resolve(data);
            };

            this._sendMessage(
                'generate-toolpath',
                { terrainPositions, toolPositions, xStep, yStep, zFloor, gridStep },
                'toolpath-complete',
                handler
            );
        });
    }

    /**
     * Dispose of worker and cleanup resources
     */
    dispose() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
            this.isInitialized = false;
            this.messageHandlers.clear();
        }
    }

    // Internal methods

    _handleMessage(e) {
        const { type, success, data } = e.data;

        // Find handler for this message type
        for (const [id, handler] of this.messageHandlers.entries()) {
            if (handler.responseType === type) {
                this.messageHandlers.delete(id);
                if (type === 'webgpu-ready') {
                    handler.callback(success);
                } else {
                    handler.callback(data);
                }
                break;
            }
        }
    }

    _sendMessage(type, data, responseType, callback) {
        const id = this.messageId++;
        this.messageHandlers.set(id, { responseType, callback });
        this.worker.postMessage({ type, data });
    }

    _parseSTL(buffer) {
        const view = new DataView(buffer);
        const isASCII = this._isASCIISTL(buffer);

        if (isASCII) {
            return this._parseASCIISTL(buffer);
        } else {
            return this._parseBinarySTL(view);
        }
    }

    _isASCIISTL(buffer) {
        const text = new TextDecoder().decode(buffer.slice(0, 80));
        return text.toLowerCase().startsWith('solid');
    }

    _parseASCIISTL(buffer) {
        const text = new TextDecoder().decode(buffer);
        const lines = text.split('\n');
        const triangles = [];
        let vertexCount = 0;
        let vertices = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('vertex')) {
                const parts = trimmed.split(/\s+/);
                vertices.push(
                    parseFloat(parts[1]),
                    parseFloat(parts[2]),
                    parseFloat(parts[3])
                );
                vertexCount++;
                if (vertexCount === 3) {
                    triangles.push(...vertices);
                    vertices = [];
                    vertexCount = 0;
                }
            }
        }

        return new Float32Array(triangles);
    }

    _parseBinarySTL(view) {
        const numTriangles = view.getUint32(80, true);
        const triangles = new Float32Array(numTriangles * 9); // 3 vertices * 3 components

        let offset = 84; // Skip 80-byte header + 4-byte count
        let floatIndex = 0;

        for (let i = 0; i < numTriangles; i++) {
            // Skip normal (12 bytes)
            offset += 12;

            // Read 3 vertices (9 floats)
            for (let j = 0; j < 9; j++) {
                triangles[floatIndex++] = view.getFloat32(offset, true);
                offset += 4;
            }

            // Skip attribute byte count (2 bytes)
            offset += 2;
        }

        return triangles;
    }
}

// Export helper for direct worker access if needed
export { default as WebGPUWorker } from './web/webgpu-worker.js';
