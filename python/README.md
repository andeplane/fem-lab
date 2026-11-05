# FEM Lab Python client

Generated, typed Command/Query methods for the FEM Lab headless Rust engine through its
single-user Node registry host. Python never implements or duplicates the FEM solver.

Build the server in a FEM Lab checkout with `npm ci`, `node tools/build-wasm.mjs` and
`npm run build -w packages/server`, then run
`node packages/server/dist/femlab-serve.js --port 7777`.

```python
from femlab import Client
with Client() as fem:
    fem.model_new(name="Python model")
    fem.geometry_add_box(name="bar", size=["1 m", "100 mm", "100 mm"])
    print(fem.query_model())
```

Install this source package with `python -m pip install ./python`. Optional notebook extras
are `./python[notebook]`; see `examples/heat_bar.ipynb` in the source repository and the
[Python guide](https://andeplane.github.io/fem-lab/docs/python/) for the exact analytical
heat-conduction benchmark, async browser notebooks, unit strings and supported limits.

The host listens only on loopback and rejects browser-origin requests. For a remote engine,
use an SSH tunnel. It is not the public account/billing service. All clients in a `with`
block release their private server engine on exit. Engine errors are exposed as
`FemError.error`. Omitted arguments preserve engine defaults; `None` sends explicit null.
