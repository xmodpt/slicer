// The shape recipe language the AI answers in (built by src/shapegen.js).
export const RECIPE_HELP = `Shape recipe (JSON). Units mm, Z up. Every node is one of:
{"box": {"size": [x, y, z]}}                         centred on the Z axis, bottom at z=0
{"cylinder": {"r": r, "h": h, "r2": topRadius?}}      centred on the Z axis, bottom at z=0; r2 makes a cone (0 = pointed)
{"sphere": {"r": r}}                                  centred on the origin
{"torus": {"R": ringRadius, "r": tubeRadius}}         centred on the origin, lying flat around the Z axis
{"revolve": {"profile": [[r, z], ...], "degrees": 360?}}  closed outline in the r–z plane (r >= 0) turned around the Z axis – vases, candles, bottles, knobs, wheels' rims
{"extrude": {"outline": [[x, y], ...], "h": h, "twist": degrees?, "scaleTop": s?}}  closed 2D outline (counter-clockwise, not self-crossing) pushed up from z=0
{"tube": {"from": [x, y, z], "to": [x, y, z], "r": r, "r2": endRadius?}}  a rod between two points with rounded ends – branches, roots, legs, arms, handles, stems. No rotation needed: just give the two end points
{"hull": [node, ...]}                                 the smooth convex skin around the shapes – crowns of trees (a few spheres), apples, rocks, rounded bodies, heads
{"union": [node, ...]}                                all together
{"difference": [node, minus1, minus2, ...]}           the first node with the others cut away
{"intersection": [node, ...]}                         only where all overlap
{"around": {"count": n, "shape": node, "axis": "z"?}} n copies turned evenly around the axis (spokes, petals, teeth, bolt holes)
{"row": {"count": n, "step": [dx, dy, dz], "shape": node}}  n copies in a line
Any node may also have "translate": [x, y, z], "rotate": [rx, ry, rz] (degrees, applied before translate), "scale": s or [sx, sy, sz].`;
