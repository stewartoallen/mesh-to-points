import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Configuration
const STEP_SIZE = 1.0; // mm

// DOM elements
const canvas = document.getElementById('canvas');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const infoPanel = document.getElementById('info');
const statusEl = document.getElementById('status');
const pointCountEl = document.getElementById('point-count');
const boundsEl = document.getElementById('bounds');

// Three.js scene setup
let scene, camera, renderer, controls;
let pointCloud = null;
let worker = null;

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
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(100, 20, 0x444444, 0x222222);
    scene.add(gridHelper);

    // Axes helper
    const axesHelper = new THREE.AxesHelper(10);
    scene.add(axesHelper);

    // Window resize handler
    window.addEventListener('resize', onWindowResize);

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
function initWorker() {
    worker = new Worker('worker.js');

    worker.onmessage = function(e) {
        const { type, data, message } = e.data;

        switch (type) {
            case 'wasm-ready':
                console.log('WASM module ready');
                updateStatus('Ready');
                break;

            case 'status':
                updateStatus(message);
                break;

            case 'conversion-complete':
                displayPointCloud(data);
                updateStatus('Complete');
                break;

            case 'error':
                console.error('Worker error:', message);
                updateStatus('Error: ' + message);
                alert('Error: ' + message);
                break;
        }
    };

    worker.onerror = function(error) {
        console.error('Worker error:', error);
        updateStatus('Worker error');
    };
}

// Update status display
function updateStatus(status) {
    statusEl.textContent = status;
}

// Display point cloud in scene
function displayPointCloud(data) {
    const { positions, pointCount, bounds } = data;

    // Remove existing point cloud
    if (pointCloud) {
        scene.remove(pointCloud);
        pointCloud.geometry.dispose();
        pointCloud.material.dispose();
    }

    // Create point cloud geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    // Create point cloud material
    const material = new THREE.PointsMaterial({
        size: 0.5,
        color: 0x00ffff,
        sizeAttenuation: true
    });

    // Create point cloud mesh
    pointCloud = new THREE.Points(geometry, material);
    scene.add(pointCloud);

    // Update info panel
    pointCountEl.textContent = pointCount.toLocaleString();
    boundsEl.textContent = `${formatBounds(bounds.min)} to ${formatBounds(bounds.max)}`;
    infoPanel.classList.remove('hidden');

    // Center camera on the model
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

    console.log(`Point cloud created: ${pointCount} points`);
}

function formatBounds(vec) {
    return `(${vec.x.toFixed(2)}, ${vec.y.toFixed(2)}, ${vec.z.toFixed(2)})`;
}

// File handling
function handleFile(file) {
    console.log('handleFile called with:', file);

    if (!file || !file.name.toLowerCase().endsWith('.stl')) {
        alert('Please select a valid STL file');
        return;
    }

    console.log('File is valid STL:', file.name);

    // Hide drop zone - move to corner
    dropZone.classList.add('minimized');

    updateStatus('Loading file...');

    const reader = new FileReader();

    reader.onload = function(e) {
        const buffer = e.target.result;
        console.log('File loaded, buffer size:', buffer.byteLength);

        // Send to worker for processing
        console.log('Sending to worker...');
        worker.postMessage({
            type: 'process-stl',
            data: {
                buffer: buffer,
                stepSize: STEP_SIZE
            }
        }, [buffer]); // Transfer buffer ownership
        console.log('Message sent to worker');
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

// Initialize
initScene();
initWorker();
