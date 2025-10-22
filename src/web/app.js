import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

// Toolpath UI elements
const toolFileInput = document.getElementById('tool-file-input');
const toolFilenameEl = document.getElementById('tool-filename');
const xStepInput = document.getElementById('x-step-input');
const yStepInput = document.getElementById('y-step-input');
const zFloorInput = document.getElementById('z-floor-input');
const generateToolpathBtn = document.getElementById('generate-toolpath-btn');
const clearToolpathBtn = document.getElementById('clear-toolpath-btn');

// Timing panel elements
const timingPanel = document.getElementById('timing-panel');
const timingTerrainEl = document.getElementById('timing-terrain');
const timingToolEl = document.getElementById('timing-tool');
const timingToolpathEl = document.getElementById('timing-toolpath');

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

// Timing data
let timingData = {
    terrainConversion: null,
    toolConversion: null,
    toolpathGeneration: null
};

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

            // Recompute terrain - need to read file fresh
            console.log('Recomputing terrain with step size:', STEP_SIZE, 'mm');
            const terrainReader = new FileReader();
            terrainReader.onload = function(e) {
                terrainWorker.postMessage({
                    type: 'process-stl',
                    data: {
                        buffer: e.target.result,
                        stepSize: STEP_SIZE,
                        filterMode: 0 // FILTER_UPWARD_FACING for terrain
                    }
                }, [e.target.result]);
            };
            terrainReader.readAsArrayBuffer(lastLoadedFile);

            // If tool was loaded, recompute it too
            if (toolFile) {
                console.log('Recomputing tool with step size:', STEP_SIZE, 'mm');

                const toolReader = new FileReader();
                toolReader.onload = function(e) {
                    toolWorker.postMessage({
                        type: 'process-stl',
                        data: {
                            buffer: e.target.result,
                            stepSize: STEP_SIZE,
                            filterMode: 1 // FILTER_DOWNWARD_FACING for tool
                        }
                    }, [e.target.result]);
                };
                toolReader.readAsArrayBuffer(toolFile);
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

// Web Worker setup
function initWorkers() {
    // Terrain worker
    terrainWorker = new Worker('worker.js');
    terrainWorker.onmessage = function(e) {
        const { type, data, message } = e.data;
        console.log('Terrain worker received message:', type);

        switch (type) {
            case 'wasm-ready':
                console.log('Terrain worker WASM ready');
                break;

            case 'status':
                console.log('Terrain worker status:', message);
                updateStatus(message);
                break;

            case 'conversion-complete':
                console.log('Terrain worker: conversion complete, points:', data.pointCount);
                terrainData = data;
                displayPointCloud(data);
                updateStatus('Terrain complete');

                // Store timing
                if (e.data.conversionTime !== undefined) {
                    timingData.terrainConversion = e.data.conversionTime;
                    updateTimingPanel();
                }
                break;

            case 'error':
                console.error('Terrain worker error:', message);
                updateStatus('Error: ' + message);
                alert('Error: ' + message);
                break;
        }
    };

    terrainWorker.onerror = function(error) {
        console.error('Terrain worker error:', error);
        updateStatus('Terrain worker error');
    };

    // Tool worker
    toolWorker = new Worker('worker.js');
    toolWorker.onmessage = function(e) {
        const { type, data, message } = e.data;

        switch (type) {
            case 'wasm-ready':
                console.log('Tool worker WASM ready');
                break;

            case 'status':
                updateStatus(message);
                break;

            case 'conversion-complete':
                toolData = data;
                console.log('Tool loaded:', data.pointCount, 'points');

                // Store timing
                if (e.data.conversionTime !== undefined) {
                    timingData.toolConversion = e.data.conversionTime;
                    updateTimingPanel();
                }

                // Display tool above terrain
                displayTool(data);
                updateStatus('Tool complete');
                break;

            case 'error':
                console.error('Tool worker error:', message);
                updateStatus('Error: ' + message);
                alert('Error: ' + message);
                break;
        }
    };

    toolWorker.onerror = function(error) {
        console.error('Tool worker error:', error);
        updateStatus('Tool worker error');
    };

    // Toolpath worker
    toolpathWorker = new Worker('worker.js');
    toolpathWorker.onmessage = function(e) {
        const { type, data, message } = e.data;

        switch (type) {
            case 'wasm-ready':
                console.log('Toolpath worker WASM ready');
                updateStatus('Ready');
                break;

            case 'status':
                updateStatus(message);
                break;

            case 'toolpath-complete':
                displayToolpath(data);
                updateStatus('Toolpath complete');
                generateToolpathBtn.disabled = false;

                // Store timing
                if (e.data.generationTime !== undefined) {
                    timingData.toolpathGeneration = e.data.generationTime;
                    updateTimingPanel();
                }
                break;

            case 'error':
                console.error('Toolpath worker error:', message);
                updateStatus('Error: ' + message);
                alert('Error: ' + message);
                break;
        }
    };

    toolpathWorker.onerror = function(error) {
        console.error('Toolpath worker error:', error);
        updateStatus('Toolpath worker error');
    };
}

// Update status display
function updateStatus(status) {
    statusEl.textContent = status;
}

// Display point cloud in scene
function displayPointCloud(data) {
    const renderStart = performance.now();
    const { positions, pointCount, bounds } = data;
    console.log('displayPointCloud: received', pointCount, 'points,', positions.byteLength, 'bytes');

    // Track if this is the first load (to reset camera)
    const isFirstLoad = pointCloud === null;

    // Remove existing point cloud
    if (pointCloud) {
        scene.remove(pointCloud);
        pointCloud.geometry.dispose();
        pointCloud.material.dispose();
    }

    const geomStart = performance.now();
    // Create point cloud geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Create checkerboard pattern colors for better surface visualization
    const colors = new Float32Array(pointCount * 3);
    const color1 = new THREE.Color(0x00ffff); // Cyan
    const color2 = new THREE.Color(0x00cccc); // Slightly darker cyan

    for (let i = 0; i < pointCount; i++) {
        // Checkerboard based on position in array
        const x = Math.floor(positions[i * 3] / STEP_SIZE);
        const y = Math.floor(positions[i * 3 + 1] / STEP_SIZE);
        const isEven = (x + y) % 2 === 0;
        const color = isEven ? color1 : color2;

        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
    }
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

    // Update info panel
    pointCountEl.textContent = pointCount.toLocaleString();
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

    // Create offset positions
    const offsetPositions = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
        offsetPositions[i] = positions[i];     // X
        offsetPositions[i + 1] = positions[i + 1]; // Y
        offsetPositions[i + 2] = positions[i + 2] + zOffset; // Z + offset
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
    if (timingData.terrainConversion !== null) {
        timingTerrainEl.textContent = timingData.terrainConversion.toFixed(2) + ' ms';
    }
    if (timingData.toolConversion !== null) {
        timingToolEl.textContent = timingData.toolConversion.toFixed(2) + ' ms';
    }
    if (timingData.toolpathGeneration !== null) {
        timingToolpathEl.textContent = timingData.toolpathGeneration.toFixed(2) + ' ms';
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
    const material = new THREE.PointsMaterial({
        size: gridStep * 3.0, // Larger than terrain points for visibility
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

    // Hide drop zone - move to corner
    dropZone.classList.add('minimized');

    processFile(file);
}

function processFile(file) {
    updateStatus('Loading file...');

    const reader = new FileReader();

    reader.onload = function(e) {
        const buffer = e.target.result;
        console.log('File loaded, buffer size:', buffer.byteLength);

        // Send to terrain worker for processing
        // Terrain uses upward-facing filter (0)
        console.log('Sending to terrain worker...');
        terrainWorker.postMessage({
            type: 'process-stl',
            data: {
                buffer: buffer,
                stepSize: STEP_SIZE,
                filterMode: 0 // FILTER_UPWARD_FACING for terrain
            }
        }, [buffer]); // Transfer buffer ownership
        console.log('Message sent to terrain worker');
    };

    reader.onerror = function() {
        updateStatus('Error reading file');
        alert('Failed to read file');
    };

    reader.readAsArrayBuffer(file);
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

        // Convert tool immediately
        if (terrainData) {
            console.log('Converting tool STL:', file.name);
            updateStatus('Converting tool...');

            try {
                const buffer = await file.arrayBuffer();

                // Send to tool worker
                toolWorker.postMessage({
                    type: 'process-stl',
                    data: {
                        buffer: buffer,
                        stepSize: STEP_SIZE,
                        filterMode: 1 // FILTER_DOWNWARD_FACING for tool
                    }
                }, [buffer]);

                // Enable generate button
                generateToolpathBtn.disabled = false;
            } catch (error) {
                console.error('Error loading tool:', error);
                alert('Error loading tool: ' + error.message);
            }
        } else {
            alert('Please load terrain first');
        }
    }
});

generateToolpathBtn.addEventListener('click', async () => {
    if (!terrainData || !toolData) {
        alert('Please load both terrain and tool STL files first');
        return;
    }

    console.log('Generating toolpath...');
    updateStatus('Generating toolpath...');

    // Disable button during processing
    generateToolpathBtn.disabled = true;

    try {

        // Now generate toolpath
        const xStep = parseInt(xStepInput.value);
        const yStep = parseInt(yStepInput.value);
        const zFloor = parseFloat(zFloorInput.value);

        console.log('Generating toolpath with X step:', xStep, 'Y step:', yStep, 'Z floor:', zFloor, 'Grid step:', STEP_SIZE);
        updateStatus('Generating toolpath...');

        toolpathWorker.postMessage({
            type: 'generate-toolpath',
            data: {
                terrainPoints: terrainData.positions,
                toolPoints: toolData.positions,
                xStep: xStep,
                yStep: yStep,
                oobZ: zFloor,
                gridStep: STEP_SIZE
            }
        });

        // Enable clear button
        clearToolpathBtn.disabled = false;

    } catch (error) {
        console.error('Error generating toolpath:', error);
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

// Initialize
initScene();
initWorkers();
