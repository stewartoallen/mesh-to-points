import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseSTL } from './parse-stl.js?v=1';

// Configuration
let STEP_SIZE = 0.1; // mm (default, can be changed via dropdown)

// DOM elements
const canvas = document.getElementById('canvas');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const stepSizeSelect = document.getElementById('step-size-select');
const recomputeBtn = document.getElementById('recompute-btn');
const infoPanel = document.getElementById('info');
const statusEl = document.getElementById('status');
const pointCountEl = document.getElementById('point-count');
const boundsEl = document.getElementById('bounds');

// Bounds override UI elements
const useBoundsOverride = document.getElementById('use-bounds-override');
const boundsInputsDiv = document.getElementById('bounds-inputs');
const boundsMinX = document.getElementById('bounds-min-x');
const boundsMinY = document.getElementById('bounds-min-y');
const boundsMinZ = document.getElementById('bounds-min-z');
const boundsMaxX = document.getElementById('bounds-max-x');
const boundsMaxY = document.getElementById('bounds-max-y');
const boundsMaxZ = document.getElementById('bounds-max-z');
const boundsFromSTLBtn = document.getElementById('bounds-from-stl-btn');
const boundsAddPaddingBtn = document.getElementById('bounds-add-padding-btn');

// Toolpath UI elements
const toolFileInput = document.getElementById('tool-file-input');
const toolFilenameEl = document.getElementById('tool-filename');
const xStepInput = document.getElementById('x-step-input');
const yStepInput = document.getElementById('y-step-input');
const zFloorInput = document.getElementById('z-floor-input');
const generateToolpathBtn = document.getElementById('generate-toolpath-btn');
const clearToolpathBtn = document.getElementById('clear-toolpath-btn');
const showTerrainCheckbox = document.getElementById('show-terrain');

// Timing panel elements
const timingPanel = document.getElementById('timing-panel');
const timingTerrainEl = document.getElementById('timing-terrain');
const timingToolEl = document.getElementById('timing-tool');
const timingToolpathEl = document.getElementById('timing-toolpath');
const memoryTerrainEl = document.getElementById('memory-terrain');
const memoryToolEl = document.getElementById('memory-tool');
const memoryToolpathEl = document.getElementById('memory-toolpath');
const memoryTotalEl = document.getElementById('memory-total');
const tilingStatusEl = document.getElementById('tiling-status');
const gpuLimitEl = document.getElementById('gpu-limit');

// Store last loaded file for recompute
let lastLoadedFile = null;

// Three.js scene setup
let scene, camera, renderer, controls;
let pointCloud = null;
let toolCloud = null;
let toolpathCloud = null;
let terrainWorker = null;
let toolWorker = null;
let toolpathWorker = null;

// Store terrain and tool data for toolpath generation
let terrainData = null;
let toolData = null;
let toolFile = null;
let webgpuWorker = null;

// Store STL bounds for bounds override feature
let stlBounds = null;

// Device capabilities
let deviceCapabilities = null;

// Timing and memory data
let timingData = {
    terrainConversion: null,
    toolConversion: null,
    toolpathGeneration: null
};

let memoryData = {
    terrain: null,
    tool: null,
    toolpath: null
};

// Helper: Format bytes to human readable
function formatBytes(bytes) {
    if (bytes === 0 || bytes === null) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Helper: Calculate memory usage of data
function calculateMemory(data) {
    if (!data) return 0;
    let bytes = 0;

    // Positions (Float32Array)
    if (data.positions) {
        bytes += data.positions.byteLength;
    }

    // Path data (Float32Array)
    if (data.pathData) {
        bytes += data.pathData.byteLength;
    }

    // Add overhead for object structure (rough estimate)
    bytes += 1024; // ~1KB overhead

    return bytes;
}

// Helper: Get bounds override from UI inputs
function getBoundsOverride() {
    if (!useBoundsOverride.checked) {
        return null;
    }

    const minX = parseFloat(boundsMinX.value);
    const minY = parseFloat(boundsMinY.value);
    const minZ = parseFloat(boundsMinZ.value);
    const maxX = parseFloat(boundsMaxX.value);
    const maxY = parseFloat(boundsMaxY.value);
    const maxZ = parseFloat(boundsMaxZ.value);

    if (isNaN(minX) || isNaN(minY) || isNaN(minZ) ||
        isNaN(maxX) || isNaN(maxY) || isNaN(maxZ)) {
        alert('Please fill in all bounds values');
        return null;
    }

    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ }
    };
}

function initScene() {
    // Scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    // Camera
    camera = new THREE.PerspectiveCamera(
        75,
        window.innerWidth / window.innerHeight,
        0.1,
        10000
    );
    camera.position.set(50, 50, 50);

    // Renderer
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(100, 20, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Axes helper (X=red, Y=green, Z=blue)
    const axesHelper = new THREE.AxesHelper(20);
    scene.add(axesHelper);

    // Add axis labels
    function createTextSprite(text, color) {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 64;
        canvas.height = 64;

        context.clearRect(0, 0, 64, 64);
        context.font = 'Bold 40px Arial';
        context.fillStyle = color;
        context.textAlign = 'center';
        context.fillText(text, 32, 40);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.scale.set(5, 5, 1);
        return sprite;
    }

    const xLabel = createTextSprite('X', '#ff0000');
    xLabel.position.set(25, 0, 0);
    scene.add(xLabel);

    const yLabel = createTextSprite('Z', '#00ff00');
    yLabel.position.set(0, 25, 0);
    scene.add(yLabel);

    const zLabel = createTextSprite('Y', '#0000ff');
    zLabel.position.set(0, 0, 25);
    scene.add(zLabel);

    // Window resize handler
    window.addEventListener('resize', onWindowResize);

    // Step size dropdown handler
    stepSizeSelect.addEventListener('change', (e) => {
        STEP_SIZE = parseFloat(e.target.value);
        console.log('Step size changed to:', STEP_SIZE, 'mm');
    });

    // Bounds override checkbox handler
    useBoundsOverride.addEventListener('change', (e) => {
        boundsInputsDiv.style.display = e.target.checked ? 'block' : 'none';

        // If enabling and bounds are empty, auto-populate from terrain
        if (e.target.checked && !boundsMinX.value && terrainData && terrainData.bounds) {
            populateBoundsFromTerrain();
        }
    });

    // Helper to populate bounds from terrain data
    function populateBoundsFromTerrain() {
        if (terrainData && terrainData.bounds) {
            const bounds = terrainData.bounds;
            boundsMinX.value = bounds.min.x.toFixed(2);
            boundsMinY.value = bounds.min.y.toFixed(2);
            boundsMinZ.value = bounds.min.z.toFixed(2);
            boundsMaxX.value = bounds.max.x.toFixed(2);
            boundsMaxY.value = bounds.max.y.toFixed(2);
            boundsMaxZ.value = bounds.max.z.toFixed(2);
            console.log('Auto-populated bounds from terrain');
        }
    }

    // "From STL" button - populate bounds from last STL calculation
    boundsFromSTLBtn.addEventListener('click', () => {
        if (stlBounds) {
            boundsMinX.value = stlBounds.min.x.toFixed(2);
            boundsMinY.value = stlBounds.min.y.toFixed(2);
            boundsMinZ.value = stlBounds.min.z.toFixed(2);
            boundsMaxX.value = stlBounds.max.x.toFixed(2);
            boundsMaxY.value = stlBounds.max.y.toFixed(2);
            boundsMaxZ.value = stlBounds.max.z.toFixed(2);
        } else {
            alert('Please load an STL file first');
        }
    });

    // "Add Padding" button - add 10% padding to current bounds
    boundsAddPaddingBtn.addEventListener('click', () => {
        // Check if inputs are empty or invalid
        if (!boundsMinX.value || !boundsMinY.value || !boundsMinZ.value ||
            !boundsMaxX.value || !boundsMaxY.value || !boundsMaxZ.value) {
            alert('Please fill in all bounds values first (click "From STL" to populate)');
            return;
        }

        const minX = parseFloat(boundsMinX.value);
        const minY = parseFloat(boundsMinY.value);
        const minZ = parseFloat(boundsMinZ.value);
        const maxX = parseFloat(boundsMaxX.value);
        const maxY = parseFloat(boundsMaxY.value);
        const maxZ = parseFloat(boundsMaxZ.value);

        if (isNaN(minX) || isNaN(minY) || isNaN(minZ) ||
            isNaN(maxX) || isNaN(maxY) || isNaN(maxZ)) {
            alert('Invalid bounds values - please check your inputs');
            return;
        }

        if (minX >= maxX || minY >= maxY || minZ >= maxZ) {
            alert('Invalid bounds: min values must be less than max values');
            return;
        }

        const paddingX = (maxX - minX) * 0.1;
        const paddingY = (maxY - minY) * 0.1;
        const paddingZ = (maxZ - minZ) * 0.1;

        boundsMinX.value = (minX - paddingX).toFixed(2);
        boundsMinY.value = (minY - paddingY).toFixed(2);
        boundsMinZ.value = (minZ - paddingZ).toFixed(2);
        boundsMaxX.value = (maxX + paddingX).toFixed(2);
        boundsMaxY.value = (maxY + paddingY).toFixed(2);
        boundsMaxZ.value = (maxZ + paddingZ).toFixed(2);
    });

    // Recompute button handler
    recomputeBtn.addEventListener('click', async () => {
        if (lastLoadedFile) {
            console.log('Recomputing with step size:', STEP_SIZE, 'mm');

            // Clear existing toolpath since resolution changed
            if (toolpathCloud) {
                scene.remove(toolpathCloud);
                toolpathCloud.geometry.dispose();
                toolpathCloud.material.dispose();
                toolpathCloud = null;
                clearToolpathBtn.disabled = true;
            }

            // Clear tool visualization
            if (toolCloud) {
                scene.remove(toolCloud);
                toolCloud.geometry.dispose();
                toolCloud.material.dispose();
                toolCloud = null;
            }

            // Reset timing data
            timingData.terrainConversion = null;
            timingData.toolConversion = null;
            timingData.toolpathGeneration = null;
            timingTerrainEl.textContent = '-';
            timingToolEl.textContent = '-';
            timingToolpathEl.textContent = '-';

            // Clear tool data so it needs to be regenerated
            toolData = null;

            // Recompute terrain using WebGPU
            console.log('Recomputing terrain with step size:', STEP_SIZE, 'mm');

            {
                // WebGPU path
                processFileWebGPU(lastLoadedFile);

                // If tool was loaded, recompute it too
                if (toolFile) {
                    console.log('Recomputing tool with step size:', STEP_SIZE, 'mm');
                    setTimeout(async () => {
                        try {
                            updateStatus('Recomputing tool...');
                            const buffer = await toolFile.arrayBuffer();
                            const { positions, triangleCount } = parseSTL(buffer);
                            console.log('Parsed tool STL:', triangleCount, 'triangles');

                            // Send to WebGPU worker (tools don't use bounds override)
                            webgpuWorker.postMessage({
                                type: 'rasterize',
                                data: {
                                    triangles: positions,
                                    stepSize: STEP_SIZE,
                                    filterMode: 1, // 1 = DOWNWARD_FACING
                                    isForTool: true,
                                    boundsOverride: null
                                }
                            }, [positions.buffer]);
                        } catch (error) {
                            console.error('Error recomputing tool:', error);
                            updateStatus('Error: ' + error.message);
                        }
                    }, 100);
                }
            }
        }
    });

    // Start render loop
    animate();
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Configuration
const NUM_PARALLEL_WORKERS = 4; // Number of parallel workers for toolpath generation

// Web Worker setup
async function initWorkers() {
    // Initialize WebGPU worker
    webgpuWorker = new Worker('webgpu-worker.js');

    const webgpuReady = new Promise((resolve) => {
        webgpuWorker.onmessage = function(e) {
            if (e.data.type === 'webgpu-ready') {
                deviceCapabilities = e.data.data.capabilities;
                resolve(e.data.data.success);
            }
        };
    });

    // Send init message
    webgpuWorker.postMessage({ type: 'init' });

    // Wait for WebGPU to initialize
    const webgpuAvailable = await webgpuReady;

    // Display device capabilities
    if (deviceCapabilities) {
        console.log('WebGPU Device Capabilities:', deviceCapabilities);
    }

    if (!webgpuAvailable) {
        console.error('❌ WebGPU not available - application requires WebGPU support');
        updateStatus('Error: WebGPU not available');
        return;
    }

    // Set up WebGPU worker message handler
    webgpuWorker.onmessage = function(e) {
        const { type, data, success, isForTool } = e.data;

        switch (type) {
            case 'webgpu-ready':
                // Already handled above
                break;

            case 'rasterize-complete':
                console.log('WebGPU worker: rasterization complete, points:', data.pointCount, 'isForTool:', isForTool);
                handleRasterizeComplete(data, isForTool);
                break;

            case 'toolpath-complete':
                console.log('WebGPU worker: toolpath complete');
                handleToolpathComplete(data);
                break;

            case 'error':
                console.error('WebGPU worker error:', e.data.message);
                updateStatus('Error: ' + e.data.message);
                generateToolpathBtn.disabled = false;
                break;
        }
    };

    webgpuWorker.onerror = function(error) {
        console.error('WebGPU worker error:', error);
        updateStatus('WebGPU worker error');
    };

    console.log('✓ WebGPU worker initialized');

    // Auto-load last files from localStorage
    setTimeout(() => {
        const terrainFile = loadFileFromLocalStorage('lastTerrainFile');
        const toolFile = loadFileFromLocalStorage('lastToolFile');

        if (terrainFile) {
            console.log('💾 Auto-loading terrain:', terrainFile.name);
            handleFile(terrainFile);
        }

        if (toolFile) {
            console.log('💾 Auto-loading tool:', toolFile.name);
            // Wait a bit for terrain to load first
            setTimeout(() => {
                toolFileInput.files = createFileList(toolFile);
                toolFileInput.dispatchEvent(new Event('change'));
            }, 500);
        }
    }, 100);
}

// Helper to create FileList from File
function createFileList(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    return dataTransfer.files;
}

// Update status display
function updateStatus(status) {
    statusEl.textContent = status;
}

// Handle rasterization complete from WebGPU worker
function handleRasterizeComplete(data, isForTool) {
    console.log('handleRasterizeComplete:', {
        isForTool: isForTool,
        pointCount: data.pointCount,
        bounds: data.bounds,
        conversionTime: data.conversionTime,
        positionsLength: data.positions?.length
    });

    // Verify data integrity on main thread
    if (data.positions && data.positions.length > 0) {
        if (data.isDense) {
            // Dense format (terrain): Z-only array with sentinel value for empty cells
            const EMPTY_CELL = -1e10;
            const firstZ = data.positions[0] <= EMPTY_CELL + 1 ? 'EMPTY' : data.positions[0].toFixed(3);
            const lastZ = data.positions[data.positions.length-1] <= EMPTY_CELL + 1 ? 'EMPTY' : data.positions[data.positions.length-1].toFixed(3);
            console.log(`[Main Thread] Dense terrain: first Z=${firstZ}, last Z=${lastZ}, grid=${data.gridWidth}x${data.gridHeight}`);

            // Count empty cells (sentinel value)
            let emptyCount = 0;
            for (let i = 0; i < data.positions.length; i++) {
                if (data.positions[i] <= EMPTY_CELL + 1) emptyCount++;
            }
            const coverage = ((1 - emptyCount/data.positions.length) * 100).toFixed(1);
            console.log(`[Main Thread] Dense terrain: ${coverage}% coverage (${data.positions.length - emptyCount} valid cells)`);
        } else {
            // Sparse format (tool): X,Y,Z triplets
            const firstPoint = `(${data.positions[0].toFixed(3)}, ${data.positions[1].toFixed(3)}, ${data.positions[2].toFixed(3)})`;
            const lastIdx = data.positions.length - 3;
            const lastPoint = `(${data.positions[lastIdx].toFixed(3)}, ${data.positions[lastIdx+1].toFixed(3)}, ${data.positions[lastIdx+2].toFixed(3)})`;
            console.log(`[Main Thread] Sparse tool: first=${firstPoint}, last=${lastPoint}`);

            // Check for NaN or Infinity
            let hasInvalid = false;
            for (let i = 0; i < Math.min(data.positions.length, 100); i++) {
                if (!isFinite(data.positions[i])) {
                    hasInvalid = true;
                    console.error(`[Main Thread] Invalid value at index ${i}: ${data.positions[i]}`);
                    break;
                }
            }
            if (!hasInvalid) {
                console.log(`[Main Thread] Data integrity check passed`);
            }
        }
    }

    // Determine if this is terrain or tool based on parameter
    if (isForTool) {
        toolData = data;

        // DIAGNOSTIC: Inspect tool raster data for diagonal coverage
        console.log('\n=== TOOL RASTER DIAGNOSTIC ===');
        const { positions, pointCount, bounds } = data;
        console.log('Tool points:', pointCount);
        console.log('Tool bounds:', bounds);

        // Analyze coverage: check if we have points on all diagonals
        // Tool points are stored as [gridX, gridY, Z] triplets (sparse format)
        const gridPoints = new Map(); // Key: "x,y" -> Z value

        let minGridX = Infinity, maxGridX = -Infinity;
        let minGridY = Infinity, maxGridY = -Infinity;

        for (let i = 0; i < positions.length; i += 3) {
            const gridX = Math.round(positions[i]);
            const gridY = Math.round(positions[i + 1]);
            const z = positions[i + 2];

            const key = `${gridX},${gridY}`;
            gridPoints.set(key, z);

            minGridX = Math.min(minGridX, gridX);
            maxGridX = Math.max(maxGridX, gridX);
            minGridY = Math.min(minGridY, gridY);
            maxGridY = Math.max(maxGridY, gridY);
        }

        console.log(`Grid extent: X[${minGridX}, ${maxGridX}] Y[${minGridY}, ${maxGridY}]`);
        console.log(`Grid size: ${maxGridX - minGridX + 1} x ${maxGridY - minGridY + 1}`);
        console.log(`Expected cells: ${(maxGridX - minGridX + 1) * (maxGridY - minGridY + 1)}`);
        console.log(`Actual points: ${gridPoints.size}`);
        console.log(`Coverage: ${(gridPoints.size / ((maxGridX - minGridX + 1) * (maxGridY - minGridY + 1)) * 100).toFixed(1)}%`);

        // Check main diagonal (top-left to bottom-right)
        console.log('\nChecking main diagonal coverage:');
        const diagSize = Math.min(maxGridX - minGridX + 1, maxGridY - minGridY + 1);
        let diagMissing = 0;
        for (let i = 0; i < diagSize; i++) {
            const x = minGridX + i;
            const y = minGridY + i;
            const key = `${x},${y}`;
            if (!gridPoints.has(key)) {
                if (diagMissing < 10) { // Show first 10 missing
                    console.log(`  Missing: (${x}, ${y})`);
                }
                diagMissing++;
            }
        }
        console.log(`Main diagonal: ${diagSize - diagMissing}/${diagSize} present (${diagMissing} missing)`);

        // Check anti-diagonal (top-right to bottom-left)
        console.log('\nChecking anti-diagonal coverage:');
        let antiDiagMissing = 0;
        for (let i = 0; i < diagSize; i++) {
            const x = maxGridX - i;
            const y = minGridY + i;
            const key = `${x},${y}`;
            if (!gridPoints.has(key)) {
                if (antiDiagMissing < 10) {
                    console.log(`  Missing: (${x}, ${y})`);
                }
                antiDiagMissing++;
            }
        }
        console.log(`Anti-diagonal: ${diagSize - antiDiagMissing}/${diagSize} present (${antiDiagMissing} missing)`);
        console.log('=== END DIAGNOSTIC ===\n');

        displayTool(data);
        updateStatus('Tool complete');

        // Store timing and memory
        if (data.conversionTime !== undefined) {
            timingData.toolConversion = data.conversionTime;
        }
        memoryData.tool = calculateMemory(data);
        updateTimingPanel();

        // Enable generate button
        generateToolpathBtn.disabled = false;
    } else {
        terrainData = data;
        displayPointCloud(data);
        updateStatus('Terrain complete');

        // Store timing and memory
        if (data.conversionTime !== undefined) {
            timingData.terrainConversion = data.conversionTime;
        }
        memoryData.terrain = calculateMemory(data);
        updateTimingPanel();

        // Auto-populate bounds if custom bounds is enabled and inputs are empty
        if (useBoundsOverride.checked && !boundsMinX.value) {
            populateBoundsFromTerrain();
        }
    }
}

// Handle toolpath complete from WebGPU worker
function handleToolpathComplete(data) {
    displayToolpath(data);
    updateStatus('Toolpath complete (webgpu)');
    generateToolpathBtn.disabled = false;

    // Store timing and memory
    timingData.toolpathGeneration = data.generationTime;
    memoryData.toolpath = calculateMemory(data);
    updateTimingPanel();

    // Enable clear button
    clearToolpathBtn.disabled = false;
}

// Display point cloud in scene
function displayPointCloud(data) {
    const renderStart = performance.now();
    const { positions, pointCount, bounds, isDense, gridWidth, gridHeight } = data;
    console.log('displayPointCloud: received', pointCount, 'points,', positions.byteLength, 'bytes, isDense:', isDense);

    // Track if this is the first load (to reset camera)
    const isFirstLoad = pointCloud === null;

    // Remove existing point cloud
    if (pointCloud) {
        scene.remove(pointCloud);
        pointCloud.geometry.dispose();
        pointCloud.material.dispose();
    }

    const geomStart = performance.now();

    let worldPositions, colors, visualPointCount;

    if (isDense) {
        // DENSE TERRAIN: Convert 2D grid (Z-only) to 3D points
        // Only create points for valid cells (skip NaN)
        const tempPositions = [];
        const tempColors = [];
        const color1 = new THREE.Color(0x00ffff); // Cyan
        const color2 = new THREE.Color(0x00cccc); // Slightly darker cyan

        for (let gridY = 0; gridY < gridHeight; gridY++) {
            for (let gridX = 0; gridX < gridWidth; gridX++) {
                const idx = gridY * gridWidth + gridX;
                const z = positions[idx];

                // Skip empty cells (sentinel value = -1e10)
                const EMPTY_CELL = -1e10;
                if (z > EMPTY_CELL + 1) {
                    // Convert grid indices to world coordinates (mm)
                    const worldX = bounds.min.x + gridX * STEP_SIZE;
                    const worldY = bounds.min.y + gridY * STEP_SIZE;

                    tempPositions.push(worldX, worldY, z);

                    // Checkerboard pattern
                    const isEven = (gridX + gridY) % 2 === 0;
                    const color = isEven ? color1 : color2;
                    tempColors.push(color.r, color.g, color.b);
                }
            }
        }

        worldPositions = new Float32Array(tempPositions);
        colors = new Float32Array(tempColors);
        visualPointCount = tempPositions.length / 3;

        console.log(`displayPointCloud: Dense terrain converted ${visualPointCount} valid points from ${gridWidth}x${gridHeight} grid`);

    } else {
        // SPARSE (tool): Convert grid indices to world coordinates
        // GPU outputs [gridX, gridY, Z] where gridX/gridY are indices
        worldPositions = new Float32Array(positions.length);
        for (let i = 0; i < positions.length; i += 3) {
            const gridX = positions[i];
            const gridY = positions[i + 1];
            const z = positions[i + 2];

            // Convert grid indices to world coordinates
            worldPositions[i] = bounds.min.x + gridX * STEP_SIZE;
            worldPositions[i + 1] = bounds.min.y + gridY * STEP_SIZE;
            worldPositions[i + 2] = z;
        }

        // Create checkerboard pattern colors
        colors = new Float32Array(pointCount * 3);
        const color1 = new THREE.Color(0x00ffff); // Cyan
        const color2 = new THREE.Color(0x00cccc); // Slightly darker cyan

        for (let i = 0; i < pointCount; i++) {
            // Checkerboard based on grid indices (already integers)
            const gridX = Math.floor(positions[i * 3]);
            const gridY = Math.floor(positions[i * 3 + 1]);
            const isEven = (gridX + gridY) % 2 === 0;
            const color = isEven ? color1 : color2;

            colors[i * 3] = color.r;
            colors[i * 3 + 1] = color.g;
            colors[i * 3 + 2] = color.b;
        }

        visualPointCount = pointCount;
    }

    // Create point cloud geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(worldPositions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const geomTime = performance.now() - geomStart;
    console.log('displayPointCloud: geometry creation took', geomTime.toFixed(2), 'ms');

    // Calculate point size proportional to step size (raster density)
    // Point size should match or slightly exceed step size for complete coverage
    const pointSize = STEP_SIZE * 1.1; // 10% larger than step for slight overlap
    console.log('displayPointCloud: point size', pointSize.toFixed(3), 'mm (step:', STEP_SIZE, 'mm)');

    // Create point cloud material with vertex colors
    const material = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: true
    });

    // Create point cloud mesh
    pointCloud = new THREE.Points(geometry, material);

    // Rotate -π/2 around X axis to correct orientation
    pointCloud.rotation.x = -Math.PI / 2;

    scene.add(pointCloud);

    // Update info panel (use visualPointCount for display)
    pointCountEl.textContent = visualPointCount.toLocaleString();
    boundsEl.textContent = `${formatBounds(bounds.min)} to ${formatBounds(bounds.max)}`;
    infoPanel.classList.remove('hidden');

    // Only reset camera on first load
    if (isFirstLoad) {
        const center = new THREE.Vector3(
            (bounds.min.x + bounds.max.x) / 2,
            (bounds.min.y + bounds.max.y) / 2,
            (bounds.min.z + bounds.max.z) / 2
        );

        const size = Math.max(
            bounds.max.x - bounds.min.x,
            bounds.max.y - bounds.min.y,
            bounds.max.z - bounds.min.z
        );

        camera.position.set(
            center.x + size,
            center.y + size,
            center.z + size
        );

        controls.target.copy(center);
        controls.update();
    }

    const renderTotal = performance.now() - renderStart;
    console.log('displayPointCloud: TOTAL render creation took', renderTotal.toFixed(2), 'ms');
    console.log(`Point cloud created: ${pointCount} points`);
}

function formatBounds(vec) {
    return `(${vec.x.toFixed(2)}, ${vec.y.toFixed(2)}, ${vec.z.toFixed(2)})`;
}

// Display tool above terrain
function displayTool(data) {
    const { positions, pointCount, bounds } = data;
    console.log('displayTool: received', pointCount, 'points');

    // Remove existing tool cloud
    if (toolCloud) {
        scene.remove(toolCloud);
        toolCloud.geometry.dispose();
        toolCloud.material.dispose();
    }

    if (!terrainData || !terrainData.bounds) {
        console.warn('No terrain data available, cannot position tool');
        return;
    }

    // Position tool so its lowest point is at highest terrain point + 20mm
    const terrainBounds = terrainData.bounds;
    const toolBounds = bounds;

    // Find highest terrain Z (after rotation, this is Y in scene coordinates)
    const highestTerrainZ = terrainBounds.max.z;

    // Find lowest tool point Z
    const lowestToolZ = toolBounds.min.z;

    // Calculate offset: we want lowestToolZ + offset = highestTerrainZ + 20
    const zOffset = highestTerrainZ + 20 - lowestToolZ;

    console.log('displayTool: terrain max Z:', highestTerrainZ, 'tool min Z:', lowestToolZ, 'offset:', zOffset);

    // Convert grid indices to world coordinates and apply Z offset
    // GPU outputs [gridX, gridY, Z] where gridX/gridY are indices
    const offsetPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        const gridX = positions[i];
        const gridY = positions[i + 1];
        const z = positions[i + 2];

        // Convert grid indices to world coordinates
        offsetPositions[i] = bounds.min.x + gridX * STEP_SIZE;     // X
        offsetPositions[i + 1] = bounds.min.y + gridY * STEP_SIZE; // Y
        offsetPositions[i + 2] = z + zOffset;                      // Z + offset
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(offsetPositions, 3));

    // Color: semi-transparent yellow/gold
    const colors = new Float32Array(pointCount * 3);
    const color = new THREE.Color(0xffaa00); // Gold/yellow
    for (let i = 0; i < pointCount; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Calculate point size
    const pointSize = STEP_SIZE * 1.1;

    // Create material with transparency
    const material = new THREE.PointsMaterial({
        size: pointSize,
        vertexColors: true,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.6
    });

    // Create point cloud
    toolCloud = new THREE.Points(geometry, material);

    // Rotate to match terrain orientation
    toolCloud.rotation.x = -Math.PI / 2;

    scene.add(toolCloud);
    console.log('Tool displayed above terrain at Z offset:', zOffset);
}

// Update timing panel
function updateTimingPanel() {
    // Update timing values
    if (timingData.terrainConversion !== null) {
        timingTerrainEl.textContent = timingData.terrainConversion.toFixed(2) + ' ms';
    }
    if (timingData.toolConversion !== null) {
        timingToolEl.textContent = timingData.toolConversion.toFixed(2) + ' ms';
    }
    if (timingData.toolpathGeneration !== null) {
        timingToolpathEl.textContent = timingData.toolpathGeneration.toFixed(2) + ' ms';
    }

    // Update memory values
    if (memoryData.terrain !== null) {
        memoryTerrainEl.textContent = formatBytes(memoryData.terrain);
    }
    if (memoryData.tool !== null) {
        memoryToolEl.textContent = formatBytes(memoryData.tool);
    }
    if (memoryData.toolpath !== null) {
        memoryToolpathEl.textContent = formatBytes(memoryData.toolpath);
    }

    // Update total JS heap if available
    if (performance.memory) {
        memoryTotalEl.textContent = formatBytes(performance.memory.usedJSHeapSize);
    } else {
        memoryTotalEl.textContent = 'N/A';
    }

    // Update GPU / Tiling info
    if (deviceCapabilities) {
        gpuLimitEl.textContent = formatBytes(deviceCapabilities.maxStorageBufferBindingSize);
    }

    // Update tiling status from terrain data
    if (terrainData && terrainData.tileCount) {
        tilingStatusEl.textContent = `${terrainData.tileCount} tiles`;
    } else if (terrainData) {
        tilingStatusEl.textContent = 'No tiling';
    }

    // Show panel if any timing data exists
    if (timingData.terrainConversion !== null ||
        timingData.toolConversion !== null ||
        timingData.toolpathGeneration !== null) {
        timingPanel.classList.remove('hidden');
    }
}

// Display toolpath in scene
function displayToolpath(data) {
    console.log('displayToolpath: received data', data);
    const { pathData, numScanlines, pointsPerLine } = data;

    // Remove existing toolpath cloud
    if (toolpathCloud) {
        scene.remove(toolpathCloud);
        toolpathCloud.geometry.dispose();
        toolpathCloud.material.dispose();
    }

    // Keep tool visible (it stays at the start position)

    // Get terrain bounds to map grid back to world space
    if (!terrainData || !terrainData.bounds) {
        console.error('No terrain data available for toolpath visualization');
        return;
    }

    const bounds = terrainData.bounds;

    // The toolpath is in grid index space, we need to map it back to world coordinates
    // The grid step size used for the point cloud
    const gridStep = STEP_SIZE;

    // Get step sizes used in toolpath generation
    const xStep = parseInt(xStepInput.value);
    const yStep = parseInt(yStepInput.value);
    const zFloor = parseFloat(zFloorInput.value);

    console.log('displayToolpath: bounds', bounds);
    console.log('displayToolpath: gridStep', gridStep, 'xStep', xStep, 'yStep', yStep);
    console.log('displayToolpath: scanlines', numScanlines, 'pointsPerLine', pointsPerLine);
    console.log('displayToolpath: terrain grid dimensions from bounds:',
        'width =', (bounds.max.x - bounds.min.x) / gridStep,
        'height =', (bounds.max.y - bounds.min.y) / gridStep);

    // Create position array for toolpath points
    const positions = [];

    let pathIdx = 0;
    for (let iy = 0; iy < numScanlines; iy++) {
        for (let ix = 0; ix < pointsPerLine; ix++) {
            const z = pathData[pathIdx++];

            // Map grid indices to world coordinates
            // The toolpath uses stepped indices (ix*xStep, iy*yStep) in grid space
            const gridX = ix * xStep;
            const gridY = iy * yStep;

            // Convert grid indices to world coordinates
            const worldX = bounds.min.x + gridX * gridStep;
            const worldY = bounds.min.y + gridY * gridStep;

            // Only add points that are not at the floor level (filter out oob points)
            if (z > zFloor + 10) { // Filter out oob points (with 10mm margin)
                positions.push(worldX, worldY, z);
            }
        }
    }

    const positionsArray = new Float32Array(positions);
    const pointCount = positions.length / 3;

    console.log('displayToolpath: created', pointCount, 'toolpath points');
    // console.log('displayToolpath: first 3 points:', positionsArray.slice(0, 9));
    // console.log('displayToolpath: last 3 points:', positionsArray.slice(-9));

    // Calculate XY range of toolpath
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < positionsArray.length; i += 3) {
        const x = positionsArray[i];
        const y = positionsArray[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    console.log('displayToolpath: XY range: X[', minX, ',', maxX, '] Y[', minY, ',', maxY, ']');
    console.log('displayToolpath: terrain XY range: X[', bounds.min.x, ',', bounds.max.x, '] Y[', bounds.min.y, ',', bounds.max.y, ']');

    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3));

    // Create material - use red/orange color for toolpath
    // Scale point size based on the actual step values used
    const effectiveStep = Math.min(xStep, yStep) * gridStep;
    const pointSize = effectiveStep * 1.2; // 20% larger than effective step for visibility
    console.log('displayToolpath: point size', pointSize.toFixed(3), 'mm (xStep:', xStep, 'yStep:', yStep, 'gridStep:', gridStep, ')');

    const material = new THREE.PointsMaterial({
        size: pointSize,
        color: 0xff4400, // Orange-red
        sizeAttenuation: true
    });

    // Create point cloud
    toolpathCloud = new THREE.Points(geometry, material);

    // Apply same rotation as terrain
    toolpathCloud.rotation.x = -Math.PI / 2;

    scene.add(toolpathCloud);

    console.log('Toolpath visualization complete');
}

// File handling
function handleFile(file) {
    console.log('handleFile called with:', file);

    if (!file || !file.name.toLowerCase().endsWith('.stl')) {
        alert('Please select a valid STL file');
        return;
    }

    console.log('File is valid STL:', file.name);

    // Store file for recompute
    lastLoadedFile = file;
    recomputeBtn.disabled = false;

    // Save to localStorage for auto-reload
    saveFileToLocalStorage('lastTerrainFile', file);

    // Hide drop zone - move to corner
    dropZone.classList.add('minimized');

    processFile(file);
}

// Save file to localStorage
async function saveFileToLocalStorage(key, file) {
    try {
        const buffer = await file.arrayBuffer();
        const base64 = arrayBufferToBase64(buffer);
        localStorage.setItem(key, JSON.stringify({
            name: file.name,
            data: base64
        }));
        console.log(`💾 Saved ${file.name} to localStorage`);
    } catch (error) {
        console.error('Error saving file to localStorage:', error);
    }
}

// Load file from localStorage
function loadFileFromLocalStorage(key) {
    try {
        const stored = localStorage.getItem(key);
        if (!stored) return null;

        const { name, data } = JSON.parse(stored);
        const buffer = base64ToArrayBuffer(data);
        const file = new File([buffer], name, { type: 'application/octet-stream' });
        console.log(`💾 Loaded ${name} from localStorage`);
        return file;
    } catch (error) {
        console.error('Error loading file from localStorage:', error);
        return null;
    }
}

// Helper: ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Helper: Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

async function processFileWebGPU(file) {
    updateStatus('Loading file...');

    try {
        const buffer = await file.arrayBuffer();
        console.log('File loaded, buffer size:', buffer.byteLength);

        updateStatus('Parsing STL...');
        const { positions, triangleCount, bounds } = parseSTL(buffer);
        console.log('Parsed STL:', triangleCount, 'triangles');

        // Store STL bounds for bounds override feature
        stlBounds = bounds;

        updateStatus('Rasterizing with WebGPU...');

        // Get bounds override if enabled
        const boundsOverride = getBoundsOverride();

        // Send to WebGPU worker
        webgpuWorker.postMessage({
            type: 'rasterize',
            data: {
                triangles: positions,
                stepSize: STEP_SIZE,
                filterMode: 0, // 0 = UPWARD_FACING for terrain
                isForTool: false,
                boundsOverride
            }
        }, [positions.buffer]);
    } catch (error) {
        console.error('Error processing file with WebGPU:', error);
        updateStatus('Error: ' + error.message);
        alert('Error: ' + error.message);
    }
}

function processFile(file) {
    // Always use WebGPU
    processFileWebGPU(file);
}

// Drag and drop handlers
dropZone.addEventListener('click', () => {
    console.log('Drop zone clicked');
    fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('drag-over');
    console.log('Drag over');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    console.log('Drag leave');
});

dropZone.addEventListener('drop', (e) => {
    console.log('Drop event triggered');
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');

    const file = e.dataTransfer.files[0];
    console.log('Dropped file:', file);
    if (file) {
        handleFile(file);
    } else {
        console.log('No file in drop event');
    }
});

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        handleFile(file);
    }
});

// Toolpath UI event handlers
toolFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        toolFile = file;
        toolFilenameEl.textContent = file.name;

        // Save to localStorage for auto-reload
        saveFileToLocalStorage('lastToolFile', file);

        // Convert tool immediately
        if (terrainData) {
            console.log('Converting tool STL:', file.name);
            updateStatus('Converting tool...');

            try {
                // WebGPU worker path
                const buffer = await file.arrayBuffer();
                const { positions, triangleCount } = parseSTL(buffer);
                console.log('Parsed tool STL:', triangleCount, 'triangles');

                // Send to WebGPU worker (tools don't use bounds override)
                webgpuWorker.postMessage({
                    type: 'rasterize',
                    data: {
                        triangles: positions,
                        stepSize: STEP_SIZE,
                        filterMode: 1, // 1 = DOWNWARD_FACING for tool
                        isForTool: true,
                        boundsOverride: null
                    }
                }, [positions.buffer]);
            } catch (error) {
                console.error('Error loading tool:', error);
                alert('Error loading tool: ' + error.message);
            }
        } else {
            alert('Please load terrain first');
        }
    }
});

// Single-threaded WASM toolpath generation
async function generateToolpathSingle(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const startTime = performance.now();
    console.log('🔨 [WASM Single] Starting toolpath generation...');

    return new Promise((resolve, reject) => {
        const worker = new Worker('worker-parallel.js');

        worker.onmessage = function(e) {
            const { type, data } = e.data;

            if (type === 'wasm-ready') {
                // Worker ready, generate full toolpath (0 to end)
                worker.postMessage({
                    type: 'generate-toolpath-partial',
                    data: {
                        terrainPoints,
                        toolPoints,
                        xStep,
                        yStep,
                        oobZ,
                        gridStep,
                        startScanline: 0,
                        endScanline: 999999 // Large number to get all scanlines
                    }
                });
            } else if (type === 'toolpath-partial-complete') {
                const endTime = performance.now();
                const totalTime = endTime - startTime;

                console.log(`🔨 [WASM Single] ✅ Complete in ${totalTime.toFixed(1)}ms`);

                worker.terminate();

                resolve({
                    pathData: data.pathData,
                    numScanlines: data.numScanlines,
                    pointsPerLine: data.pointsPerLine,
                    generationTime: totalTime
                });
            } else if (type === 'error') {
                console.error('[WASM Single] Error:', data);
                worker.terminate();
                reject(new Error(data.message || 'Worker error'));
            }
        };

        worker.onerror = function(error) {
            console.error('[WASM Single] Worker error:', error);
            worker.terminate();
            reject(error);
        };
    });
}

// Parallel toolpath generation coordinator
async function generateToolpathParallel(terrainPoints, toolPoints, xStep, yStep, oobZ, gridStep) {
    const startTime = performance.now();

    // Create temporary worker to get dimensions
    const tempWorker = new Worker('worker-parallel.js');

    return new Promise((resolve, reject) => {
        let terrainDims = null;
        let totalScanlines = null;
        let pointsPerLine = null;

        tempWorker.onmessage = async function(e) {
            const { type, data } = e.data;

            if (type === 'wasm-ready') {
                // Get dimensions by requesting conversion
                const terrainSize = terrainPoints.length * 4;
                const toolSize = toolPoints.length * 4;

                // Use a quick helper: convert and get dimensions
                // For now, we'll calculate dimensions ourselves
                // pointsPerLine = ceil(terrainWidth / xStep), where terrainWidth comes from bounds

                // Calculate from bounds (approximate)
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;

                for (let i = 0; i < terrainPoints.length; i += 3) {
                    const x = terrainPoints[i];
                    const y = terrainPoints[i + 1];
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }

                const terrainWidth = Math.round((maxX - minX) / gridStep) + 1;
                const terrainHeight = Math.round((maxY - minY) / gridStep) + 1;

                pointsPerLine = Math.ceil(terrainWidth / xStep);
                totalScanlines = Math.ceil(terrainHeight / yStep);

                console.log(`📐 Terrain dimensions: ${terrainWidth}x${terrainHeight}, Toolpath: ${pointsPerLine}x${totalScanlines}`);

                // Close temp worker
                tempWorker.terminate();

                // Now spawn parallel workers
                const scanlinesPerWorker = Math.ceil(totalScanlines / NUM_PARALLEL_WORKERS);
                const workers = [];
                const results = [];
                let completedWorkers = 0;

                console.log(`🚀 Spawning ${NUM_PARALLEL_WORKERS} parallel workers...`);

                for (let i = 0; i < NUM_PARALLEL_WORKERS; i++) {
                    const startScanline = i * scanlinesPerWorker;
                    const endScanline = Math.min(startScanline + scanlinesPerWorker, totalScanlines);

                    if (startScanline >= totalScanlines) break;

                    console.log(`  Worker ${i}: scanlines ${startScanline}-${endScanline}`);

                    const worker = new Worker('worker-parallel.js');
                    const workerIndex = i;

                    worker.onmessage = function(e) {
                        const { type, data: workerData } = e.data;

                        if (type === 'wasm-ready') {
                            // Worker ready, send work
                            worker.postMessage({
                                type: 'generate-toolpath-partial',
                                data: {
                                    terrainPoints,
                                    toolPoints,
                                    xStep,
                                    yStep,
                                    oobZ,
                                    gridStep,
                                    startScanline,
                                    endScanline
                                }
                            });
                        } else if (type === 'toolpath-partial-complete') {
                            console.log(`  ✓ Worker ${workerIndex} completed`);
                            results[workerIndex] = workerData;
                            completedWorkers++;

                            // Terminate worker
                            worker.terminate();

                            // Check if all done
                            if (completedWorkers === workers.length) {
                                // Merge results
                                console.log('🔗 Merging results...');
                                const mergedData = new Float32Array(totalScanlines * pointsPerLine);

                                for (const result of results) {
                                    const startIdx = result.startScanline * result.pointsPerLine;
                                    mergedData.set(result.pathData, startIdx);
                                }

                                const endTime = performance.now();
                                const totalTime = endTime - startTime;

                                console.log(`✅ Parallel generation complete in ${totalTime.toFixed(1)}ms`);

                                resolve({
                                    pathData: mergedData,
                                    numScanlines: totalScanlines,
                                    pointsPerLine: pointsPerLine,
                                    generationTime: totalTime
                                });
                            }
                        } else if (type === 'error') {
                            console.error(`Worker ${workerIndex} error:`, workerData);
                            worker.terminate();
                            reject(new Error(workerData.message || 'Worker error'));
                        }
                    };

                    worker.onerror = function(error) {
                        console.error(`Worker ${workerIndex} error:`, error);
                        worker.terminate();
                        reject(error);
                    };

                    workers.push(worker);
                }
            } else if (type === 'error') {
                tempWorker.terminate();
                reject(new Error(data.message || 'Worker error'));
            }
        };

        tempWorker.onerror = function(error) {
            tempWorker.terminate();
            reject(error);
        };
    });
}

generateToolpathBtn.addEventListener('click', async () => {
    if (!terrainData || !toolData) {
        alert('Please load both terrain and tool STL files first');
        return;
    }

    console.log('🎯 Starting toolpath generation (webgpu)...');
    updateStatus('Generating toolpath (webgpu)...');

    // Disable button during processing
    generateToolpathBtn.disabled = true;

    try {
        const xStep = parseInt(xStepInput.value);
        const yStep = parseInt(yStepInput.value);
        const zFloor = parseFloat(zFloorInput.value);

        console.log('Parameters: X step:', xStep, 'Y step:', yStep, 'Z floor:', zFloor, 'Grid step:', STEP_SIZE);

        // Send to WebGPU worker (COPY data, don't transfer - we need to keep it)
        webgpuWorker.postMessage({
            type: 'generate-toolpath',
            data: {
                terrainPoints: terrainData.positions,
                toolPoints: toolData.positions,
                xStep,
                yStep,
                oobZ: zFloor,
                gridStep: STEP_SIZE,
                terrainBounds: terrainData.bounds // Pass terrain bounds for correct coordinate system
            }
        });
        // Result will be handled by the worker message handler
        return; // Exit early since async

    } catch (error) {
        console.error('Error generating toolpath:', error);
        updateStatus('Error: ' + error.message);
        alert('Error generating toolpath: ' + error.message);
        generateToolpathBtn.disabled = false;
    }
});

clearToolpathBtn.addEventListener('click', () => {
    if (toolpathCloud) {
        scene.remove(toolpathCloud);
        toolpathCloud.geometry.dispose();
        toolpathCloud.material.dispose();
        toolpathCloud = null;
        updateStatus('Toolpath cleared');
        clearToolpathBtn.disabled = true;
        // Tool remains visible at its start position
    }
});

// Show/hide terrain toggle
showTerrainCheckbox.addEventListener('change', (e) => {
    if (pointCloud) {
        pointCloud.visible = e.target.checked;
        console.log('Terrain visibility:', e.target.checked);
    }
});

// Initialize
initScene();
initWorkers();
