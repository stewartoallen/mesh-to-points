// raster-path: Terrain and Tool Raster Path Finder using WebGPU
// Main ESM entry point

/**
 * Configuration options for RasterPath
 * @typedef {Object} RasterPathConfig
 * @property {number} maxGPUMemoryMB - Maximum GPU memory per tile (default: 256MB)
 * @property {number} gpuMemorySafetyMargin - Safety margin as percentage (default: 0.8 = 80%)
 * @property {number} tileOverlapMM - Overlap between tiles in mm for toolpath continuity (default: 10mm)
 * @property {boolean} autoTiling - Automatically tile large datasets (default: true)
 * @property {number} minTileSize - Minimum tile dimension (default: 50mm)
 */

/**
 * Main class for rasterizing geometry and generating toolpaths using WebGPU
 * Manages WebGPU worker lifecycle and provides async API for conversions
 */
export class RasterPath {
    constructor(config = {}) {
        this.worker = null;
        this.isInitialized = false;
        this.messageHandlers = new Map();
        this.messageId = 0;
        this.deviceCapabilities = null;

        // Configuration with defaults
        this.config = {
            maxGPUMemoryMB: config.maxGPUMemoryMB ?? 256,
            gpuMemorySafetyMargin: config.gpuMemorySafetyMargin ?? 0.8,
            tileOverlapMM: config.tileOverlapMM ?? 10,
            autoTiling: config.autoTiling ?? true,
            minTileSize: config.minTileSize ?? 50,
        };
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
                    console.error('[RasterPath] Worker error:', error);
                    reject(error);
                };

                // Send init message with config
                const handler = (data) => {
                    this.isInitialized = data.success;
                    if (data.success) {
                        this.deviceCapabilities = data.capabilities;
                        resolve(true);
                    } else {
                        reject(new Error('Failed to initialize WebGPU'));
                    }
                };

                this._sendMessage('init', { config: this.config }, 'webgpu-ready', handler);
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Rasterize triangle mesh to height map
     * @param {Float32Array} triangles - Unindexed triangle positions (9 floats per triangle: v0.xyz, v1.xyz, v2.xyz)
     * @param {number} stepSize - Grid resolution (e.g., 0.05)
     * @param {number} filterMode - 0 for max Z (terrain), 1 for min Z (tool)
     * @param {object} boundsOverride - Optional bounding box {min: {x, y, z}, max: {x, y, z}}
     * @returns {Promise<{positions: Float32Array, pointCount: number, bounds: object}>}
     */
    async rasterizeMesh(triangles, stepSize, filterMode = 0, boundsOverride = null) {
        if (!this.isInitialized) {
            throw new Error('RasterPath not initialized. Call init() first.');
        }

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
     * Convert STL buffer to point mesh
     * @param {ArrayBuffer} stlBuffer - Binary STL data
     * @param {number} stepSize - Grid resolution (e.g., 0.05)
     * @param {number} filterMode - 0 for max Z (terrain), 1 for min Z (tool)
     * @param {object} boundsOverride - Optional bounding box {min: {x, y, z}, max: {x, y, z}}
     * @returns {Promise<{positions: Float32Array, pointCount: number, bounds: object}>}
     */
    async rasterizeSTL(stlBuffer, stepSize, filterMode = 0, boundsOverride = null) {
        // Parse STL to triangles
        const triangles = this._parseSTL(stlBuffer);

        // Rasterize the mesh
        return this.rasterizeMesh(triangles, stepSize, filterMode, boundsOverride);
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
            throw new Error('RasterPath not initialized. Call init() first.');
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
     * Get device capabilities
     * @returns {object|null} Device capabilities or null if not initialized
     */
    getDeviceCapabilities() {
        return this.deviceCapabilities;
    }

    /**
     * Get current configuration
     * @returns {object} Current configuration
     */
    getConfig() {
        return { ...this.config };
    }

    /**
     * Update configuration at runtime
     * @param {object} newConfig - Partial config to update
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        if (this.isInitialized) {
            this._sendMessage('update-config', { config: this.config }, null, () => {});
        }
    }

    /**
     * Estimate memory requirements for a rasterization job
     * @param {object} bounds - Bounding box {min: {x, y, z}, max: {x, y, z}}
     * @param {number} stepSize - Grid resolution
     * @returns {object} Memory estimation details
     */
    estimateMemory(bounds, stepSize) {
        const gridWidth = Math.ceil((bounds.max.x - bounds.min.x) / stepSize) + 1;
        const gridHeight = Math.ceil((bounds.max.y - bounds.min.y) / stepSize) + 1;
        const totalPoints = gridWidth * gridHeight;

        const gpuOutputBuffer = totalPoints * 3 * 4; // positions
        const gpuMaskBuffer = totalPoints * 4; // valid mask
        const totalGPUMemory = gpuOutputBuffer + gpuMaskBuffer;

        const maxSafeSize = this.deviceCapabilities
            ? this.deviceCapabilities.maxStorageBufferBindingSize * this.config.gpuMemorySafetyMargin
            : this.config.maxGPUMemoryMB * 1024 * 1024;

        const needsTiling = totalGPUMemory > maxSafeSize;

        return {
            gridWidth,
            gridHeight,
            totalPoints,
            gpuMemoryMB: totalGPUMemory / (1024 * 1024),
            maxSafeMB: maxSafeSize / (1024 * 1024),
            needsTiling,
            estimatedTiles: needsTiling ? this._estimateTileCount(bounds, stepSize, maxSafeSize) : 1
        };
    }

    /**
     * Query if a job will use tiling
     * @param {object} bounds - Bounding box
     * @param {number} stepSize - Grid resolution
     * @returns {boolean} True if tiling will be used
     */
    willUseTiling(bounds, stepSize) {
        if (!this.config.autoTiling) return false;
        const estimate = this.estimateMemory(bounds, stepSize);
        return estimate.needsTiling;
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
            this.deviceCapabilities = null;
        }
    }

    // Internal methods

    _estimateTileCount(bounds, stepSize, maxSafeSize) {
        const width = bounds.max.x - bounds.min.x;
        const height = bounds.max.y - bounds.min.y;

        // Binary search for optimal tile dimension
        let low = this.config.minTileSize;
        let high = Math.max(width, height);
        let bestTileDim = high;

        while (low <= high) {
            const mid = (low + high) / 2;
            const gridW = Math.ceil(mid / stepSize);
            const gridH = Math.ceil(mid / stepSize);
            const memoryNeeded = gridW * gridH * 4 * 4; // 4 bytes per coord * 4 coords (3 pos + 1 mask)

            if (memoryNeeded <= maxSafeSize) {
                bestTileDim = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        const tilesX = Math.ceil(width / bestTileDim);
        const tilesY = Math.ceil(height / bestTileDim);
        return tilesX * tilesY;
    }

    _handleMessage(e) {
        const { type, success, data } = e.data;

        // Find handler for this message type
        for (const [id, handler] of this.messageHandlers.entries()) {
            if (handler.responseType === type) {
                this.messageHandlers.delete(id);
                if (type === 'webgpu-ready') {
                    handler.callback(data);
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
