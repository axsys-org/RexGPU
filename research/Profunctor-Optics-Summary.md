# Profunctor Optics: A Categorical Update — Summary

**Authors:** Bryce Clarke, Derek Elkins, Jeremy Gibbons, Fosco Loregian, Bartosz Milewski, Emily Pillmore, Mario Román
**Published:** Compositionality, Volume 6, Issue 1 (2024)
**arXiv:** 2001.07488v6

---

## Core Thesis

Optics (bidirectional data accessors like lenses, prisms, traversals) can be unified under a single categorical definition using **coends over monoidal actions**, and this definition extends to **mixed** (different categories for forward/backward directions) and **V-enriched** settings. The paper generalizes the Pastro–Street theorem on Tambara modules to prove a **profunctor representation theorem** for all such optics, justifying their composition via ordinary function composition.

---

## 1. What Are Optics?

Optics capture patterns of bidirectional data access:

- **Lens**: `view : S → A` + `update : S × A → S` — access a subfield
- **Prism**: `match : S → A + S` + `build : A → S` — pattern-match with possible failure
- **Traversal**: iterate over all elements of a container
- **Grate**: construct a new structure given a way to create foci from a view function

The problem: composing optics of *different* kinds (e.g., a lens with a prism) by hand is tedious and error-prone.

## 2. Profunctor Representation (Why It Matters)

Each optic family can be encoded as a **function polymorphic over profunctors** with specific algebraic structure (a Tambara module). Under this encoding:

```haskell
type Lens a b s t = forall p. Cartesian p => p a b -> p s t
type Prism a b s t = forall p. Cocartesian p => p a b -> p s t
```

**Composition of different optic kinds becomes ordinary function composition** — a lens composed with a prism "just works" because the constraint intersection (Cartesian ∩ Cocartesian) flows through the type system.

## 3. The Unified Definition (Definition 2.1)

All optics are instances of a single coend formula:

```
Optic(L,R)((A,B), (S,T)) := ∫^{M ∈ M} C(S, M ◁ A) ⊗ D(M ▷ B, T)
```

Where:
- **M** is a monoidal category of "contexts" (residuals)
- **◁, ▷** are monoidal actions on categories C and D
- The coend quotient captures that the context M is existentially quantified — you can't access it directly, only use its shape

By varying the two actions (◁, ▷), you recover every known optic family.

## 4. Table of Optics (Figure 6)

| Optic | Actions | Concrete Form |
|---|---|---|
| **Adapter** | (id, id) | `C(S,A) ⊗ D(B,T)` |
| **Lens** | (×, •) | `C(S,A) × D(S•B, T)` |
| **Monoidal lens** | (⊗, U×) | `CCom(S,A) × C(US⊗B, T)` |
| **Algebraic lens** | (U×, U•) | `C(S,A) × D(ΨS•B, T)` |
| **Monadic lens** | (×, ⋊) | `W(S,A) × W(S×B, ΨT)` |
| **Linear lens** | (•, ⊗) | `C(S, [B,T]•A)` |
| **Prism** | (•, +) | `C(S, T•A) × D(B,T)` |
| **Grate** | ({,}, •) | `D([S,A]•B, T)` |
| **Glass** | (×[,], ×[,]) | `C(S × [[S,A],B], T)` |
| **Affine traversal** | (+⊗, +⊗) | `C(S, T + A⊗{B,T})` |
| **Traversal** | (Pw, Pw) | `V(S, Σ_n A^n ⊗ [B^n,T])` |
| **Kaleidoscope** | (App, App) | `Π_n V([A^n,B], [S^n,T])` |
| **Setter** | (ev, ev) | `V([A,B], [S,T])` |
| **Fold** | (Foldable, *) | `V(S, LA)` |

## 5. Key Derivation Technique

Each optic is derived from the coend definition by:

1. Applying an **adjunction** to simplify one factor (e.g., `(×) ⊣ Δ` for products, `(+) ⊣ Δ` for coproducts, `(−⊗B) ⊣ [B,−]` for exponentials)
2. Applying the **coYoneda lemma** to eliminate the coend
3. The result collapses to a concrete pair of functions

This is the paper's main methodological contribution: a uniform recipe.

## 6. Novel Contributions

### Mixed Optics
The forward and backward directions can live in **different categories** (C ≠ D). This captures:
- **Monadic lenses**: update returns in a monad (`W(S×B, ΨT)` where Ψ is IO, State, etc.)
- **Algebraic lenses**: context carries algebraic structure (list monad → "classifying lens" that trains on datasets)
- **Coalgebraic prisms**: failure captured in a comonad

### New Optic Families
- **Algebraic lenses** (Def 3.8): generalize achromatic lenses; include "classifying lenses" (list monad) that support nearest-neighbor classification
- **Kaleidoscopes** (Def 3.26): optic for applicative functors; accessor for pointwise foldable data
- **Glasses** (Def 3.31): strictly generalize both grates and lenses; concrete representation of lens-grate composition

### Traversals via Power Series
Traversals are derived as the optic for **power series functors** (Prop 3.22):

```
Pw_X(A) = Σ_{n∈N} A^n ⊗ X_n
```

This resolves Milewski's open problem of fitting traversals into the same elementary pattern as lenses and prisms.

## 7. Tambara Theory (Section 4)

The categorical machinery justifying profunctor optics:

1. **Generalized Tambara modules** (Def 4.1): profunctors P with structure maps `α: P(A,B) → P(M◁A, M▷B)` — dinatural in M, natural in A,B
2. **Θ comonad** (Prop 4.5): `ΘP(A,B) = ∫_M P(M◁A, M▷B)` — Tambara modules are its coalgebras
3. **Φ monad** (Prop 4.7): left adjoint to Θ; `ΦQ(X,Y) = ∫^{M,U,V} Q(U,V) ⊗ C(X, M◁U) ⊗ D(M▷V, Y)` — this is the optic itself
4. **Kleisli construction** (Lemma 4.9): the Kleisli category of the promonad Φ̌ = Φ∘y is precisely the category **Optic**
5. **Profunctor Representation Theorem** (Thm 4.14):

```
∫_{P ∈ Tamb} V(P(A,B), P(S,T)) ≅ Optic((A,B), (S,T))
```

This says: an optic IS a polymorphic function over Tambara modules. Composition of optics IS function composition.

## 8. Coend Calculus Toolkit

The paper's proofs rely on four rules:
- **Yoneda/coYoneda reduction**: `∫^X C(X,A) ⊗ FX ≅ FA`
- **Fubini rule**: coends commute
- **Continuity/cocontinuity**: hom distributes over ends/coends
- **Adjunctions**: `D(FX,Y) ≅ C(X,GY)` simplifies factors inside coends

## 9. Implications for RPE / Practical Systems

### Direct Relevance to Compiled Optics
The paper's framework validates RPE's approach of compiling tree paths to byte offsets:

- **Lenses** (`view` + `update`) map directly to struct field access: `getFloat32(offset)` / `setFloat32(offset, value)`
- **Prisms** map to variant/union access with match/build (e.g., checking which node type is active)
- **Traversals** map to iterating over array-of-structs with a compiled stride
- **The coend quotient** (existential context) corresponds to RPE's compile-time erasure of the tree structure — at runtime only flat offsets remain

### Composition = Zero Cost
The profunctor representation theorem guarantees that composed optics (lens-then-prism, lens-then-traversal) can be compiled to a single accessor — no intermediate allocation. This is exactly RPE's "compiled profunctor optics" model.

### Mixed Optics for GPU
Mixed optics (C ≠ D) naturally model CPU↔GPU data flow:
- Forward direction (view): CPU-side tree → GPU buffer offset
- Backward direction (update): GPU buffer write → CPU-side dirty range tracking
- The two "categories" are the CPU address space and GPU buffer layout

---

## Key References

- Pastro & Street (2008): Original Tambara module / doubles construction
- Milewski (2017): Identified Tambara modules as the unifying algebraic structure
- Boisseau & Gibbons (2018): First profunctor representation theorem (non-mixed, Set-enriched)
- Riley (2018): Mixed optics (mentioned but not fully developed), optic laws
- Clarke et al. (2024) [this paper]: Full mixed V-enriched generalization with Haskell implementation

**Implementation:** https://github.com/mroman42/vitrea
