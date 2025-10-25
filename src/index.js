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
                // Support both source (src/index.js -> src/web/webgpu-worker.js)
                // and build (build/raster-path.js -> build/webgpu-worker.js)
                const isBuildVersion = import.meta.url.includes('/build/') || import.meta.url.includes('raster-path.js');
                const workerPath = isBuildVersion
                    ? new URL('./webgpu-worker.js', import.meta.url)
                    : new URL('./web/webgpu-worker.js', import.meta.url);
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
     * Generate radial toolpath (lathe-like operation)
     * Rotates terrain around X-axis, generates scanline at each angle
     * @param {Float32Array} terrainTriangles - Terrain mesh triangles
     * @param {Float32Array} toolPositions - Tool raster (sparse XYZ)
     * @param {number} xRotationStep - Degrees between each rotation
     * @param {number} xStep - Sampling step along X-axis
     * @param {number} zFloor - Z floor value for out-of-bounds
     * @param {number} gridStep - Rasterization resolution
     * @param {object} terrainBounds - Terrain bounding box {min: {x,y,z}, max: {x,y,z}}
     * @returns {Promise<{pathData: Float32Array, numRotations: number, pointsPerLine: number, rotationStepDegrees: number, generationTime: number}>}
     */
    async generateRadialToolpath(terrainTriangles, toolPositions, xRotationStep, xStep, zFloor, gridStep, terrainBounds) {
        if (!this.isInitialized) {
            throw new Error('RasterPath not initialized. Call init() first.');
        }

        const startTime = performance.now();

        // Calculate tool radius from tool positions (sparse XYZ format)
        let toolRadius = 0;
        for (let i = 0; i < toolPositions.length; i += 3) {
            const gridY = toolPositions[i + 1];
            const yWorld = gridY * gridStep;
            toolRadius = Math.max(toolRadius, Math.abs(yWorld));
        }

        // Generate rotation angles
        const angles = [];
        for (let angle = 0; angle < 360; angle += xRotationStep) {
            angles.push(angle);
        }

        console.log(`Generating radial toolpath: ${angles.length} rotations at ${xRotationStep}° steps`);
        console.log(`Tool radius: ${toolRadius.toFixed(2)}mm`);

        // Process each rotation sequentially
        const scanlines = [];
        for (let i = 0; i < angles.length; i++) {
            const angle = angles[i];
            console.log(`Processing rotation ${i + 1}/${angles.length}: ${angle}°`);

            // 1. Rotate terrain triangles
            const rotatedTriangles = this._rotateTrianglesAroundX(terrainTriangles, angle);

            // 2. Define strip bounds (full X, narrow Y band, full Z)
            const stripBounds = {
                min: {
                    x: terrainBounds.min.x,
                    y: -toolRadius,
                    z: terrainBounds.min.z
                },
                max: {
                    x: terrainBounds.max.x,
                    y: toolRadius,
                    z: terrainBounds.max.z
                }
            };

            if (i === 0) {
                console.log(`Strip bounds for rotation ${angle}°:`, stripBounds);
                console.log(`  X range: ${stripBounds.min.x.toFixed(2)} to ${stripBounds.max.x.toFixed(2)} (width: ${(stripBounds.max.x - stripBounds.min.x).toFixed(2)}mm)`);
            }

            // 3. Rasterize strip
            const stripRaster = await this.rasterizeMesh(rotatedTriangles, gridStep, 0, stripBounds);

            // 4. Generate scanline from strip
            const scanlineData = await new Promise((resolve, reject) => {
                const handler = (data) => {
                    resolve(data);
                };

                this._sendMessage(
                    'generate-radial-scanline',
                    {
                        stripPositions: stripRaster.positions,
                        stripBounds: stripRaster.bounds,
                        toolPositions,
                        xStep,
                        zFloor,
                        gridStep
                    },
                    'radial-scanline-complete',
                    handler
                );
            });

            scanlines.push(scanlineData.scanline);

            if (i === 0) {
                console.log(`  Scanline output: ${scanlineData.scanline.length} points`);
            }
        }

        const endTime = performance.now();
        const generationTime = endTime - startTime;

        // Combine scanlines into single Float32Array
        const pointsPerLine = scanlines[0].length;
        console.log(`Total scanline output: ${pointsPerLine} points per line, ${angles.length} lines`);
        const pathData = new Float32Array(angles.length * pointsPerLine);
        for (let i = 0; i < scanlines.length; i++) {
            pathData.set(scanlines[i], i * pointsPerLine);
        }

        console.log(`✅ Radial toolpath complete: ${angles.length} rotations × ${pointsPerLine} points in ${generationTime.toFixed(1)}ms`);

        return {
            pathData,
            numRotations: angles.length,
            pointsPerLine,
            rotationStepDegrees: xRotationStep,
            generationTime
        };
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

    _rotateTrianglesAroundX(triangles, angleDegrees) {
        const rad = angleDegrees * Math.PI / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const rotated = new Float32Array(triangles.length);

        // Rotate each vertex: X stays same, Y and Z rotate
        for (let i = 0; i < triangles.length; i += 3) {
            const x = triangles[i];
            const y = triangles[i + 1];
            const z = triangles[i + 2];

            rotated[i] = x;                      // X unchanged
            rotated[i + 1] = y * cos - z * sin;  // Y' = Y*cos - Z*sin
            rotated[i + 2] = y * sin + z * cos;  // Z' = Y*sin + Z*cos
        }

        return rotated;
    }
}

// Note: Direct worker export removed to support both src and build directory structures
// The worker is managed internally by the RasterPath class
