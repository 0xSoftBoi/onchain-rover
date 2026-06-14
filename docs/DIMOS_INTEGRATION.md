# Integrating DimOS into Clanker500

[DimOS](https://github.com/dimensionalOS/dimos) (dimensionalOS, Apache-2.0,
~v0.0.12 alpha) is an "agentive OS for physical space": a **reactive dataflow of
`Module`s** with typed `In[]`/`Out[]` ports, **LangChain agents** (native Ollama
support), an LLM-callable **SkillLibrary**, and a **spatial-memory VLM perception**
stack. It is *not* ROS-locked (ROS2 is just one transport; default is LCM).

## The thesis fit (one sentence)
**DimOS becomes the rover's brain (perception + spatial memory + skill-calling
agent); our existing stack stays the body and the economy (FastAPI control, x402
payments, ENS identity, ERC-8004 reputation, GibberLink, Ledger governance).**
The agent *sees, remembers, reasons, and then calls our crypto rails as skills.*

This is additive, not a rewrite — and it directly upgrades the judge-vulnerable
parts: "the robot can't actually perceive" and "is it really an agent."

## What to use vs skip (avoid overlap)
| DimOS piece | Decision |
|---|---|
| `Module` + `cmd_vel: In[Twist]` motion abstraction | **USE** — thin adapter to our serial JSON |
| LangChain agent + `ollama:` local model | **USE** — the skill-calling brain |
| `SkillLibrary` + `GenericRestSkill` | **USE** — agent calls our FastAPI/sidecar as tools, zero glue |
| Spatial memory + Moondream VLM + object tracking | **USE (sparingly)** — the perception wow; RAM-gated |
| DimOS `[web]` (its own FastAPI/SSE), MJPEG, rerun viz | **SKIP** — pure overlap with our dashboards/`/stream` |
| `faster-whisper` audio | **SKIP** — we have GibberLink + espeak |

## Architecture
```
            ┌─ DimOS (the brain, on the Jetson) ──────────────────────┐
            │  VLMAgent("ollama:gemma3:1b")                           │
            │    ├─ SkillLibrary:                                     │
            │    │    • Move/Look skills  → RoverModule (cmd_vel)     │
            │    │    • GenericRestSkill   → our FastAPI :8000        │
            │    │    • GenericRestSkill   → our sidecar :4021        │
            │    │        (hire/x402, auction, give-feedback)         │
            │    └─ Perception: Moondream VLM + spatial memory        │
            │  RoverModule(Module): cmd_vel:In[Twist] ─┐              │
            └───────────────────────────────────────────┼────────────┘
                                                         ▼
                              rover.py  →  ESP32 serial {"T":1,"L":..,"R":..}
```

## Phase 1 — RoverModule (the body adapter)  ·  ~1 file, low effort, high value
A `Module` that turns DimOS `Twist` (unicycle `linear.x`, `angular.z`) into our
left/right wheel serial JSON, and publishes odometry back as `PoseStamped`.
```python
# robot/dimos_rover.py
from dimos.core.module import Module
from dimos.core.stream import In, Out
from dimos.msgs.geometry_msgs.Twist import Twist
from dimos.msgs.geometry_msgs.PoseStamped import PoseStamped
from rover import Rover           # our tested serial lib
import reactivex as rx

WHEEL_BASE = 0.18
class RoverModule(Module):
    cmd_vel: In[Twist]
    pose: Out[PoseStamped]
    def start(self):
        self.r = Rover()          # shares the same ESP32 serial discipline as api.py
        self.register_disposable(self.cmd_vel.observable().subscribe(self._drive))
    def _drive(self, t: Twist):
        v, w = t.linear.x, t.angular.z
        self.r.drive(max(-0.35, min(0.35, v - w*WHEEL_BASE/2)),
                     max(-0.35, min(0.35, v + w*WHEEL_BASE/2)))   # same speed clamp as pilot
```
Gotcha: the ESP32 serial port is single-owner — run DimOS **or** `api.py`'s
serial loop, not both. Cleanest: have `api.py` expose the shared `Rover`, and the
RoverModule reuse it (import the singleton) rather than opening a 2nd connection.

## Phase 2 — Agent + skills calling our rails  ·  low effort, high value
The DimOS agent's tools are our *existing* services — no new backend:
```python
from dimos.agents.vlm_agent import VLMAgent, VLMAgentConfig
from dimos.skills.rest.rest import GenericRestSkill
from dimos.skills.skill_library import SkillLibrary

skills = SkillLibrary()
skills.add(GenericRestSkill(name="hire_self",  base_url="http://localhost:4021"))  # x402 /task, auction
skills.add(GenericRestSkill(name="rover_api",  base_url="http://localhost:8000"))  # seek/capture/say
agent = VLMAgent(VLMAgentConfig(model="ollama:gemma3:1b", skills=skills))
```
Now a natural-language job — *"a buyer hired us to photograph booth 12"* — drives
the agent to: look (VLM) → move (RoverModule) → capture → call our `/store-proof`
(Walrus) → call sidecar `/give-feedback` (ERC-8004). The auction/negotiation we
built becomes one more skill the agent can invoke. **This is the honest "agent"
answer: a real LangChain tool-calling loop over physical + crypto skills.**

## Phase 3 — Spatial perception (the wow, RAM-gated)  ·  medium-high effort
`uv pip install 'dimos[perception]'` → Moondream VLM + spatio-temporal RAG
(`sqlite-vec`) + YOLO/EdgeTAM. Gives the rover real scene memory:
*"drive to the package I saw near the door."* Highest demo impact, but see RAM.

## Jetson Orin NX reality (~3.5 GB free RAM) — the honest risk
- **Phases 1–2 are light and very feasible** (core dataflow + Ollama agent + REST
  skills). Do these first; they alone are a strong integration.
- **Phase 3 is the RAM fight.** `[perception]` pulls torch + transformers +
  ultralytics + moondream + EdgeTAM — running them concurrently will exceed
  3.5 GB. Mitigations: one model at a time; prefer EdgeTAM/Moondream (edge-tuned);
  keep Ollama at 1–3B; consider offloading the heavy VLM to a laptop server and
  calling it as a (DimOS REST) skill.
- **`rerun-sdk` is a hard core dep** even headless ("no way to use dimos without
  rerun rn") — extra weight; tolerate it or pin/patch.
- Install: `export GIT_LFS_SKIP_SMUDGE=1`; torch must be the **JetPack/CUDA build**,
  not the x86 PyPI wheel. ARM64 open3d wheel is provided. Python ≥3.10 (we have 3.10).

## Install (Jetson)
```bash
export GIT_LFS_SKIP_SMUDGE=1
~/ugv_jetson/ugv-env/bin/pip install 'dimos[base,agents]'   # phase 1-2 first
# phase 3 later, watching RAM:
# ~/ugv_jetson/ugv-env/bin/pip install 'dimos[perception]'
```

## What it strengthens (judge/sponsor angle)
- **Answers "is it really an agent?"** — real perception + a tool-calling planner,
  not just our negotiation loop.
- **Answers "the robot can't perceive"** — spatial memory + VLM scene understanding.
- DimOS's `cmd_vel`/skills are clean, legible architecture; our crypto rails plug
  in as skills → the agent-economy story gets a credible robotics backbone.
- Keeps every sponsor integration intact (ENS, World, Circle, Walrus, Ledger,
  ASI) — DimOS sits *above* them as the brain that calls them.

## Recommendation
Do **Phase 1 + 2** (a day's work, low risk, high narrative value): RoverModule +
Ollama agent + GenericRestSkill to our FastAPI/sidecar. Demo "agent perceives a
job → drives → proves it on-chain." Treat **Phase 3** as a stretch — wire one VLM
"look and describe" skill if RAM allows; don't bet the demo on the full perception
stack on a 3.5 GB Jetson. **Do not** replace our FastAPI/dashboards/stream with
DimOS's — that's pure overlap and demo risk.
```
