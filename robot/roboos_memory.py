"""
Phase 4 — RoboOS Real-Time Shared Memory adapter for Guard <-> Courier.

RoboOS coordinates multiple agents through a spatiotemporal Real-Time Shared
Memory (Redis): every robot publishes its state (pose, role, current action,
verification status) and every other robot can read it, so the Brain plans over
a live, shared world view instead of point-to-point messages.

This is a thin, dependency-light adapter over that idea:
  * Redis backend when REDIS_URL / a local redis is reachable (what RoboOS uses).
  * In-process dict fallback otherwise, so it imports + unit-tests with no redis.

State lives under one Redis hash (default key "roboos:rovers"), field per robot,
JSON value. Coordination primitive: wait_for() blocks until another robot reports
a field value (e.g. courier waits for guard.action == "admitted").

    mem = SharedMemory()
    mem.update("courier", action="at_checkpoint", x=1.2, y=0.3)
    mem.wait_for("guard", "action", "admitted", timeout=30)
"""
import json
import os
import time

NS = os.environ.get("ROBOOS_MEM_KEY", "roboos:rovers")


class _DictBackend:
    """Process-local fallback (single machine / tests). Not cross-process."""
    name = "dict"
    _store = {}

    def hset(self, field, value):
        self._store[field] = value

    def hget(self, field):
        return self._store.get(field)

    def hgetall(self):
        return dict(self._store)


class _RedisBackend:
    name = "redis"

    def __init__(self, url):
        import redis
        self.r = redis.from_url(url, decode_responses=True)
        self.r.ping()                              # fail fast if unreachable

    def hset(self, field, value):
        self.r.hset(NS, field, value)

    def hget(self, field):
        return self.r.hget(NS, field)

    def hgetall(self):
        return self.r.hgetall(NS)


def _make_backend():
    url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    try:
        return _RedisBackend(url)
    except Exception as e:
        print(f"[shared-mem] redis unavailable ({str(e)[:60]}) — in-process dict")
        return _DictBackend()


class SharedMemory:
    """Per-robot spatiotemporal state shared across agents."""

    def __init__(self, backend=None, clock=time.time):
        self.b = backend or _make_backend()
        self._clock = clock                        # injectable for tests

    def update(self, robot, **state):
        """Merge new state for `robot` and stamp it. Returns the merged record."""
        cur = self.get(robot)
        cur.update(state)
        cur["robot"] = robot
        cur["ts"] = self._clock()
        self.b.hset(robot, json.dumps(cur))
        return cur

    def get(self, robot):
        raw = self.b.hget(robot)
        return json.loads(raw) if raw else {}

    def all(self):
        return {k: json.loads(v) for k, v in self.b.hgetall().items()}

    def wait_for(self, robot, key, value, timeout=30, poll=0.2):
        """Block until robot's `key` == `value`. Returns True, or False on timeout.
        The coordination primitive behind the Guard/Courier handshake."""
        t0 = self._clock()
        while self._clock() - t0 < timeout:
            if self.get(robot).get(key) == value:
                return True
            time.sleep(poll)
        return False


if __name__ == "__main__":
    m = SharedMemory()
    print("backend:", m.b.name)
    m.update("courier", action="at_checkpoint", x=1.2, y=0.3)
    m.update("guard", action="verifying")
    print("all:", json.dumps(m.all(), indent=2))
