"""E1: exact one-dimensional conduction, driven entirely by generated registry methods."""
from pathlib import Path
import argparse
import json
import numpy as np
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
from femlab import Client

parser = argparse.ArgumentParser()
parser.add_argument('--url', default='http://127.0.0.1:7777')
parser.add_argument('--out', type=Path, default=Path('heat-bar.png'))
args = parser.parse_args()
with Client(args.url) as fem:
    fem.model_new(name='python-heat-bar')
    fem.geometry_add_box(name='bar', size=['1 m','100 mm','100 mm'])
    fem.material_add(name='steel', E='210 GPa', nu=0.3, rho='7850 kg/m^3', k='45 W/(m K)', cp='460 J/(kg K)')
    fem.material_assign(material='steel', bodies=['bar'])
    fem.mesh_set(mesher={'kind':'lattice','size':'100 mm'})
    fem.constraint_temperature(name='cold', on='bar.xmin', value='0 degC')
    fem.constraint_temperature(name='hot', on='bar.xmax', value='100 degC')
    fem.step_add(name='conduct', procedure='heat-steady', constraints=['cold','hot'], loads=[])
    fem.solve_run(step='conduct')
    path = fem.query_path(field='temperature', from_=['0 m','50 mm','50 mm'], to=['1 m','50 mm','50 mm'], n=11)
    x, actual = np.asarray(path['s']), np.asarray(path['values'])
    exact = 273.15 + 100*x
    error = float(np.max(np.abs(actual-exact)))
    assert error < 1e-8, (path['unit'], error)
    plt.plot(x, actual-273.15, 'o', label='FEM Lab')
    plt.plot(x, exact-273.15, '-', label='T(x)=100x degC')
    plt.xlabel('Distance (m)'); plt.ylabel('Temperature (degC)'); plt.legend()
    plt.savefig(args.out)
    args.out.with_suffix('.journal.json').write_text(json.dumps(fem.query_journal()['entries'], indent=2))
    print(json.dumps({'max_error_K':error,'plot':str(args.out),'unit':path['unit']}))
