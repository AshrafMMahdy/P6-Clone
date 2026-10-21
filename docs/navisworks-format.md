# Navisworks files: what the clone's reader knows

Clean-room: worked out from the bytes of sample files only (the two in `tests/fixtures/navisworks`, the samples listed in
`sample 4D/SOURCES.md`, the user's own files), never from Autodesk or third-party reader code. Code: `core/bim/nwd/`.

## Container (`lichunk-008`, stream revisions 431 to 448 seen)

- A header line `#LcUStream-V1.1 binary double release C lichunk-008\n`, the sections, the table of contents, the header
  line again.
- Sections are zlib streams (one or several, some after a 4-byte lead), at the file offsets the table gives.
- Table: the line `#LcUStream-V1.1 binary double release utf8 navisworks:NNN lizlib\n`, 7 zero bytes, then zlib:
  `i32 -1, u32 count`, and per section `u32 length, UTF-8 name padded to 4, u32 version, (align 8) u64 offset, u64 length,
  u32, u32`. Names: `<file>\LcOpNwdLogicalHierarchy` (a cache: `cache\...`).
- `lichunk-007` (stream revision 103, before 2015) is laid out differently and is not read yet.

## Model tree (`LcOpNwdLogicalHierarchy`)

An object stream: `u32 1, u32, u32 base, u32 count`, then `count` values. A value is a u32 tag: 0 or -1 none; 1 and a
u32 id, an earlier object; else the next id (`base+1, base+2...`): a new object, `u32 class`, its body. Strings are
`u32 length` (-1 none) and UTF-8 padded to 4; doubles sit on 8-byte boundaries.

| Class | Object | Body |
|---|---|---|
| 0x35 | node | name, attribute, u32 flags, u32 GUID index (1-based into LcOpGuidStore), u32 n, n values, u32 m, m children |
| 0x16 | leaf (geometry item) | name, attribute, u32, u32 index, u32 n, n values |
| 0x34 | attribute | display name, internal name (`LcRevitLayer`, `LcRevitCollection`, `lcldrevit_parameter_-1012805`...) |
| 0x56 | property group | name, attribute, u32, u32 n, n properties: attribute, u32 type, value |
| 0x1f | material appearance | name, attribute, u32, 14 doubles |
| 0xc8 | material | name, u32, u32, asset |
| 0xb9 | material asset | JSON, text, u32 n, n (path, u32, u32) |
| 0x42 | key | name, attribute, u32, u64 (a DWG handle; a Revit ElementId in LcOaPartitionProps) |
| 0x27 / 0x28 / 0x29 | transform | name, attribute, u32 flags, 12 doubles and a u32 / 3 doubles / 7 doubles (translation, quaternion) |

Property types: 1 double, 2 integer, 3 boolean, 4 text, 6 length, 8 object (its attribute's display name, e.g.
`Level "L1", #30`), 10 area, 11 volume. Revit writes lengths, areas and volumes in feet.

Revit exports: levels (`LcRevitLayer`) > Category > Family > Type (`LcRevitCollection`) > instances. An element's own
group (`LcRevitData_Element`: Name, Type, Family, Category, Id, IfcGUID, every parameter) is on its node in older files
and in `LcOaPartitionProps` (the same object stream from id 100, element-id keys then groups, in tree order) in newer
ones. DWG exports: layers (`LcOpDwgLayer`) > inserts, blocks and geometry items.

## GUID store (`LcOpGuidStore`)

`u32, u32 count`, then `count` 16-byte GUIDs (Windows byte order). A node's GUID index points here; compressed to 22
characters, the GUID is the GlobalId Revit's own IFC export writes (355 of 355 on the user's 2016 project).

## NWF

No model of its own: `LcOpXRefTable` holds JSON listing the .nwc / .nwd files; they are read from beside the .nwf, else
from the saved path.

## Fragments (`LcOpNwdFragments`)

`u32 count`, then `count` fragments as an object stream from id 100. A fragment (class 0x0d): (align 8) double radius,
u32, u32 primitive (4 faces, 8 lines, 16 / 32 points and text), u32 flags, u32 item: the tree item's position in
pre-order (the file is 0); then a transform value (0x0e: 3 doubles translation; 0x0f: translation and quaternion x, y,
z, w; 0x11: 13 floats, a 3x4 matrix and one, then 3 doubles translation), a material (0x37: u32 flags, colours 0x36 of
13 floats and a u32, an asset 0xb9 when flags & 0x20), and a box (0x5d: 6 floats, the bounding box in the piece's frame,
3 doubles translation, a float radius, a u32, the u32 number of its geometry block). A box another fragment points back
to is that geometry placed again. Every fragment's item is a leaf (class 0x16) in all the samples.

## Geometry blocks (`LcOpNwdGeometry`)

The blocks, then a table: `u32 count, u32 pages, a u32 per page, a u32 length per block`. A block is an object stream
from id 100: the root (0x5e faces; 0x5f lines and 0x60 points are not meshes), then attributes:

- 0x3c positions, 0x3d texture coordinates: `u32 corners, u32 floats`, the float32 values, then an index code (none
  when there is one value per corner);
- 0x64 normals: `i32 -corners, u32 count`, 6 bytes each (3 x int16; 3 x int8 in revision 431), then an index code;
- triangle strips: `u32 count, u32 bits, u32 count`, the lengths packed most significant bit first in u32 words, then
  `u32 n` and an index code taking strip corners to corners (0: the corners in order). Strip k gives triangles
  (k, k+1, k+2), every other one flipped.

Index code, a byte per step: `0x00-0x3f` n+1 new values (the next ones in the array); `0x40-0x7f` the value n corners
back; `0x80-0xbf` the previous value n+1 more times; `0xc0-0xdf` a predefined value (normals along the axes);
`0xe0-0xef` and a byte: the value `(n & 15) << 8 | byte` corners back; `0xf0` and a u16: the value at that index. Padded
to 4 bytes.

Checked: the hello walls' mesh volumes are Revit's to 0.01 ft3; on the user's 2016 project all 325 elements with a Revit
volume match it within 1%.

## Not read yet

Lines and points (blocks 0x5f / 0x60), texture coordinates and normals (the viewer computes its own), TimeLiner (`LcTlTimelinerElement`), selection sets, clash tests,
point clouds, `lichunk-007` files.
