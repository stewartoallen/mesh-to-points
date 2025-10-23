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
 * Tiled terrain - terrain broken into small tiles for cache efficiency
 * Each tile is small enough to fit in CPU cache
 */
typedef struct {
    float** tiles;      // Array of tile pointers (flat tiles, not 2D)
    int tile_size;      // Cells per tile edge (e.g., 256 for 256x256)
    int tiles_x;        // Number of tiles in X direction
    int tiles_y;        // Number of tiles in Y direction
    int total_width;    // Original terrain width in cells
    int total_height;   // Original terrain height in cells
    float min_z;        // Minimum Z value
    float max_z;        // Maximum Z value
} TiledTerrain;

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

/**
 * Convert HeightMap to tiled terrain for better cache performance
 *
 * @param map Height map to convert
 * @param tile_size Size of each tile edge (e.g., 256 for 256x256 tiles)
 * @return TiledTerrain structure
 */
TiledTerrain* create_tiled_terrain(HeightMap* map, int tile_size) {
    if (!map || tile_size <= 0) return NULL;

    TiledTerrain* tiled = (TiledTerrain*)malloc(sizeof(TiledTerrain));

    tiled->tile_size = tile_size;
    tiled->total_width = map->width;
    tiled->total_height = map->height;
    tiled->min_z = map->min_z;
    tiled->max_z = map->max_z;

    // Calculate number of tiles needed (round up)
    tiled->tiles_x = (map->width + tile_size - 1) / tile_size;
    tiled->tiles_y = (map->height + tile_size - 1) / tile_size;

    // Allocate array of tile pointers
    int total_tiles = tiled->tiles_x * tiled->tiles_y;
    tiled->tiles = (float**)malloc(total_tiles * sizeof(float*));

    // Create each tile
    for (int ty = 0; ty < tiled->tiles_y; ty++) {
        for (int tx = 0; tx < tiled->tiles_x; tx++) {
            int tile_idx = ty * tiled->tiles_x + tx;

            // Allocate tile (flat array)
            tiled->tiles[tile_idx] = (float*)malloc(tile_size * tile_size * sizeof(float));

            // Initialize tile to EMPTY_CELL
            for (int i = 0; i < tile_size * tile_size; i++) {
                tiled->tiles[tile_idx][i] = EMPTY_CELL;
            }

            // Copy data from height map to this tile
            int start_x = tx * tile_size;
            int start_y = ty * tile_size;

            for (int local_y = 0; local_y < tile_size; local_y++) {
                for (int local_x = 0; local_x < tile_size; local_x++) {
                    int global_x = start_x + local_x;
                    int global_y = start_y + local_y;

                    // Check if within original map bounds
                    if (global_x < map->width && global_y < map->height) {
                        float z = map->z_grid[global_y * map->width + global_x];
                        tiled->tiles[tile_idx][local_y * tile_size + local_x] = z;
                    }
                }
            }
        }
    }

    return tiled;
}

void free_tiled_terrain(TiledTerrain* tiled) {
    if (tiled) {
        if (tiled->tiles) {
            int total_tiles = tiled->tiles_x * tiled->tiles_y;
            for (int i = 0; i < total_tiles; i++) {
                free(tiled->tiles[i]);
            }
            free(tiled->tiles);
        }
        free(tiled);
    }
}

/**
 * Get terrain Z value from tiled terrain
 * Returns EMPTY_CELL (NaN) if position is out of bounds or empty
 * Optimized with bit shifts when tile_size is power of 2
 */
static inline float get_tiled_z(TiledTerrain* tiled, int x, int y) {
    // Check bounds
    if (x < 0 || x >= tiled->total_width || y < 0 || y >= tiled->total_height) {
        return EMPTY_CELL;
    }

    // Calculate which tile this position is in
    // Use bitshift if tile_size is power of 2, else use division
    int tile_x, tile_y, local_x, local_y;

    // Check if tile_size is power of 2 (has only one bit set)
    int is_pow2 = (tiled->tile_size & (tiled->tile_size - 1)) == 0;

    if (is_pow2) {
        // Fast path: use bit operations
        int shift = __builtin_ctz(tiled->tile_size);  // Count trailing zeros
        int mask = tiled->tile_size - 1;

        tile_x = x >> shift;
        tile_y = y >> shift;
        local_x = x & mask;
        local_y = y & mask;
    } else {
        // Slow path: use division/modulo
        tile_x = x / tiled->tile_size;
        tile_y = y / tiled->tile_size;
        local_x = x % tiled->tile_size;
        local_y = y % tiled->tile_size;
    }

    int tile_idx = tile_y * tiled->tiles_x + tile_x;

    // Return Z value from tile
    return tiled->tiles[tile_idx][local_y * tiled->tile_size + local_x];
}

// ============================================================================
// Toolpath Generation
// ============================================================================

/**
 * Calculate tool center Z using SPARSE TOOL with TILED TERRAIN (optimized)
 * Uses tiled terrain for better cache locality
 *
 * @param tiled Tiled terrain
 * @param tool Sparse tool representation
 * @param tool_x Tool center X position in terrain grid coordinates
 * @param tool_y Tool center Y position in terrain grid coordinates
 * @param oob_z Z value to use for out-of-bounds/missing terrain
 * @return Z height for tool center (tool tip Z position)
 */
float calculate_tool_height_tiled(TiledTerrain* tiled, SparseTool* tool,
                                   int tool_x, int tool_y, float oob_z) {
    float min_delta = FLT_MAX;

    // For each tool point, test against tiled terrain
    for (int i = 0; i < tool->count; i++) {
        // Get tool offset and Z
        int offset_x = tool->x_offsets[i];
        int offset_y = tool->y_offsets[i];
        float tool_z = tool->z_values[i];

        // Calculate terrain position for this tool point
        int terrain_x = tool_x + offset_x;
        int terrain_y = tool_y + offset_y;

        // Get terrain Z using tiled lookup
        float terrain_z = get_tiled_z(tiled, terrain_x, terrain_y);
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
 * Calculate tool center Z using SPARSE TOOL with standard HeightMap
 * Legacy version for non-tiled terrain
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

// Old dense algorithm removed - using sparse tool representation only

/**
 * Generate complete toolpath using TILED terrain (optimized for cache)
 *
 * @param tiled Tiled terrain
 * @param tool Sparse tool representation
 * @param x_step X step size in grid cells
 * @param y_step Y step size in grid cells
 * @param oob_z Z value for out-of-bounds areas
 * @param tile_size Tile size used for terrain
 * @return ToolPath structure
 */
ToolPath* generate_toolpath_tiled(TiledTerrain* tiled, SparseTool* tool,
                                   int x_step, int y_step, float oob_z) {
    if (!tiled || !tool) return NULL;

    ToolPath* path = (ToolPath*)malloc(sizeof(ToolPath));

    // Calculate path dimensions
    path->points_per_line = (tiled->total_width + x_step - 1) / x_step;
    path->num_scanlines = (tiled->total_height + y_step - 1) / y_step;

    // Allocate path data
    int total_points = path->num_scanlines * path->points_per_line;
    path->path_data = (float*)malloc(total_points * sizeof(float));

    // Generate path by scanning in raster order
    int path_idx = 0;
    for (int scanline = 0; scanline < path->num_scanlines; scanline++) {
        int tool_y = scanline * y_step;

        for (int point = 0; point < path->points_per_line; point++) {
            int tool_x = point * x_step;

            // Calculate tool center Z using tiled terrain
            float z = calculate_tool_height_tiled(tiled, tool, tool_x, tool_y, oob_z);
            path->path_data[path_idx++] = z;
        }
    }

    return path;
}

/**
 * Generate complete toolpath by scanning SPARSE TOOL over terrain
 * Legacy version for non-tiled terrain
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
 * Generate PARTIAL toolpath for a range of scanlines (for parallelization)
 *
 * @param terrain Terrain height map
 * @param tool Sparse tool representation
 * @param x_step X step size in grid cells
 * @param y_step Y step size in grid cells
 * @param oob_z Z value for out-of-bounds areas
 * @param start_scanline First scanline to generate (inclusive)
 * @param end_scanline Last scanline to generate (exclusive)
 * @return ToolPath structure containing only the specified scanlines
 */
ToolPath* generate_toolpath_partial(HeightMap* terrain, SparseTool* tool,
                                    int x_step, int y_step, float oob_z,
                                    int start_scanline, int end_scanline) {
    if (!terrain || !tool) return NULL;

    ToolPath* path = (ToolPath*)malloc(sizeof(ToolPath));

    // Calculate dimensions
    path->points_per_line = (terrain->width + x_step - 1) / x_step;
    int total_scanlines = (terrain->height + y_step - 1) / y_step;

    // Clamp scanline range
    if (start_scanline < 0) start_scanline = 0;
    if (end_scanline > total_scanlines) end_scanline = total_scanlines;
    if (start_scanline >= end_scanline) {
        path->num_scanlines = 0;
        path->path_data = NULL;
        return path;
    }

    path->num_scanlines = end_scanline - start_scanline;

    // Allocate path data for this range only
    int total_points = path->num_scanlines * path->points_per_line;
    path->path_data = (float*)malloc(total_points * sizeof(float));

    // Generate path for specified scanline range
    int path_idx = 0;
    for (int scanline = start_scanline; scanline < end_scanline; scanline++) {
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

// Old dense algorithm removed - using sparse tool representation only

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
    // Convert tool to sparse representation for better performance
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool);
    if (!sparse_tool) {
        return NULL;
    }

    // Debug: Write sparse tool count to memory location for browser verification
    *((int*)0x10000) = sparse_tool->count;

    // Generate toolpath using sparse algorithm
    ToolPath* path = generate_toolpath_sparse(terrain, sparse_tool, x_step, y_step, oob_z);

    // Free sparse tool (no longer needed)
    free_sparse_tool(sparse_tool);

    return path;
}

// Global variable to store last sparse tool count for debugging
static int g_last_sparse_tool_count = 0;

ToolPath* generate_path_partial(HeightMap* terrain, HeightMap* tool,
                                int x_step, int y_step, float oob_z,
                                int start_scanline, int end_scanline) {
    // Convert tool to sparse representation for better performance
    SparseTool* sparse_tool = create_sparse_tool_from_map(tool);
    if (!sparse_tool) {
        return NULL;
    }

    // Store sparse tool count for verification
    g_last_sparse_tool_count = sparse_tool->count;

    // Generate partial toolpath using sparse algorithm
    ToolPath* path = generate_toolpath_partial(terrain, sparse_tool, x_step, y_step, oob_z,
                                                start_scanline, end_scanline);

    // Free sparse tool (no longer needed)
    free_sparse_tool(sparse_tool);

    return path;
}

int get_sparse_tool_count() {
    return g_last_sparse_tool_count;
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
