# Recompute Button Feature

## ✅ Feature Added

Allows users to change detail level and reprocess the same STL file without re-dropping it.

## UI Layout

```
Top-right controls:
┌─────────────────────────────────────┐
│ Detail: [0.1mm (High) ▼] [Recompute] │
└─────────────────────────────────────┘
```

## User Workflow

### Before (without recompute button)
1. Drop inner.stl at 1.0mm
2. View result
3. Want more detail → Change to 0.1mm
4. ❌ Have to find file and drag/drop again
5. ❌ Tedious, especially for repeated changes

### After (with recompute button)
1. Drop inner.stl at 1.0mm
2. View result, button now enabled
3. Want more detail → Change to 0.1mm
4. ✅ Click "Recompute" button
5. ✅ Same file reprocessed instantly!
6. Repeat as needed for any detail level

## Implementation

### HTML (`index.html`)
```html
<div class="step-size-control">
    <label for="step-size-select">Detail:</label>
    <select id="step-size-select">
        <option value="1.0">1.0mm (Fast)</option>
        <option value="0.5">0.5mm (Good)</option>
        <option value="0.1" selected>0.1mm (High)</option>
        <option value="0.05">0.05mm (Max)</option>
    </select>
    <button id="recompute-btn" class="recompute-btn" disabled>Recompute</button>
</div>
```

### JavaScript (`app.js`)

**State management:**
```javascript
let lastLoadedFile = null; // Store file reference

function handleFile(file) {
    // ... validation ...

    // Store file for recompute
    lastLoadedFile = file;
    recomputeBtn.disabled = false;

    processFile(file);
}

function processFile(file) {
    // Shared logic for initial load and recompute
    // Reads file and sends to worker with current STEP_SIZE
}
```

**Button handler:**
```javascript
recomputeBtn.addEventListener('click', () => {
    if (lastLoadedFile) {
        console.log('Recomputing with step size:', STEP_SIZE, 'mm');
        processFile(lastLoadedFile);
    }
});
```

### CSS (`style.css`)

**Button styling:**
```css
.recompute-btn {
    padding: 6px 16px;
    background: rgba(0, 255, 255, 0.2);
    border: 1px solid #00ffff;
    border-radius: 6px;
    color: #00ffff;
    cursor: pointer;
}

.recompute-btn:hover:not(:disabled) {
    background: rgba(0, 255, 255, 0.3);
    box-shadow: 0 0 8px rgba(0, 255, 255, 0.3);
}

.recompute-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
    border-color: #666666;
    color: #666666;
}
```

## Button States

### Disabled (initial state)
- Appearance: Dimmed (30% opacity)
- Color: Gray (#666666)
- Cursor: not-allowed
- When: No file loaded yet

### Enabled (after file load)
- Appearance: Bright cyan
- Background: Semi-transparent cyan
- Cursor: pointer
- When: File has been loaded

### Hover (enabled)
- Background: Slightly brighter
- Glow effect: Cyan shadow

### Active (clicked)
- Background: Even brighter
- Animation: Slight downward movement (1px)
- Feedback: Processing starts

## Use Cases

### 1. Detail Refinement
```
Load at 1.0mm (fast preview)
  ↓
Explore model, find area of interest
  ↓
Change to 0.1mm
  ↓
Click Recompute
  ↓
See fine details in same view
```

### 2. Performance Testing
```
Load at 0.05mm (very high)
  ↓
Too slow/too dense
  ↓
Change to 0.1mm
  ↓
Click Recompute
  ↓
Better balance
```

### 3. Iterative Exploration
```
Start at 1.0mm → Recompute at 0.5mm → Recompute at 0.1mm → Recompute at 0.05mm
(Progressive refinement without re-dropping)
```

## Technical Details

### File Storage
- File object stored in `lastLoadedFile` variable
- File remains in memory until page reload
- No need to re-read from disk
- Browser maintains file reference

### Processing Flow
```
User clicks Recompute
  ↓
processFile(lastLoadedFile) called
  ↓
FileReader reads file (from memory)
  ↓
Buffer sent to worker with current STEP_SIZE
  ↓
Worker processes with new step size
  ↓
Results displayed
  ↓
Camera position preserved (from earlier fix)
```

### Memory Considerations
- File object: Small reference (~KB)
- File contents: Only loaded when processing
- No accumulation - same file reused
- Negligible memory impact

## User Benefits

1. **Convenience** ✅
   - No need to locate and drag file again
   - One-click reprocessing

2. **Speed** ✅
   - No UI interaction needed
   - Instant reprocessing start

3. **Workflow** ✅
   - Natural iterative refinement
   - Easy experimentation with detail levels

4. **Camera Preservation** ✅
   - Combined with earlier fix
   - Change detail without losing view

## Testing

```bash
npx serve
# Open http://localhost:3000
```

Test workflow:
1. ✅ Load page - button is disabled (gray)
2. ✅ Drop inner.stl (1.0mm)
3. ✅ Button becomes enabled (cyan)
4. ✅ Change dropdown to 0.5mm
5. ✅ Click "Recompute" button
6. ✅ File reprocesses with 0.5mm
7. ✅ Camera stays in same position
8. ✅ Change to 0.1mm
9. ✅ Click "Recompute" again
10. ✅ Higher detail, same view

## Visual Feedback

**States:**
- Initial: [Recompute] (disabled, gray)
- After load: [Recompute] (enabled, cyan)
- On hover: [Recompute] (bright cyan + glow)
- On click: [Recompute] (brightest + press effect)
- Processing: Status updates in info panel

## Files Modified

1. **index.html**
   - Added recompute button to controls

2. **app.js**
   - Added `lastLoadedFile` state variable
   - Added `recomputeBtn` DOM reference
   - Split file handling into `handleFile()` and `processFile()`
   - Added recompute button click handler
   - Enable button after file load

3. **style.css**
   - Added `.recompute-btn` styles
   - Hover, active, disabled states
   - Consistent with overall theme

Perfect iterative workflow! 🎉
