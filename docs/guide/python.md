# Python and notebooks

Python is a client of the same schema-owned Commands and Queries as TypeScript. It does not
implement another FEM engine. Unit strings, structured errors, numerical capabilities and
supported solver limits are unchanged.

## Python in the browser

Open the **Script** panel, select **Python notebook**, edit cells and press **Run all cells**.
A line beginning `# %%` starts another visible cell. Cells run from top to bottom in one fresh
Python environment. `fem` is an asynchronous generated client; use `await` for engine calls.
`numpy` is pre-imported as `np`. Import `matplotlib.pyplot` to produce plots next to the cells.
The optional pinned Pyodide distribution and numpy download only on the first Python run;
matplotlib downloads when imported. Network access to the distribution is required on a cold
browser cache. Normal application startup has no Python download.

```python
# %%
print(await fem.query_model())
# %%
import matplotlib.pyplot as plt
field = await fem.query_field(step='conduct', field='temperature')
print(field['unit'], np.min(field['values']), np.max(field['values']))
plt.plot(np.sort(field['values']))
```

The example's `conduct` Step must already have a solved thermal Result. `query_field` returns
scientific f64 values in SI units, independently of display units, with its retained Result
identity and component count. Its values are a numpy view of the transferred numeric buffer.
The Script run has a maximum 30000 ms execution deadline after a separate maximum 120000 ms
runtime startup deadline. Source is limited to 64000 characters; console plus plot output is
limited to 8 MiB. Each browser registry request is limited to 1 MiB. Stop terminates the disposable worker; already-applied Commands stay in the
Journal. Infinite loops cannot freeze the editor. Arbitrary untrusted Python is unsupported:
Pyodide can access JavaScript APIs within its Worker. Account/billing/credential operations
must use the ordinary explicit account controls.

Each completed run retains its source as `notebook.py` and Agg PNG plots in the project's
input/output files, including source from a run that reports an error. Save the project or
export its complete project bundle to carry these files. A plain `femlab/1` Model file carries
the engine Journal, not notebook source/plots. Reopening a complete project restores source
and plots; press Run all cells to re-execute deliberately. Opening never executes Python.
The Journal records only expanded engine Commands, so native and browser replay do not need
Python installed. Python cells are not rolled back if a later cell fails.

## CPython and Jupyter

For a published client release, install with `python3 -m pip install femlab`; the optional
notebook dependencies are `python3 -m pip install 'femlab[notebook]'`. The client needs a
running FEM Lab compute host: it does not embed another engine or contact the hosted AI
service. This server uses the CPU Node WASM engine with one worker; native server GPU
execution is not provided by this host. Existing `query.cost` planning limits still apply. Package publication is separate from source installation and is tracked in #31.

Prerequisites: Python 3.10 or newer, Node 22 or newer, a FEM Lab checkout and its Node WASM
engine build. From the checkout:

```sh
npm ci
node tools/build-wasm.mjs
npm run build -w packages/server
python3 -m pip install './python[notebook]'
FEMLAB_SERVE="$PWD/packages/server/dist/femlab-serve.js" femlab serve --port 7777
```

Alternatively start the host directly with
`node packages/server/dist/femlab-serve.js --port 7777`. Port 0 chooses an available port and
prints the actual loopback URL. The server prints no session capabilities; each Python
Client acquires its own private engine and closes it when leaving a `with` block. The server
allows at most 16 sessions, expires inactive sessions after 30 minutes, and rejects requests
over 64 MiB. There is no public bind option or account/payment endpoint. Do not reverse-proxy
this single-user host publicly. For a remote machine use an SSH tunnel, for example
`ssh -L 7777:127.0.0.1:7777 home-mini`, with the host running on that machine.

```python
from femlab import Client
with Client('http://127.0.0.1:7777') as fem:
    fem.model_new(name='notebook model')
    fem.geometry_add_box(name='bar', size=['1 m', '100 mm', '100 mm'])
    print(fem.query_model())
```

Methods use snake_case names; a Python keyword gains an underscore (`from_`, `as_`). The
underlying Command/Query retains its original wire name and camelCase argument names.
`femlab.generated` also contains keyword-only dataclass argument envelopes; `Client.dispatch`
and `Client.query` accept those or ordinary registry dictionaries. Optional omitted values
retain engine defaults; an explicit `None` is sent as JSON null and is validated by the
engine. `FemError.error` carries the structured engine error.

Run `python3 python/examples/heat_bar.py --out heat-bar.png` for benchmark E1: it constructs
and solves steady conduction, checks eleven samples against `T(x)=273.15+100x K` to 1e-8 K,
plots the result and exports its replay Journal. Open `python/examples/heat_bar.ipynb` in
JupyterLab for the same benchmark. The source package builds a normal wheel and installs
with pip; this repository does not imply that a public PyPI release has been published.
Generated Python API freshness is checked by `npm run codegen:check`.
