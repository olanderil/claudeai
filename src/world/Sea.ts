/**
 * Where the water is.
 *
 * Its own module, and a leaf on purpose. This used to live in `Terrain`, which
 * also re-exports the whole of `Worlds` — so anything `Worlds` itself imports
 * could not read it without closing a loop: `Worlds` -> the module -> `Terrain`
 * -> `Worlds`. That loop is not a warning at build time. It is a
 * `ReferenceError` on load, because `Worlds` plans its scenery at module scope
 * and gets there before the far side of the cycle has initialised.
 *
 * A constant with no imports of its own cannot take part in a cycle, so this is
 * the safe place for it. `Terrain` still re-exports it and nothing else had to
 * change.
 */

/** Water surface height. Terrain below this is seabed. */
export const SEA_LEVEL = 0;
