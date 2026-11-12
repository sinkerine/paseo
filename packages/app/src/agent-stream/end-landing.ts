export interface EndLandingGeometry {
  ready: boolean;
  atEnd: boolean;
}

export interface EndLandingPorts {
  read(): EndLandingGeometry;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  onSettled(): void;
}

export interface EndLanding {
  start(): void;
  cancel(): void;
  isActive(): boolean;
}

export function createEndLanding(ports: EndLandingPorts): EndLanding {
  let generation = 0;
  let active = false;
  let frame: number | null = null;
  let eligibleFrames = 0;
  let atEndFrames = 0;

  function cancel() {
    generation += 1;
    active = false;
    if (frame !== null) ports.cancelFrame(frame);
    frame = null;
  }

  function schedule(requestGeneration: number) {
    frame = ports.requestFrame(() => {
      // A cancelled callback may already be in the scheduler's current batch.
      if (!active || generation !== requestGeneration) return;
      frame = null;
      const geometry = ports.read();
      if (geometry.ready) {
        eligibleFrames += 1;
        atEndFrames = geometry.atEnd ? atEndFrames + 1 : 0;
        if (atEndFrames >= 2 || eligibleFrames >= 60) {
          active = false;
          ports.onSettled();
          return;
        }
      }
      schedule(requestGeneration);
    });
  }

  return {
    start() {
      cancel();
      active = true;
      eligibleFrames = 0;
      atEndFrames = 0;
      schedule(generation);
    },
    cancel,
    isActive: () => active,
  };
}
