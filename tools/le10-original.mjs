// Reproducible authored FE source for the original line-supported NAFEMS LE10.
// Coordinates/connectivity come from the existing registry mesher/export/converter;
// no second stiffness, stress-recovery or geometry kernel lives in this generator.
import { createHash } from 'node:crypto';

export function mappedLe10(n, layers) {
  if (!Number.isInteger(n) || n < 2 || !Number.isInteger(layers) || layers < 2 || layers % 2) {
    throw new Error('LE10 requires at least two divisions and an even layer count for z=0.3 m.');
  }
  return {
    cmd: 'mesh.set', order: 2,
    mesher: {
      kind: 'sweep',
      base: { kind: 'mapped', body: 'plate', blocks: [{
        corners: [['2 m', '0 m'], ['3.25 m', '0 m'], ['0 m', '2.75 m'], ['0 m', '1 m']],
        edges: [
          { kind: 'line' },
          { kind: 'ellipse', center: ['0 m', '0 m'], semiAxes: ['3.25 m', '2.75 m'] },
          { kind: 'line' },
          { kind: 'ellipse', center: ['0 m', '0 m'], semiAxes: ['2 m', '1 m'] },
        ],
        n: [n, n],
        tags: ['y0', 'outer', 'x0', 'inner'],
      }] },
      sweep: { kind: 'extrude', layers, height: '0.6 m' },
    },
  };
}

const sha256 = text => createHash('sha256').update(text).digest('hex');
const metres = quantity => {
  if (typeof quantity === 'object' && quantity.unit === 'm') return quantity.value;
  if (typeof quantity === 'string' && quantity.endsWith(' m')) return Number(quantity.slice(0, -2));
  throw new Error('Converted LE10 source must retain explicit metre coordinates.');
};

/** Construct through registry I/O, then name the exact outer mid-plane nodes. */
export async function originalLe10Source(Engine, n, layers) {
  const engine = new Engine(1);
  try {
    const commands = [{ cmd: 'model.new', name: 'le10-source' }, mappedLe10(n, layers)];
    await engine.replay_hashes(JSON.stringify(commands.map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), true, false);
    const { output } = JSON.parse(await engine.dispatch(JSON.stringify({ cmd: 'mesh.export', format: 'inp' })));
    const convert = text => JSON.parse(engine.query(JSON.stringify({
      query: 'query.convertAbaqus', text, name: 'original-le10', body: 'plate',
      mode: 'mesh', unitLength: '1 m', sha256: sha256(text),
    }))).commands.find(command => command.cmd === 'mesh.set');
    const initial = convert(output.text);
    const line = initial.mesher.nodes.filter(node => {
      const [x, y, z] = node.at.map(metres);
      return Math.abs(z - 0.3) < 1e-12 && Math.abs((x / 3.25) ** 2 + (y / 2.75) ** 2 - 1) < 1e-12;
    }).map(node => node.label);
    if (line.length !== 2 * n + 1) throw new Error(`LE10 midline expected ${2 * n + 1} nodes, got ${line.length}.`);
    const rows = [];
    for (let offset = 0; offset < line.length; offset += 16) rows.push(line.slice(offset, offset + 16).join(', '));
    // Include the support Set in the hashed source deck, not only in a post-import edit.
    const source = `${output.text.trimEnd()}\n** Original NAFEMS LE10: uz only on the outer mid-plane edge, z=0.3 m.\n*NSET, NSET="outer-midline"\n${rows.join('\n')}\n`;
    const mesh = convert(source);
    return { mesh, source, sha256: sha256(source), n, layers };
  } finally { engine.free(); }
}

/** Physical supports are split deliberately; no other Command restrains uz. */
export function originalLe10Commands(mesh) {
  return [
    { cmd: 'model.new', name: 'nafems-le10-original' },
    { cmd: 'model.setUnits', units: { length: 'm', force: 'N', stress: 'MPa' } },
    { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, source: 'NAFEMS LE10 / SimScale: isotropic E=210 GPa, nu=0.3' },
    mesh,
    { cmd: 'material.assign', material: 'steel', bodies: ['plate'] },
    { cmd: 'constraint.fix', name: 'symx', on: 'plate.surface_plate.x0', dofs: ['ux'] },
    { cmd: 'constraint.fix', name: 'symy', on: 'plate.surface_plate.y0', dofs: ['uy'] },
    { cmd: 'constraint.fix', name: 'rim-in-plane', on: 'plate.surface_plate.outer', dofs: ['ux', 'uy'] },
    { cmd: 'constraint.fix', name: 'rim-midline', on: 'plate.nset_outer-midline', dofs: ['uz'] },
    { cmd: 'load.pressure', name: 'top', on: 'plate.surface_plate.top', value: '1 MPa' },
    { cmd: 'step.add', name: 'static', procedure: 'static', constraints: ['symx', 'symy', 'rim-in-plane', 'rim-midline'], loads: ['top'] },
    { cmd: 'solve.run', step: 'static' },
  ];
}
