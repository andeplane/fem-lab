# ADR 0048: Elastic corotational beams from one scalar energy

Status: accepted. Issues: #825 and #345.

## Context

The moment Command and six joint degrees of freedom already support linear beams. B6 additionally requires a finite-angle circular-elastica solution. Reusing the linear stiffness on total displacements is not objective, and a continuum total-Lagrangian kernel does not describe a beam section.

## Decision

Beam2 implements the existing Element tangent-and-force extension point with a corotational elastic energy. A unit deformed chord and the projected mean of the two rotated reference section directors define an objective element triad. Nodal sections are rotated with the exponential of their total global rotation vectors. The principal logarithms of their rotations relative to the element triad and the chord extension form the local deformational coordinates. The existing Timoshenko matrix supplies the elastic quadratic energy; thermal axial strain is subtracted from chord extension.

A fixed-size second-order forward differentiation of that single energy supplies internal force and the consistent symmetric tangent. There is no finite-difference step, alternate force implementation, incremental rotation history or worker-dependent reduction. At zero displacement it reduces to the existing linear element. The beam output strain is engineering axial section strain and stress is the extreme-fibre elastic section stress; continuum strain/stress measures are unchanged.

The global rotational unknown is a total exponential coordinate, not an increment composed by the solver. A moment load is therefore a constant generalized force conjugate to that coordinate. In planar bending it is the ordinary dead end moment. Arbitrary physical global dead torques and follower torques would require an SO(3) rotation-Jacobian pullback of virtual work and are unsupported; general finite three-axis coefficients are generalized work coefficients, not physical spatial torque components. This matches the existing deformation-independent external-load contract and keeps Journal/replay state independent of the iteration path.

Only elastic section laws are supported; a stateful material is rejected explicitly rather than dropping its history. Collapsed chords, opposed averaged directors and relative rotations at the logarithm cut fail with a structured mesh-inverted error so the existing nonlinear cutback handles them. The element does not implement linear beam stress stiffening, follower loads, warping or finite-strain plasticity.

## Consequences and verification

Large overall rotations are permitted with small relative elastic section deformations. Members must be spatially refined, especially as adjacent sections approach the chart limits. Circular-elastica end moments at positive and negative pi/2, mesh convergence, worker determinism, rigid-motion objectivity, coordinate covariance, force/tangent consistency and the exact linear limit gate the implementation. An explicit energy-derived tangent costs more scalar work than the linear element, but gives one auditable constitutive path and avoids a fragile hand-maintained tangent.

Total beam rotation vectors must remain strictly inside the principal exponential chart, with magnitude less than pi radians at every node. Reaching that limit or a nonfinite rotation is an explicit unsupported error; reducing load increments does not extend the supported final-rotation range. This prevents the rank loss of exponential coordinates near full turns.

The corotational beam kernel rejects gravity loads. Its finite-rotation distributed-load interpolation and within-element self-weight stress recovery are not implemented. Use linear `static` beams or a solid model for self-weight; manually replacing gravity with nodal loads does not establish an equivalent distributed-load model. Nodal dead forces/moments and axial thermal expansion remain supported within the stated limits.
