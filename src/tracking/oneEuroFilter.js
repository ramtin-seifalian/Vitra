// One Euro Filter (Casiez, Roussel, Vogel 2012) — low-lag, adaptive
// smoothing: aggressive filtering when the signal is nearly still (kills
// tracking jitter), lighter filtering when it moves fast (keeps head turns
// responsive instead of laggy). This is the standard fix for "shaky AR".
class LowPassFilter {
  constructor() {
    this.initialized = false;
    this.hatXPrev = 0;
  }
  filter(x, alpha) {
    const result = this.initialized ? alpha * x + (1 - alpha) * this.hatXPrev : x;
    this.initialized = true;
    this.hatXPrev = result;
    return result;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTime = null;
    this.lastValue = 0;
  }

  filter(value, timestampMs) {
    if (this.lastTime === null) {
      this.lastTime = timestampMs;
      this.lastValue = value;
      this.xFilter.filter(value, 1);
      this.dxFilter.filter(0, 1);
      return value;
    }
    const dt = Math.max((timestampMs - this.lastTime) / 1000, 1e-3);
    this.lastTime = timestampMs;

    const dx = (value - this.lastValue) / dt;
    const edx = this.dxFilter.filter(dx, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const result = this.xFilter.filter(value, alpha(cutoff, dt));

    this.lastValue = value;
    return result;
  }
}

// Filters a THREE.Vector3-like {x,y,z} with one OneEuroFilter per axis.
export class Vector3OneEuroFilter {
  constructor(options) {
    this.fx = new OneEuroFilter(options);
    this.fy = new OneEuroFilter(options);
    this.fz = new OneEuroFilter(options);
  }
  filter(v, timestampMs, out = v) {
    out.x = this.fx.filter(v.x, timestampMs);
    out.y = this.fy.filter(v.y, timestampMs);
    out.z = this.fz.filter(v.z, timestampMs);
    return out;
  }
}

// Smooths a THREE.Quaternion by slerping toward each new sample, with the
// slerp factor adapted by angular speed (same spirit as One Euro, applied to
// rotation instead of a scalar): fast head turns stay responsive, small
// tracking noise while still gets heavily damped.
export class QuaternionSlerpFilter {
  constructor({ minCutoff = 1.0, beta = 12.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.current = null;
    this.lastTime = null;
  }
  filter(quat, timestampMs) {
    if (this.current === null) {
      this.current = quat.clone();
      this.lastTime = timestampMs;
      return this.current;
    }
    const dt = Math.max((timestampMs - this.lastTime) / 1000, 1e-3);
    this.lastTime = timestampMs;

    const angle = 2 * Math.acos(Math.min(1, Math.abs(this.current.dot(quat))));
    const angularSpeed = angle / dt;
    const cutoff = this.minCutoff + this.beta * angularSpeed;
    const t = Math.min(1, alpha(cutoff, dt));

    this.current.slerp(quat, t);
    return this.current;
  }
}
