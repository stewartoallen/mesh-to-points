// mesh-converter.c
// WASM wrapper around the shared mesh converter library
#include <stdlib.h>
#include <stdio.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#include "mesh-converter-lib.h"

// Export all the library functions for WASM
EXPORT
float* convert_to_point_mesh(float* triangles, int triangle_count, float step_size, int* out_point_count, int filter_mode);

EXPORT
void get_bounds(float* out_bounds);

EXPORT
void free_output();

EXPORT
float test_triangle_data(float* triangles, int count);

// Include the actual implementation
#include "mesh-converter-lib.c"
