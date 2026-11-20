// A steady clock for the effects loop. Timers in a worker keep running when
// the window is hidden or minimised; the page's own timers and animation
// frames are slowed or stopped then, which would freeze your camera for others.
const scope = self as unknown as { onmessage: ((e: MessageEvent<number>) => void) | null; postMessage(m: null): void };
let timer = 0;
scope.onmessage = (e) => {
  clearInterval(timer);
  if (e.data > 0) timer = setInterval(() => scope.postMessage(null), e.data) as unknown as number;
};
