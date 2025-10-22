/**
 * CNC Toolpath Generator
 *
 * Takes two point clouds (terrain and tool) and generates a toolpath by
 * scanning the tool over the terrain surface.
 *
 * Key concepts:
 * - XY coordinates are in discrete grid space (integer indices)
 * - Only Z coordinates are in continuous float space (mm)
 * - Tool collision detection finds the Z height where tool touches terrain
 */

#include <stdlib.h>
#include <math.h>
#include <float.h>

// ============================================================================
// Data Structures
// ============================================================================

/**
 * Represents a point cloud organized as a 2D grid with Z values.
 * XY coordinates are discrete indices, Z values are continuous floats.
 */
typedef struct {
    float* z_values;    // Array of Z heights (one per point)
    int* grid;          // 2D grid mapping: grid[y*width + x] = index into z_values, or -1 if no point
    int width;          // X dimension in grid units
    int height;         // Y dimension in grid units
    int point_count;    // Total number of points (length of z_values array)
} PointGrid;

/**
 * Represents a tool as a collection of points relative to tool center.
 * All coordinates are offsets from the tool's center position.
 */
typedef struct {
    int* x_offsets;     // Relative X positions (grid units)
    int* y_offsets;     // Relative Y positions (grid units)
    float* z_offsets;   // Relative Z positions (mm)
    int point_count;    // Number of points in tool
} ToolCloud;

/**
 * Represents a generated toolpath.
 * Currently uses naive full encoding (every Z height stored).
 * Future: support RLE or point-to-point compression.
 */
typedef struct {
    float** scanlines;      // 2D array: scanlines[y_index][x_index] = z_height
    int num_scanlines;      // Number of Y scan lines
    int points_per_line;    // Number of X points per scan line
    float out_of_bounds_z;  // Z value to use for out-of-bounds areas
} ToolPath;

// ============================================================================
// Grid Conversion Functions
// ============================================================================

/**
 * Convert flat point cloud array to indexed 2D grid structure.
 *
 * Input: Flat array of points (x,y,z, x,y,z, ...) from mesh-to-point conversion
 * Output: PointGrid with 2D lookup table
 *
 * Note: Assumes points are generated on a regular XY grid. We need to:
 * 1. Find min/max X and Y to determine grid dimensions
 * 2. Determine grid step size (spacing between points)
 * 3. Build lookup table mapping (x_grid, y_grid) -> z_value
 */
PointGrid* create_point_grid(float* points, int point_count) {
    if (point_count == 0) return NULL;

    PointGrid* grid = (PointGrid*)malloc(sizeof(PointGrid));

    // Find bounding box and determine grid step
    float min_x = FLT_MAX, max_x = -FLT_MAX;
    float min_y = FLT_MAX, max_y = -FLT_MAX;
    float min_step = FLT_MAX;

    for (int i = 0; i < point_count; i++) {
        float x = points[i * 3 + 0];
        float y = points[i * 3 + 1];

        if (x < min_x) min_x = x;
        if (x > max_x) max_x = x;
        if (y < min_y) min_y = y;
        if (y > max_y) max_y = y;
    }

    // Estimate grid step by finding minimum distance between points
    // Sample a subset to avoid O(n^2) comparison
    int sample_size = point_count < 100 ? point_count : 100;
    for (int i = 0; i < sample_size; i++) {
        float x1 = points[i * 3 + 0];
        float y1 = points[i * 3 + 1];

        for (int j = i + 1; j < sample_size; j++) {
            float x2 = points[j * 3 + 0];
            float y2 = points[j * 3 + 1];

            float dx = fabs(x2 - x1);
            float dy = fabs(y2 - y1);

            // Check for axis-aligned neighbors
            if (dx > 0.001 && dx < min_step && dy < 0.001) min_step = dx;
            if (dy > 0.001 && dy < min_step && dx < 0.001) min_step = dy;
        }
    }

    // If we couldn't determine step, estimate from bounds
    if (min_step == FLT_MAX) {
        int estimated_points_per_axis = (int)sqrt(point_count);
        min_step = (max_x - min_x) / estimated_points_per_axis;
    }

    // Calculate grid dimensions
    grid->width = (int)((max_x - min_x) / min_step) + 2;  // +2 for rounding safety
    grid->height = (int)((max_y - min_y) / min_step) + 2;
    grid->point_count = point_count;

    // Allocate arrays
    grid->z_values = (float*)malloc(sizeof(float) * point_count);
    grid->grid = (int*)malloc(sizeof(int) * grid->width * grid->height);

    // Initialize grid to -1 (no point)
    for (int i = 0; i < grid->width * grid->height; i++) {
        grid->grid[i] = -1;
    }

    // Fill grid
    for (int i = 0; i < point_count; i++) {
        float x = points[i * 3 + 0];
        float y = points[i * 3 + 1];
        float z = points[i * 3 + 2];

        int grid_x = (int)((x - min_x) / min_step + 0.5);
        int grid_y = (int)((y - min_y) / min_step + 0.5);

        if (grid_x >= 0 && grid_x < grid->width && grid_y >= 0 && grid_y < grid->height) {
            grid->z_values[i] = z;
            grid->grid[grid_y * grid->width + grid_x] = i;
        }
    }

    return grid;
}

/**
 * Convert tool point cloud to relative offset structure.
 * Tool points are converted to integer XY offsets and float Z offsets.
 */
ToolCloud* create_tool_cloud(float* points, int point_count, float grid_step) {
    if (point_count == 0) return NULL;

    ToolCloud* tool = (ToolCloud*)malloc(sizeof(ToolCloud));
    tool->point_count = point_count;

    tool->x_offsets = (int*)malloc(sizeof(int) * point_count);
    tool->y_offsets = (int*)malloc(sizeof(int) * point_count);
    tool->z_offsets = (float*)malloc(sizeof(float) * point_count);

    // Find tool center
    // For XY: use average (tool should be centered at origin)
    // For Z: use the HIGHEST point (mounting point / tool holder position)
    float center_x = 0, center_y = 0;
    float center_z = -1e10f;  // Start very low, find highest

    for (int i = 0; i < point_count; i++) {
        center_x += points[i * 3 + 0];
        center_y += points[i * 3 + 1];
        float z = points[i * 3 + 2];
        if (z > center_z) center_z = z;  // Find highest Z (tool mounting point)
    }
    center_x /= point_count;
    center_y /= point_count;

    // Convert to offsets
    for (int i = 0; i < point_count; i++) {
        float x = points[i * 3 + 0];
        float y = points[i * 3 + 1];
        float z = points[i * 3 + 2];

        tool->x_offsets[i] = (int)((x - center_x) / grid_step + 0.5);
        tool->y_offsets[i] = (int)((y - center_y) / grid_step + 0.5);
        tool->z_offsets[i] = z - center_z;
    }

    return tool;
}

void free_point_grid(PointGrid* grid) {
    if (grid) {
        free(grid->z_values);
        free(grid->grid);
        free(grid);
    }
}

void free_tool_cloud(ToolCloud* tool) {
    if (tool) {
        free(tool->x_offsets);
        free(tool->y_offsets);
        free(tool->z_offsets);
        free(tool);
    }
}

// ============================================================================
// Collision Detection
// ============================================================================

/**
 * Calculate the Z height where tool center should be positioned at (tool_x, tool_y)
 * to just touch the terrain without penetrating it.
 *
 * Algorithm:
 * 1. Start with tool at high Z position
 * 2. For each tool point, find terrain Z at that XY location
 * 3. Calculate delta = tool_point_z - terrain_z
 * 4. The minimum delta tells us how much to lower the tool
 * 5. Return: initial_tool_z - min_delta
 *
 * @param terrain The terrain point grid
 * @param tool The tool point cloud
 * @param tool_x Tool center X position (grid coordinates)
 * @param tool_y Tool center Y position (grid coordinates)
 * @param oob_z Z value to use for out-of-bounds terrain areas
 * @return Z height for tool center
 */
float calculate_tool_height(PointGrid* terrain, ToolCloud* tool, int tool_x, int tool_y, float oob_z) {
    float min_delta = FLT_MAX;

    // For each point in the tool
    for (int i = 0; i < tool->point_count; i++) {
        int terrain_x = tool_x + tool->x_offsets[i];
        int terrain_y = tool_y + tool->y_offsets[i];
        float tool_z_offset = tool->z_offsets[i];

        // Check if terrain position is in bounds
        if (terrain_x < 0 || terrain_x >= terrain->width ||
            terrain_y < 0 || terrain_y >= terrain->height) {
            // Out of bounds - use provided Z value
            float delta = tool_z_offset - oob_z;
            if (delta < min_delta) min_delta = delta;
            continue;
        }

        // Look up terrain Z at this position
        int terrain_idx = terrain->grid[terrain_y * terrain->width + terrain_x];
        if (terrain_idx < 0) {
            // No terrain point at this grid location - use oob_z
            float delta = tool_z_offset - oob_z;
            if (delta < min_delta) min_delta = delta;
            continue;
        }

        float terrain_z = terrain->z_values[terrain_idx];
        float delta = tool_z_offset - terrain_z;

        if (delta < min_delta) {
            min_delta = delta;
        }
    }

    // If min_delta is still FLT_MAX, no valid collision was found
    if (min_delta == FLT_MAX) {
        return oob_z; // Tool completely off terrain
    }

    // Tool should be positioned at: 0 (reference) - min_delta
    // Since tool_z_offset is relative to tool center at Z=0
    return -min_delta;
}

// ============================================================================
// Toolpath Generation
// ============================================================================

/**
 * Generate a CNC toolpath by scanning the tool over the terrain.
 *
 * @param terrain The terrain point grid
 * @param tool The tool point cloud
 * @param x_step Step size in X direction (grid units)
 * @param y_step Step size in Y direction (grid units)
 * @param oob_z Z value for out-of-bounds areas
 * @return Generated toolpath
 */
ToolPath* generate_toolpath(PointGrid* terrain, ToolCloud* tool, int x_step, int y_step, float oob_z) {
    ToolPath* path = (ToolPath*)malloc(sizeof(ToolPath));
    path->out_of_bounds_z = oob_z;

    // Calculate number of scan lines and points per line
    // Start at 0, step by step_size, stop before we go out of bounds
    path->num_scanlines = (terrain->height + y_step - 1) / y_step;
    path->points_per_line = (terrain->width + x_step - 1) / x_step;

    // Allocate scanlines
    path->scanlines = (float**)malloc(sizeof(float*) * path->num_scanlines);
    for (int i = 0; i < path->num_scanlines; i++) {
        path->scanlines[i] = (float*)malloc(sizeof(float) * path->points_per_line);
    }

    // Generate toolpath
    int scanline_idx = 0;
    for (int y = 0; y < terrain->height && scanline_idx < path->num_scanlines; y += y_step) {
        int point_idx = 0;

        for (int x = 0; x < terrain->width && point_idx < path->points_per_line; x += x_step) {
            float z_height = calculate_tool_height(terrain, tool, x, y, oob_z);
            path->scanlines[scanline_idx][point_idx] = z_height;
            point_idx++;
        }

        scanline_idx++;
    }

    return path;
}

void free_toolpath(ToolPath* path) {
    if (path) {
        for (int i = 0; i < path->num_scanlines; i++) {
            free(path->scanlines[i]);
        }
        free(path->scanlines);
        free(path);
    }
}

// ============================================================================
// Exported Functions for WASM
// ============================================================================

/**
 * Create point grid from flat array (exported for WASM)
 */
PointGrid* create_grid(float* points, int point_count) {
    return create_point_grid(points, point_count);
}

/**
 * Create tool cloud from flat array (exported for WASM)
 */
ToolCloud* create_tool(float* points, int point_count, float grid_step) {
    return create_tool_cloud(points, point_count, grid_step);
}

/**
 * Generate toolpath (exported for WASM)
 */
ToolPath* generate_path(PointGrid* terrain, ToolCloud* tool, int x_step, int y_step, float oob_z) {
    return generate_toolpath(terrain, tool, x_step, y_step, oob_z);
}

/**
 * Get toolpath dimensions for allocating output buffer
 */
void get_path_dimensions(ToolPath* path, int* out_num_scanlines, int* out_points_per_line) {
    if (path && out_num_scanlines && out_points_per_line) {
        *out_num_scanlines = path->num_scanlines;
        *out_points_per_line = path->points_per_line;
    }
}

/**
 * Copy toolpath data to flat output array for return to JavaScript
 * Output format: flat array of all Z heights, row by row
 */
void copy_path_data(ToolPath* path, float* output) {
    if (!path || !output) return;

    int idx = 0;
    for (int y = 0; y < path->num_scanlines; y++) {
        for (int x = 0; x < path->points_per_line; x++) {
            output[idx++] = path->scanlines[y][x];
        }
    }
}
