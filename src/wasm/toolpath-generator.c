// toolpath-generator-v2.c
// Redesigned to work with pure 2D height maps (grid space only)
// All operations in integer grid coordinates, no floating point offsets

#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include <float.h>

// Sentinel value for missing/empty grid cells
#define EMPTY_CELL NAN

// ============================================================================
// Data Structures
// ============================================================================

/**
 * 2D Height Map - dense grid of Z values
 * Missing cells are marked with EMPTY_CELL (NaN)
 */
typedef struct {
    float* z_grid;      // Flat array: z_grid[y * width + x]
    int width;          // Grid width (X dimension)
    int height;         // Grid height (Y dimension)
    float min_z;        // Minimum Z value (for bounds checking)
    float max_z;        // Maximum Z value (for bounds checking)
} HeightMap;

/**
 * Sparse tool representation - array of offset triplets
 * Format: [x_offset_int, y_offset_int, z_float, ...]
 */
typedef struct {
    int* x_offsets;     // X offsets from tool center (integers)
    int* y_offsets;     // Y offsets from tool center (integers)
    float* z_values;    // Z values relative to tool tip
    int count;          // Number of tool points
} SparseTool;

/**
 * Toolpath output - 2D array of tool center Z heights
 */
typedef struct {
    float* path_data;   // Flat array: path_data[scanline * points_per_line + point]
    int num_scanlines;  // Number of Y scanlines
    int points_per_line; // Points per scanline (X direction)
} ToolPath;

// ============================================================================
// Height Map Construction
// ============================================================================

/**
 * Convert flat point array (x,y,z triplets) to 2D height map
 * Assumes points are already on a regular grid with given step size
 */
HeightMap* create_height_map_from_points(float* points, int point_count, float grid_step) {
    if (point_count == 0) return NULL;

    HeightMap* map = (HeightMap*)malloc(sizeof(HeightMap));

    // Find bounding box
    float min_x = FLT_MAX, max_x = -FLT_MAX;
    float min_y = FLT_MAX, max_y = -FLT_MAX;
    map->min_z = FLT_MAX;
    map->max_z = -FLT_MAX;

    for (int i = 0; i < point_count; i++) {
        float x = points[i * 3 + 0];
        float y = points[i * 3 + 1];
        float z = points[i * 3 + 2];

        if (x < min_x) min_x = x;
        if (x > max_x) max_x = x;
        if (y < min_y) min_y = y;
        if (y > max_y) max_y = y;
        if (z < map->min_z) map->min_z = z;
        if (z > map->max_z) map->max_z = z;
    }

    // Calculate grid dimensions (add 1 for fencepost)
    map->width = (int)roundf((max_x - min_x) / grid_step) + 1;
    map->height = (int)roundf((max_y - min_y) / grid_step) + 1;

    // Allocate grid and initialize to EMPTY_CELL
    int grid_size = map->width * map->height;
    map->z_grid = (float*)malloc(grid_size * sizeof(float));
    for (int i = 0; i < grid_size; i++) {
        map->z_grid[i] = EMPTY_CELL;
    }

    // Fill grid with Z values
    for (int i = 0; i < point_count; i++) {
        float x = points[i * 3 + 0];
        float y = points[i * 3 + 1];
        float z = points[i * 3 + 2];

        // Convert to grid coordinates (integer)
        int grid_x = (int)roundf((x - min_x) / grid_step);
        int grid_y = (int)roundf((y - min_y) / grid_step);

        // Clamp to grid bounds
        if (grid_x < 0) grid_x = 0;
        if (grid_x >= map->width) grid_x = map->width - 1;
        if (grid_y < 0) grid_y = 0;
        if (grid_y >= map->height) grid_y = map->height - 1;

        map->z_grid[grid_y * map->width + grid_x] = z;
    }

    return map;
}

/**
 * Create tool height map with Z values relative to tool tip (lowest point)
 */
HeightMap* create_tool_height_map(float* points, int point_count, float grid_step) {
    if (point_count == 0) return NULL;

    // First, find the tool tip (lowest Z point)
    float tool_tip_z = FLT_MAX;
    for (int i = 0; i < point_count; i++) {
        float z = points[i * 3 + 2];
        if (z < tool_tip_z) tool_tip_z = z;
    }

    // Create temporary array with Z values relative to tip
    float* relative_points = (float*)malloc(point_count * 3 * sizeof(float));
    for (int i = 0; i < point_count; i++) {
        relative_points[i * 3 + 0] = points[i * 3 + 0];
        relative_points[i * 3 + 1] = points[i * 3 + 1];
        relative_points[i * 3 + 2] = points[i * 3 + 2] - tool_tip_z; // Relative to tip
    }

    // Create height map from relative points
    HeightMap* map = create_height_map_from_points(relative_points, point_count, grid_step);
    free(relative_points);

    return map;
}

/**
 * Convert HeightMap tool to sparse representation
 * Only stores non-empty cells with their integer offsets from center
 */
SparseTool* create_sparse_tool_from_map(HeightMap* tool_map) {
    if (!tool_map) return NULL;

    // First pass: count non-empty cells
    int count = 0;
    for (int i = 0; i < tool_map->width * tool_map->height; i++) {
        if (!isnan(tool_map->z_grid[i])) {
            count++;
        }
    }

    if (count == 0) return NULL;

    // Allocate sparse tool
    SparseTool* sparse = (SparseTool*)malloc(sizeof(SparseTool));
    sparse->count = count;
    sparse->x_offsets = (int*)malloc(count * sizeof(int));
    sparse->y_offsets = (int*)malloc(count * sizeof(int));
    sparse->z_values = (float*)malloc(count * sizeof(float));

    // Calculate tool center
    int tool_center_x = tool_map->width / 2;
    int tool_center_y = tool_map->height / 2;

    // Second pass: fill sparse arrays
    int idx = 0;
    for (int ty = 0; ty < tool_map->height; ty++) {
        for (int tx = 0; tx < tool_map->width; tx++) {
            float z = tool_map->z_grid[ty * tool_map->width + tx];
            if (!isnan(z)) {
                sparse->x_offsets[idx] = tx - tool_center_x;
                sparse->y_offsets[idx] = ty - tool_center_y;
                sparse->z_values[idx] = z;
                idx++;
            }
        }
    }

    return sparse;
}

void free_sparse_tool(SparseTool* tool) {
    if (tool) {
        free(tool->x_offsets);
        free(tool->y_offsets);
        free(tool->z_values);
        free(tool);
    }
}

// ============================================================================
// Toolpath Generation
// ============================================================================

/**
 * Calculate tool center Z at given position using SPARSE TOOL representation.
 * Iterates through sparse tool points and tests against terrain.
 *
 * @param terrain Terrain height map
 * @param tool Sparse tool representation
 * @param tool_x Tool center X position in terrain grid coordinates
 * @param tool_y Tool center Y position in terrain grid coordinates
 * @param oob_z Z value to use for out-of-bounds/missing terrain
 * @return Z height for tool center (tool tip Z position)
 */
float calculate_tool_height_sparse(HeightMap* terrain, SparseTool* tool,
                                    int tool_x, int tool_y, float oob_z) {
    float min_delta = FLT_MAX;

    // For each tool point, test against terrain
    for (int i = 0; i < tool->count; i++) {
        // Get tool offset and Z
        int offset_x = tool->x_offsets[i];
        int offset_y = tool->y_offsets[i];
        float tool_z = tool->z_values[i];

        // Calculate terrain position for this tool point
        int terrain_x = tool_x + offset_x;
        int terrain_y = tool_y + offset_y;

        // Check if terrain position is in bounds
        if (terrain_x < 0 || terrain_x >= terrain->width ||
            terrain_y < 0 || terrain_y >= terrain->height) {
            // Out of bounds - skip this tool point
            continue;
        }

        // Get terrain Z at this position
        float terrain_z = terrain->z_grid[terrain_y * terrain->width + terrain_x];
        if (isnan(terrain_z)) {
            // Missing terrain data - skip this tool point
            continue;
        }

        // Calculate delta between tool point and terrain
        float delta = tool_z - terrain_z;

        if (delta < min_delta) {
            min_delta = delta;
        }
    }

    // If no valid collision found, tool is completely off terrain
    if (min_delta == FLT_MAX) {
        return oob_z;
    }

    // Return tool tip Z position (negate min_delta to get absolute Z)
    return -min_delta;
}

/**
 * Calculate tool center Z at given position using DENSE TOOL (original).
 * Tests each tool grid cell against corresponding terrain cell.
 *
 * @param terrain Terrain height map
 * @param tool Tool height map (Z relative to tool tip at Z=0)
 * @param tool_x Tool center X position in terrain grid coordinates
 * @param tool_y Tool center Y position in terrain grid coordinates
 * @param oob_z Z value to use for out-of-bounds/missing terrain
 * @return Z height for tool center (tool tip Z position)
 */
float calculate_tool_height_at_position(HeightMap* terrain, HeightMap* tool,
                                         int tool_x, int tool_y, float oob_z) {
    float min_delta = FLT_MAX;
    int valid_collisions = 0;

    // Calculate tool grid center position
    int tool_center_x = tool->width / 2;
    int tool_center_y = tool->height / 2;

    // For each cell in tool grid, test against terrain
    for (int ty = 0; ty < tool->height; ty++) {
        for (int tx = 0; tx < tool->width; tx++) {
            // Get tool Z at this grid position
            float tool_z = tool->z_grid[ty * tool->width + tx];
            if (isnan(tool_z)) continue; // Skip empty tool cells

            // Calculate terrain position for this tool cell
            // Integer offset from tool center to this cell
            int offset_x = tx - tool_center_x;
            int offset_y = ty - tool_center_y;

            // Terrain position to test
            int terrain_x = tool_x + offset_x;
            int terrain_y = tool_y + offset_y;

            // Check if terrain position is in bounds
            if (terrain_x < 0 || terrain_x >= terrain->width ||
                terrain_y < 0 || terrain_y >= terrain->height) {
                // Out of bounds - skip this tool point (doesn't constrain)
                continue;
            }

            // Get terrain Z at this position
            float terrain_z = terrain->z_grid[terrain_y * terrain->width + terrain_x];
            if (isnan(terrain_z)) {
                // Missing terrain data - skip this tool point
                continue;
            }

            // Calculate delta between tool point and terrain
            // tool_z is the Z offset of this tool point relative to tool tip (Z=0)
            // delta = tool_z_offset - terrain_z
            // This tells us how much to lower the tool tip to avoid collision
            float delta = tool_z - terrain_z;

            if (delta < min_delta) {
                min_delta = delta;
            }
            valid_collisions++;
        }
    }

    // If no valid collision found, tool is completely off terrain
    if (min_delta == FLT_MAX) {
        return oob_z;
    }

    // Return tool tip Z position (negate min_delta to get absolute Z)
    return -min_delta;
}

/**
 * Generate complete toolpath by scanning SPARSE TOOL over terrain
 *
 * @param terrain Terrain height map
 * @param tool Sparse tool representation
 * @param x_step X step size in grid cells (how many cells to skip)
 * @param y_step Y step size in grid cells (how many cells to skip)
 * @param oob_z Z value for out-of-bounds areas
 * @return ToolPath structure
 */
ToolPath* generate_toolpath_sparse(HeightMap* terrain, SparseTool* tool,
                                   int x_step, int y_step, float oob_z) {
    if (!terrain || !tool) return NULL;

    ToolPath* path = (ToolPath*)malloc(sizeof(ToolPath));

    // Calculate path dimensions
    path->points_per_line = (terrain->width + x_step - 1) / x_step;
    path->num_scanlines = (terrain->height + y_step - 1) / y_step;

    // Allocate path data
    int total_points = path->num_scanlines * path->points_per_line;
    path->path_data = (float*)malloc(total_points * sizeof(float));

    // Generate path by scanning in raster order
    int path_idx = 0;
    for (int scanline = 0; scanline < path->num_scanlines; scanline++) {
        int tool_y = scanline * y_step;

        for (int point = 0; point < path->points_per_line; point++) {
            int tool_x = point * x_step;

            // Calculate tool center Z at this position using sparse algorithm
            float z = calculate_tool_height_sparse(terrain, tool, tool_x, tool_y, oob_z);
            path->path_data[path_idx++] = z;
        }
    }

    return path;
}

/**
 * Generate complete toolpath by scanning tool over terrain
 * Now uses sparse algorithm internally for better performance
 *
 * @param terrain Terrain height map
 * @param tool Tool height map (Z relative to tool tip)
 * @param x_step X step size in grid cells (how many cells to skip)
 * @param y_step Y step size in grid cells (how many cells to skip)
 * @param oob_z Z value for out-of-bounds areas
 * @return ToolPath structure
 */
ToolPath* generate_toolpath(HeightMap* terrain, HeightMap* tool,
                            int x_step, int y_step, float oob_z) {
    // Convert tool to sparse representation for better performance
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool);
    if (!sparse_tool) {
        return NULL;
    }

    // Generate toolpath using sparse algorithm
    ToolPath* path = generate_toolpath_sparse(terrain, sparse_tool, x_step, y_step, oob_z);

    // Free sparse tool (no longer needed)
    free_sparse_tool(sparse_tool);

    return path;
}

/**
 * Generate complete toolpath using DENSE algorithm (kept for testing/comparison)
 * This is the original implementation before sparse optimization
 *
 * @param terrain Terrain height map
 * @param tool Tool height map (Z relative to tool tip)
 * @param x_step X step size in grid cells (how many cells to skip)
 * @param y_step Y step size in grid cells (how many cells to skip)
 * @param oob_z Z value for out-of-bounds areas
 * @return ToolPath structure
 */
ToolPath* generate_toolpath_dense(HeightMap* terrain, HeightMap* tool,
                                  int x_step, int y_step, float oob_z) {
    if (!terrain || !tool) return NULL;

    ToolPath* path = (ToolPath*)malloc(sizeof(ToolPath));

    // Calculate path dimensions
    path->points_per_line = (terrain->width + x_step - 1) / x_step;
    path->num_scanlines = (terrain->height + y_step - 1) / y_step;

    // Allocate path data
    int total_points = path->num_scanlines * path->points_per_line;
    path->path_data = (float*)malloc(total_points * sizeof(float));

    // Generate path by scanning in raster order
    int path_idx = 0;
    for (int scanline = 0; scanline < path->num_scanlines; scanline++) {
        int tool_y = scanline * y_step;

        for (int point = 0; point < path->points_per_line; point++) {
            int tool_x = point * x_step;

            // Calculate tool center Z at this position
            float z = calculate_tool_height_at_position(terrain, tool, tool_x, tool_y, oob_z);
            path->path_data[path_idx++] = z;
        }
    }

    return path;
}

// ============================================================================
// Memory Management
// ============================================================================

void free_height_map(HeightMap* map) {
    if (map) {
        free(map->z_grid);
        free(map);
    }
}

void free_toolpath(ToolPath* path) {
    if (path) {
        free(path->path_data);
        free(path);
    }
}

// ============================================================================
// WASM Exports
// ============================================================================

HeightMap* create_terrain_map(float* points, int point_count, float grid_step) {
    return create_height_map_from_points(points, point_count, grid_step);
}

HeightMap* create_tool_map(float* points, int point_count, float grid_step) {
    return create_tool_height_map(points, point_count, grid_step);
}

ToolPath* generate_path(HeightMap* terrain, HeightMap* tool,
                        int x_step, int y_step, float oob_z) {
    // TEST: Try dense algorithm to see if it's faster in WASM
    // (sparse has 5x slowdown in browser vs native, investigating why)

    // Debug marker: write -1 to indicate using DENSE
    *((int*)0x10000) = -1;

    return generate_toolpath_dense(terrain, tool, x_step, y_step, oob_z);

    /* ORIGINAL SPARSE CODE - temporarily disabled for testing
    // Convert tool to sparse representation for better performance
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool);
    if (!sparse_tool) {
        return NULL;
    }

    // Debug: Write sparse tool count to memory location 0 for browser verification
    // Browser can read this to confirm sparse algorithm is being used
    *((int*)0x10000) = sparse_tool->count;

    // Generate toolpath using sparse algorithm
    ToolPath* path = generate_toolpath_sparse(terrain, sparse_tool, x_step, y_step, oob_z);

    // Free sparse tool (no longer needed)
    free_sparse_tool(sparse_tool);

    return path;
    */
}

void get_path_dimensions(ToolPath* path, int* num_scanlines, int* points_per_line) {
    if (path) {
        *num_scanlines = path->num_scanlines;
        *points_per_line = path->points_per_line;
    }
}

void copy_path_data(ToolPath* path, float* out_buffer) {
    if (path && out_buffer) {
        int total_points = path->num_scanlines * path->points_per_line;
        for (int i = 0; i < total_points; i++) {
            out_buffer[i] = path->path_data[i];
        }
    }
}

void get_map_dimensions(HeightMap* map, int* width, int* height) {
    if (map) {
        *width = map->width;
        *height = map->height;
    }
}
