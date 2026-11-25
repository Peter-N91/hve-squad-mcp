# RPI template fixtures

Byte-identical copies of the RPI artifact templates whose structure
[`src/engine/advisory-contracts.ts`](../../../src/engine/advisory-contracts.ts)
validates. The tests fill them to build realistic research and plan artifacts.

The pinned cast under `host/cast` ships agents and instructions only, so these
templates are not available at runtime and are kept here as test data.

| File | Source | SHA-256 |
|------|--------|---------|
| `rpi-research/templates/research.md` | `microsoft/hve-core/.github/skills/rpi/rpi-research/templates/research.md` @ `b1cae5059b6efedb406eef070d2981c201a5baed` | `f54b7929a52a6e1260a227461553288106495175d9db85a942f0eafb30b94efe` |
| `rpi-plan/templates/implementation-plan.md` | `microsoft/hve-core/.github/skills/rpi/rpi-plan/templates/implementation-plan.md` @ `b1cae5059b6efedb406eef070d2981c201a5baed` | `f5ac81cba7bf151ecff94216dfd38e6a5bd6cb231687682ce382e6ea7cf5ea80` |
| `rpi-plan/templates/implementation-details.md` | `microsoft/hve-core/.github/skills/rpi/rpi-plan/templates/implementation-details.md` @ `b1cae5059b6efedb406eef070d2981c201a5baed` | `183187dd67662501c1ed612a38b8247321a21ca2a14ad8d93430d580c14a35c7` |

These files remain under the license of `microsoft/hve-core`; see the
repository [NOTICE](../../../NOTICE). Do not edit them. If the validator moves
to a newer template revision, replace the files and this table together.
